import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCoordinatorTools } from "../server/handlers.ts";
import {
  assignReviewerPerspective,
  buildCoordinatorSystemPrompt,
  buildDeveloperPrompt,
  buildExpertPrompt,
  buildKickoffPrompt,
  buildReviewerPrompt,
  getSafetyRulesText,
  SAFETY_RULES_EN,
  SAFETY_RULES_ZH,
  type ReviewerPerspective,
} from "../server/prompts.ts";
import {
  buildRecoveryBrief,
  initTask,
  recordCandidateDelivery,
  recordReviewVerdict,
  registerTaskAgent,
} from "../server/task-store.ts";

process.env.SKIP_DOTENV = "true";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

function extractPluginToolMentions(text: string): string[] {
  const matches = text.match(/`paseo_team(?:_[a-z_]+)?`/g) ?? [];
  return [...new Set(matches.map((m) => m.slice(1, -1)))].sort();
}

function makeSampleRecord(t: test.TestContext) {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "paseo-team-prompts-"));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  const cwd = path.join(baseDir, "workspace");
  mkdirSync(cwd);
  const stateRoot = path.join(baseDir, "state");
  return initTask({
    cwd,
    goal: "Audit all prompts and tools",
    teamName: "Standard",
    preset: {
      developer: { model: "codex/gpt-6.1-sol" },
      planReviewers: [{ model: "codex/gpt-6-astra" }],
      codeReviewers: [{ model: "codex/gpt-6-astra" }],
      complexMode: "simple",
    },
    requireReview: true,
    stateRoot,
  });
}

test("safety rules enforce credential redlines in both languages without contradicting plugin auto-injection", () => {
  assert.equal(getSafetyRulesText("en"), SAFETY_RULES_EN);
  assert.equal(getSafetyRulesText("zh"), SAFETY_RULES_ZH);

  for (const text of [SAFETY_RULES_EN, SAFETY_RULES_ZH]) {
    assert.match(text, /\.env/);
    assert.match(text, /SKIP_DOTENV=true/);
    assert.match(text, /DOTENV_CONFIG_PATH=\/dev\/null/);
    assert.match(text, /printenv/);
    assert.doesNotMatch(
      text,
      /Include this exact section verbatim whenever spawning subagents|再派生子 agent 时，必须将本节原文写入其简报/,
    );
  }
});

test("coordinator system prompt covers both languages, native single-channel messaging, and only the real paseo_team tool", (t) => {
  const { recordPath } = makeSampleRecord(t);
  const allRealPluginTools = new Set(
    createCoordinatorTools(recordPath).map((tool) => tool.name),
  );
  assert.deepEqual([...allRealPluginTools], ["paseo_team"]);

  for (const lang of ["zh", "en"] as const) {
    for (const complexMode of ["simple", "expert"] as const) {
      const prompt = buildCoordinatorSystemPrompt({
        taskId: "task-coord-1",
        taskDir: "/tmp/evidence/task-coord-1",
        teamName: "标准",
        complexMode,
        lang,
      });

      assert.match(prompt, /task-coord-1/);
      assert.match(prompt, /\/tmp\/evidence\/task-coord-1/);
      assert.match(prompt, /create_agent/);
      assert.match(prompt, /send_agent_prompt/);
      assert.match(prompt, /\.worktrees/);
      assert.match(prompt, /git commit/);
      assert.ok(
        prompt.includes(getSafetyRulesText(lang)),
        `coordinator prompt (${lang}) must embed safety rules`,
      );

      if (lang === "zh") {
        assert.match(prompt, /立即结束本轮/);
        assert.match(prompt, /不要轮询/);
        assert.match(prompt, /同一时刻只有一名 Developer/);
      } else {
        assert.match(prompt, /End your turn immediately/);
        assert.match(prompt, /without polling/i);
        assert.match(prompt, /One Developer writes at a time/);
      }

      if (complexMode === "expert") {
        assert.match(prompt, /expert/);
      } else {
        assert.match(prompt, lang === "zh" ? /绝不自审/ : /never self-approve/);
      }

      const mentioned = extractPluginToolMentions(prompt);
      assert.deepEqual(mentioned, ["paseo_team"]);
      assert.match(prompt, /action:\s*"set_route"/);
      assert.match(prompt, /action:\s*"update"/);
      assert.match(prompt, /action:\s*"complete"/);
      assert.match(prompt, /action:\s*"summary"/);
    }
  }
});

test("developer and expert prompts require zero custom plugin tools and specify native reply format", () => {
  for (const lang of ["zh", "en"] as const) {
    const devPrompt = buildDeveloperPrompt({
      taskId: "task-dev-1",
      taskDir: "/tmp/evidence/task-dev-1",
      lang,
    });
    assert.deepEqual(extractPluginToolMentions(devPrompt), []);
    assert.match(devPrompt, /SKIP_DOTENV=true/);
    assert.match(devPrompt, /\.worktrees/);
    assert.match(devPrompt, /git commit/);
    assert.match(devPrompt, lang === "zh" ? /摘要：/ : /Summary:/);
    assert.match(devPrompt, lang === "zh" ? /检查：/ : /Checks:/);
    assert.match(
      devPrompt,
      lang === "zh" ? /架构影响：/ : /Architecture impact:/,
    );
    assert.ok(devPrompt.includes(getSafetyRulesText(lang)));

    const expertPrompt = buildExpertPrompt({
      taskId: "task-exp-1",
      taskDir: "/tmp/evidence/task-exp-1",
      lang,
    });
    assert.deepEqual(extractPluginToolMentions(expertPrompt), []);
    assert.match(expertPrompt, /\/tmp\/evidence\/task-exp-1/);
    assert.match(
      expertPrompt,
      lang === "zh" ? /严禁修改代码仓库/ : /Never modify repository files/,
    );
    assert.ok(expertPrompt.includes(getSafetyRulesText(lang)));
  }
});

test("reviewer prompt distinguishes plan vs code stages, uses zero custom tools, and sets native verdict format", () => {
  assert.equal(assignReviewerPerspective(0, 1), "comprehensive");
  assert.equal(assignReviewerPerspective(0, 2), "spec-boundary");
  assert.equal(assignReviewerPerspective(1, 2), "arch-simplicity");

  const perspectives: ReviewerPerspective[] = [
    "spec-boundary",
    "arch-simplicity",
    "comprehensive",
  ];

  for (const lang of ["zh", "en"] as const) {
    for (const stage of ["plan", "code"] as const) {
      const rendered = perspectives.map((perspective) =>
        buildReviewerPrompt({
          taskId: "task-rev-1",
          perspective,
          stage,
          lang,
        }),
      );
      assert.equal(new Set(rendered).size, 3);

      for (const prompt of rendered) {
        assert.deepEqual(extractPluginToolMentions(prompt), []);
        assert.match(prompt, /APPROVE/);
        assert.match(prompt, /REQUEST_CHANGES/);
        assert.match(prompt, /BLOCKED/);
        assert.match(prompt, /blocking:/);
        assert.match(prompt, /advice:/);
        assert.ok(prompt.includes(getSafetyRulesText(lang)));

        if (stage === "plan") {
          assert.match(
            prompt,
            lang === "zh"
              ? /独立方案审查指引/
              : /Independent Plan Reviewer Guide/,
          );
          assert.doesNotMatch(
            prompt,
            lang === "zh"
              ? /独立代码审查指引/
              : /Independent Code Reviewer Guide/,
          );
        } else {
          assert.match(
            prompt,
            lang === "zh"
              ? /独立代码审查指引/
              : /Independent Code Reviewer Guide/,
          );
          assert.match(
            prompt,
            lang === "zh"
              ? /终止所有临时启动的后台服务/
              : /terminate any temporary background server/,
          );
        }
      }
    }
  }
});

test("recovery brief includes findings and kickoff prompt embeds concise native protocol in both languages", (t) => {
  const { recordPath } = makeSampleRecord(t);
  registerTaskAgent(recordPath, {
    role: "developer",
    agentId: "dev-99",
    profile: "antigravity/gemini-4-neon",
    briefSummary: "Fix bug",
  });
  recordCandidateDelivery(recordPath, {
    agentId: "dev-99",
    summary: "Fixed bug",
    architectureImpact: "None",
    ciStatus: "pass",
    ciSummary: "npm test passed",
  });
  registerTaskAgent(recordPath, {
    role: "code-reviewer",
    agentId: "rev-99",
    profile: "claude/claude-opus-5-5",
    briefSummary: "Review fix",
  });
  recordReviewVerdict(recordPath, {
    stage: "code",
    agentId: "rev-99",
    round: 1,
    verdict: "REQUEST_CHANGES",
    summary: "Need edge fix",
    findings: ["blocking: a.ts:1 missing check"],
  });
  const broken = recordReviewVerdict(recordPath, {
    stage: "code",
    agentId: "rev-99",
    round: 2,
    verdict: "REQUEST_CHANGES",
    summary: "Still missing edge fix",
    findings: ["blocking: a.ts:1 still missing check"],
  });

  const brief = buildRecoveryBrief(broken.record);
  assert.match(brief, new RegExp(broken.record.taskId));
  assert.match(brief, /codeReview=required\(R2\/2\)/);
  assert.match(brief, /Circuit Breaker:/);
  assert.match(brief, /agentId=dev-99/);
  assert.match(brief, /agentId=rev-99/);
  assert.match(brief, /reuse existing agentIds/);
  assert.match(brief, /Latest Code Review Findings/);
  assert.match(brief, /blocking: a\.ts:1 still missing check/);

  const zhKickoff = buildKickoffPrompt({
    taskId: "t-kick-zh",
    goal: "更新按钮文案",
    teamName: "标准",
    complexMode: "simple",
    taskDir: "/tmp/evidence/t-kick-zh",
    rosterLines: ['- Developer: provider="antigravity/gemini-4-neon"'],
    userConstraints: ["- 用户已明确要求方案评审"],
    lang: "zh",
  });
  assert.match(zhKickoff, /\[Team 任务启动\]/);
  assert.match(zhKickoff, /create_agent/);
  assert.deepEqual(extractPluginToolMentions(zhKickoff), ["paseo_team"]);
  assert.match(zhKickoff, /action: "set_route"/);
  assert.match(zhKickoff, /action: "update"/);
  assert.match(zhKickoff, /action: "complete"/);
  assert.match(zhKickoff, /\/tmp\/evidence\/t-kick-zh/);
  assert.ok(zhKickoff.includes(SAFETY_RULES_ZH));
  assert.match(zhKickoff, /用户已明确要求方案评审/);
  assert.match(zhKickoff, /antigravity\/gemini-4-neon/);

  const enKickoff = buildKickoffPrompt({
    taskId: "t-kick-en",
    goal: "Update button label",
    teamName: "Standard",
    complexMode: "expert",
    taskDir: "/tmp/evidence/t-kick-en",
    rosterLines: ['- Expert: provider="claude/claude-opus-5-5"'],
    userConstraints: ["- User explicitly requested plan review"],
    lang: "en",
  });
  assert.match(enKickoff, /\[Team Kickoff\]/);
  assert.match(enKickoff, /mode: `expert`/);
  assert.deepEqual(extractPluginToolMentions(enKickoff), ["paseo_team"]);
  assert.match(enKickoff, /action: "set_route"/);
  assert.match(enKickoff, /action: "update"/);
  assert.match(enKickoff, /action: "complete"/);
  assert.match(enKickoff, /\/tmp\/evidence\/t-kick-en/);
  assert.ok(enKickoff.includes(SAFETY_RULES_EN));
  assert.match(enKickoff, /User explicitly requested plan review/);
  assert.match(enKickoff, /claude\/claude-opus-5-5/);
});
