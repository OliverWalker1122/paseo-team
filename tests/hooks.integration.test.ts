import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import contribute, {
  extractToolName,
  isAutoAllowedTeamPermission,
} from "../index.server.ts";
import { saveConfig } from "../server/config-store.ts";
import { COORDINATOR_ROSTER_HINT } from "../server/prompts.ts";
import {
  getConfigBundleRpc,
  saveConfigRpc,
  startTeamTaskRpc,
  TEAM_ENABLED_METADATA_KEY,
  TEAM_PERSPECTIVE_LABEL_KEY,
  TEAM_ROLE_LABEL_KEY,
  TEAM_SUBAGENT_METADATA_KEY,
  watchActiveTreesSubscription,
  watchConversationGraphSubscription,
} from "../shared/contracts.ts";

process.env.SKIP_DOTENV = "true";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

type HookHandler = (
  payload: Record<string, unknown>,
  context: { paseo: unknown; signal: AbortSignal },
) => Promise<unknown> | unknown;

type RpcHandler = (
  input: unknown,
  context: {
    paseo: unknown;
    push?: (ev: unknown) => Promise<void>;
    signal?: AbortSignal;
  },
) => Promise<unknown> | unknown;

const samplePreset = {
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

function createServerHarness(t: test.TestContext) {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "paseo-team-v7-int-"));
  const prevCfg = process.env.XDG_CONFIG_HOME;
  const workspaceDir = path.join(baseDir, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  process.env.XDG_CONFIG_HOME = path.join(baseDir, "config");

  const hooks = new Map<string, HookHandler>();
  const rpcs = new Map<string, RpcHandler>();
  const sentMessages: Array<{ agentId: string; text: string }> = [];
  const permissionResponses: Array<{ agentId: string; requestId: string }> = [];
  const agentDirectory = new Map<string, Record<string, unknown>>();
  const subCallbacks: Array<() => void> = [];
  let streamReleased = 0;
  let streamListCalls = 0;
  let streamObserver: {
    snapshot?: (data: {
      entries: Array<{ agent: Record<string, unknown> }>;
    }) => void;
    update?: (msg: {
      type: string;
      payload:
        | { kind: "upsert"; agent: Record<string, unknown> }
        | { kind: "remove"; agentId: string };
    }) => void;
  } | null = null;

  const paseoMock = {
    providers: {
      async snapshot() {
        return {
          entries: [
            {
              provider: "antigravity",
              label: "Antigravity",
              status: "ready",
              modes: [{ id: "auto" }],
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
              modes: [{ id: "auto" }],
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
              modes: [{ id: "auto-review" }],
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
      async list(opts?: { subscribe?: unknown }) {
        const entries = [...agentDirectory.values()].map((agent) => ({
          agent,
        }));
        if (opts?.subscribe) {
          streamListCalls += 1;
          return {
            entries,
            subscription: {
              subscribe(obs: NonNullable<typeof streamObserver>) {
                streamObserver = obs;
                return () => {
                  if (streamObserver === obs) streamObserver = null;
                };
              },
              async release() {
                streamReleased += 1;
              },
            },
          };
        }
        return { entries };
      },
      subscribe(cb: () => void) {
        subCallbacks.push(cb);
        return () => {
          const i = subCallbacks.indexOf(cb);
          if (i >= 0) subCallbacks.splice(i, 1);
        };
      },
      ref(agentId: string) {
        return {
          async refresh() {
            const agent = agentDirectory.get(agentId);
            return agent ? { agent } : null;
          },
          async setMetadata(patch: Record<string, unknown>) {
            const existing = agentDirectory.get(agentId);
            if (existing) {
              existing.metadata = {
                ...((existing.metadata as Record<string, unknown>) ?? {}),
                ...patch,
              };
            }
          },
          async send(text: string) {
            sentMessages.push({ agentId, text });
          },
          async respondToPermission(opts: { requestId: string }) {
            permissionResponses.push({ agentId, requestId: opts.requestId });
          },
        };
      },
    },
  };

  const serverMock = {
    handle(def: { name: string }, handler: RpcHandler) {
      rpcs.set(def.name, handler);
    },
    addHook(name: string, handler: HookHandler) {
      hooks.set(name, handler);
      return () => hooks.delete(name);
    },
  };

  const dispose = contribute(serverMock as never);
  t.after(() => {
    dispose();
    if (prevCfg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevCfg;
    rmSync(baseDir, { recursive: true, force: true });
  });

  const controller = new AbortController();
  return {
    workspaceDir,
    hooks,
    rpcs,
    sentMessages,
    permissionResponses,
    agentDirectory,
    paseo: paseoMock,
    getStreamStats: () => ({ streamListCalls, streamReleased }),
    emitAgentUpsert: (agent: Record<string, unknown>) => {
      agentDirectory.set(String(agent.id), agent);
      streamObserver?.update?.({
        type: "agent_update",
        payload: { kind: "upsert", agent },
      });
    },
    emitAgentRemove: (agentId: string) => {
      agentDirectory.delete(agentId);
      streamObserver?.update?.({
        type: "agent_update",
        payload: { kind: "remove", agentId },
      });
    },
    invokeHook: (name: string, payload: Record<string, unknown>) =>
      hooks.get(name)!(payload, {
        paseo: paseoMock,
        signal: controller.signal,
      }),
    invokeRpc: (name: string, input: unknown) =>
      rpcs.get(name)!(input, { paseo: paseoMock }),
  };
}

test("v7 server registers only 2 minimal hooks (zero state-machine observers)", (t) => {
  const h = createServerHarness(t);
  assert.deepEqual([...h.hooks.keys()].sort(), [
    "agent.open.before",
    "agent.permission.before",
  ]);
  assert.equal(
    extractToolName({ toolName: "paseo_team_roster" }),
    "paseo_team_roster",
  );
  assert.equal(
    extractToolName({ tool: { name: "create_agent" } }),
    "create_agent",
  );
  assert.equal(extractToolName(null), null);
});

test("agent.open.before directly injects full team roster on Turn 1 when Team toggle or /paseo-team is active, and handles subagents & cross-worktree spawns", async (t) => {
  const h = createServerHarness(t);
  saveConfig({
    schemaVersion: 5,
    default: "标准",
    teams: { 标准: samplePreset },
    projects: {},
  });

  const baseReq = {
    workspaceId: "wks_main",
    cwd: h.workspaceDir,
    reason: "create",
    purpose: "interactive",
    background: false,
    labels: {},
    metadata: {},
    appendSystemPrompt: [],
    tools: [],
    env: {},
    mcpServers: {},
  };

  // 1. Skips history & background opens
  assert.equal(
    await h.invokeHook("agent.open.before", {
      request: {
        ...baseReq,
        agentId: "h1",
        provider: "claude",
        purpose: "history",
      },
    }),
    undefined,
  );
  assert.equal(
    await h.invokeHook("agent.open.before", {
      request: {
        ...baseReq,
        agentId: "b1",
        provider: "claude",
        background: true,
      },
    }),
    undefined,
  );

  // 2. Normal top-level chat gets tiny 1-line hint + read-only `paseo_team_roster` fallback
  const normalOut = (await h.invokeHook("agent.open.before", {
    request: {
      ...baseReq,
      agentId: "normal-1",
      provider: "claude",
      title: "普通问题",
    },
  })) as { appendSystemPrompt: string[]; tools: Array<{ name: string }> };
  assert.deepEqual(normalOut.appendSystemPrompt, [COORDINATOR_ROSTER_HINT]);
  assert.deepEqual(
    normalOut.tools.map((x) => x.name),
    ["paseo_team_roster"],
  );

  // 3. New Workspace chat with composer Team toggle ON gets FULL protocol + exact role models immediately on Turn 1!
  const toggleOut = (await h.invokeHook("agent.open.before", {
    request: {
      ...baseReq,
      agentId: "nw-team-1",
      provider: "claude",
      title: "设置里可以改变组件的透明度",
      metadata: { [TEAM_ENABLED_METADATA_KEY]: true },
    },
  })) as { appendSystemPrompt: string[]; tools: Array<{ name: string }> };
  assert.match(toggleOut.appendSystemPrompt[0], /Paseo Team 团队模式协议/);
  assert.match(toggleOut.appendSystemPrompt[0], /antigravity\/gemini-4-neon/);
  assert.match(toggleOut.appendSystemPrompt[0], /claude\/claude-opus-5-5/);
  assert.match(toggleOut.appendSystemPrompt[0], /codex\/gpt-6\.2-astra/);

  // 4. Same-workspace non-team subagent gets undefined; cross-workspace root spawn gets roster tool!
  h.agentDirectory.set("normal-1", {
    id: "normal-1",
    workspaceId: "wks_main",
    cwd: h.workspaceDir,
  });
  assert.equal(
    await h.invokeHook("agent.open.before", {
      request: {
        ...baseReq,
        agentId: "same-ws-helper",
        provider: "claude",
        title: "Helper",
        labels: { "paseo.parent-agent-id": "normal-1" },
      },
    }),
    undefined,
  );
  const crossWsOut = (await h.invokeHook("agent.open.before", {
    request: {
      ...baseReq,
      agentId: "worktree-coord",
      workspaceId: "wks_worktree_new",
      provider: "claude",
      title: "团队协调：自定义透明度",
      labels: { "paseo.parent-agent-id": "normal-1" },
    },
  })) as { tools: Array<{ name: string }> };
  assert.ok(crossWsOut);
  assert.deepEqual(
    crossWsOut.tools.map((x) => x.name),
    ["paseo_team_roster"],
  );

  // 5. Team subagents (Developer, Expert, Plan/Code Reviewer) get concise role guides, ZERO custom tools,
  //    and non-blocking `paseo-team.subagent: true` metadata.
  h.agentDirectory.set("sub-dev", { id: "sub-dev", metadata: {} });
  const devOut = (await h.invokeHook("agent.open.before", {
    request: {
      ...baseReq,
      agentId: "sub-dev",
      provider: "antigravity",
      title: "实现透明度滑块",
      labels: {
        "paseo.parent-agent-id": "nw-team-1",
        [TEAM_ROLE_LABEL_KEY]: "developer",
      },
    },
  })) as { appendSystemPrompt: string[]; tools: Array<{ name: string }> };
  assert.match(devOut.appendSystemPrompt[0], /Developer 指引/);
  assert.deepEqual(devOut.tools, []);
  assert.equal(
    (h.agentDirectory.get("sub-dev")?.metadata as Record<string, unknown>)[
      TEAM_SUBAGENT_METADATA_KEY
    ],
    true,
  );

  const revOut = (await h.invokeHook("agent.open.before", {
    request: {
      ...baseReq,
      agentId: "sub-rev",
      provider: "codex",
      title: "Review opacity slider",
      labels: {
        "paseo.parent-agent-id": "nw-team-1",
        [TEAM_ROLE_LABEL_KEY]: "code-reviewer",
        [TEAM_PERSPECTIVE_LABEL_KEY]: "arch-simplicity",
      },
    },
  })) as { appendSystemPrompt: string[]; tools: Array<{ name: string }> };
  assert.match(revOut.appendSystemPrompt[0], /Architecture & Simplicity/);
  assert.deepEqual(revOut.tools, []);
});

test("agent.permission.before auto-allows roster and native coordinator tools without opening dangerous permissions", async (t) => {
  const h = createServerHarness(t);

  assert.equal(
    isAutoAllowedTeamPermission({
      toolName: "mcp__paseo__paseo_team_roster",
      isTeamCoordinator: false,
      isTeamSubagent: false,
    }),
    true,
  );
  assert.equal(
    isAutoAllowedTeamPermission({
      toolName: "mcp__paseo__create_agent",
      isTeamCoordinator: true,
      isTeamSubagent: false,
    }),
    true,
  );
  assert.equal(
    isAutoAllowedTeamPermission({
      toolName: "mcp__paseo__create_agent",
      isTeamCoordinator: false,
      isTeamSubagent: false,
    }),
    false,
  );
  assert.equal(
    isAutoAllowedTeamPermission({
      toolName: "run_shell_command",
      isTeamCoordinator: true,
      isTeamSubagent: false,
    }),
    false,
  );

  await h.invokeHook("agent.permission.before", {
    agent: {
      id: "coord-1",
      parentAgentId: null,
      title: "透明度",
      metadata: { [TEAM_ENABLED_METADATA_KEY]: true },
    },
    request: {
      id: "perm-1",
      kind: "tool",
      toolName: "mcp__paseo__create_agent",
      actions: [{ id: "allow-once", behavior: "allow" }],
    },
  });
  await h.invokeHook("agent.permission.before", {
    agent: {
      id: "coord-1",
      parentAgentId: null,
      title: "透明度",
      metadata: { [TEAM_ENABLED_METADATA_KEY]: true },
    },
    request: {
      id: "perm-shell",
      kind: "tool",
      toolName: "bash",
      actions: [{ id: "allow-once", behavior: "allow" }],
    },
  });
  assert.deepEqual(h.permissionResponses, [
    { agentId: "coord-1", requestId: "perm-1" },
  ]);
});

test("config RPCs, startTeamTaskRpc, and live Paseo graph subscriptions work end-to-end", async (t) => {
  const h = createServerHarness(t);
  const saved = (await h.invokeRpc(saveConfigRpc.name, {
    cwd: h.workspaceDir,
    config: {
      schemaVersion: 5,
      default: "标准",
      teams: { 标准: samplePreset },
      projects: {},
    },
  })) as { effectiveTeamName: string };
  assert.equal(saved.effectiveTeamName, "标准");

  const loaded = (await h.invokeRpc(getConfigBundleRpc.name, {
    cwd: h.workspaceDir,
  })) as { effectiveTeamName: string };
  assert.equal(loaded.effectiveTeamName, "标准");

  h.agentDirectory.set("chat-1", {
    id: "chat-1",
    workspaceId: "wks_1",
    cwd: h.workspaceDir,
    status: "idle",
    provider: "claude",
    model: "claude-opus-5-5",
    title: "测试对话",
    metadata: {},
  });

  await h.invokeRpc(startTeamTaskRpc.name, {
    cwd: h.workspaceDir,
    workspaceId: "wks_1",
    agentId: "chat-1",
    rawArgs: "实现透明度滑块",
    language: "zh",
  });
  assert.equal(h.sentMessages.length, 1);

  // Verify live subscriptions share ONE daemon agents.list({ subscribe: {} }) stream
  // and push real-time upsert/remove transitions (e.g. Developer running -> idle + Reviewers added)!
  const convEvents: Array<{
    rootAgentId: string;
    tree: { totalAgents: number; runningCount: number } | null;
  }> = [];
  const ac = new AbortController();
  h.rpcs.get(watchConversationGraphSubscription.name)!(
    { agentId: "chat-1", workspaceId: "wks_1", language: "zh" },
    {
      paseo: h.paseo,
      push: async (ev: unknown) => {
        convEvents.push(ev as (typeof convEvents)[number]);
      },
      signal: ac.signal,
    },
  );
  const treeEvents: Array<{
    trees: Array<{
      rootAgentId: string;
      totalAgents: number;
      runningCount: number;
    }>;
  }> = [];
  h.rpcs.get(watchActiveTreesSubscription.name)!(
    { language: "zh" },
    {
      paseo: h.paseo,
      push: async (ev: unknown) => {
        treeEvents.push(ev as (typeof treeEvents)[number]);
      },
      signal: ac.signal,
    },
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.getStreamStats().streamListCalls, 1);
  assert.equal(convEvents.length, 1);
  assert.equal(convEvents[0].rootAgentId, "chat-1");
  assert.equal(convEvents[0].tree?.totalAgents, 1);
  assert.equal(treeEvents.length, 1);

  // Live upsert: Developer starts running
  h.emitAgentUpsert({
    id: "dev-live",
    workspaceId: "wks_1",
    cwd: h.workspaceDir,
    status: "running",
    provider: "antigravity",
    model: "gemini-4-neon",
    title: "Developer: live task",
    labels: {
      "paseo.parent-agent-id": "chat-1",
      [TEAM_ROLE_LABEL_KEY]: "developer",
    },
    createdAt: "2026-11-28T01:27:00.000Z",
    updatedAt: "2026-11-28T01:27:00.000Z",
  });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(convEvents.at(-1)?.tree?.totalAgents, 2);
  assert.equal(convEvents.at(-1)?.tree?.runningCount, 1);
  assert.equal(treeEvents.at(-1)?.trees[0].runningCount, 1);

  // Live upsert: Developer finishes idle AND Code Reviewer spawns idle -> both views update immediately
  h.emitAgentUpsert({
    id: "dev-live",
    workspaceId: "wks_1",
    cwd: h.workspaceDir,
    status: "idle",
    provider: "antigravity",
    model: "gemini-4-neon",
    title: "Developer: live task",
    labels: {
      "paseo.parent-agent-id": "chat-1",
      [TEAM_ROLE_LABEL_KEY]: "developer",
    },
    createdAt: "2026-11-28T01:27:00.000Z",
    updatedAt: "2026-11-28T01:42:00.000Z",
  });
  h.emitAgentUpsert({
    id: "rev-live",
    workspaceId: "wks_1",
    cwd: h.workspaceDir,
    status: "idle",
    provider: "claude",
    model: "claude-opus-5-5",
    title: "Review #1",
    labels: {
      "paseo.parent-agent-id": "chat-1",
      [TEAM_ROLE_LABEL_KEY]: "code-reviewer",
    },
    createdAt: "2026-11-28T01:37:00.000Z",
    updatedAt: "2026-11-28T01:43:00.000Z",
  });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(convEvents.at(-1)?.tree?.totalAgents, 3);
  assert.equal(convEvents.at(-1)?.tree?.runningCount, 0);
  assert.equal(treeEvents.at(-1)?.trees[0].totalAgents, 3);
  assert.equal(treeEvents.at(-1)?.trees[0].runningCount, 0);

  // Live remove drops subagent cleanly
  h.emitAgentRemove("rev-live");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(convEvents.at(-1)?.tree?.totalAgents, 2);

  // Aborting all subscribers releases the shared daemon subscription cleanly
  ac.abort();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.getStreamStats().streamReleased, 1);
});
