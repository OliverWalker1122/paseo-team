import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isAutoAllowedStartCall,
  isAutoAllowedTeamTool,
  isScopedCoordinatorPermissionResponse,
} from "../index.server.ts";
import {
  buildConversationGraph,
  parseInlineTaskDirectives,
  reviewInputProblem,
  toPipelineSnapshot,
  unsetRoles,
} from "../server/handlers.ts";
import { inspectQualityGate } from "../server/quality-gate.ts";
import {
  findTaskByAgentId,
  initTask,
  loadTask,
  listTasksByLauncher,
  markTaskCompleted,
  nextReviewRound,
  readReviewRounds,
  recordCandidateDelivery,
  recordPlanSubmission,
  recordReviewVerdict,
  registerTaskAgent,
  setTaskRoute,
} from "../server/task-store.ts";

process.env.SKIP_DOTENV = "true";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const preset = {
  developer: { model: "auto" },
  planReviewers: [{ model: "auto" }],
  codeReviewers: [{ model: "auto" }],
  complexMode: "simple" as const,
};

function setup(t: test.TestContext, launcherAgentId?: string) {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "paseo-team-handoff-"));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  const cwd = path.join(baseDir, "workspace");
  mkdirSync(cwd);
  const stateRoot = path.join(baseDir, "state");
  const make = (goal: string, launcher = launcherAgentId) =>
    initTask({
      cwd,
      goal,
      teamName: "Standard",
      preset,
      requireReview: true,
      launcherAgentId: launcher,
      stateRoot,
    });
  return { stateRoot, make };
}

test("review findings must be tagged and match the verdict", () => {
  assert.equal(reviewInputProblem("APPROVE", []), null);
  assert.equal(reviewInputProblem("APPROVE", ["advice: rename x"]), null);
  assert.match(
    reviewInputProblem("APPROVE", ["blocking: a.ts:1 crash"]) ?? "",
    /APPROVE cannot carry blocking/,
  );
  assert.match(
    reviewInputProblem("REQUEST_CHANGES", ["advice: style"]) ?? "",
    /needs at least one "blocking:"/,
  );
  assert.match(
    reviewInputProblem("BLOCKED", ["it is broken"]) ?? "",
    /must start with "blocking:" or "advice:"/,
  );
  assert.equal(
    reviewInputProblem("REQUEST_CHANGES", ["Blocking：a.ts:3 null deref"]),
    null,
  );
});

test("dispatched reviewer without verdict blocks the gate and names the agent", (t) => {
  const { make } = setup(t);
  const { recordPath } = make("Check gate naming");
  registerTaskAgent(recordPath, {
    role: "code-reviewer",
    agentId: "rev-1",
    profile: "auto",
    briefSummary: "Review",
  });
  recordCandidateDelivery(recordPath, {
    summary: "d1",
    architectureImpact: "None",
    ciWaivedUserQuote: "user waived CI for test",
  });
  const gate = inspectQualityGate({ recordPath });
  assert.ok(
    gate.missing.some((m) => m.includes("rev-1")),
    gate.missing.join("\n"),
  );
  recordReviewVerdict(recordPath, {
    stage: "code",
    agentId: "rev-1",
    round: 1,
    verdict: "APPROVE",
    summary: "ok",
  });
  assert.equal(inspectQualityGate({ recordPath }).status, "READY");
});

test("plan submission stays inside the task dir and bumps the plan round", (t) => {
  const { make } = setup(t);
  const { recordPath, taskDir, record } = make("Plan something");
  assert.equal(nextReviewRound(record, "plan"), 1);

  assert.throws(
    () =>
      recordPlanSubmission(recordPath, { planFile: "../x.md", summary: "s" }),
    /directly in the task evidence directory/,
  );
  assert.throws(
    () =>
      recordPlanSubmission(recordPath, { planFile: "plan.md", summary: "s" }),
    /missing or empty/,
  );

  writeFileSync(path.join(taskDir, "plan.md"), "# plan\n");
  recordPlanSubmission(recordPath, { planFile: "plan.md", summary: "v1" });
  const second = recordPlanSubmission(recordPath, {
    planFile: "plan.md",
    summary: "v2",
  });
  assert.equal(second.planVersion, "v2");
  assert.equal(nextReviewRound(second, "plan"), 2);
});

test("lists only the tasks started from one launcher chat", (t) => {
  const { make, stateRoot } = setup(t, "chat-1");
  const a = make("First task");
  const b = make("Second task");
  make("Elsewhere", "chat-2");

  const tasks = listTasksByLauncher("chat-1", stateRoot);
  assert.deepEqual(
    tasks.map((x) => x.record.taskId).sort(),
    [a.record.taskId, b.record.taskId].sort(),
  );
  assert.equal(listTasksByLauncher("nobody", stateRoot).length, 0);
});

test("single coordinated task renders directly while multiple sequential tasks on one chat render as subtrees with active task prioritized", async (t) => {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "paseo-team-graph-"));
  const prevState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = baseDir;
  t.after(() => {
    if (prevState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevState;
    rmSync(baseDir, { recursive: true, force: true });
  });
  const cwd = path.join(baseDir, "workspace");
  mkdirSync(cwd);
  const stateRoot = path.join(baseDir, "paseo-team");
  const base = { cwd, teamName: "Standard", preset, stateRoot };

  const first = initTask({
    ...base,
    goal: "First coordinated task",
    coordinatorAgentId: "chat-1",
  });
  const paseo = {
    agents: {
      list: async () => ({
        entries: [
          {
            agent: {
              id: "chat-1",
              workspaceId: "wks-1",
              status: "idle",
              provider: "claude",
            },
          },
        ],
      }),
    },
  };

  // Single task coordinated by chat-1 renders directly in team_task mode (and resolves by workspaceId alone).
  const singleGraph = await buildConversationGraph(
    paseo as unknown as Parameters<typeof buildConversationGraph>[0],
    { workspaceId: "wks-1" },
  );
  assert.equal(singleGraph.mode, "team_task");
  assert.equal(singleGraph.task?.goal, "First coordinated task");

  markTaskCompleted(first.recordPath);
  const second = initTask({
    ...base,
    goal: "Second active coordinated task",
    coordinatorAgentId: "chat-1",
  });
  // Touch completed task later to prove open tasks still win priority.
  markTaskCompleted(first.recordPath);

  assert.equal(
    findTaskByAgentId("chat-1", stateRoot)?.record.taskId,
    second.record.taskId,
  );

  const multiGraph = await buildConversationGraph(
    paseo as unknown as Parameters<typeof buildConversationGraph>[0],
    { agentId: "chat-1" },
  );
  assert.equal(multiGraph.mode, "launcher");
  assert.deepEqual(
    multiGraph.tasks?.map((x) => x.goal),
    ["Second active coordinated task", "First coordinated task"],
  );

  // Regression: if another chat in the same workspace has an older stale active task
  // whose agent updatedAt happens to be newer, workspace-only lookup still picks the newest active task.
  await new Promise((r) => setTimeout(r, 15));
  initTask({
    ...base,
    goal: "Newest task on chat-2",
    coordinatorAgentId: "chat-2",
  });
  const twoChatPaseo = {
    agents: {
      list: async () => ({
        entries: [
          {
            agent: {
              id: "chat-1",
              workspaceId: "wks-1",
              status: "closed",
              provider: "claude",
              updatedAt: "2099-01-01T00:00:00.000Z",
            },
          },
          {
            agent: {
              id: "chat-2",
              workspaceId: "wks-1",
              status: "idle",
              provider: "codex",
              updatedAt: "2026-11-26T00:00:00.000Z",
            },
          },
        ],
      }),
    },
  };
  const wsLatest = await buildConversationGraph(
    twoChatPaseo as unknown as Parameters<typeof buildConversationGraph>[0],
    { workspaceId: "wks-1" },
  );
  assert.equal(wsLatest.mode, "team_task");
  assert.equal(wsLatest.task?.goal, "Newest task on chat-2");
});

test("recording a second reviewer verdict preserves earlier reviewer source metadata", (t) => {
  const { make } = setup(t);
  const { recordPath } = make("Preserve source");
  registerTaskAgent(recordPath, {
    role: "code-reviewer",
    agentId: "rev-1",
    profile: "auto",
    briefSummary: "Review",
  });

  // Dispatched but unsubmitted reviewer blocks the gate.
  assert.equal(
    inspectQualityGate({ recordPath }).checks.codeReviewSatisfied,
    false,
  );
  recordCandidateDelivery(recordPath, {
    summary: "d1",
    architectureImpact: "None",
    ciWaivedUserQuote: "user waived CI for test",
  });
  recordReviewVerdict(recordPath, {
    stage: "code",
    agentId: "rev-1",
    round: 1,
    verdict: "APPROVE",
    summary: "ok",
    source: "self",
  });
  registerTaskAgent(recordPath, {
    role: "code-reviewer",
    agentId: "rev-2",
    profile: "auto",
    briefSummary: "Review",
  });
  const rec = recordReviewVerdict(recordPath, {
    stage: "code",
    agentId: "rev-2",
    round: 1,
    verdict: "APPROVE",
    summary: "ok",
    source: "self",
  }).record;
  assert.deepEqual(
    rec.codeReviewers.map((r) => r.source),
    ["self", "self"],
  );
});

test("a re-review of the same delivery keeps both verdicts in history", (t) => {
  const { make } = setup(t);
  const { recordPath } = make("Re-review history");
  const base = { stage: "code" as const, agentId: "rev-1", round: 1 };
  recordReviewVerdict(recordPath, {
    ...base,
    verdict: "REQUEST_CHANGES",
    summary: "first",
    findings: ["blocking: a.ts:1 bug"],
  });
  recordReviewVerdict(recordPath, {
    ...base,
    verdict: "APPROVE",
    summary: "second",
  });
  assert.deepEqual(
    readReviewRounds(recordPath, "code", "rev-1").map((r) => r.verdict),
    ["REQUEST_CHANGES", "APPROVE"],
  );
});

test("asking a reviewer to look again at the same delivery opens the next round", (t) => {
  const { make } = setup(t);
  const { recordPath, record } = make("Round counting");
  const deliver = () =>
    recordCandidateDelivery(recordPath, {
      summary: "d",
      architectureImpact: "None",
      ciWaivedUserQuote: "user said skip CI for this test",
    });
  const review = (agentId: string, verdict: "APPROVE" | "REQUEST_CHANGES") => {
    const rec = loadTask(recordPath);
    return recordReviewVerdict(recordPath, {
      stage: "code",
      agentId,
      round: nextReviewRound(rec, "code", agentId),
      verdict,
      summary: "s",
    });
  };
  assert.equal(nextReviewRound(record, "code", "rev-1"), 1);
  deliver();
  assert.equal(review("rev-1", "APPROVE").round, 1);
  assert.equal(review("rev-2", "REQUEST_CHANGES").round, 1);
  // Coordinator rules on the finding and asks rev-2 to re-review: round 2.
  assert.equal(review("rev-2", "APPROVE").round, 2);
  // Still failing after that would hit the limit.
  assert.equal(review("rev-2", "REQUEST_CHANGES").status, "CIRCUIT_BROKEN");
});

test("preset phrases are recognized after Chinese punctuation", () => {
  for (const raw of [
    "加 search 命令；需要审查；用 Deepseek 预设",
    "加 search 命令，用 Deepseek 预设。",
    "add search; use preset Deepseek",
  ]) {
    assert.equal(parseInlineTaskDirectives(raw).teamOverride, "Deepseek", raw);
  }
  assert.equal(
    parseInlineTaskDirectives("加 search 命令").teamOverride,
    undefined,
  );
});

test("review phrases recognize code/plan modifiers and negations", () => {
  for (const raw of [
    "网页端改进；需要代码审查；用 Deepseek 预设",
    "开启代码审查",
    "add toggle with code review",
    "require code review",
  ]) {
    const parsed = parseInlineTaskDirectives(raw);
    assert.equal(parsed.requireReview, true, raw);
    assert.equal(parsed.skipReviewReason, undefined, raw);
  }
  const plan = parseInlineTaskDirectives("需要方案审查");
  assert.equal(plan.requireReview, true);
  assert.equal(plan.requirePlanReview, true);
  const planSynonym = parseInlineTaskDirectives("开始开发，需要方案评审");
  assert.equal(planSynonym.requireReview, true);
  assert.equal(planSynonym.requirePlanReview, true);
  assert.equal(
    parseInlineTaskDirectives("重构跨模块结算状态机").isComplex,
    false,
    "complexity must be judged by coordinator from full context, not blind regex keywords",
  );
  assert.equal(
    parseInlineTaskDirectives("用专家模式重构结算状态机").isComplex,
    true,
  );
  for (const raw of [
    "不需要代码审查",
    "不需要方案评审",
    "不要审查",
    "跳过代码审查",
    "skip code review",
    "without review",
  ]) {
    const parsed = parseInlineTaskDirectives(raw);
    assert.ok(parsed.skipReviewReason, raw);
    assert.equal(parsed.requireReview, undefined, raw);
  }
});

test("route-first workflow starts with coordinator only, expands on setTaskRoute without downgrading user locks, and falls back on direct dispatch", (t) => {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "paseo-team-route-"));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  const cwd = path.join(baseDir, "workspace");
  mkdirSync(cwd);
  const stateRoot = path.join(baseDir, "state");

  // 1. Pending route shows ONLY the Coordinator stage (no premature guessed placeholders).
  const t1 = initTask({
    cwd,
    goal: "开始开发，但是先别部署。",
    teamName: "标准",
    preset,
    routeDecided: false,
    coordinatorAgentId: "coord-r1",
    stateRoot,
  });
  const pendingSnap = toPipelineSnapshot(
    t1.recordPath,
    t1.record,
    new Map(),
    "zh",
  );
  assert.equal(pendingSnap.routeDecided, false);
  assert.equal(pendingSnap.skippedStageCount, 0);
  assert.deepEqual(
    pendingSnap.stages.map((s) => s.stageId),
    ["coordinator"],
  );
  assert.equal(pendingSnap.stages[0].subtitle, "评估需求复杂度与执行路径");

  // 2. Coordinator declares complex route with planReview + codeReview -> expands confirmed pipeline and locks gates.
  const decidedComplex = setTaskRoute(t1.recordPath, {
    isComplex: true,
    planReview: true,
    codeReview: true,
    reason: "涉及跨模块回测状态与资金风险，需先方案评审",
  });
  assert.deepEqual(decidedComplex.preserved, []);
  const complexSnap = toPipelineSnapshot(
    t1.recordPath,
    decidedComplex.record,
    new Map(),
    "zh",
  );
  assert.equal(complexSnap.routeDecided, true);
  assert.equal(
    complexSnap.routeReason,
    "涉及跨模块回测状态与资金风险，需先方案评审",
  );
  assert.deepEqual(
    complexSnap.stages.map((s) => s.stageId),
    ["coordinator", "plan-review", "development", "code-review", "merge-gate"],
  );
  assert.equal(
    inspectQualityGate({ recordPath: t1.recordPath }).checks
      .planReviewSatisfied,
    false,
  );

  // 3. Explicit user planReview requirement cannot be downgraded by setTaskRoute.
  const t2 = initTask({
    cwd,
    goal: "修改接口，需要方案评审",
    teamName: "标准",
    preset,
    requireReview: true,
    requirePlanReview: true,
    routeDecided: false,
    coordinatorAgentId: "coord-r2",
    stateRoot,
  });
  const lockedRes = setTaskRoute(t2.recordPath, {
    isComplex: false,
    planReview: false,
    codeReview: false,
    reason: "看起来改幅较小",
  });
  assert.deepEqual(lockedRes.preserved, [
    "planReview=required",
    "codeReview=required",
  ]);
  assert.equal(lockedRes.record.planReview, "required");
  assert.equal(lockedRes.record.codeReview, "required");

  // 4. Simple route (planReview=false, codeReview=false) cleanly hides both review stages.
  const t3 = initTask({
    cwd,
    goal: "改一个按钮文案",
    teamName: "标准",
    preset,
    routeDecided: false,
    coordinatorAgentId: "coord-r3",
    stateRoot,
  });
  const simpleRes = setTaskRoute(t3.recordPath, {
    isComplex: false,
    planReview: false,
    codeReview: false,
    reason: "单文件文案微调，低风险",
  });
  const simpleSnap = toPipelineSnapshot(
    t3.recordPath,
    simpleRes.record,
    new Map(),
    "zh",
  );
  assert.deepEqual(
    simpleSnap.stages.map((s) => s.stageId),
    ["coordinator", "development", "merge-gate"],
  );

  // 5. Fallback: if a coordinator dispatches Developer directly without calling setTaskRoute, graph still expands cleanly.
  const t4 = initTask({
    cwd,
    goal: "直接派发兜底验证",
    teamName: "标准",
    preset,
    routeDecided: false,
    coordinatorAgentId: "coord-r4",
    stateRoot,
  });
  const afterDev = registerTaskAgent(t4.recordPath, {
    role: "developer",
    agentId: "dev-fallback",
    profile: "auto",
    briefSummary: "Direct dispatch",
  });
  assert.equal(afterDev.routeDecided, true);
  const fallbackSnap = toPipelineSnapshot(
    t4.recordPath,
    afterDev,
    new Map(),
    "zh",
  );
  assert.deepEqual(
    fallbackSnap.stages.map((s) => s.stageId),
    ["coordinator", "development", "merge-gate"],
  );
});

test("idle unsubmitted members stay pending and round history shows the latest verdict", (t) => {
  const { make } = setup(t);
  const { recordPath } = make("Snapshot honesty");
  registerTaskAgent(recordPath, {
    role: "developer",
    agentId: "dev-1",
    profile: "auto",
    briefSummary: "Build",
  });
  registerTaskAgent(recordPath, {
    role: "code-reviewer",
    agentId: "rev-1",
    profile: "auto",
    briefSummary: "Review",
  });
  const idleMap = new Map([
    [
      "dev-1",
      { status: "idle" as const, awaitingPermission: false, provider: "codex" },
    ],
    [
      "rev-1",
      { status: "idle" as const, awaitingPermission: false, provider: "codex" },
    ],
  ]);
  const pendingSnap = toPipelineSnapshot(
    recordPath,
    loadTask(recordPath),
    idleMap,
    "zh",
  );
  const devNode = pendingSnap.stages
    .flatMap((s) => s.nodes)
    .find((n) => n.agentId === "dev-1");
  const revNode = pendingSnap.stages
    .flatMap((s) => s.nodes)
    .find((n) => n.agentId === "rev-1");
  assert.equal(devNode?.visualStatus, "pending");
  assert.equal(revNode?.visualStatus, "pending");

  // Two verdicts in the same round: snapshot reflects the latest and keeps both.
  recordCandidateDelivery(recordPath, {
    agentId: "dev-1",
    summary: "d1",
    architectureImpact: "None",
    ciWaivedUserQuote: "user waived CI",
  });
  recordReviewVerdict(recordPath, {
    stage: "code",
    agentId: "rev-1",
    round: 1,
    verdict: "REQUEST_CHANGES",
    summary: "first",
    findings: ["blocking: a.ts:1 bug"],
  });
  recordReviewVerdict(recordPath, {
    stage: "code",
    agentId: "rev-1",
    round: 1,
    verdict: "APPROVE",
    summary: "second",
  });
  recordReviewVerdict(recordPath, {
    stage: "code",
    agentId: "rev-1",
    round: 3,
    verdict: "APPROVE",
    summary: "extra",
    userAuthorizedExtraRound: "user approved extra round",
  });
  const finalSnap = toPipelineSnapshot(
    recordPath,
    loadTask(recordPath),
    idleMap,
    "zh",
  );
  const r1Stage = finalSnap.stages.find((s) => s.stepId === "code-review");
  assert.equal(r1Stage?.nodes[0].verdict, "APPROVE");
  assert.equal(r1Stage?.nodes[0].rounds?.length, 2);
  const r3Stage = finalSnap.stages.find((s) => s.stepId === "code-review-r3");
  assert.equal(r3Stage?.subtitle, "第 3/3 轮");
});

test("waived code review skips reviewer nodes immediately from task creation", (t) => {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "paseo-team-waived-"));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  const cwd = path.join(baseDir, "workspace");
  mkdirSync(cwd);
  const stateRoot = path.join(baseDir, "state");
  const { recordPath, record } = initTask({
    cwd,
    goal: "Quick tweak; skip code review",
    teamName: "Standard",
    preset,
    skipReviewReason: "Quick tweak; skip code review",
    stateRoot,
  });
  const codeNodes = record.nodes.filter((n) => n.role === "code-reviewer");
  assert.ok(codeNodes.length > 0);
  assert.ok(codeNodes.every((n) => n.status === "skipped"));
  const snap = toPipelineSnapshot(recordPath, record, new Map(), "en");
  assert.equal(
    snap.stages.some((s) => s.stageId === "code-review"),
    false,
  );
  assert.equal(snap.skippedStageCount, 2);
});

test("mid-round-2 review keeps gate blocked for unresolved reviewer and avoids phantom round 3", (t) => {
  const { make } = setup(t);
  const { recordPath } = make("Mid-round-2 live snapshot");
  registerTaskAgent(recordPath, {
    role: "developer",
    agentId: "dev-1",
    profile: "auto",
    briefSummary: "Build",
  });
  registerTaskAgent(recordPath, {
    role: "code-reviewer",
    slotIndex: 0,
    agentId: "rev-1",
    profile: "auto",
    briefSummary: "Review 1",
  });
  registerTaskAgent(recordPath, {
    role: "code-reviewer",
    slotIndex: 1,
    agentId: "rev-2",
    profile: "auto",
    briefSummary: "Review 2",
  });

  recordCandidateDelivery(recordPath, {
    agentId: "dev-1",
    summary: "d1",
    architectureImpact: "None",
    ciWaivedUserQuote: "user waived CI",
  });
  recordReviewVerdict(recordPath, {
    stage: "code",
    agentId: "rev-1",
    round: 1,
    verdict: "REQUEST_CHANGES",
    summary: "fix 1",
    findings: ["blocking: a.ts:1 bug"],
  });
  recordReviewVerdict(recordPath, {
    stage: "code",
    agentId: "rev-2",
    round: 1,
    verdict: "REQUEST_CHANGES",
    summary: "fix 2",
    findings: ["blocking: a.ts:2 bug"],
  });

  // Round 2 delivered: gate stays blocked before any round-2 review arrives.
  recordCandidateDelivery(recordPath, {
    agentId: "dev-1",
    summary: "d2",
    architectureImpact: "None",
    ciWaivedUserQuote: "user waived CI",
  });
  assert.equal(inspectQualityGate({ recordPath }).status, "BLOCKED");

  // rev-1 finishes round 2 first while rev-2 is still running round 2.
  recordReviewVerdict(recordPath, {
    stage: "code",
    agentId: "rev-1",
    round: 2,
    verdict: "APPROVE",
    summary: "r2 ok",
  });

  const gateMidR2 = inspectQualityGate({ recordPath });
  assert.equal(gateMidR2.status, "BLOCKED");
  assert.equal(gateMidR2.checks.codeReviewSatisfied, false);
  assert.ok(
    gateMidR2.missing.some((m) => m.includes("rev-2")),
    gateMidR2.missing.join("\n"),
  );

  const liveMidR2 = new Map([
    [
      "rev-1",
      {
        status: "running" as const,
        awaitingPermission: false,
        provider: "codex",
      },
    ],
    [
      "rev-2",
      { status: "running" as const, awaitingPermission: false, provider: "pi" },
    ],
  ]);
  const snapMidR2 = toPipelineSnapshot(
    recordPath,
    loadTask(recordPath),
    liveMidR2,
    "zh",
  );
  assert.equal(snapMidR2.gateReady, false);
  // No phantom development-r3 or code-review-r3!
  assert.deepEqual(
    snapMidR2.stages.map((s) => s.stepId),
    [
      "coordinator",
      "development",
      "code-review",
      "development-r2",
      "code-review-r2",
      "merge-gate",
    ],
  );
  const r2Stage = snapMidR2.stages.find((s) => s.stepId === "code-review-r2");
  assert.deepEqual(
    r2Stage?.nodes.map((n) => [n.agentId, n.visualStatus]),
    [
      ["rev-1", "approved"],
      ["rev-2", "running"],
    ],
  );

  // Once rev-2 also approves round 2, the gate passes.
  recordReviewVerdict(recordPath, {
    stage: "code",
    agentId: "rev-2",
    round: 2,
    verdict: "APPROVE",
    summary: "r2 ok",
  });
  assert.equal(inspectQualityGate({ recordPath }).status, "READY");
});

test("roles without a model block the task instead of guessing one", () => {
  const preset = {
    developer: { model: "auto" },
    codeReviewers: [{ model: "codex/gpt-6-astra" }, { model: "auto" }],
    separatePlanReviewers: false,
    planReviewers: [{ model: "codex/gpt-6-astra" }],
    complexMode: "simple" as const,
  };
  assert.deepEqual(unsetRoles(preset), ["Developer", "Code Reviewer #2"]);
  assert.deepEqual(
    unsetRoles({
      ...preset,
      developer: { model: "codex/gpt-6.1-sol" },
      codeReviewers: [{ model: "codex/gpt-6-astra" }],
      complexMode: "expert",
    }),
    ["Expert"],
  );
});

test("permission hook auto-allows coordinator read-only checks and scoped child permission responses across providers", () => {
  // Provider-specific tool name prefixes (Antigravity mcp_paseo_*, Claude mcp__paseo__*, direct).
  assert.equal(
    isAutoAllowedTeamTool("coordinator", "mcp_paseo_list_pending_permissions"),
    true,
  );
  assert.equal(
    isAutoAllowedTeamTool(
      "coordinator",
      "mcp__paseo__list_pending_permissions",
    ),
    true,
  );
  assert.equal(
    isAutoAllowedTeamTool("coordinator", "mcp_paseo_list_hosts"),
    true,
  );
  assert.equal(
    isAutoAllowedTeamTool("coordinator", "mcp_paseo_list_workspaces"),
    true,
  );
  assert.equal(
    isAutoAllowedTeamTool("coordinator", "paseo.create_agent"),
    true,
  );
  assert.equal(isAutoAllowedTeamTool("coordinator", "paseo_team"), true);
  assert.equal(
    isAutoAllowedTeamTool("coordinator", "mcp_paseo_paseo_team"),
    true,
  );
  assert.equal(
    isAutoAllowedTeamTool("coordinator", "mcp__paseo__paseo_team"),
    true,
  );
  assert.equal(isAutoAllowedTeamTool(undefined, "mcp_paseo_paseo_team"), false);
  assert.equal(
    isAutoAllowedTeamTool("developer", "mcp_paseo_paseo_team"),
    false,
  );
  assert.equal(
    isAutoAllowedTeamTool("code-reviewer", "mcp_paseo_paseo_team"),
    false,
  );
  // Subagents have no custom paseo_team_* tools in single-channel mode.
  assert.equal(
    isAutoAllowedTeamTool("developer", "mcp_paseo_paseo_team_run_check"),
    false,
  );
  assert.equal(
    isAutoAllowedTeamTool("developer", "paseo.paseo_team_submit_delivery"),
    false,
  );
  assert.equal(
    isAutoAllowedTeamTool(
      "code-reviewer",
      "mcp_paseo_paseo_team_submit_review",
    ),
    false,
  );
  assert.equal(
    isAutoAllowedTeamTool("coordinator", "mcp_paseo_paseo_team_set_route"),
    false,
  );
  // Non-coordinators must never be auto-allowed coordinator management tools.
  assert.equal(
    isAutoAllowedTeamTool("developer", "mcp_paseo_list_pending_permissions"),
    false,
  );
  assert.equal(
    isAutoAllowedTeamTool("coordinator", "mcp_paseo_respond_to_permission"),
    false,
  );

  // Direct /paseo-team start fallback (e.g. brand-new draft chat or chat with attachments):
  // auto-allow only `paseo_team(action="start")` on top-level non-subagent chats.
  assert.equal(
    isAutoAllowedStartCall(null, "mcp_paseo_paseo_team", {
      action: "start",
      rawArgs: "implement feature",
    }),
    true,
  );
  assert.equal(
    isAutoAllowedStartCall(undefined, "mcp__paseo__paseo_team", {
      action: "start",
      rawArgs: "implement feature",
    }),
    true,
  );
  assert.equal(
    isAutoAllowedStartCall(null, "mcp_paseo_paseo_team", {
      action: "set_route",
    }),
    false,
  );
  assert.equal(
    isAutoAllowedStartCall("parent-coord-1", "mcp_paseo_paseo_team", {
      action: "start",
      rawArgs: "implement feature",
    }),
    false,
  );
  assert.equal(
    isAutoAllowedStartCall(null, "mcp_paseo_create_agent", {
      action: "start",
    }),
    false,
  );

  const taskRecord = {
    nodes: [
      { role: "coordinator" as const, agentId: "coord-1" },
      { role: "developer" as const, agentId: "dev-1" },
      { role: "code-reviewer" as const, agentId: "rev-1" },
    ],
  };
  const autoAllowed = new Set(["permission:call_child_review"]);

  // Allowed: responding to a child permission that the hook already auto-allowed.
  assert.equal(
    isScopedCoordinatorPermissionResponse({
      role: "coordinator",
      toolName: "mcp_paseo_respond_to_permission",
      requestInput: {
        agentId: "rev-1",
        requestId: "permission:call_child_review",
      },
      taskRecord,
      autoAllowedPermissionIds: autoAllowed,
    }),
    true,
  );
  // Allowed: responding to a registered child node of the same task.
  assert.equal(
    isScopedCoordinatorPermissionResponse({
      role: "coordinator",
      toolName: "paseo.respond_to_permission",
      requestInput: { agentId: "dev-1", requestId: "permission:call_other" },
      taskRecord,
      autoAllowedPermissionIds: autoAllowed,
    }),
    true,
  );
  // Denied: responding to an unrelated session outside this task, or to coordinator itself.
  assert.equal(
    isScopedCoordinatorPermissionResponse({
      role: "coordinator",
      toolName: "mcp_paseo_respond_to_permission",
      requestInput: {
        agentId: "user-private-chat",
        requestId: "permission:call_foreign",
      },
      taskRecord,
      autoAllowedPermissionIds: autoAllowed,
    }),
    false,
  );
  assert.equal(
    isScopedCoordinatorPermissionResponse({
      role: "coordinator",
      toolName: "mcp_paseo_respond_to_permission",
      requestInput: { agentId: "coord-1", requestId: "permission:call_self" },
      taskRecord,
      autoAllowedPermissionIds: autoAllowed,
    }),
    false,
  );
  assert.equal(
    isScopedCoordinatorPermissionResponse({
      role: "developer",
      toolName: "mcp_paseo_respond_to_permission",
      requestInput: {
        agentId: "rev-1",
        requestId: "permission:call_child_review",
      },
      taskRecord,
      autoAllowedPermissionIds: autoAllowed,
    }),
    false,
  );
});

test("toPipelineSnapshot keeps active running Developer/Expert as running even if a delivery exists (regression for bcd00383)", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "paseo-team-live-status-"));
  const stateRoot = path.join(tmp, "state");
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const { recordPath } = initTask({
    cwd: tmp,
    goal: "添加设置按钮与背景透明",
    teamName: "标准",
    preset: {
      developer: { model: "antigravity/gemini-4-neon", thinking: "xhigh" },
      planReviewers: [{ model: "claude/claude-opus-5-5", thinking: "high" }],
      codeReviewers: [{ model: "claude/claude-opus-5-5", thinking: "high" }],
      complexMode: "simple",
    },
    coordinatorAgentId: "coord-live",
    stateRoot,
  });
  setTaskRoute(recordPath, {
    isComplex: false,
    planReview: false,
    codeReview: false,
    reason: "单文件前端改动",
  });
  registerTaskAgent(recordPath, {
    role: "developer",
    agentId: "dev-running-1",
    profile: "antigravity/gemini-4-neon · xhigh",
    provider: "antigravity",
    briefSummary: "设置按钮 + 背景透明",
  });
  // Even if a delivery record already exists on round 1, a live-running Developer on the
  // latest round must render visualStatus="running" (never contradicting liveState="running").
  recordCandidateDelivery(recordPath, {
    agentId: "dev-running-1",
    summary: "Preliminary note",
    architectureImpact: "无",
  });

  const liveMap = new Map<
    string,
    {
      id: string;
      status: "running" | "idle";
      provider: string;
      awaitingPermission: boolean;
    }
  >([
    [
      "coord-live",
      {
        id: "coord-live",
        status: "running",
        provider: "claude",
        awaitingPermission: false,
      },
    ],
    [
      "dev-running-1",
      {
        id: "dev-running-1",
        status: "running",
        provider: "antigravity",
        awaitingPermission: false,
      },
    ],
  ]);
  const runningSnap = toPipelineSnapshot(
    recordPath,
    loadTask(recordPath),
    liveMap,
    "zh",
  );
  const devStage = runningSnap.stages.find((s) => s.stageId === "development");
  assert.ok(devStage);
  const devView = devStage.nodes[0];
  assert.equal(devView.liveState, "running");
  assert.equal(
    devView.visualStatus,
    "running",
    "running Developer must never render visualStatus='completed'",
  );

  // Once Developer finishes (idle), visualStatus cleanly transitions to completed.
  liveMap.set("dev-running-1", {
    id: "dev-running-1",
    status: "idle",
    provider: "antigravity",
    awaitingPermission: false,
  });
  const idleSnap = toPipelineSnapshot(
    recordPath,
    loadTask(recordPath),
    liveMap,
    "zh",
  );
  const idleDev = idleSnap.stages.find((s) => s.stageId === "development")
    ?.nodes[0];
  assert.equal(idleDev?.liveState, "idle");
  assert.equal(idleDev?.visualStatus, "completed");
});
