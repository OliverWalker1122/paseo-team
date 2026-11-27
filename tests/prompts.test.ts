import assert from "node:assert/strict";
import test from "node:test";
import {
  assignReviewerPerspective,
  buildCoordinatorTeamGuide,
  buildDeveloperPrompt,
  buildExpertPrompt,
  buildKickoffPrompt,
  buildReviewerPrompt,
  COORDINATOR_ROSTER_HINT,
  getSafetyRulesText,
  type ReviewerPerspective,
  SAFETY_RULES_EN,
  SAFETY_RULES_ZH,
} from "../server/prompts.ts";

process.env.SKIP_DOTENV = "true";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

test("safety rules enforce credential redlines in both languages", () => {
  assert.equal(getSafetyRulesText("en"), SAFETY_RULES_EN);
  assert.equal(getSafetyRulesText("zh"), SAFETY_RULES_ZH);

  for (const text of [SAFETY_RULES_EN, SAFETY_RULES_ZH]) {
    assert.match(text, /\.env/);
    assert.match(text, /SKIP_DOTENV=true/);
    assert.match(text, /DOTENV_CONFIG_PATH=\/dev\/null/);
    assert.match(text, /printenv/);
  }
  assert.match(COORDINATOR_ROSTER_HINT, /paseo_team_roster/);
});

test("coordinator guide and kickoff prompt use zero state-machine tools and embed roster & rules in EN/ZH", () => {
  const rosterLines = [
    '- Developer: provider="antigravity/gemini-4-neon" settings={"modeId":"auto","thinkingOptionId":"xhigh"} labels={"paseo-team.role":"developer"}',
    '- Code Reviewer #1: provider="claude/claude-opus-5-5" settings={"modeId":"auto"} labels={"paseo-team.role":"code-reviewer","paseo-team.perspective":"spec-boundary"}',
  ];

  for (const lang of ["zh", "en"] as const) {
    for (const complexMode of ["simple", "expert"] as const) {
      const guide = buildCoordinatorTeamGuide({
        teamName: "标准",
        complexMode,
        rosterLines,
        userConstraints: [
          lang === "zh"
            ? "- 用户明确要求代码审查。"
            : "- User requested review.",
        ],
        lang,
      });

      assert.match(guide, /create_agent/);
      assert.match(guide, /send_agent_prompt/);
      assert.match(guide, /\.worktrees/);
      assert.match(guide, /git commit/);
      assert.ok(guide.includes(getSafetyRulesText(lang)));
      // Must NOT mention deleted v6 state-machine tools or actions.
      assert.doesNotMatch(guide, /set_route|task\.json|paseo_team\(/);

      const kickoff = buildKickoffPrompt({
        goal: lang === "zh" ? "新增透明背景滑块" : "Add opacity slider",
        teamName: "标准",
        complexMode,
        rosterLines,
        lang,
      });
      assert.match(
        kickoff,
        lang === "zh" ? /^\[Team 任务启动\]/ : /^\[Team Kickoff\]/,
      );
      assert.match(kickoff, /antigravity\/gemini-4-neon/);
    }

    const unsetNotice = buildCoordinatorTeamGuide({
      teamName: "标准",
      complexMode: "simple",
      rosterLines: [],
      unsetRoles: ["Developer", "Code Reviewer #1"],
      lang,
    });
    assert.match(unsetNotice, /Developer/);
    assert.match(unsetNotice, /\/paseo-team setup/);
  }
});

test("developer, expert, and reviewer prompts use zero custom plugin tools", () => {
  assert.equal(assignReviewerPerspective(0, 1), "comprehensive");
  assert.equal(assignReviewerPerspective(0, 2), "spec-boundary");
  assert.equal(assignReviewerPerspective(1, 2), "arch-simplicity");

  const perspectives: ReviewerPerspective[] = [
    "spec-boundary",
    "arch-simplicity",
    "comprehensive",
  ];

  for (const lang of ["zh", "en"] as const) {
    const dev = buildDeveloperPrompt(lang);
    assert.doesNotMatch(dev, /paseo_team/);
    assert.match(dev, /SKIP_DOTENV=true/);
    assert.match(dev, /\.worktrees/);
    assert.ok(dev.includes(getSafetyRulesText(lang)));

    const exp = buildExpertPrompt(lang);
    assert.doesNotMatch(exp, /paseo_team/);
    assert.ok(exp.includes(getSafetyRulesText(lang)));

    for (const stage of ["plan", "code"] as const) {
      const rendered = perspectives.map((perspective) =>
        buildReviewerPrompt({ stage, perspective, lang }),
      );
      assert.equal(new Set(rendered).size, 3);
      for (const prompt of rendered) {
        assert.doesNotMatch(prompt, /paseo_team/);
        assert.match(prompt, /APPROVE/);
        assert.match(prompt, /REQUEST_CHANGES/);
        assert.match(prompt, /BLOCKED/);
        assert.match(prompt, /blocking:/);
        assert.match(prompt, /advice:/);
        assert.ok(prompt.includes(getSafetyRulesText(lang)));
      }
    }
  }
});
