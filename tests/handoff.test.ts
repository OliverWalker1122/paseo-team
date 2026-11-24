import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildConversationGraph,
  memberOwnsHandoff,
  parseInlineTaskDirectives,
  reviewInputProblem,
} from "../server/handlers.ts";
import { inspectQualityGate } from "../server/quality-gate.ts";
import {
  checkTurnHandoff,
  initTask,
  loadTask,
  listTasksByLauncher,
  nextReviewRound,
  readReviewRounds,
  recordCandidateDelivery,
  recordPlanSubmission,
  recordReviewVerdict,
  registerTaskAgent,
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

test("turn without submit reminds once, then blocks the node; gate names the agent", (t) => {
  const { make } = setup(t);
  const { recordPath } = make("Check handoff");
  registerTaskAgent(recordPath, {
    role: "code-reviewer",
    agentId: "rev-1",
    profile: "auto",
    briefSummary: "Review",
  });
  assert.equal(checkTurnHandoff(recordPath, "rev-1"), "remind");
  const gate = inspectQualityGate({ recordPath });
  assert.ok(
    gate.missing.some(
      (m) => m.includes("rev-1") && m.includes("submit_review"),
    ),
    gate.missing.join("\n"),
  );
  assert.equal(checkTurnHandoff(recordPath, "rev-1"), "missing");
  recordReviewVerdict(recordPath, {
    stage: "code",
    agentId: "rev-1",
    round: 1,
    verdict: "APPROVE",
    summary: "ok",
  });
  assert.equal(checkTurnHandoff(recordPath, "rev-1"), "ok");
  // Unknown agents (e.g. the coordinator) are never nagged.
  assert.equal(checkTurnHandoff(recordPath, "someone-else"), "ok");
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

test("a launcher chat that also coordinated an old task shows both as subtrees", async (t) => {
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
  const base = { cwd, teamName: "Standard", preset };
  initTask({ ...base, goal: "Old task", coordinatorAgentId: "chat-1" });
  initTask({ ...base, goal: "New task", launcherAgentId: "chat-1" });

  const paseo = { agents: { list: async () => ({ entries: [] }) } };
  const graph = await buildConversationGraph(
    paseo as unknown as Parameters<typeof buildConversationGraph>[0],
    { agentId: "chat-1" },
  );
  assert.equal(graph.mode, "launcher");
  assert.deepEqual(graph.tasks?.map((x) => x.goal).sort(), [
    "New task",
    "Old task",
  ]);
});

test("coordinator may record for a member only after its reminder failed", (t) => {
  const { make } = setup(t);
  const { recordPath } = make("Guard duplicate handoffs");
  registerTaskAgent(recordPath, {
    role: "code-reviewer",
    agentId: "rev-1",
    profile: "auto",
    briefSummary: "Review",
  });

  // Dispatched but unsubmitted reviewer blocks the gate even without "with review".
  assert.equal(
    inspectQualityGate({ recordPath }).checks.codeReviewSatisfied,
    false,
  );
  assert.equal(memberOwnsHandoff(recordPath, "rev-1"), null);
  checkTurnHandoff(recordPath, "rev-1"); // first miss: reminder sent
  assert.match(memberOwnsHandoff(recordPath, "rev-1") ?? "", /reminded/);
  checkTurnHandoff(recordPath, "rev-1"); // second miss: coordinator may act
  assert.equal(memberOwnsHandoff(recordPath, "rev-1"), null);
  recordReviewVerdict(recordPath, {
    stage: "code",
    agentId: "rev-1",
    round: 1,
    verdict: "APPROVE",
    summary: "ok",
    source: "self",
  });
  assert.match(
    memberOwnsHandoff(recordPath, "rev-1") ?? "",
    /already submitted/,
  );
  // A later write must not strip the earlier entry's source.
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

test("follow-up turns after a handoff are not nagged; a rework request is", (t) => {
  const { make } = setup(t);
  const { recordPath } = make("Owed handoffs");
  registerTaskAgent(recordPath, {
    role: "developer",
    agentId: "dev-1",
    profile: "auto",
    briefSummary: "Build",
  });
  recordCandidateDelivery(recordPath, {
    agentId: "dev-1",
    summary: "d1",
    architectureImpact: "None",
    ciWaivedUserQuote: "user said skip CI for this test",
  });
  // Coordinator asks a question afterwards: nothing is owed.
  assert.equal(checkTurnHandoff(recordPath, "dev-1"), "ok");
  recordReviewVerdict(recordPath, {
    stage: "code",
    agentId: "rev-1",
    round: 1,
    verdict: "REQUEST_CHANGES",
    summary: "fix",
    findings: ["blocking: a.ts:1 bug"],
  });
  // Rework requested: a turn without a new delivery is reminded.
  assert.equal(checkTurnHandoff(recordPath, "dev-1"), "remind");
});
