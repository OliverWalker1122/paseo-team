import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  computeWorkspaceFingerprint,
  inspectQualityGate,
} from "../server/quality-gate.ts";
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

test("verifies uncompressed uncommitted workspace changes end-to-end without requiring git worktrees or commits", (t) => {
  const { repoDir, stateRoot } = setupWorkspace(t);

  // Pre-existing user draft file in workspace does NOT block Quality Gate!
  writeFileSync(path.join(repoDir, "draft-notes.md"), "user notes\n");

  const created = initTask({
    cwd: repoDir,
    goal: "Add stats helper to app.mjs",
    teamName: "Standard",
    preset: {
      developer: { model: "codex/gpt-6.1-sol", thinking: "high" },
      planReviewers: [{ model: "claude/claude-opus-5-5", thinking: "high" }],
      codeReviewers: [
        { model: "claude/claude-opus-5-5", thinking: "high" },
        { model: "codex/gpt-6-astra", thinking: "high" },
      ],
      complexMode: "simple",
    },
    requireReview: true,
    stateRoot,
  });

  // 1. Developer edits app.mjs directly in workspace (no commit, no .worktrees!)
  writeFileSync(
    path.join(repoDir, "app.mjs"),
    "export const v = 2;\nexport const stats = () => ({ total: 2 });\n",
  );
  const fp1 = computeWorkspaceFingerprint(repoDir);

  // 2. Developer runs full CI check via runCheck -> binds fp1 in ci-1.log.json
  const ciRes = runCheck(process.execPath, ["-e", "process.exit(0)"], {
    log: path.join(created.taskDir, "ci-1.log"),
    cwd: repoDir,
  });
  assert.equal(ciRes.status, "PASS");

  // 3. Coordinator records delivery (fingerprint computed automatically)
  const delivered = recordCandidateDelivery(created.recordPath, {
    ciLog: "ci-1.log",
    summary: "Implemented stats() in app.mjs",
    architectureImpact: "None",
  });
  assert.equal(delivered.candidate, fp1);

  // 4. Both Code Reviewers inspect workspace & APPROVE
  registerTaskAgent(created.recordPath, {
    role: "code-reviewer",
    slotIndex: 0,
    agentId: "rev-1",
    profile: "claude/claude-opus-5-5",
    briefSummary: "Spec review",
  });
  registerTaskAgent(created.recordPath, {
    role: "code-reviewer",
    slotIndex: 1,
    agentId: "rev-2",
    profile: "codex/gpt-6-astra",
    briefSummary: "Architecture review",
  });

  recordReviewVerdict(created.recordPath, {
    stage: "code",
    agentId: "rev-1",
    round: 1,
    verdict: "APPROVE",
    summary: "Spec satisfied",
  });
  recordReviewVerdict(created.recordPath, {
    stage: "code",
    agentId: "rev-2",
    round: 1,
    verdict: "APPROVE",
    summary: "Minimal & idiomatic",
  });

  // 5. Quality Gate is READY!
  const gateReady = inspectQualityGate({
    recordPath: created.recordPath,
    cwd: repoDir,
  });
  assert.equal(gateReady.status, "READY");
  assert.deepEqual(gateReady.checks, {
    deliveryRecorded: true,
    ciPassed: true,
    planReviewSatisfied: true,
    codeReviewSatisfied: true,
    notCircuitBroken: true,
  });

  // 6. Post-CI sneaky edit invalidates BOTH ciPassed and codeReviewSatisfied!
  writeFileSync(path.join(repoDir, "app.mjs"), "export const v = 999;\n");
  const gateStale = inspectQualityGate({
    recordPath: created.recordPath,
    cwd: repoDir,
  });
  assert.equal(gateStale.status, "BLOCKED");
  assert.equal(gateStale.checks.ciPassed, false);
  assert.equal(gateStale.checks.codeReviewSatisfied, false);

  // Restore approved code -> READY again -> markTaskCompleted
  writeFileSync(
    path.join(repoDir, "app.mjs"),
    "export const v = 2;\nexport const stats = () => ({ total: 2 });\n",
  );
  const gateRestored = inspectQualityGate({
    recordPath: created.recordPath,
    cwd: repoDir,
  });
  assert.equal(gateRestored.status, "READY");
  const completed = markTaskCompleted(
    created.recordPath,
    gateRestored.fingerprint,
  );
  assert.equal(completed.lifecycleStatus, "completed");

  // Once completed/signed-off, future workspace edits do not corrupt archived task gate
  writeFileSync(path.join(repoDir, "app.mjs"), "export const v = 3;\n");
  const gateArchived = inspectQualityGate({
    recordPath: created.recordPath,
    cwd: repoDir,
  });
  assert.equal(gateArchived.status, "READY");
});

test("supports multiple parallel developers registered by coordinator and invalidates gate on unreviewed edits", (t) => {
  const { repoDir, stateRoot } = setupWorkspace(t);
  const created = initTask({
    cwd: repoDir,
    goal: "Parallel backend and frontend changes",
    teamName: "Standard",
    preset: {
      developer: { model: "auto" },
      planReviewers: [{ model: "auto" }],
      codeReviewers: [{ model: "auto" }],
      complexMode: "simple",
    },
    requireReview: true,
    stateRoot,
  });

  registerTaskAgent(created.recordPath, {
    role: "developer",
    agentId: "dev-1",
    profile: "codex/gpt-6.1-sol",
    briefSummary: "Backend slice",
  });
  const withTwoDevs = registerTaskAgent(created.recordPath, {
    role: "developer",
    agentId: "dev-2",
    profile: "codex/gpt-6.1-sol",
    briefSummary: "Frontend slice",
  });
  const devs = withTwoDevs.nodes.filter((n) => n.role === "developer");
  assert.deepEqual(
    devs.map((n) => [n.nodeId, n.label]),
    [
      ["developer", "Developer #1"],
      ["developer-1", "Developer #2"],
    ],
  );

  writeFileSync(path.join(repoDir, "app.mjs"), "export const v = 3;\n");
  runCheck(process.execPath, ["-e", "process.exit(0)"], {
    log: path.join(created.taskDir, "ci-1.log"),
    cwd: repoDir,
  });
  recordCandidateDelivery(created.recordPath, {
    ciLog: "ci-1.log",
    summary: "Completed both slices",
    architectureImpact: "None",
  });

  registerTaskAgent(created.recordPath, {
    role: "code-reviewer",
    slotIndex: 0,
    agentId: "rev-1",
    profile: "auto",
    briefSummary: "Cross review",
  });
  recordReviewVerdict(created.recordPath, {
    stage: "code",
    agentId: "rev-1",
    round: 1,
    verdict: "APPROVE",
    summary: "Approved",
  });

  // Reviewer runs temporary repro file then cleans it up -> gate stays READY!
  const tmpRepro = path.join(repoDir, ".tmp-repro.mjs");
  writeFileSync(tmpRepro, "console.log('ok');\n");
  rmSync(tmpRepro);
  assert.equal(
    inspectQualityGate({ recordPath: created.recordPath, cwd: repoDir }).status,
    "READY",
  );

  // Leftover unreviewed file changes workspace fingerprint -> gate drops to BLOCKED!
  writeFileSync(path.join(repoDir, "rogue.txt"), "rogue\n");
  const blocked = inspectQualityGate({
    recordPath: created.recordPath,
    cwd: repoDir,
  });
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.checks.ciPassed, false);
  assert.equal(blocked.checks.codeReviewSatisfied, false);
});

test("ignores accidental git commit SHA in targetVersionOrCommit for code reviews, auto-detects CI log, and normalizes subdirectory cwd", (t) => {
  const { repoDir, stateRoot } = setupWorkspace(t);
  const subDir = path.join(repoDir, "packages", "core");
  spawnSync("mkdir", ["-p", subDir]);
  writeFileSync(path.join(subDir, "mod.mjs"), "export const ok = true;\n");

  const created = initTask({
    cwd: repoDir,
    goal: "Fix core module and verify from subdir",
    teamName: "Standard",
    preset: {
      developer: { model: "auto" },
      planReviewers: [{ model: "auto" }],
      codeReviewers: [{ model: "auto" }],
      complexMode: "simple",
    },
    requireReview: true,
    stateRoot,
  });

  // Running check from a subdirectory produces the exact same workspace fingerprint as repo root
  assert.equal(
    computeWorkspaceFingerprint(subDir),
    computeWorkspaceFingerprint(repoDir),
  );
  const ciRes = runCheck(process.execPath, ["-e", "process.exit(0)"], {
    log: path.join(created.taskDir, "ci-1.log"),
    cwd: subDir,
  });
  assert.equal(ciRes.status, "PASS");

  // Omitting ciLog in recordCandidateDelivery auto-binds the passing ci-1.log sidecar!
  const delivered = recordCandidateDelivery(created.recordPath, {
    summary: "Added core/mod.mjs",
    architectureImpact: "None",
  });
  assert.equal(delivered.ci?.log, "ci-1.log");

  registerTaskAgent(created.recordPath, {
    role: "code-reviewer",
    slotIndex: 0,
    agentId: "rev-sha",
    profile: "claude/claude-opus-5-5",
    briefSummary: "Spec review",
  });

  // Even if Coordinator passes a short Git SHA in targetVersionOrCommit, code stage binds workspace fingerprint!
  recordReviewVerdict(created.recordPath, {
    stage: "code",
    agentId: "rev-sha",
    targetVersionOrCommit: "deadbeef1234",
    round: 1,
    verdict: "APPROVE",
    summary: "Approved",
  });

  const gate = inspectQualityGate({
    recordPath: created.recordPath,
    cwd: repoDir,
  });
  assert.equal(gate.status, "READY");
  assert.equal(gate.checks.ciPassed, true);
  assert.equal(gate.checks.codeReviewSatisfied, true);
});
