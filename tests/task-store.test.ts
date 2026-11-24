import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PipelineTaskSnapshotSchema } from "../shared/contracts.ts";
import { detectPromptLanguage } from "../shared/i18n.ts";
import {
  loadConfig,
  migrateConfig,
  resolveEffectiveTeam,
  saveConfig,
} from "../server/config-store.ts";
import { toPipelineSnapshot } from "../server/handlers.ts";
import {
  buildRecoveryBrief,
  checkAgentReadOnlyIntegrity,
  findTaskByAgentId,
  initTask,
  listAllRecentTasks,
  loadTask,
  recordCandidateDelivery,
  recordReviewVerdict,
  registerTaskAgent,
} from "../server/task-store.ts";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.SKIP_DOTENV = "true";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

function tempGitRepo(t: test.TestContext) {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "paseo-team-state-"));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  const repoDir = path.join(baseDir, "repo");
  const stateRoot = path.join(baseDir, "state");
  const configPath = path.join(baseDir, "config.json");

  const git = (...args: string[]) =>
    spawnSync(
      "git",
      ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args],
      { cwd: baseDir, encoding: "utf8" },
    );
  git("init", "-b", "main", repoDir);
  writeFileSync(path.join(repoDir, "index.js"), "export default 1;\n");
  spawnSync("git", ["-C", repoDir, "add", "."]);
  spawnSync(
    "git",
    [
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@example.invalid",
      "-C",
      repoDir,
      "commit",
      "-m",
      "init",
    ],
    { encoding: "utf8" },
  );

  return { baseDir, repoDir, stateRoot, configPath };
}

test("migrates legacy profile-based v3/v4 config to schemaVersion 5 direct models with English default", (t) => {
  const { repoDir, configPath } = tempGitRepo(t);
  const v3 = {
    schemaVersion: 3,
    teams: {
      标准: {
        developer: "Developer",
        planReviewers: ["Architect", "QA"],
        codeReviewers: ["Architect", "QA"],
        expert: "Architect",
        complexMode: "expert",
        reader: "legacy-ignored",
      },
      旧深思: {
        developer: "Developer",
        planReviewers: ["QA"],
        codeReviewers: ["QA"],
        complexMode: "deep",
      },
    },
    default: "标准",
    projects: { [repoDir]: "旧深思" },
  };
  const legacyMap = new Map([
    ["Developer", { model: "codex/gpt-6.1-sol", thinking: "high" }],
    ["Architect", { model: "claude/claude-opus-5-5", thinking: "high" }],
    ["QA", { model: "codex/gpt-6-astra", thinking: "high" }],
  ]);

  const migrated = migrateConfig(v3, legacyMap);
  assert.equal(migrated.schemaVersion, 5);
  assert.deepEqual(migrated.teams["标准"].developer, {
    model: "codex/gpt-6.1-sol",
    thinking: "high",
  });
  assert.deepEqual(migrated.teams["标准"].codeReviewers, [
    { model: "claude/claude-opus-5-5", thinking: "high" },
    { model: "codex/gpt-6-astra", thinking: "high" },
  ]);
  assert.equal(migrated.teams["标准"].separatePlanReviewers, false);
  assert.equal(migrated.teams["旧深思"].complexMode, "simple");

  saveConfig(migrated, configPath);
  const loaded = loadConfig(configPath);
  assert.equal(loaded.exists, true);
  const eff = resolveEffectiveTeam(loaded.config, repoDir);
  assert.equal(eff.teamName, "旧深思");
  assert.equal(eff.source, "project");
});

test("builds left-to-right pipeline stages, bilingual snapshots, and enforces 2-round circuit breaker", (t) => {
  const { repoDir, stateRoot } = tempGitRepo(t);
  const preset = {
    developer: { model: "codex/gpt-6.1-sol", thinking: "high" },
    planReviewers: [
      { model: "claude/claude-opus-5-5", thinking: "high" },
      { model: "codex/gpt-6-astra", thinking: "high" },
    ],
    codeReviewers: [
      { model: "claude/claude-opus-5-5", thinking: "high" },
      { model: "codex/gpt-6-astra", thinking: "high" },
    ],
    expert: { model: "claude/claude-opus-5-5", thinking: "high" },
    complexMode: "expert" as const,
  };

  assert.equal(detectPromptLanguage("Add stats command to CLI", "zh"), "en");
  assert.equal(detectPromptLanguage("重构跨模块结算状态机", "en"), "zh");

  const task1 = initTask({
    cwd: repoDir,
    goal: "Refactor cross-module settlement state machine",
    teamName: "Standard",
    preset,
    isComplex: true,
    coordinatorAgentId: "coord-1",
    stateRoot,
  });

  const planRevNodes = task1.record.nodes.filter(
    (n) => n.role === "plan-reviewer",
  );
  assert.equal(planRevNodes.length, 2);
  assert.equal(planRevNodes[0].perspective, "spec-boundary");
  assert.equal(planRevNodes[1].perspective, "arch-simplicity");

  registerTaskAgent(task1.recordPath, {
    role: "plan-reviewer",
    slotIndex: 0,
    agentId: "plan-rev-0",
    profile: "claude/claude-opus-5-5",
    provider: "claude",
    model: "claude-opus-5-5",
    briefSummary: "Review settlement plan boundaries",
    round: 1,
    captureReadOnlyCwd: repoDir,
  });

  const r1 = recordReviewVerdict(task1.recordPath, {
    stage: "plan",
    agentId: "plan-rev-0",
    targetVersionOrCommit: "v1",
    round: 1,
    verdict: "REQUEST_CHANGES",
    summary: "Missing idempotent replay conflict handling",
    findings: [
      "blocking: replay of the same event id is applied twice",
      "advice: name the queue after its consumer",
    ],
  });
  assert.equal(r1.status, "RECORDED");

  const r2 = recordReviewVerdict(task1.recordPath, {
    stage: "plan",
    agentId: "plan-rev-0",
    targetVersionOrCommit: "v2",
    round: 2,
    verdict: "REQUEST_CHANGES",
    summary: "Lock ordering can still deadlock",
  });
  assert.equal(r2.status, "CIRCUIT_BROKEN");
  assert.ok(r2.record.circuitBroken);

  const r3Blocked = recordReviewVerdict(task1.recordPath, {
    stage: "plan",
    agentId: "plan-rev-0",
    targetVersionOrCommit: "v3",
    round: 3,
    verdict: "APPROVE",
    summary: "Attempt bypass round 3",
  });
  assert.equal(r3Blocked.status, "CIRCUIT_BROKEN");

  const r3Allowed = recordReviewVerdict(task1.recordPath, {
    stage: "plan",
    agentId: "plan-rev-0",
    targetVersionOrCommit: "v3",
    round: 3,
    verdict: "APPROVE",
    summary: "Simplified single-queue design approved",
    userAuthorizedExtraRound: "User: approved extra review round",
  });
  assert.equal(r3Allowed.status, "RECORDED");
  assert.equal(r3Allowed.record.circuitBroken, null);

  const liveMap = new Map([
    [
      "coord-1",
      {
        status: "running" as const,
        awaitingPermission: false,
        provider: "claude",
        model: "claude-opus-5-5",
      },
    ],
    [
      "plan-rev-0",
      {
        status: "idle" as const,
        awaitingPermission: false,
        provider: "claude",
        model: "claude-opus-5-5",
      },
    ],
  ]);

  const snapEn = toPipelineSnapshot(
    task1.recordPath,
    r3Allowed.record,
    liveMap,
    "en",
  );
  assert.equal(snapEn.stages[0].title, "Coordinator");
  assert.equal(snapEn.stages[5].title, "Quality Gate");

  const snapZh = toPipelineSnapshot(
    task1.recordPath,
    r3Allowed.record,
    liveMap,
    "zh",
  );
  assert.equal(snapZh.stages[0].title, "主控协调");
  assert.equal(snapZh.stages[5].title, "验收门禁");

  assert.equal(snapEn.runningCount, 1);

  // Every review round stays visible, oldest first; the blocked bypass attempt left no record.
  const planRev = snapEn.stages
    .flatMap((st) => st.nodes)
    .find((n) => n.agentId === "plan-rev-0");
  assert.deepEqual(
    planRev?.rounds?.map((r) => [r.round, r.verdict]),
    [
      [1, "REQUEST_CHANGES"],
      [2, "REQUEST_CHANGES"],
      [3, "APPROVE"],
    ],
  );
  assert.equal(planRev?.rounds?.[0].findings?.length, 2);

  const brief = buildRecoveryBrief(r3Allowed.record);
  assert.match(brief, /Refactor cross-module settlement state machine/);
  assert.match(brief, /plan-rev-0/);
});

test("auto-triggers code review on architecture impact and detects read-only workspace tampering", (t) => {
  const { repoDir, stateRoot } = tempGitRepo(t);
  const preset = {
    developer: { model: "auto" },
    planReviewers: [{ model: "auto" }],
    codeReviewers: [{ model: "auto" }],
    complexMode: "simple" as const,
  };

  const taskB = initTask({
    cwd: repoDir,
    goal: "Optimize order reconciliation",
    teamName: "Fast",
    preset,
    stateRoot,
  });

  // Developer leaves uncommitted edits directly in the workspace (native Paseo flow!)
  writeFileSync(path.join(repoDir, "index.js"), "export default 2;\n");

  const delivered = recordCandidateDelivery(taskB.recordPath, {
    summary: "Added reconciliation state table",
    architectureImpact: "Added persistent reconciliation table",
  });
  assert.equal(delivered.codeReview, "required");
  assert.equal(delivered.candidate?.length, 40);

  // Reviewer snapshot captures the workspace with Developer's uncommitted edits
  registerTaskAgent(taskB.recordPath, {
    role: "code-reviewer",
    agentId: "rev-ro",
    profile: "codex/gpt-6-astra",
    briefSummary: "Read-only review",
    captureReadOnlyCwd: repoDir,
  });

  // No violation when reviewer leaves Developer's uncommitted edits untouched
  const cleanRo = checkAgentReadOnlyIntegrity(
    taskB.recordPath,
    "rev-ro",
    repoDir,
  );
  assert.equal(cleanRo.violated, false);

  // Violation detected if reviewer modifies or adds files
  writeFileSync(path.join(repoDir, "unwanted.txt"), "oops\n");
  const dirtyRo = checkAgentReadOnlyIntegrity(
    taskB.recordPath,
    "rev-ro",
    repoDir,
  );
  assert.equal(dirtyRo.violated, true);
  assert.equal(dirtyRo.record.readOnlyViolations.length, 1);
});

test("normalizes legacy v1-v5 task.json records without nodes so hooks and UI never crash", (t) => {
  const { repoDir, stateRoot } = tempGitRepo(t);
  const legacyDirA = path.join(stateRoot, "proj-a", "todo-whimsical-legacy");
  const legacyDirB = path.join(stateRoot, "proj-a", "20261123-legacy-v5");
  mkdirSync(legacyDirA, { recursive: true });
  mkdirSync(legacyDirB, { recursive: true });

  writeFileSync(
    path.join(legacyDirA, "task.json"),
    JSON.stringify({
      taskId: "todo-whimsical-legacy",
      cwd: repoDir,
      request: "Legacy task without nodes field",
      phase: "done",
    }),
  );

  writeFileSync(
    path.join(legacyDirB, "task.json"),
    JSON.stringify({
      task_id: "20261123-legacy-v5",
      project: repoDir,
      goal: "Fix settlement sync",
      team: "标准",
      complexMode: "expert",
      status: "deployed",
      candidate: "b".repeat(40),
      agents: [
        { role: "developer", profile: "CodexDev", agentId: "legacy-dev-1" },
        { role: "code-reviewer", profile: "QA", agentId: "legacy-rev-1" },
      ],
      codeReviewers: [
        {
          role: "code-reviewer",
          agentId: "legacy-rev-1",
          status: "APPROVE",
          round: 2,
          commit: "b".repeat(40),
          findings: ["blocking: keyed by local addr only"],
          advice: ["add a two-platform test"],
        },
      ],
      gates: [{ name: "smoke-test", status: "done" }],
    }),
  );

  assert.equal(findTaskByAgentId("non-existent-id", stateRoot), null);
  const matched = findTaskByAgentId("legacy-dev-1", stateRoot);
  assert.equal(matched?.matchedRole, "developer");
  assert.equal(matched?.record.taskId, "20261123-legacy-v5");

  const all = listAllRecentTasks(stateRoot, 20);
  assert.equal(all.length, 2);
  for (const item of all) {
    const loaded = loadTask(item.recordPath);
    assert.ok(Array.isArray(loaded.nodes) && loaded.nodes.length > 0);
    const snap = toPipelineSnapshot(item.recordPath, loaded, new Map(), "en");
    const parsed = PipelineTaskSnapshotSchema.parse(snap);
    assert.ok(parsed.stages.length >= 3);
    assert.ok((parsed.skippedStageCount ?? 0) >= 1);
  }

  // Legacy reviewer entries keep their findings instead of collapsing to "N finding(s)".
  const legacy = loadTask(path.join(legacyDirB, "task.json"));
  const legacySnap = toPipelineSnapshot(
    path.join(legacyDirB, "task.json"),
    legacy,
    new Map(),
    "en",
  );
  const legacyRev = legacySnap.stages
    .flatMap((st) => st.nodes)
    .find((n) => n.agentId === "legacy-rev-1");
  assert.equal(legacyRev?.summary, undefined);
  assert.deepEqual(legacyRev?.rounds?.[0].findings, [
    "blocking: keyed by local addr only",
    "advice: add a two-platform test",
  ]);
  assert.equal(legacyRev?.rounds?.[0].round, 2);
});

test("preserves Paseo-managed worktree directory as workspace root without collapsing to main checkout", (t) => {
  const { baseDir, repoDir, stateRoot } = tempGitRepo(t);
  const paseoWt = path.join(baseDir, "paseo-managed-wt");
  spawnSync(
    "git",
    ["-C", repoDir, "worktree", "add", "-b", "feat/paseo-wt", paseoWt, "HEAD"],
    { encoding: "utf8" },
  );

  const created = initTask({
    cwd: paseoWt,
    goal: "Implement feature inside Paseo-managed worktree",
    teamName: "Standard",
    preset: {
      developer: { model: "codex/gpt-6.1-sol" },
      planReviewers: [{ model: "claude/claude-opus-5-5" }],
      codeReviewers: [{ model: "claude/claude-opus-5-5" }],
      complexMode: "simple",
    },
    requireReview: true,
    stateRoot,
  });

  assert.equal(created.record.projectRoot, paseoWt);
  assert.equal(created.record.planReview, "not-required");
  assert.equal(created.record.codeReview, "required");
});
