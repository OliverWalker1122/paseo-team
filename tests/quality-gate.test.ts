import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectQualityGate } from "../server/quality-gate.ts";
import {
  initTask,
  loadTask,
  markTaskCompleted,
  recordCandidateDelivery,
  recordPlanSubmission,
  recordReviewVerdict,
  registerTaskAgent,
  resolveCircuitBreaker,
} from "../server/task-store.ts";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.SKIP_DOTENV = "true";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

function setupWorkspace(t: test.TestContext) {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "paseo-team-qgate-"));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  const repoDir = path.join(baseDir, "workspace");
  const stateRoot = path.join(baseDir, "state");

  const git = (...args: string[]) =>
    spawnSync(
      "git",
      ["-c", "user.name=Q", "-c", "user.email=q@example.invalid", ...args],
      { cwd: baseDir, encoding: "utf8" },
    );
  git("init", "-b", "main", repoDir);
  writeFileSync(path.join(repoDir, "app.mjs"), "export const v = 1;\n");
  spawnSync("git", ["-C", repoDir, "add", "."]);
  spawnSync(
    "git",
    [
      "-c",
      "user.name=Q",
      "-c",
      "user.email=q@example.invalid",
      "-C",
      repoDir,
      "commit",
      "-m",
      "initial",
    ],
    { encoding: "utf8" },
  );
  return { baseDir, repoDir, stateRoot };
}

const preset = {
  developer: { model: "auto" },
  planReviewers: [{ model: "auto" }],
  codeReviewers: [{ model: "auto" }, { model: "auto" }],
  complexMode: "simple" as const,
};

function writeLegacySidecar(taskDir: string, name: string, passed = true) {
  writeFileSync(path.join(taskDir, name), passed ? "ok\n" : "fail\n");
  writeFileSync(
    path.join(taskDir, `${name}.json`),
    JSON.stringify({
      status: passed ? "PASS" : "FAIL",
      exitCode: passed ? 0 : 1,
    }),
  );
}

test("gate passes on recorded native CI evidence and ignores later workspace edits", (t) => {
  const { repoDir, stateRoot } = setupWorkspace(t);
  const created = initTask({
    cwd: repoDir,
    goal: "Add stats helper to app.mjs",
    teamName: "Standard",
    preset,
    requireReview: true,
    stateRoot,
  });

  writeFileSync(path.join(repoDir, "app.mjs"), "export const v = 2;\n");
  const delivered = recordCandidateDelivery(created.recordPath, {
    ciStatus: "pass",
    ciSummary: "npm test 10/10",
    summary: "Implemented stats()",
    architectureImpact: "None",
  });
  assert.equal(delivered.candidate, "delivery-r1");
  assert.equal(delivered.ci?.status, "pass");

  for (const agentId of ["rev-1", "rev-2"]) {
    registerTaskAgent(created.recordPath, {
      role: "code-reviewer",
      agentId,
      profile: "auto",
      briefSummary: "Review",
    });
    recordReviewVerdict(created.recordPath, {
      stage: "code",
      agentId,
      round: 1,
      verdict: "APPROVE",
      summary: "Approved",
    });
  }

  const ready = inspectQualityGate({ recordPath: created.recordPath });
  assert.equal(ready.status, "READY");
  assert.deepEqual(ready.checks, {
    deliveryRecorded: true,
    ciPassed: true,
    planReviewSatisfied: true,
    codeReviewSatisfied: true,
  });

  // User edits or commits no longer invalidate the gate.
  writeFileSync(path.join(repoDir, "notes.md"), "user notes\n");
  assert.equal(
    inspectQualityGate({ recordPath: created.recordPath }).status,
    "READY",
  );
  const completed = markTaskCompleted(created.recordPath);
  assert.equal(completed.lifecycleStatus, "completed");
});

test("rework round needs fresh CI (native status or legacy sidecar) and only the latest review round counts", async (t) => {
  const { repoDir, stateRoot } = setupWorkspace(t);
  const created = initTask({
    cwd: repoDir,
    goal: "Fix parser",
    teamName: "Standard",
    preset,
    requireReview: true,
    stateRoot,
  });

  writeLegacySidecar(created.taskDir, "ci-1.log", true);
  recordCandidateDelivery(created.recordPath, {
    summary: "Round 1",
    architectureImpact: "None",
  });
  recordReviewVerdict(created.recordPath, {
    stage: "code",
    agentId: "rev-1",
    round: 1,
    verdict: "REQUEST_CHANGES",
    summary: "Edge case missing",
  });
  recordReviewVerdict(created.recordPath, {
    stage: "code",
    agentId: "rev-2",
    round: 1,
    verdict: "APPROVE",
    summary: "Fine",
  });
  assert.equal(
    inspectQualityGate({ recordPath: created.recordPath }).checks
      .codeReviewSatisfied,
    false,
  );

  // Round 2 delivered without rerunning CI: the old legacy run is stale.
  await new Promise((r) => setTimeout(r, 15));
  const r2 = recordCandidateDelivery(created.recordPath, {
    summary: "Round 2",
    architectureImpact: "None",
  });
  assert.equal(r2.candidate, "delivery-r2");
  assert.equal(
    inspectQualityGate({ recordPath: created.recordPath }).checks.ciPassed,
    false,
  );

  // A failing native check report blocks ciPassed.
  recordCandidateDelivery(created.recordPath, {
    summary: "Round 2 failed",
    architectureImpact: "None",
    ciStatus: "fail",
    ciSummary: "1 test failed",
  });
  assert.equal(
    inspectQualityGate({ recordPath: created.recordPath }).checks.ciPassed,
    false,
  );

  // A fresh passing native check report satisfies ciPassed.
  recordCandidateDelivery(created.recordPath, {
    summary: "Round 2 fixed",
    architectureImpact: "None",
    ciStatus: "pass",
    ciSummary: "all tests passed",
  });

  // A fresh reviewer approving round 2 supersedes round 1 findings.
  recordReviewVerdict(created.recordPath, {
    stage: "code",
    agentId: "rev-3",
    round: 2,
    verdict: "APPROVE",
    summary: "Fixed",
  });
  const gate = inspectQualityGate({ recordPath: created.recordPath });
  assert.deepEqual(gate.checks, {
    deliveryRecorded: true,
    ciPassed: true,
    planReviewSatisfied: true,
    codeReviewSatisfied: true,
  });
});

test("registers parallel developers and binds reported passing CI", (t) => {
  const { repoDir, stateRoot } = setupWorkspace(t);
  const subDir = path.join(repoDir, "packages", "core");
  mkdirSync(subDir, { recursive: true });
  const created = initTask({
    cwd: repoDir,
    goal: "Parallel backend and frontend changes",
    teamName: "Standard",
    preset,
    stateRoot,
  });

  registerTaskAgent(created.recordPath, {
    role: "developer",
    agentId: "dev-1",
    profile: "auto",
    briefSummary: "Backend slice",
  });
  const withTwoDevs = registerTaskAgent(created.recordPath, {
    role: "developer",
    agentId: "dev-2",
    profile: "auto",
    briefSummary: "Frontend slice",
  });
  assert.deepEqual(
    withTwoDevs.nodes
      .filter((n) => n.role === "developer")
      .map((n) => [n.nodeId, n.label]),
    [
      ["developer", "Developer #1"],
      ["developer-1", "Developer #2"],
    ],
  );

  const delivered = recordCandidateDelivery(created.recordPath, {
    summary: "Completed both slices",
    architectureImpact: "None",
    ciStatus: "pass",
    ciSummary: "npm test passed",
  });
  assert.equal(delivered.ci?.status, "pass");
  assert.equal(
    inspectQualityGate({ recordPath: created.recordPath }).status,
    "READY",
  );
});

test("resolveCircuitBreaker supports waiving a broken plan stage and granting an extra code round (plus selective R2 re-review)", (t) => {
  const { repoDir, stateRoot } = setupWorkspace(t);
  const created = initTask({
    cwd: repoDir,
    goal: "Background image theme with plan & code review",
    teamName: "Standard",
    preset,
    isComplex: true,
    requirePlanReview: true,
    requireReview: true,
    stateRoot,
  });

  // Plan R1 & R2 both REQUEST_CHANGES -> trips plan circuit breaker.
  writeFileSync(path.join(created.taskDir, "plan.md"), "# Plan v1\n");
  recordPlanSubmission(created.recordPath, {
    planFile: "plan.md",
    summary: "Plan v1",
  });
  registerTaskAgent(created.recordPath, {
    role: "plan-reviewer",
    agentId: "plan-r1",
    profile: "claude/claude-opus-5-5",
    briefSummary: "Spec",
  });
  recordReviewVerdict(created.recordPath, {
    stage: "plan",
    agentId: "plan-r1",
    round: 1,
    verdict: "REQUEST_CHANGES",
    summary: "Fix test fixture",
    findings: ["blocking: plan.md:10 fixture misses script"],
  });
  recordPlanSubmission(created.recordPath, {
    planFile: "plan.md",
    summary: "Plan v2",
  });
  const planBroken = recordReviewVerdict(created.recordPath, {
    stage: "plan",
    agentId: "plan-r1",
    round: 2,
    verdict: "REQUEST_CHANGES",
    summary: "Check before write",
    findings: ["blocking: plan.md:26 move check before write"],
  });
  assert.equal(planBroken.status, "CIRCUIT_BROKEN");
  assert.equal(loadTask(created.recordPath).lifecycleStatus, "blocked");

  // User chooses to waive remaining plan review and proceed directly to development.
  const waived = resolveCircuitBreaker(created.recordPath, {
    decision: "waive_stage",
    stage: "plan",
    reason: "User chose pre-write guard and proceed straight to Developer",
  });
  assert.equal(waived.record.lifecycleStatus, "active");
  assert.equal(waived.record.circuitBroken, null);
  assert.equal(waived.record.planReview, "waived");

  // Developer delivers R1; Rev #1 approves, Rev #2 requests changes.
  recordCandidateDelivery(created.recordPath, {
    summary: "R1 implementation",
    architectureImpact: "None",
    ciStatus: "pass",
    ciSummary: "npm test 94/94",
  });
  for (const id of ["code-r1", "code-r2"]) {
    registerTaskAgent(created.recordPath, {
      role: "code-reviewer",
      agentId: id,
      profile: "auto",
      briefSummary: "Code review",
    });
  }
  recordReviewVerdict(created.recordPath, {
    stage: "code",
    agentId: "code-r1",
    round: 1,
    verdict: "APPROVE",
    summary: "Looks good",
  });
  recordReviewVerdict(created.recordPath, {
    stage: "code",
    agentId: "code-r2",
    round: 1,
    verdict: "REQUEST_CHANGES",
    summary: "Bad image race",
    findings: ["blocking: index.html:1297 stale token"],
  });

  // R2 rework: only code-r2 re-reviews (selective R2) and still requests changes -> trips code breaker.
  recordCandidateDelivery(created.recordPath, {
    summary: "R2 fix",
    architectureImpact: "None",
    ciStatus: "pass",
    ciSummary: "npm test 98/98",
  });
  const codeBroken = recordReviewVerdict(created.recordPath, {
    stage: "code",
    agentId: "code-r2",
    round: 2,
    verdict: "REQUEST_CHANGES",
    summary: "Abort race",
    findings: ["blocking: index.html:1271 abort mismatch"],
  });
  assert.equal(codeBroken.status, "CIRCUIT_BROKEN");
  assert.equal(loadTask(created.recordPath).lifecycleStatus, "blocked");

  // User authorizes one extra round; R3 passes without re-dispatching code-r1 (already APPROVE).
  const extra = resolveCircuitBreaker(created.recordPath, {
    decision: "extra_round",
    reason: "User authorized one final targeted fix round",
  });
  assert.equal(extra.maxRounds, 3);
  assert.equal(extra.record.lifecycleStatus, "active");
  assert.equal(extra.record.circuitBroken, null);

  recordCandidateDelivery(created.recordPath, {
    summary: "R3 targeted fix",
    architectureImpact: "None",
    ciStatus: "pass",
    ciSummary: "npm test 99/99",
  });
  const r3 = recordReviewVerdict(created.recordPath, {
    stage: "code",
    agentId: "code-r2",
    round: 3,
    verdict: "APPROVE",
    summary: "Verified R3",
  });
  assert.equal(r3.status, "RECORDED");

  // Quality gate MUST be READY (plan review waiver honored despite dispatched plan-r1!).
  const gate = inspectQualityGate({ recordPath: created.recordPath });
  assert.equal(gate.status, "READY");
  assert.deepEqual(gate.checks, {
    deliveryRecorded: true,
    ciPassed: true,
    planReviewSatisfied: true,
    codeReviewSatisfied: true,
  });
});
