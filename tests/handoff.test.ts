import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reviewInputProblem } from "../server/handlers.ts";
import { inspectQualityGate } from "../server/quality-gate.ts";
import {
  checkTurnHandoff,
  initTask,
  listTasksByLauncher,
  markTurnStarted,
  nextReviewRound,
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

  markTurnStarted(recordPath, "rev-1");
  assert.equal(checkTurnHandoff(recordPath, "rev-1"), "remind");
  const gate = inspectQualityGate({ recordPath });
  assert.ok(
    gate.missing.some(
      (m) => m.includes("rev-1") && m.includes("submit_review"),
    ),
    gate.missing.join("\n"),
  );

  markTurnStarted(recordPath, "rev-1");
  assert.equal(checkTurnHandoff(recordPath, "rev-1"), "missing");

  markTurnStarted(recordPath, "rev-1");
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
