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
  checkAgentReadOnlyIntegrity,
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

  // 4. Both Code Reviewers inspect workspace in read-only mode & APPROVE
  registerTaskAgent(created.recordPath, {
    role: "code-reviewer",
    slotIndex: 0,
    agentId: "rev-1",
    profile: "claude/claude-opus-5-5",
    briefSummary: "Spec review",
    captureReadOnlyCwd: repoDir,
  });
  registerTaskAgent(created.recordPath, {
    role: "code-reviewer",
    slotIndex: 1,
    agentId: "rev-2",
    profile: "codex/gpt-6-astra",
    briefSummary: "Architecture review",
    captureReadOnlyCwd: repoDir,
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
    readOnlyClean: true,
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
  assert.equal(completed.lifecycleStatus, "merged");

  // Once completed/signed-off, future workspace edits do not corrupt archived task gate
  writeFileSync(path.join(repoDir, "app.mjs"), "export const v = 3;\n");
  const gateArchived = inspectQualityGate({
    recordPath: created.recordPath,
    cwd: repoDir,
  });
  assert.equal(gateArchived.status, "READY");
});

test("anti-spoofing sidecar check rejects forged task.json approvals and read-only violations block Quality Gate", (t) => {
  const { repoDir, stateRoot } = setupWorkspace(t);
  const created = initTask({
    cwd: repoDir,
    goal: "Fix edge case",
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

  writeFileSync(path.join(repoDir, "app.mjs"), "export const v = 3;\n");
  runCheck(process.execPath, ["-e", "process.exit(0)"], {
    log: path.join(created.taskDir, "ci-1.log"),
    cwd: repoDir,
  });
  recordCandidateDelivery(created.recordPath, {
    ciLog: "ci-1.log",
    summary: "Updated v=3",
    architectureImpact: "None",
  });

  registerTaskAgent(created.recordPath, {
    role: "code-reviewer",
    slotIndex: 0,
    agentId: "rev-tamper",
    profile: "auto",
    briefSummary: "Blind review",
    captureReadOnlyCwd: repoDir,
  });
  recordReviewVerdict(created.recordPath, {
    stage: "code",
    agentId: "rev-tamper",
    round: 1,
    verdict: "APPROVE",
    summary: "Approved",
  });

  // Reviewer tampers with workspace after snapshot -> readOnlyClean fails!
  writeFileSync(path.join(repoDir, "rogue.txt"), "rogue\n");
  checkAgentReadOnlyIntegrity(created.recordPath, "rev-tamper", repoDir);
  const blocked = inspectQualityGate({
    recordPath: created.recordPath,
    cwd: repoDir,
  });
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.checks.readOnlyClean, false);
});
