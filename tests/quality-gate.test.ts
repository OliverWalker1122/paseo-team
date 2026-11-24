import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectQualityGate } from "../server/quality-gate.ts";
import { runCheck } from "../server/run-check.ts";
import {
  initTask,
  markTaskCompleted,
  recordCandidateDelivery,
  recordReviewVerdict,
  registerTaskAgent,
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

function pass(taskDir: string, name: string, cwd: string, code = 0) {
  return runCheck(process.execPath, ["-e", `process.exit(${code})`], {
    log: path.join(taskDir, name),
    cwd,
  });
}

test("gate passes on recorded evidence and ignores later workspace edits", (t) => {
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
  assert.equal(pass(created.taskDir, "ci-1.log", repoDir).status, "PASS");
  const delivered = recordCandidateDelivery(created.recordPath, {
    ciLog: "ci-1.log",
    summary: "Implemented stats()",
    architectureImpact: "None",
  });
  assert.equal(delivered.candidate, "delivery-r1");

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

test("rework round needs a fresh CI run and only the latest review round counts", (t) => {
  const { repoDir, stateRoot } = setupWorkspace(t);
  const created = initTask({
    cwd: repoDir,
    goal: "Fix parser",
    teamName: "Standard",
    preset,
    requireReview: true,
    stateRoot,
  });

  pass(created.taskDir, "ci-1.log", repoDir);
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

  // Round 2 delivered without rerunning CI: the old run is stale.
  const r2 = recordCandidateDelivery(created.recordPath, {
    summary: "Round 2",
    architectureImpact: "None",
  });
  assert.equal(r2.candidate, "delivery-r2");
  assert.equal(
    inspectQualityGate({ recordPath: created.recordPath }).checks.ciPassed,
    false,
  );

  // A failing latest run is not enough either.
  pass(created.taskDir, "ci-2.log", repoDir, 1);
  assert.equal(
    inspectQualityGate({ recordPath: created.recordPath }).checks.ciPassed,
    false,
  );
  pass(created.taskDir, "ci-3.log", repoDir);

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

test("registers parallel developers and auto-binds the latest CI log from a subdirectory", (t) => {
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

  assert.equal(pass(created.taskDir, "ci-1.log", subDir).status, "PASS");
  const delivered = recordCandidateDelivery(created.recordPath, {
    summary: "Completed both slices",
    architectureImpact: "None",
  });
  assert.equal(delivered.ci?.log, "ci-1.log");
  assert.equal(
    inspectQualityGate({ recordPath: created.recordPath }).status,
    "READY",
  );
});
