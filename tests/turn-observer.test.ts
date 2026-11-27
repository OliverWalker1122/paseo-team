import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectQualityGate } from "../server/quality-gate.ts";
import { initTask, loadTask, registerTaskAgent } from "../server/task-store.ts";
import {
  extractTurnReply,
  observeMemberTurn,
  parseDeveloperReply,
  parseExpertReply,
  parseReviewerReply,
} from "../server/turn-observer.ts";

process.env.SKIP_DOTENV = "true";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const samplePreset = {
  developer: { model: "antigravity/gemini-4-neon", thinking: "xhigh" },
  codeReviewers: [
    { model: "claude/claude-opus-5-5", thinking: "high" },
    { model: "codex/gpt-6.2-astra", thinking: "high" },
  ],
  separatePlanReviewers: false,
  planReviewers: [{ model: "claude/claude-opus-5-5", thinking: "high" }],
  complexMode: "simple" as const,
};

test("extractTurnReply isolates target turn by turnId or last message boundary and captures shell exit status", () => {
  const withTurnIds = [
    {
      turnId: "t1",
      item: { type: "assistant_message", text: "Old turn reply" },
    },
    {
      turnId: "t2",
      item: { type: "assistant_message", text: "Working on tests..." },
    },
    {
      turnId: "t2",
      item: {
        type: "tool_call",
        name: "shell",
        detail: { type: "shell", command: "npm test", exitCode: 0 },
      },
    },
    {
      turnId: "t2",
      item: {
        type: "assistant_message",
        text: "Summary: done\nChecks: PASS (12/12)",
      },
    },
  ];
  const r1 = extractTurnReply(withTurnIds, "t2");
  assert.equal(r1.text, "Summary: done\nChecks: PASS (12/12)");
  assert.deepEqual(r1.shellHint, {
    hasPassingShell: true,
    hasFailingShell: false,
  });

  // Projected timeline without turnId (as observed on Codex/Claude/Antigravity): slices after last agent_message.
  const withoutTurnIds = [
    { item: { type: "assistant_message", text: "Earlier turn" } },
    { item: { type: "tool_call", name: "agent_message", detail: {} } },
    {
      item: {
        type: "tool_call",
        name: "shell",
        detail: { type: "shell", command: "npm test", exitCode: 1 },
      },
    },
    {
      item: {
        type: "assistant_message",
        text: "结论：REQUEST_CHANGES\n摘要：缺少边界校验",
      },
    },
  ];
  const r2 = extractTurnReply(withoutTurnIds, "non-matching-id");
  assert.match(r2.text, /REQUEST_CHANGES/);
  assert.deepEqual(r2.shellHint, {
    hasPassingShell: false,
    hasFailingShell: true,
  });
});

test("parseReviewerReply handles structured EN/ZH headers, inline verdicts, findings normalization, and non-verdict replies", () => {
  const zh = parseReviewerReply(
    [
      "结论：REQUEST_CHANGES",
      "摘要：测试夹具未执行主题脚本，错误提示缺少底色。",
      "- 阻断：test/server.test.mjs:85 loadPage 未执行末尾 script",
      "- 必改：public/index.html:264 #message 无底色",
      "- 建议：建议放宽上限到 20MB",
    ].join("\n"),
  );
  assert.equal(zh.verdict, "REQUEST_CHANGES");
  assert.match(zh.summary, /测试夹具未执行主题脚本/);
  assert.deepEqual(zh.findings, [
    "blocking: test/server.test.mjs:85 loadPage 未执行末尾 script",
    "blocking: public/index.html:264 #message 无底色",
    "advice: 建议放宽上限到 20MB",
  ]);

  const en = parseReviewerReply(
    [
      "Verdict: APPROVE",
      "Summary: Diff matches spec and tests pass.",
      "- advice: unverified iOS Safari scroll behavior",
    ].join("\n"),
  );
  assert.equal(en.verdict, "APPROVE");
  assert.equal(en.summary, "Diff matches spec and tests pass.");
  assert.deepEqual(en.findings, [
    "advice: unverified iOS Safari scroll behavior",
  ]);

  const inline = parseReviewerReply(
    "第 2 轮复审结论：**APPROVE**（已确认所有阻断修复，98/98 全绿）。",
  );
  assert.equal(inline.verdict, "APPROVE");

  // Clarifying question without a verdict must return verdict=null so the plugin never nags.
  const question = parseReviewerReply(
    "在开始审查前想确认一下：这次改动需要兼容旧的 localStorage 键名吗？",
  );
  assert.equal(question.verdict, null);
  assert.match(question.summary, /确认一下/);
});

test("parseDeveloperReply and parseExpertReply extract checks without false-positive failures on '0 failed'", () => {
  const passZh = parseDeveloperReply(
    [
      "- 摘要：新增背景上传功能（public/index.html:1133）",
      "- 检查：通过（npm test 98/98 通过，0 失败）",
      "- 架构影响：无",
    ].join("\n"),
  );
  assert.equal(passZh.ciStatus, "pass");
  assert.equal(passZh.architectureImpact, "无");
  assert.match(passZh.summary, /新增背景上传功能/);

  const failEn = parseDeveloperReply(
    "Summary: partial fix\nChecks: FAIL (2 failed in store.test.mjs)\nArchitecture impact: None",
  );
  assert.equal(failEn.ciStatus, "fail");
  assert.equal(failEn.architectureImpact, "None");

  const shellFallback = parseDeveloperReply("Updated app.txt to after=smoke.", {
    hasPassingShell: true,
    hasFailingShell: false,
  });
  assert.equal(shellFallback.ciStatus, "pass");

  const waived = parseDeveloperReply(
    "Summary: docs only\nChecks: waived (no test suite for markdown)",
  );
  assert.match(waived.ciWaivedUserQuote ?? "", /waived/);

  const expert = parseExpertReply(
    "摘要：已将架构方案写入 plan.md，建议采用单键 IndexedDB。",
  );
  assert.equal(expert.planFile, "plan.md");
  assert.match(expert.summary, /单键 IndexedDB/);
});

test("observeMemberTurn passively drives full native pipeline from Expert -> Developer -> Dual Code Review -> Quality Gate READY", (t) => {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "paseo-team-obs-"));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  const cwd = path.join(baseDir, "workspace");
  mkdirSync(cwd);
  const stateRoot = path.join(baseDir, "state");

  const { recordPath } = initTask({
    cwd,
    goal: "Add background image setting",
    teamName: "Standard",
    preset: samplePreset,
    requireReview: true,
    stateRoot,
  });
  registerTaskAgent(recordPath, {
    role: "expert",
    agentId: "exp-1",
    profile: "claude/claude-opus-5-5",
    briefSummary: "Draft plan",
  });
  registerTaskAgent(recordPath, {
    role: "developer",
    agentId: "dev-1",
    profile: "antigravity/gemini-4-neon",
    briefSummary: "Implement",
  });
  registerTaskAgent(recordPath, {
    role: "code-reviewer",
    agentId: "rev-1",
    profile: "claude/claude-opus-5-5",
    briefSummary: "Spec",
  });
  registerTaskAgent(recordPath, {
    role: "code-reviewer",
    agentId: "rev-2",
    profile: "codex/gpt-6.2-astra",
    briefSummary: "Arch",
  });

  // 1. Expert replies natively -> planVersion increments passively.
  const expObs = observeMemberTurn(recordPath, {
    role: "expert",
    agentId: "exp-1",
    text: "Summary: Wrote plan.md covering IndexedDB background storage.",
  });
  assert.equal(expObs.recorded, true);
  assert.equal(loadTask(recordPath).planVersion, "v1");

  // 2. Developer replies natively with Checks: PASS -> delivery + CI pass recorded passively.
  const devObs = observeMemberTurn(recordPath, {
    role: "developer",
    agentId: "dev-1",
    text: "Summary: Added background picker in index.html.\nChecks: PASS (npm test 94/94)\nArchitecture impact: None",
  });
  assert.equal(devObs.recorded, true);
  assert.equal(loadTask(recordPath).ci?.status, "pass");
  assert.equal(loadTask(recordPath).candidate, "delivery-r1");

  // 3. Reviewer #1 asks a clarifying question first -> recorded=false, no verdict forced, no error.
  const qObs = observeMemberTurn(recordPath, {
    role: "code-reviewer",
    agentId: "rev-1",
    text: "Quick question: should old theme keys be kept?",
  });
  assert.equal(qObs.recorded, false);
  assert.equal(inspectQualityGate({ recordPath }).status, "BLOCKED");

  // 4. Both reviewers reply with APPROVE -> Quality Gate immediately READY!
  const r1Obs = observeMemberTurn(recordPath, {
    role: "code-reviewer",
    agentId: "rev-1",
    text: "Verdict: APPROVE\nSummary: Verified spec & edge cases.\n- advice: minor copy polish",
  });
  const r2Obs = observeMemberTurn(recordPath, {
    role: "code-reviewer",
    agentId: "rev-2",
    text: "结论：APPROVE\n摘要：架构简洁，无多余抽象。",
  });
  assert.equal(r1Obs.verdict, "APPROVE");
  assert.equal(r2Obs.verdict, "APPROVE");

  const gate = inspectQualityGate({ recordPath });
  assert.equal(gate.status, "READY");
  assert.deepEqual(gate.checks, {
    deliveryRecorded: true,
    ciPassed: true,
    planReviewSatisfied: true,
    codeReviewSatisfied: true,
  });
});
