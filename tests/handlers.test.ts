import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { saveConfig } from "../server/config-store.ts";
import {
  buildAgentTree,
  buildConfigBundle,
  buildConversationGraph,
  createRosterTool,
  inferTeamRole,
  listActiveTrees,
  type LiveAgentRecord,
  notifyConfigChanges,
  parseInlineTaskDirectives,
  resolveTeamGuideForCwd,
  startTeamTask,
  subscribeConfigChanges,
  unsetRoles,
} from "../server/handlers.ts";
import {
  TEAM_ENABLED_METADATA_KEY,
  TEAM_PERSPECTIVE_LABEL_KEY,
  TEAM_ROLE_LABEL_KEY,
} from "../shared/contracts.ts";

process.env.SKIP_DOTENV = "true";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

const readyPreset = {
  developer: { model: "antigravity/gemini-4-neon", thinking: "xhigh" },
  codeReviewers: [
    { model: "claude/claude-opus-5-5", thinking: "high" },
    { model: "codex/gpt-6.2-astra", thinking: "high" },
  ],
  separatePlanReviewers: false,
  planReviewers: [
    { model: "claude/claude-opus-5-5", thinking: "high" },
    { model: "codex/gpt-6.2-astra", thinking: "high" },
  ],
  expert: { model: "claude/claude-opus-5-5", thinking: "high" },
  complexMode: "simple" as const,
};

function makeMockPaseo(agentsList: Array<Record<string, unknown>> = []) {
  const sent: Array<{ agentId: string; text: string }> = [];
  const metaPatches: Array<{
    agentId: string;
    patch: Record<string, unknown>;
  }> = [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const a of agentsList) byId.set(String(a.id), a);

  const paseo = {
    providers: {
      async snapshot() {
        return {
          entries: [
            {
              provider: "antigravity",
              label: "Antigravity",
              status: "ready",
              modes: [
                {
                  id: "default",
                  label: "Default",
                  description: "Ask before risky actions",
                },
                {
                  id: "auto",
                  label: "Auto",
                  description: "Auto approve safe tools",
                },
                {
                  id: "full-access",
                  label: "Full access",
                  description: "Unrestricted execution",
                },
              ],
              models: [
                {
                  id: "gemini-4-neon",
                  label: "Gemini 4 Neon",
                  thinkingOptions: [{ id: "xhigh", label: "Extra" }],
                  defaultThinkingOptionId: "xhigh",
                },
              ],
            },
            {
              provider: "claude",
              label: "Claude",
              status: "ready",
              modes: [
                { id: "auto", label: "Auto mode" },
                { id: "acceptEdits", label: "Accept edits" },
                {
                  id: "bypassPermissions",
                  label: "Bypass permissions",
                  description: "Skip permission prompts",
                },
              ],
              models: [
                {
                  id: "claude-opus-5-5",
                  label: "Opus 5.5",
                  thinkingOptions: [{ id: "high", label: "High" }],
                  defaultThinkingOptionId: "high",
                },
              ],
            },
            {
              provider: "codex",
              label: "Codex",
              status: "ready",
              modes: [{ id: "auto-review" }, { id: "auto" }],
              models: [
                {
                  id: "gpt-6.2-astra",
                  label: "GPT-6.2-Astra",
                  thinkingOptions: [{ id: "high", label: "High" }],
                  defaultThinkingOptionId: "high",
                },
              ],
            },
          ],
        };
      },
    },
    agents: {
      async list() {
        return { entries: [...byId.values()].map((agent) => ({ agent })) };
      },
      ref(agentId: string) {
        return {
          async refresh() {
            const agent = byId.get(agentId);
            return agent ? { agent } : null;
          },
          async setMetadata(patch: Record<string, unknown>) {
            metaPatches.push({ agentId, patch });
            const existing = byId.get(agentId);
            if (existing) {
              existing.metadata = {
                ...((existing.metadata as Record<string, unknown>) ?? {}),
                ...patch,
              };
            }
          },
          async send(text: string) {
            sent.push({ agentId, text });
          },
        };
      },
    },
  };

  return { paseo: paseo as never, sent, metaPatches, byId };
}

test("parseInlineTaskDirectives parses Chinese & English presets, modes, and review directives", () => {
  const zh = parseInlineTaskDirectives(
    "/paseo-team 修复登录超时，用 标准 预设，用专家模式，方案审查",
  );
  assert.equal(zh.teamOverride, "标准");
  assert.equal(zh.complexModeOverride, "expert");
  assert.equal(zh.requireReview, true);
  assert.equal(zh.requirePlanReview, true);
  assert.doesNotMatch(zh.goal, /^\/paseo-team/);

  const waived = parseInlineTaskDirectives("微调文案 免审 用简单模式");
  assert.equal(waived.skipReview, true);
  assert.equal(waived.complexModeOverride, "simple");

  const en = parseInlineTaskDirectives(
    "start Refactor parser, use preset Fast, with review",
  );
  assert.equal(en.teamOverride, "Fast");
  assert.equal(en.requireReview, true);
  assert.doesNotMatch(en.goal, /^start\s/);
});

test("unsetRoles detects unset developer, expert, and reviewers", () => {
  assert.deepEqual(unsetRoles(readyPreset), []);
  assert.deepEqual(
    unsetRoles({
      developer: { model: "auto" },
      codeReviewers: [{ model: "auto" }],
      planReviewers: [{ model: "auto" }],
      expert: { model: "auto" },
      complexMode: "expert",
    }),
    ["Developer", "Expert", "Code Reviewer #1", "Plan Reviewer #1"],
  );
});

test("inferTeamRole resolves explicit labels, legacy role labels, and bilingual title prefixes", () => {
  assert.equal(
    inferTeamRole({ labels: { [TEAM_ROLE_LABEL_KEY]: "developer" } }),
    "developer",
  );
  assert.equal(
    inferTeamRole({ labels: { role: "plan-reviewer" } }),
    "plan-reviewer",
  );
  assert.equal(
    inferTeamRole({ title: "[Developer] 实现设置按钮" }),
    "developer",
  );
  assert.equal(inferTeamRole({ title: "专家：根因分析" }), "expert");
  assert.equal(
    inferTeamRole({ title: "方案审查 #1：架构核对" }),
    "plan-reviewer",
  );
  assert.equal(
    inferTeamRole({ title: "Code Reviewer #2: Simplicity" }),
    "code-reviewer",
  );
  assert.equal(inferTeamRole({ title: "Random helper chat" }), null);
});

test("resolveTeamGuideForCwd, startTeamTask, and read-only paseo_team_roster work cleanly without task.json", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "paseo-team-handlers-"));
  const prevCfg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(tmp, "cfg");
  const cwd = path.join(tmp, "repo");
  mkdirSync(cwd, { recursive: true });
  t.after(() => {
    if (prevCfg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevCfg;
    rmSync(tmp, { recursive: true, force: true });
  });

  saveConfig({
    schemaVersion: 5,
    default: "标准",
    teams: { 标准: readyPreset },
    projects: {},
  });

  const { paseo, sent, metaPatches, byId } = makeMockPaseo([
    {
      id: "coord-1",
      workspaceId: "wks_1",
      cwd,
      status: "idle",
      provider: "claude",
      model: "claude-opus-5-5",
      metadata: {},
    },
  ]);

  let changed = 0;
  const unsub = subscribeConfigChanges(() => {
    changed += 1;
  });
  notifyConfigChanges();
  assert.equal(changed, 1);
  unsub();

  const bundle = await buildConfigBundle(paseo, cwd);
  assert.equal(bundle.effectiveTeamName, "标准");
  assert.equal(bundle.providers.length, 3);
  assert.deepEqual(
    bundle.providers[0].modeOptions?.map((m) => m.id),
    ["default", "auto", "full-access"],
  );
  assert.equal(bundle.providers[0].modeOptions?.[2].label, "Full access");

  // Explicit per-role permission modes override default fallback; invalid modes fall back cleanly.
  saveConfig({
    schemaVersion: 5,
    default: "标准",
    teams: {
      标准: {
        ...readyPreset,
        developer: {
          model: "antigravity/gemini-4-neon",
          thinking: "xhigh",
          mode: "full-access",
        },
        codeReviewers: [
          {
            model: "claude/claude-opus-5-5",
            thinking: "high",
            mode: "bypassPermissions",
          },
          {
            model: "codex/gpt-6.2-astra",
            thinking: "high",
            mode: "nonexistent-mode",
          },
        ],
      },
    },
    projects: {},
  });

  const guideRes = await resolveTeamGuideForCwd(paseo, cwd, {
    requireReview: true,
    requirePlanReview: true,
    lang: "zh",
  });
  assert.equal(guideRes.unset.length, 0);
  assert.match(guideRes.guide, /antigravity\/gemini-4-neon/);
  assert.match(guideRes.guide, /"modeId":"full-access"/);
  assert.match(guideRes.guide, /"modeId":"bypassPermissions"/);
  assert.match(guideRes.guide, /"modeId":"auto-review"/);
  assert.doesNotMatch(guideRes.guide, /nonexistent-mode/);
  assert.match(guideRes.guide, /paseo-team\.role/);

  // startTeamTask sends kickoff message & marks paseo-team.enabled=true (no task.json lock!)
  const started = await startTeamTask(paseo, {
    cwd,
    workspaceId: "wks_1",
    agentId: "coord-1",
    rawArgs: "实现组件透明度滑块",
    language: "zh",
  });
  assert.equal(started.coordinatorAgentId, "coord-1");
  assert.equal(started.teamName, "标准");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /\[Team 任务启动\]/);
  assert.equal(metaPatches[0].patch[TEAM_ENABLED_METADATA_KEY], true);

  // Running a second /paseo-team sequentially in the same idle chat succeeds cleanly (zero lock!)
  await startTeamTask(paseo, {
    cwd,
    workspaceId: "wks_1",
    agentId: "coord-1",
    rawArgs: "再加一个快捷重置按钮 免审",
    language: "zh",
  });
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /用户已明确免审/);

  // Rejects empty args or busy agent
  await assert.rejects(
    () =>
      startTeamTask(paseo, {
        cwd,
        agentId: "coord-1",
        rawArgs: "/paseo-team   ",
        language: "zh",
      }),
    /请提供任务目标/,
  );
  byId.get("coord-1")!.status = "running";
  await assert.rejects(
    () =>
      startTeamTask(paseo, {
        cwd,
        agentId: "coord-1",
        rawArgs: "另一个需求",
        language: "zh",
      }),
    /正在运行中/,
  );

  // Read-only `paseo_team_roster` returns text-only (NO structuredContent!) and marks metadata.
  const tool = createRosterTool();
  const out = await tool.execute(
    { rawArgs: "Add dark mode toggle with review" },
    {
      agent: { id: "coord-1", cwd, title: "Dark mode" },
      paseo,
    } as never,
  );
  assert.notEqual(out.isError, true);
  assert.equal(
    (out as { structuredContent?: unknown }).structuredContent,
    undefined,
  );
  assert.match(out.text ?? "", /antigravity\/gemini-4-neon/);
  assert.match(out.text ?? "", /Code Reviewer #1/);
});

test("buildAgentTree, buildConversationGraph, and listActiveTrees build live Paseo DAG waves with zero stale state", async () => {
  const { paseo } = makeMockPaseo([
    {
      id: "root-1",
      workspaceId: "wks_todo",
      cwd: "/tmp/todo",
      status: "idle",
      provider: "claude",
      model: "claude-opus-5-5",
      thinkingOptionId: "high",
      title: "自定义组件透明度",
      metadata: { [TEAM_ENABLED_METADATA_KEY]: true },
      createdAt: "2026-11-28T00:00:00.000Z",
      updatedAt: "2026-11-28T00:05:00.000Z",
    },
    {
      id: "dev-1",
      workspaceId: "wks_todo",
      labels: {
        "paseo.parent-agent-id": "root-1",
        [TEAM_ROLE_LABEL_KEY]: "developer",
      },
      cwd: "/tmp/todo",
      status: "idle",
      provider: "antigravity",
      model: "gemini-4-neon",
      thinkingOptionId: "xhigh",
      title: "Developer: 透明度滑块",
      createdAt: "2026-11-28T00:01:00.000Z",
      updatedAt: "2026-11-28T00:02:00.000Z",
    },
    {
      id: "rev-1",
      workspaceId: "wks_todo",
      labels: {
        "paseo.parent-agent-id": "root-1",
        [TEAM_ROLE_LABEL_KEY]: "code-reviewer",
        [TEAM_PERSPECTIVE_LABEL_KEY]: "spec-boundary",
      },
      cwd: "/tmp/todo",
      status: "running",
      provider: "claude",
      model: "claude-opus-5-5",
      title: "Code Reviewer #1: 规格边界",
      createdAt: "2026-11-28T00:02:30.000Z",
      updatedAt: "2026-11-28T00:03:00.000Z",
    },
    {
      id: "rev-2",
      workspaceId: "wks_todo",
      labels: {
        "paseo.parent-agent-id": "root-1",
        [TEAM_ROLE_LABEL_KEY]: "code-reviewer",
        [TEAM_PERSPECTIVE_LABEL_KEY]: "arch-simplicity",
      },
      cwd: "/tmp/todo",
      status: "idle",
      pendingPermissions: [{ id: "p1" }],
      provider: "codex",
      model: "gpt-6.2-astra",
      title: "Code Reviewer #2: 架构简洁",
      createdAt: "2026-11-28T00:02:35.000Z",
      updatedAt: "2026-11-28T00:03:10.000Z",
    },
    {
      id: "standalone-chat",
      workspaceId: "wks_other",
      cwd: "/tmp/other",
      status: "idle",
      provider: "claude",
      title: "随便聊聊",
      metadata: {},
      createdAt: "2026-11-28T00:00:00.000Z",
      updatedAt: "2026-11-28T00:00:00.000Z",
    },
  ]);

  // Focusing any child (rev-1) resolves to the root tree with 3 layers:
  // Coordinator -> Developer -> parallel [Code Reviewer #1, Code Reviewer #2]
  const graph = await buildConversationGraph(paseo, {
    agentId: "rev-1",
    workspaceId: "wks_todo",
    language: "zh",
  });
  assert.equal(graph.rootAgentId, "root-1");
  assert.ok(graph.tree);
  assert.equal(graph.tree.totalAgents, 4);
  assert.equal(graph.tree.runningCount, 1);
  assert.equal(graph.tree.attentionCount, 1);
  assert.equal(graph.tree.layers.length, 3);
  assert.equal(graph.tree.layers[0].nodes[0].role, "coordinator");
  assert.equal(graph.tree.layers[1].nodes[0].role, "developer");
  assert.equal(graph.tree.layers[2].nodes.length, 2);
  assert.equal(graph.tree.layers[2].nodes[0].status, "running");
  assert.equal(graph.tree.layers[2].nodes[1].status, "awaiting_permission");
  assert.match(
    graph.tree.layers[2].nodes[0].perspectiveLabel ?? "",
    /需求规格/,
  );

  // Standalone chat without Team mode or subagents returns null tree
  const emptyGraph = await buildConversationGraph(paseo, {
    agentId: "standalone-chat",
    workspaceId: "wks_other",
    language: "en",
  });
  assert.equal(emptyGraph.tree, null);

  // listActiveTrees returns only team/subagent trees (excludes standalone chat)
  const activeTrees = await listActiveTrees(paseo, { language: "zh" });
  assert.equal(activeTrees.length, 1);
  assert.equal(activeTrees[0].rootAgentId, "root-1");

  // Direct unit check for nested subagents (e.g. cross-worktree child spawning developer)
  const nestedMap = new Map<string, LiveAgentRecord>([
    [
      "r",
      {
        id: "r",
        workspaceId: "w1",
        parentAgentId: null,
        title: "Root",
        cwd: "/a",
        status: "idle",
        provider: "claude",
        model: "opus",
        thinkingOptionId: null,
        labels: {},
        isTeamEnabled: true,
        background: false,
        archivedAt: null,
        createdAt: "2026-11-28T00:00:00Z",
        updatedAt: "2026-11-28T00:01:00Z",
      },
    ],
    [
      "c1",
      {
        id: "c1",
        workspaceId: "w2",
        parentAgentId: "r",
        title: "Worktree Coord",
        cwd: "/b",
        status: "running",
        provider: "claude",
        model: "opus",
        thinkingOptionId: null,
        labels: {},
        isTeamEnabled: true,
        background: false,
        archivedAt: null,
        createdAt: "2026-11-28T00:01:00Z",
        updatedAt: "2026-11-28T00:02:00Z",
      },
    ],
    [
      "c2",
      {
        id: "c2",
        workspaceId: "w2",
        parentAgentId: "c1",
        title: "Developer: Nested edit",
        cwd: "/b",
        status: "running",
        provider: "antigravity",
        model: "gemini",
        thinkingOptionId: null,
        labels: { [TEAM_ROLE_LABEL_KEY]: "developer" },
        isTeamEnabled: false,
        background: false,
        archivedAt: null,
        createdAt: "2026-11-28T00:02:00Z",
        updatedAt: "2026-11-28T00:03:00Z",
      },
    ],
  ]);
  const nestedTree = buildAgentTree("r", nestedMap, "en");
  assert.ok(nestedTree);
  assert.equal(nestedTree.layers.length, 3);
  assert.equal(nestedTree.layers[2].nodes[0].agentId, "c2");
});
