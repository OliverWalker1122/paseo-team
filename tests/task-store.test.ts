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

test("migrates legacy v3/v4 configs to schemaVersion 5 direct model specs", (t) => {
  const { repoDir, configPath } = tempGitRepo(t);
  const v3 = {
    schemaVersion: 3,
    teams: {
      Standard: {
        developer: "codex/gpt-6.1-sol",
        planReviewers: ["claude/claude-opus-5-5", "codex/gpt-6-astra"],
        codeReviewers: ["claude/claude-opus-5-5", "codex/gpt-6-astra"],
        expert: "claude/claude-opus-5-5",
        complexMode: "expert",
        reader: "legacy-ignored",
      },
      LegacyDeep: {
        developer: "Developer",
        planReviewers: ["QA"],
        codeReviewers: ["QA"],
        complexMode: "deep",
      },
    },
    default: "Standard",
    projects: { [repoDir]: "LegacyDeep" },
  };

  const migrated = migrateConfig(v3);
  assert.equal(migrated.schemaVersion, 5);
  assert.deepEqual(migrated.teams["Standard"].developer, {
    model: "codex/gpt-6.1-sol",
  });
  assert.deepEqual(migrated.teams["Standard"].codeReviewers, [
    { model: "claude/claude-opus-5-5" },
    { model: "codex/gpt-6-astra" },
  ]);
  // Old Paseo agent-profile names carry no model, so they fall back to Auto.
  assert.deepEqual(migrated.teams["LegacyDeep"].developer, { model: "auto" });
  assert.equal(migrated.teams["Standard"].separatePlanReviewers, false);
  assert.equal(migrated.teams["LegacyDeep"].complexMode, "simple");

  saveConfig(migrated, configPath);
  const loaded = loadConfig(configPath);
  assert.equal(loaded.exists, true);
  const eff = resolveEffectiveTeam(loaded.config, repoDir);
  assert.equal(eff.teamName, "LegacyDeep");
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
  // Soft breaker: the over-limit verdict is still recorded.
  assert.equal(r3Blocked.record.planReviewers[0].round, 3);

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
  assert.equal(snapEn.stages.at(-1)?.title, "Quality Gate");
  // Multi-round plan review dynamically expands into separate workflow step rows per round
  assert.deepEqual(
    snapEn.stages
      .filter((st) => st.stageId === "plan-review")
      .map((st) => [st.stepId, st.title]),
    [
      ["plan-review", "Plan Review · Round 1"],
      ["plan-review-r2", "Plan Review · Round 2"],
      ["plan-review-r3", "Plan Review · Round 3"],
    ],
  );

  const snapZh = toPipelineSnapshot(
    task1.recordPath,
    r3Allowed.record,
    liveMap,
    "zh",
  );
  assert.equal(snapZh.stages[0].title, "主控协调");
  assert.equal(snapZh.stages.at(-1)?.title, "验收门禁");

  assert.equal(snapEn.runningCount, 1);

  // Every review round stays visible on its corresponding round workflow node; blocked bypass left no record.
  const planRevNodesAcrossRounds = snapEn.stages
    .flatMap((st) => st.nodes)
    .filter((n) => n.agentId === "plan-rev-0");
  assert.deepEqual(
    planRevNodesAcrossRounds.map((n) => [n.round, n.verdict]),
    [
      [1, "REQUEST_CHANGES"],
      [2, "REQUEST_CHANGES"],
      [3, "APPROVE"],
    ],
  );
  assert.equal(planRevNodesAcrossRounds[0].rounds?.[0].findings?.length, 2);

  const brief = buildRecoveryBrief(r3Allowed.record);
  assert.match(brief, /Refactor cross-module settlement state machine/);
  assert.match(brief, /plan-rev-0/);
});

test("code review is the coordinator's call, not forced by architecture wording", (t) => {
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
  assert.equal(delivered.codeReview, "not-required");
  assert.equal(delivered.candidate, "delivery-r1");

  const requested = recordCandidateDelivery(taskB.recordPath, {
    summary: "Added reconciliation state table",
    architectureImpact: "Added persistent reconciliation table",
    requireCodeReview: true,
  });
  assert.equal(requested.codeReview, "required");
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
      team: "Standard",
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

test("dynamically appends Developer Round 2 and Code Review Round 2 workflow steps when changes are requested", (t) => {
  const { repoDir, stateRoot } = tempGitRepo(t);
  const created = initTask({
    cwd: repoDir,
    goal: "修复并补充边界回归测试",
    teamName: "Standard",
    preset: {
      developer: { model: "codex/gpt-6.1-sol" },
      planReviewers: [{ model: "claude/claude-opus-5-5" }],
      codeReviewers: [
        { model: "claude/claude-opus-5-5" },
        { model: "codex/gpt-6-astra" },
      ],
      complexMode: "simple",
    },
    requireReview: true,
    coordinatorAgentId: "coord-main",
    stateRoot,
  });

  registerTaskAgent(created.recordPath, {
    role: "developer",
    agentId: "dev-1",
    profile: "codex/gpt-6.1-sol",
    briefSummary: "实现修复",
  });
  registerTaskAgent(created.recordPath, {
    role: "code-reviewer",
    slotIndex: 0,
    agentId: "rev-1",
    profile: "claude/claude-opus-5-5",
    briefSummary: "规格审查",
  });
  registerTaskAgent(created.recordPath, {
    role: "code-reviewer",
    slotIndex: 1,
    agentId: "rev-2",
    profile: "codex/gpt-6-astra",
    briefSummary: "架构审查",
  });

  // Round 1 delivery + Round 1 code review (rev-1 APPROVE, rev-2 REQUEST_CHANGES)
  writeFileSync(path.join(repoDir, "index.js"), "export default 10;\n");
  recordCandidateDelivery(created.recordPath, {
    agentId: "dev-1",
    summary: "首轮修复实现",
    architectureImpact: "无",
  });
  recordReviewVerdict(created.recordPath, {
    stage: "code",
    agentId: "rev-1",
    round: 1,
    verdict: "APPROVE",
    summary: "主路径符合预期",
  });
  recordReviewVerdict(created.recordPath, {
    stage: "code",
    agentId: "rev-2",
    round: 1,
    verdict: "REQUEST_CHANGES",
    summary: "缺少空输入回归断言",
    findings: ["blocking: index.js 空输入分支缺少回归测试"],
  });

  // While dev-1 is actively running Round 2 revision, Development Round 2 step grows immediately!
  const liveDuringDevR2 = new Map([
    [
      "dev-1",
      {
        status: "running" as const,
        awaitingPermission: false,
        provider: "codex",
        model: "gpt-6.1-sol",
      },
    ],
  ]);
  const snapMidRevision = toPipelineSnapshot(
    created.recordPath,
    loadTask(created.recordPath),
    liveDuringDevR2,
    "zh",
  );
  assert.deepEqual(
    snapMidRevision.stages.map((s) => [s.stepId, s.title]),
    [
      ["coordinator", "主控协调"],
      ["development", "开发实现 · 第 1 轮"],
      ["code-review", "代码审查 · 第 1 轮"],
      ["development-r2", "开发修订 · 第 2 轮"],
      ["merge-gate", "验收门禁"],
    ],
  );
  assert.equal(snapMidRevision.stages[1].nodes[0].visualStatus, "completed");
  assert.equal(snapMidRevision.stages[3].nodes[0].visualStatus, "running");

  // Developer delivers Round 2, and rev-2 approves Round 2 -> Code Review Round 2 step grows below!
  writeFileSync(path.join(repoDir, "index.js"), "export default 11;\n");
  recordCandidateDelivery(created.recordPath, {
    agentId: "dev-1",
    summary: "补充空输入回归测试",
    architectureImpact: "无",
  });
  const afterR2 = recordReviewVerdict(created.recordPath, {
    stage: "code",
    agentId: "rev-2",
    round: 2,
    verdict: "APPROVE",
    summary: "空输入回归测试已覆盖，通过",
  });

  const snapFinal = toPipelineSnapshot(
    created.recordPath,
    afterR2.record,
    new Map(),
    "zh",
  );
  const parsed = PipelineTaskSnapshotSchema.parse(snapFinal);
  assert.deepEqual(
    parsed.stages.map((s) => [s.stepId, s.title, s.nodes.map((n) => n.label)]),
    [
      ["coordinator", "主控协调", ["主控 Coordinator"]],
      ["development", "开发实现 · 第 1 轮", ["Developer · 第 1 轮"]],
      [
        "code-review",
        "代码审查 · 第 1 轮",
        ["代码审查 #1 · 第 1 轮", "代码审查 #2 · 第 1 轮"],
      ],
      ["development-r2", "开发修订 · 第 2 轮", ["Developer · 第 2 轮修订"]],
      ["code-review-r2", "代码审查 · 第 2 轮", ["代码审查 #2 · 第 2 轮"]],
      ["merge-gate", "验收门禁", ["验收门禁"]],
    ],
  );
  assert.equal(parsed.stages[1].nodes[0].summary, "首轮修复实现");
  assert.equal(parsed.stages[3].nodes[0].summary, "补充空输入回归测试");
  assert.equal(parsed.stages[2].nodes[1].verdict, "REQUEST_CHANGES");
  assert.equal(parsed.stages[4].nodes[0].verdict, "APPROVE");
});
