import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import contribute from "../index.server.ts";
import { controlTaskRpc, startTeamTaskRpc } from "../shared/contracts.ts";
import { saveConfig } from "../server/config-store.ts";
import { subscribeTaskChanges } from "../server/handlers.ts";
import {
  initTask,
  loadTask,
  recordCandidateDelivery,
  recordReviewVerdict,
  registerTaskAgent,
} from "../server/task-store.ts";

process.env.SKIP_DOTENV = "true";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

type HookHandler = (
  payload: Record<string, unknown>,
  context: { paseo: unknown; signal: AbortSignal },
) => Promise<unknown> | unknown;

type RpcHandler = (
  input: unknown,
  context: { paseo: unknown },
) => Promise<unknown> | unknown;

function createPluginHarness(t: test.TestContext) {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "paseo-team-hooks-"));
  const prevState = process.env.XDG_STATE_HOME;
  const prevConfig = process.env.XDG_CONFIG_HOME;
  const stateHome = path.join(baseDir, "state");
  const configHome = path.join(baseDir, "config");
  const workspaceDir = path.join(baseDir, "workspace");
  mkdirSync(stateHome, { recursive: true });
  mkdirSync(configHome, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  process.env.XDG_STATE_HOME = stateHome;
  process.env.XDG_CONFIG_HOME = configHome;

  const hooks = new Map<string, HookHandler>();
  const hookEvents: Array<{ action: "add" | "remove"; name: string }> = [];
  const rpcs = new Map<string, RpcHandler>();
  const sentMessages: Array<{ agentId: string; text: string }> = [];
  const permissionResponses: Array<{
    agentId: string;
    requestId: string;
    response: Record<string, unknown>;
  }> = [];
  const createdAgents: Array<Record<string, unknown>> = [];
  const reloadedAgents: Array<{ agentId: string; requestId?: string }> = [];
  const metadataUpdates: Array<{
    agentId: string;
    patch: Record<string, unknown>;
  }> = [];
  const agentDirectory = new Map<string, Record<string, unknown>>();
  const timelines = new Map<string, unknown[]>();

  let createdSeq = 0;
  const paseoMock = {
    providers: {
      async list() {
        return {
          providers: [
            {
              id: "codex",
              label: "Codex",
              availability: "available",
              availableModes: [{ id: "auto-review" }, { id: "auto" }],
              defaultModeId: "auto-review",
            },
            {
              id: "claude",
              label: "Claude",
              availability: "available",
              availableModes: [{ id: "auto" }, { id: "default" }],
              defaultModeId: "auto",
            },
            {
              id: "antigravity",
              label: "Antigravity",
              availability: "available",
              availableModes: [
                { id: "default" },
                { id: "auto" },
                { id: "full-access" },
              ],
              defaultModeId: "full-access",
            },
          ],
        };
      },
      async models(provider: string) {
        const byProvider: Record<string, Array<Record<string, unknown>>> = {
          codex: [
            {
              id: "gpt-6.2-astra",
              label: "GPT-6.2-Astra",
              thinkingOptions: [{ id: "high", label: "High" }],
              defaultThinkingOptionId: "high",
            },
          ],
          claude: [
            {
              id: "claude-sonnet-5-5",
              label: "Sonnet 5.5",
              thinkingOptions: [{ id: "medium", label: "Medium" }],
              defaultThinkingOptionId: "medium",
            },
          ],
          antigravity: [
            {
              id: "gemini-4-neon",
              label: "Gemini 4 Neon",
              thinkingOptions: [{ id: "xhigh", label: "Extra" }],
              defaultThinkingOptionId: "high",
            },
          ],
        };
        return { models: byProvider[provider] ?? [] };
      },
    },
    workspaces: {
      ref(workspaceId: string) {
        return {
          agents: {
            async create(payload: Record<string, unknown>) {
              createdSeq += 1;
              const id = `created-agent-${createdSeq}`;
              createdAgents.push({ workspaceId, id, ...payload });
              return { id };
            },
          },
        };
      },
    },
    agents: {
      async list() {
        return {
          entries: [...agentDirectory.values()].map((agent) => ({ agent })),
        };
      },
      subscribe() {
        return () => {};
      },
      ref(agentId: string) {
        return {
          async refresh() {
            const agent = agentDirectory.get(agentId);
            return agent ? { agent } : null;
          },
          async setMetadata(patch: Record<string, unknown>) {
            metadataUpdates.push({ agentId, patch });
            const existing = agentDirectory.get(agentId);
            if (existing) {
              existing.metadata = {
                ...((existing.metadata as Record<string, unknown>) ?? {}),
                ...patch,
              };
            }
          },
          async reload(opts?: { requestId?: string }) {
            reloadedAgents.push({ agentId, requestId: opts?.requestId });
            const agent = agentDirectory.get(agentId);
            if (agent?.provider === "codex") {
              throw new Error(
                "thread/items/list is not supported yet requestType=refresh_agent_request code=agent_refresh_failed",
              );
            }
            return agent ? { agent } : null;
          },
          async send(text: string) {
            sentMessages.push({ agentId, text });
          },
          async respondToPermission(opts: {
            requestId: string;
            response: Record<string, unknown>;
          }) {
            permissionResponses.push({
              agentId,
              requestId: opts.requestId,
              response: opts.response,
            });
          },
          timeline: {
            async refetch() {
              return { entries: timelines.get(agentId) ?? [] };
            },
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
      hookEvents.push({ action: "add", name });
      return () => {
        hooks.delete(name);
        hookEvents.push({ action: "remove", name });
      };
    },
  };

  const dispose = contribute(serverMock as never);
  t.after(() => {
    dispose();
    if (prevState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevState;
    if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevConfig;
    rmSync(baseDir, { recursive: true, force: true });
  });

  const controller = new AbortController();
  const hookCtx = { paseo: paseoMock, signal: controller.signal };

  return {
    baseDir,
    stateRoot: path.join(stateHome, "paseo-team"),
    workspaceDir,
    hooks,
    hookEvents,
    rpcs,
    sentMessages,
    permissionResponses,
    createdAgents,
    reloadedAgents,
    metadataUpdates,
    agentDirectory,
    timelines,
    async invokeHook(name: string, payload: Record<string, unknown>) {
      const fn = hooks.get(name);
      assert.ok(fn, `expected hook ${name} to be registered`);
      return await fn(payload, hookCtx);
    },
    async invokeRpc(name: string, input: unknown) {
      const fn = rpcs.get(name);
      assert.ok(fn, `expected RPC ${name} to be registered`);
      return await fn(input, { paseo: paseoMock });
    },
  };
}

const samplePreset = {
  developer: { model: "antigravity/gemini-4-neon", thinking: "xhigh" },
  planReviewers: [
    { model: "claude/claude-sonnet-5-5", thinking: "medium" },
    { model: "codex/gpt-6.2-astra", thinking: "high" },
  ],
  codeReviewers: [
    { model: "claude/claude-sonnet-5-5", thinking: "medium" },
    { model: "codex/gpt-6.2-astra", thinking: "high" },
  ],
  expert: { model: "claude/claude-sonnet-5-5", thinking: "medium" },
  complexMode: "expert" as const,
};

test("contribute registers all five lifecycle hooks", (t) => {
  const h = createPluginHarness(t);
  assert.deepEqual([...h.hooks.keys()].sort(), [
    "agent.create.after",
    "agent.open.before",
    "agent.permission.before",
    "agent.turn.after",
    "agent.turn.before",
  ]);
});

test("agent.create.after registers children from metadata and title prefixes and ignores unrelated agents", async (t) => {
  const h = createPluginHarness(t);
  const { recordPath, record } = initTask({
    cwd: h.workspaceDir,
    goal: "实现复杂迁移并需要方案审查和代码审查",
    teamName: "标准",
    preset: samplePreset,
    isComplex: true,
    requirePlanReview: true,
    requireReview: true,
  });
  record.coordinatorAgentId = "coord-1";
  const coordNode = record.nodes.find((n) => n.nodeId === "coordinator");
  if (coordNode) coordNode.agentId = "coord-1";
  const { saveTask } = await import("../server/task-store.ts");
  saveTask(recordPath, record);

  // 1. Metadata role registers immediately even without bracketed title.
  await h.invokeHook("agent.create.after", {
    agent: {
      id: "exp-1",
      parentAgentId: "coord-1",
      provider: "claude",
      cwd: h.workspaceDir,
      title: "Draft migration architecture",
      background: false,
      metadata: { "paseo-team.task": { role: "expert" } },
    },
  });

  // 2. Generic [Reviewer] before delivery maps to plan-reviewer when planReview=required.
  await h.invokeHook("agent.create.after", {
    agent: {
      id: "plan-rev-1",
      parentAgentId: "coord-1",
      provider: "codex",
      cwd: h.workspaceDir,
      title: "[Reviewer #1] Review plan",
      background: false,
      metadata: {},
    },
  });

  // 3. [Developer] prefix registers developer.
  await h.invokeHook("agent.create.after", {
    agent: {
      id: "dev-1",
      parentAgentId: "coord-1",
      provider: "antigravity",
      cwd: h.workspaceDir,
      title: "[Developer] Implement migration",
      background: false,
      metadata: {},
    },
  });

  // 4. Unrelated agent (no parent / non-coordinator parent / no role signal) is ignored.
  await h.invokeHook("agent.create.after", {
    agent: {
      id: "stranger-1",
      parentAgentId: null,
      provider: "codex",
      cwd: h.workspaceDir,
      title: "[Developer] Unrelated chat",
      background: false,
      metadata: {},
    },
  });
  await h.invokeHook("agent.create.after", {
    agent: {
      id: "child-of-dev",
      parentAgentId: "dev-1",
      provider: "codex",
      cwd: h.workspaceDir,
      title: "[Developer] Nested child",
      background: false,
      metadata: {},
    },
  });

  // 5. After delivery exists, generic [Reviewer] maps to code-reviewer.
  recordCandidateDelivery(recordPath, {
    agentId: "dev-1",
    summary: "d1",
    architectureImpact: "None",
    ciWaivedUserQuote: "waived for hook test",
  });
  await h.invokeHook("agent.create.after", {
    agent: {
      id: "code-rev-1",
      parentAgentId: "coord-1",
      provider: "claude",
      cwd: h.workspaceDir,
      title: "[Reviewer #1] Review code",
      background: false,
      metadata: {},
    },
  });

  const saved = loadTask(recordPath);
  assert.equal(saved.nodes.find((n) => n.agentId === "exp-1")?.role, "expert");
  assert.equal(
    saved.nodes.find((n) => n.agentId === "plan-rev-1")?.role,
    "plan-reviewer",
  );
  assert.equal(
    saved.nodes.find((n) => n.agentId === "dev-1")?.role,
    "developer",
  );
  assert.equal(
    saved.nodes.find((n) => n.agentId === "code-rev-1")?.role,
    "code-reviewer",
  );
  assert.equal(
    saved.nodes.some((n) => n.agentId === "stranger-1"),
    false,
  );
  assert.equal(
    saved.nodes.some((n) => n.agentId === "child-of-dev"),
    false,
  );
});

test("agent.open.before injects role-specific prompts & tools, distinguishes plan vs code reviewers, and skips history/background", async (t) => {
  const h = createPluginHarness(t);
  const { recordPath, record } = initTask({
    cwd: h.workspaceDir,
    goal: "实现新功能并完成方案审查与代码审查",
    teamName: "标准",
    preset: samplePreset,
    isComplex: true,
    requirePlanReview: true,
    requireReview: true,
  });

  const baseReq = {
    workspaceId: "wks_test",
    cwd: h.workspaceDir,
    reason: "create",
    purpose: "interactive",
    background: false,
    labels: {},
    metadata: {},
    appendSystemPrompt: ["EXISTING_SYS_PROMPT"],
    tools: [{ name: "existing_tool" }],
    env: {},
    mcpServers: {},
  };

  // Skips history and background opens.
  assert.equal(
    await h.invokeHook("agent.open.before", {
      request: {
        ...baseReq,
        agentId: "hist-1",
        provider: "claude",
        purpose: "history",
        labels: { task: record.taskId, role: "developer" },
      },
    }),
    undefined,
  );
  assert.equal(
    await h.invokeHook("agent.open.before", {
      request: {
        ...baseReq,
        agentId: "bg-1",
        provider: "antigravity",
        background: true,
        labels: { task: record.taskId, role: "developer" },
      },
    }),
    undefined,
  );

  // 0a. Normal non-team interactive top-level chat gets the single persistent `paseo_team`
  // tool with ZERO appendSystemPrompt pollution (preserving prompt cache on future /paseo-team).
  const normalChatOut = (await h.invokeHook("agent.open.before", {
    request: {
      ...baseReq,
      agentId: "normal-chat-1",
      provider: "codex",
      title: "Casual question",
    },
  })) as {
    appendSystemPrompt: string[];
    tools: Array<{
      name: string;
      execute: (
        args: Record<string, unknown>,
        ctx: Record<string, unknown>,
      ) => Promise<{ text: string; isError?: boolean }>;
    }>;
  };
  assert.deepEqual(normalChatOut.appendSystemPrompt, ["EXISTING_SYS_PROMPT"]);
  assert.deepEqual(
    normalChatOut.tools.map((tool) => tool.name),
    ["existing_tool", "paseo_team"],
  );
  const noTaskRes = await normalChatOut.tools[1].execute(
    { action: "summary" },
    { agent: { id: "normal-chat-1", metadata: {} } },
  );
  assert.equal(noTaskRes.isError, true);
  assert.match(noTaskRes.text, /No active Paseo Team task/);

  // 0b. Non-team subagent (with parent-agent-id not matching a team role) gets undefined.
  assert.equal(
    await h.invokeHook("agent.open.before", {
      request: {
        ...baseReq,
        agentId: "unrelated-sub-1",
        provider: "claude",
        title: "Random helper",
        labels: { "paseo.parent-agent-id": "normal-chat-1" },
      },
    }),
    undefined,
  );

  // 1. Coordinator via metadata (also updates coordinatorAgentId, without mutating appendSystemPrompt).
  const coordOut = (await h.invokeHook("agent.open.before", {
    request: {
      ...baseReq,
      agentId: "coord-open",
      provider: "antigravity",
      title: "[Team] Test",
      metadata: {
        "paseo-team.task": {
          taskId: record.taskId,
          recordPath,
          role: "coordinator",
        },
      },
    },
  })) as { appendSystemPrompt: string[]; tools: Array<{ name: string }> };
  assert.deepEqual(coordOut.appendSystemPrompt, ["EXISTING_SYS_PROMPT"]);
  assert.deepEqual(
    coordOut.tools.map((tool) => tool.name),
    ["existing_tool", "paseo_team"],
  );
  assert.equal(loadTask(recordPath).coordinatorAgentId, "coord-open");

  // 2. Expert via labels -> dedicated prompt, ZERO custom plugin tools.
  const expOut = (await h.invokeHook("agent.open.before", {
    request: {
      ...baseReq,
      agentId: "exp-open",
      provider: "claude",
      title: "Architect draft",
      labels: { task: record.taskId, role: "expert" },
    },
  })) as { appendSystemPrompt: string[]; tools: Array<{ name: string }> };
  assert.match(expOut.appendSystemPrompt[1], /独立专家指引/);
  assert.deepEqual(
    expOut.tools.map((tool) => tool.name),
    ["existing_tool"],
  );

  // 3. Developer via single-active-task title fallback -> dedicated prompt, ZERO custom plugin tools.
  const devOut = (await h.invokeHook("agent.open.before", {
    request: {
      ...baseReq,
      agentId: "dev-open",
      provider: "antigravity",
      title: "[Developer] Build feature",
    },
  })) as { appendSystemPrompt: string[]; tools: Array<{ name: string }> };
  assert.match(devOut.appendSystemPrompt[1], /Developer 指引/);
  assert.deepEqual(
    devOut.tools.map((tool) => tool.name),
    ["existing_tool"],
  );

  // 4. Plan reviewers get plan-review guide, split perspectives, and ZERO custom plugin tools.
  const planRev0 = (await h.invokeHook("agent.open.before", {
    request: {
      ...baseReq,
      agentId: "plan-r0",
      provider: "claude",
      title: "方案审查一",
      labels: { task: record.taskId, role: "plan-reviewer" },
    },
  })) as { appendSystemPrompt: string[]; tools: Array<{ name: string }> };
  const planRev1 = (await h.invokeHook("agent.open.before", {
    request: {
      ...baseReq,
      agentId: "plan-r1",
      provider: "codex",
      title: "方案审查二",
      labels: { task: record.taskId, role: "plan-reviewer" },
    },
  })) as { appendSystemPrompt: string[]; tools: Array<{ name: string }> };
  assert.match(planRev0.appendSystemPrompt[1], /独立方案审查指引/);
  assert.match(planRev0.appendSystemPrompt[1], /需求规格与真实边界/);
  assert.match(planRev1.appendSystemPrompt[1], /独立方案审查指引/);
  assert.match(planRev1.appendSystemPrompt[1], /架构一致性与复杂度删减/);
  assert.deepEqual(
    planRev0.tools.map((tool) => tool.name),
    ["existing_tool"],
  );

  // 5. Code reviewers get code-review guide and ZERO custom plugin tools.
  const codeRev0 = (await h.invokeHook("agent.open.before", {
    request: {
      ...baseReq,
      agentId: "code-r0",
      provider: "antigravity",
      title: "代码审查一",
      labels: { task: record.taskId, role: "code-reviewer" },
    },
  })) as { appendSystemPrompt: string[]; tools: Array<{ name: string }> };
  assert.match(codeRev0.appendSystemPrompt[1], /独立代码审查指引/);
  assert.deepEqual(
    codeRev0.tools.map((tool) => tool.name),
    ["existing_tool"],
  );

  // 6. Resume path via findTaskByAgentId (labels omitted on resume).
  const resumedDev = (await h.invokeHook("agent.open.before", {
    request: {
      ...baseReq,
      reason: "resume",
      agentId: "dev-open",
      provider: "antigravity",
      title: "No prefix on resume",
    },
  })) as { appendSystemPrompt: string[]; tools: Array<{ name: string }> };
  assert.match(resumedDev.appendSystemPrompt[1], /Developer 指引/);

  // 7. Regression: even when a second active task exists in the same workspace and
  // create_agent omits labels.task/labels.role, `paseo.parent-agent-id` + colon-prefixed titles
  // ("Developer: ...", "Code Review #1: ...", "Plan Review #1: ...") bind cleanly with zero custom tools.
  initTask({
    cwd: h.workspaceDir,
    goal: "另一个陈旧的未结项任务（验证多活跃任务下按 parent-agent-id 精准绑定）",
    teamName: "标准",
    preset: samplePreset,
  });
  const colonDev = (await h.invokeHook("agent.open.before", {
    request: {
      ...baseReq,
      agentId: "dev-colon",
      provider: "antigravity",
      title: "Developer: edit temp file",
      labels: { "paseo.parent-agent-id": "coord-open" },
    },
  })) as { appendSystemPrompt: string[]; tools: Array<{ name: string }> };
  assert.match(colonDev.appendSystemPrompt[1], /Developer 指引/);
  assert.deepEqual(
    colonDev.tools.map((tool) => tool.name),
    ["existing_tool"],
  );
  recordCandidateDelivery(recordPath, {
    agentId: "dev-colon",
    summary: "done",
    architectureImpact: "无",
    ciWaivedUserQuote: "waived for colon title test",
  });
  const colonRev = (await h.invokeHook("agent.open.before", {
    request: {
      ...baseReq,
      agentId: "rev-colon-1",
      provider: "claude",
      title: "Code Review #1: spec & edge cases",
      labels: { "paseo.parent-agent-id": "coord-open" },
    },
  })) as { appendSystemPrompt: string[]; tools: Array<{ name: string }> };
  assert.match(colonRev.appendSystemPrompt[1], /独立代码审查指引/);
  assert.deepEqual(
    colonRev.tools.map((tool) => tool.name),
    ["existing_tool"],
  );
  assert.equal(
    loadTask(recordPath).nodes.find((n) => n.agentId === "rev-colon-1")
      ?.briefSummary,
    "spec & edge cases",
  );
  const planReviewNoEr = (await h.invokeHook("agent.open.before", {
    request: {
      ...baseReq,
      agentId: "plan-rev-no-er",
      provider: "claude",
      title: "Plan Review #1: 需求规格与边界",
      labels: { "paseo.parent-agent-id": "coord-open" },
    },
  })) as { appendSystemPrompt: string[]; tools: Array<{ name: string }> };
  assert.match(planReviewNoEr.appendSystemPrompt[1], /独立方案审查指引/);
  assert.equal(
    loadTask(recordPath).nodes.find((n) => n.agentId === "plan-rev-no-er")
      ?.briefSummary,
    "需求规格与边界",
  );
});

test("agent.permission.before handles multi-provider prefixes, prevents Antigravity coord+child deadlock, and blocks foreign/dangerous approvals", async (t) => {
  const h = createPluginHarness(t);
  const { recordPath, record } = initTask({
    cwd: h.workspaceDir,
    goal: "Test permissions across Codex, Claude, Antigravity",
    teamName: "标准",
    preset: samplePreset,
    requireReview: true,
  });
  record.coordinatorAgentId = "coord-ag";
  const coordNode = record.nodes.find((n) => n.nodeId === "coordinator");
  if (coordNode) coordNode.agentId = "coord-ag";
  const { saveTask } = await import("../server/task-store.ts");
  saveTask(recordPath, record);
  registerTaskAgent(recordPath, {
    role: "developer",
    agentId: "dev-claude",
    profile: "claude/claude-sonnet-5-5",
    briefSummary: "Dev",
  });
  registerTaskAgent(recordPath, {
    role: "code-reviewer",
    agentId: "rev-ag",
    profile: "antigravity/gemini-3.8-flash",
    briefSummary: "Reviewer",
  });

  const allowActions = [
    { id: "allow-once", label: "Allow", behavior: "allow" },
    { id: "deny", label: "Deny", behavior: "deny" },
  ];

  // 1. Non-tool permission kinds (e.g. request_user_input question) must NEVER be auto-approved.
  await h.invokeHook("agent.permission.before", {
    agent: {
      id: "coord-ag",
      parentAgentId: null,
      provider: "antigravity",
      cwd: h.workspaceDir,
      title: "[Team] Test",
      background: false,
      metadata: {},
    },
    request: {
      id: "perm-question",
      provider: "antigravity",
      name: "mcp_paseo_create_agent",
      kind: "question",
      actions: allowActions,
    },
  });
  assert.equal(h.permissionResponses.length, 0);

  // 2. Coordinator calls `paseo_team`, `list_pending_permissions`, scoped `respond_to_permission`, and `create_agent`.
  await h.invokeHook("agent.permission.before", {
    agent: {
      id: "coord-ag",
      parentAgentId: null,
      provider: "antigravity",
      cwd: h.workspaceDir,
      title: "[Team] Test",
      background: false,
      metadata: {},
    },
    request: {
      id: "perm-coord-team",
      provider: "antigravity",
      name: "mcp_paseo_paseo_team",
      kind: "tool",
      actions: allowActions,
    },
  });
  await h.invokeHook("agent.permission.before", {
    agent: {
      id: "coord-ag",
      parentAgentId: null,
      provider: "antigravity",
      cwd: h.workspaceDir,
      title: "[Team] Test",
      background: false,
      metadata: {},
    },
    request: {
      id: "perm-list-pending",
      provider: "antigravity",
      name: "mcp_paseo_list_pending_permissions",
      kind: "tool",
      actions: allowActions,
    },
  });
  await h.invokeHook("agent.permission.before", {
    agent: {
      id: "coord-ag",
      parentAgentId: null,
      provider: "antigravity",
      cwd: h.workspaceDir,
      title: "[Team] Test",
      background: false,
      metadata: {},
    },
    request: {
      id: "perm-resp-child",
      provider: "antigravity",
      name: "mcp_paseo_respond_to_permission",
      kind: "tool",
      input: { agentId: "rev-ag", requestId: "perm-child-action" },
      actions: allowActions,
    },
  });
  await h.invokeHook("agent.permission.before", {
    agent: {
      id: "coord-ag",
      parentAgentId: null,
      provider: "codex",
      cwd: h.workspaceDir,
      title: "[Team] Test",
      background: false,
      metadata: {},
    },
    request: {
      id: "perm-codex-dot",
      provider: "codex",
      name: "paseo.create_agent",
      kind: "tool",
      actions: allowActions,
    },
  });

  // 3. Blocked: foreign agent permission response, dangerous kill_agent, shell, and developer calling coordinator tool.
  for (const blocked of [
    {
      agentId: "coord-ag",
      id: "perm-foreign-resp",
      name: "mcp_paseo_respond_to_permission",
      input: { agentId: "user-personal-chat", requestId: "perm-other" },
    },
    {
      agentId: "coord-ag",
      id: "perm-kill",
      name: "mcp_paseo_kill_agent",
      input: { agentId: "dev-claude" },
    },
    {
      agentId: "coord-ag",
      id: "perm-shell",
      name: "run_command",
      input: { CommandLine: "rm -rf /" },
    },
    {
      agentId: "dev-claude",
      id: "perm-dev-escalate",
      name: "mcp_paseo_create_agent",
      input: {},
    },
  ]) {
    await h.invokeHook("agent.permission.before", {
      agent: {
        id: blocked.agentId,
        parentAgentId: blocked.agentId === "coord-ag" ? null : "coord-ag",
        provider: "antigravity",
        cwd: h.workspaceDir,
        title: "Agent",
        background: false,
        metadata: {},
      },
      request: {
        id: blocked.id,
        provider: "antigravity",
        name: blocked.name,
        kind: "tool",
        input: blocked.input,
        actions: allowActions,
      },
    });
  }

  assert.deepEqual(
    h.permissionResponses.map((r) => [r.agentId, r.requestId, r.response]),
    [
      [
        "coord-ag",
        "perm-coord-team",
        { behavior: "allow", selectedActionId: "allow-once" },
      ],
      [
        "coord-ag",
        "perm-list-pending",
        { behavior: "allow", selectedActionId: "allow-once" },
      ],
      [
        "coord-ag",
        "perm-resp-child",
        { behavior: "allow", selectedActionId: "allow-once" },
      ],
      [
        "coord-ag",
        "perm-codex-dot",
        { behavior: "allow", selectedActionId: "allow-once" },
      ],
    ],
  );
});

test("agent.turn.before notifies subscribers and agent.turn.after passively parses native member replies without sending plugin reminders", async (t) => {
  const h = createPluginHarness(t);
  const { recordPath, record } = initTask({
    cwd: h.workspaceDir,
    goal: "测试单轨原生回合观测钩子",
    teamName: "标准",
    preset: samplePreset,
    requireReview: true,
  });
  record.coordinatorAgentId = "coord-turn";
  const coordNode = record.nodes.find((n) => n.nodeId === "coordinator");
  if (coordNode) coordNode.agentId = "coord-turn";
  const { saveTask } = await import("../server/task-store.ts");
  saveTask(recordPath, record);
  registerTaskAgent(recordPath, {
    role: "developer",
    agentId: "dev-turn",
    profile: "antigravity/gemini-4-neon",
    briefSummary: "Dev",
  });
  registerTaskAgent(recordPath, {
    role: "code-reviewer",
    agentId: "rev-turn",
    profile: "claude/claude-opus-5-5",
    briefSummary: "Rev",
  });

  let notifications = 0;
  const unsub = subscribeTaskChanges(() => {
    notifications += 1;
  });
  t.after(unsub);

  // turn.before notifies for task agent.
  await h.invokeHook("agent.turn.before", {
    agent: { id: "dev-turn" },
    turnId: "t1",
  });
  await new Promise((r) => setTimeout(r, 160));
  assert.ok(notifications >= 1, "agent.turn.before should notify task changes");

  // Failed turn -> never parsed or recorded, zero plugin messages.
  h.timelines.set("dev-turn", [
    {
      turnId: "t-d0",
      item: { type: "assistant_message", text: "Checks: PASS" },
    },
  ]);
  await h.invokeHook("agent.turn.after", {
    agent: { id: "dev-turn" },
    turnId: "t-d0",
    outcome: { kind: "failed", error: { message: "boom" } },
  });
  assert.equal(loadTask(recordPath).delivery, null);
  assert.equal(h.sentMessages.length, 0);

  // Completed Developer turn -> delivery & CI pass parsed passively from native reply.
  h.timelines.set("dev-turn", [
    {
      turnId: "t-d1",
      item: {
        type: "assistant_message",
        text: "摘要：完成改动\n检查：通过（npm test 12/12）\n架构影响：无",
      },
    },
  ]);
  await h.invokeHook("agent.turn.after", {
    agent: { id: "dev-turn" },
    turnId: "t-d1",
    outcome: { kind: "completed" },
  });
  assert.equal(loadTask(recordPath).candidate, "delivery-r1");
  assert.equal(loadTask(recordPath).ci?.status, "pass");
  assert.equal(h.sentMessages.length, 0);

  // Reviewer asking a clarifying question (no verdict) -> updates summary passively, NEVER sends a reminder!
  h.timelines.set("rev-turn", [
    {
      turnId: "t-r-q",
      item: {
        type: "assistant_message",
        text: "先确认一下：需要兼容旧格式吗？",
      },
    },
  ]);
  await h.invokeHook("agent.turn.after", {
    agent: { id: "rev-turn" },
    turnId: "t-r-q",
    outcome: { kind: "completed" },
  });
  assert.equal(loadTask(recordPath).codeReviewers.length, 0);
  assert.equal(h.sentMessages.length, 0);

  // Reviewer finishing review with native verdict -> passively recorded with findings!
  h.timelines.set("rev-turn", [
    {
      turnId: "t-r1",
      item: {
        type: "assistant_message",
        text: "结论：REQUEST_CHANGES\n摘要：缺少空值判断\n- 阻断：app.ts:10 未处理空值",
      },
    },
  ]);
  await h.invokeHook("agent.turn.after", {
    agent: { id: "rev-turn" },
    turnId: "t-r1",
    outcome: { kind: "completed" },
  });
  const afterRev = loadTask(recordPath);
  assert.equal(afterRev.codeReviewers.length, 1);
  assert.equal(afterRev.codeReviewers[0].status, "REQUEST_CHANGES");
  assert.deepEqual(afterRev.codeReviewers[0].findings, [
    "blocking: app.ts:10 未处理空值",
  ]);
  assert.equal(h.sentMessages.length, 0);

  // Abandoned task -> turn.after ignores further replies cleanly.
  await h.invokeRpc(controlTaskRpc.name, {
    recordPath,
    action: "abandon_task",
    language: "zh",
  });
  h.timelines.set("rev-turn", [
    {
      turnId: "t-r2",
      item: { type: "assistant_message", text: "结论：APPROVE" },
    },
  ]);
  await h.invokeHook("agent.turn.after", {
    agent: { id: "rev-turn" },
    turnId: "t-r2",
    outcome: { kind: "completed" },
  });
  assert.equal(loadTask(recordPath).codeReviewers[0].status, "REQUEST_CHANGES");
  assert.equal(h.sentMessages.length, 0);
});

test("full L2 plugin pipeline: tasks.start -> open.before tools -> run_check -> R1 rework -> R2 dual approve -> complete", async (t) => {
  const h = createPluginHarness(t);
  saveConfig({
    schemaVersion: 5,
    default: "标准",
    projects: {},
    teams: {
      标准: {
        developer: { model: "antigravity/gemini-4-neon", thinking: "xhigh" },
        codeReviewers: [
          { model: "claude/claude-sonnet-5-5", thinking: "medium" },
          { model: "codex/gpt-6.2-astra", thinking: "high" },
        ],
        separatePlanReviewers: false,
        planReviewers: [
          { model: "claude/claude-sonnet-5-5", thinking: "medium" },
          { model: "codex/gpt-6.2-astra", thinking: "high" },
        ],
        expert: { model: "claude/claude-sonnet-5-5", thinking: "medium" },
        complexMode: "simple",
      },
    },
  });
  // Use Codex as the open chat provider to guard against refresh_agent_request /
  // hydrateTimelineFromProvider (`thread/items/list is not supported yet`).
  h.agentDirectory.set("launcher-1", {
    id: "launcher-1",
    status: "idle",
    provider: "codex",
    model: "gpt-6.2-astra",
    thinkingOptionId: "high",
  });

  // Guard: starting /paseo-team while the chat is mid-turn is rejected cleanly.
  h.agentDirectory.set("busy-chat", {
    id: "busy-chat",
    status: "running",
    provider: "claude",
    model: "claude-sonnet-5-5",
  });
  await assert.rejects(
    () =>
      h.invokeRpc(startTeamTaskRpc.name, {
        cwd: h.workspaceDir,
        workspaceId: "wks_l2",
        agentId: "busy-chat",
        rawArgs: "Should not interrupt running chat",
      }),
    /currently running/,
  );

  const openToolMap = async (req: Record<string, unknown>) => {
    const out = (await h.invokeHook("agent.open.before", {
      request: {
        workspaceId: "wks_l2",
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
        ...req,
      },
    })) as {
      tools: Array<{
        name: string;
        execute: (
          args: Record<string, unknown>,
          context?: Record<string, unknown>,
        ) => Promise<{
          text: string;
          isError?: boolean;
        }>;
      }>;
    };
    return new Map(out.tools.map((tool) => [tool.name, tool]));
  };

  // Simulate opening the user's normal chat BEFORE `/paseo-team` is ever invoked.
  // Its persistent `paseo_team` tool is registered once at initial open and never reloaded!
  const coordTools = await openToolMap({
    agentId: "launcher-1",
    provider: "codex",
    title: "Existing user chat",
  });
  assert.ok(coordTools.has("paseo_team"));

  const hookEventsBeforeStart = h.hookEvents.length;
  const started = (await h.invokeRpc(startTeamTaskRpc.name, {
    cwd: h.workspaceDir,
    workspaceId: "wks_l2",
    agentId: "launcher-1",
    rawArgs: "Update label in app.txt, with code review",
  })) as { taskId: string; recordPath: string; coordinatorAgentId: string };

  // Current chat becomes the coordinator directly with ZERO reloads and ZERO hook invalidations,
  // keeping prompt prefix caches 100% intact across all providers.
  assert.equal(h.createdAgents.length, 0);
  assert.equal(started.coordinatorAgentId, "launcher-1");
  assert.equal(h.metadataUpdates.length, 1);
  assert.equal(h.metadataUpdates[0].agentId, "launcher-1");
  assert.equal(h.reloadedAgents.length, 0);
  assert.deepEqual(h.hookEvents.slice(hookEventsBeforeStart), []);
  assert.equal(h.hooks.has("agent.open.before"), true);
  assert.equal(h.sentMessages.length, 1);
  assert.equal(h.sentMessages[0].agentId, "launcher-1");
  assert.match(h.sentMessages[0].text, /\[Team Kickoff\]/);
  assert.match(h.sentMessages[0].text, /`paseo_team`/);
  assert.match(h.sentMessages[0].text, /action: "set_route"/);
  assert.match(h.sentMessages[0].text, /Plan Reviewer #1/);
  assert.match(h.sentMessages[0].text, /antigravity\/gemini-4-neon/);
  // Task starts in pending-route state until coordinator declares complexity & route.
  assert.equal(loadTask(started.recordPath).routeDecided, false);
  h.sentMessages.length = 0;

  const coordCtx = () => ({
    agent: {
      id: "launcher-1",
      metadata: h.agentDirectory.get("launcher-1")?.metadata ?? {},
    },
  });
  const teamTool = coordTools.get("paseo_team")!;

  // Validation guards on missing fields return clean errors without mutating task state.
  assert.equal(
    (await teamTool.execute({ action: "set_route" }, coordCtx())).isError,
    true,
  );
  assert.equal(
    (await teamTool.execute({ action: "update" }, coordCtx())).isError,
    true,
  );

  // Summary works immediately via dynamic context resolution without any reload.
  const sumRes = await teamTool.execute({ action: "summary" }, coordCtx());
  assert.notEqual(sumRes.isError, true);
  assert.match(sumRes.text, new RegExp(started.taskId));

  // Coordinator assesses complexity & locks route via paseo_team(set_route) before dispatching members.
  const routeRes = await teamTool.execute(
    {
      action: "set_route",
      isComplex: false,
      planReview: false,
      codeReview: true,
      reason:
        "Localized single-file label update with user-requested code review",
    },
    coordCtx(),
  );
  assert.notEqual(routeRes.isError, true);
  assert.equal(loadTask(started.recordPath).routeDecided, true);
  assert.equal(loadTask(started.recordPath).planReview, "not-required");
  assert.equal(loadTask(started.recordPath).codeReview, "required");

  // Subagents open with ZERO custom plugin tools (100% native Paseo messaging).
  const devTools = await openToolMap({
    agentId: "dev-l2",
    provider: "antigravity",
    title: "Developer",
    labels: { task: started.taskId, role: "developer" },
  });
  const rev0Tools = await openToolMap({
    agentId: "rev-l2-0",
    provider: "claude",
    title: "CR #1",
    labels: { task: started.taskId, role: "code-reviewer" },
  });
  const rev1Tools = await openToolMap({
    agentId: "rev-l2-1",
    provider: "codex",
    title: "CR #2",
    labels: { task: started.taskId, role: "code-reviewer" },
  });
  assert.equal(devTools.size, 0);
  assert.equal(rev0Tools.size, 0);
  assert.equal(rev1Tools.size, 0);

  // R1: Developer replies natively after running tests -> agent.turn.after passively records delivery & CI pass.
  writeFileSync(path.join(h.workspaceDir, "app.txt"), "v1\n");
  h.timelines.set("dev-l2", [
    {
      turnId: "dev-r1",
      item: {
        type: "assistant_message",
        text: "Summary: Implemented v1 in app.txt\nChecks: PASS (tests ok r1)\nArchitecture impact: None",
      },
    },
  ]);
  await h.invokeHook("agent.turn.after", {
    agent: { id: "dev-l2" },
    turnId: "dev-r1",
    outcome: { kind: "completed" },
  });
  assert.equal(loadTask(started.recordPath).candidate, "delivery-r1");
  assert.equal(loadTask(started.recordPath).ci?.status, "pass");

  // R1 review: rev0 replies APPROVE, rev1 replies REQUEST_CHANGES -> passively recorded; gate still blocked.
  h.timelines.set("rev-l2-0", [
    {
      turnId: "r1-0",
      item: {
        type: "assistant_message",
        text: "Verdict: APPROVE\nSummary: Looks good",
      },
    },
  ]);
  h.timelines.set("rev-l2-1", [
    {
      turnId: "r1-1",
      item: {
        type: "assistant_message",
        text: "Verdict: REQUEST_CHANGES\nSummary: Needs edge fix\n- blocking: app.txt:1 missing newline check",
      },
    },
  ]);
  await h.invokeHook("agent.turn.after", {
    agent: { id: "rev-l2-0" },
    turnId: "r1-0",
    outcome: { kind: "completed" },
  });
  await h.invokeHook("agent.turn.after", {
    agent: { id: "rev-l2-1" },
    turnId: "r1-1",
    outcome: { kind: "completed" },
  });

  const blockedComplete = await teamTool.execute(
    { action: "complete" },
    coordCtx(),
  );
  assert.equal(blockedComplete.isError, true);
  assert.match(blockedComplete.text, /Quality gate BLOCKED/);

  // R2 rework: Developer replies natively with fresh passing check -> selective R2 re-review by rev1 only!
  await new Promise((r) => setTimeout(r, 15));
  writeFileSync(path.join(h.workspaceDir, "app.txt"), "v2\n");
  h.timelines.set("dev-l2", [
    {
      turnId: "dev-r2",
      item: {
        type: "assistant_message",
        text: "Summary: Fixed blocking finding in v2\nChecks: PASS (tests ok r2)\nArchitecture impact: None",
      },
    },
  ]);
  await h.invokeHook("agent.turn.after", {
    agent: { id: "dev-l2" },
    turnId: "dev-r2",
    outcome: { kind: "completed" },
  });
  assert.equal(loadTask(started.recordPath).candidate, "delivery-r2");

  // Selective R2: rev1 approves (rev0 already approved in R1).
  h.timelines.set("rev-l2-1", [
    {
      turnId: "r2-1",
      item: {
        type: "assistant_message",
        text: "Verdict: APPROVE\nSummary: Fix confirmed",
      },
    },
  ]);
  await h.invokeHook("agent.turn.after", {
    agent: { id: "rev-l2-1" },
    turnId: "r2-1",
    outcome: { kind: "completed" },
  });

  // Final quality gate passes and marks task completed.
  const done = await teamTool.execute({ action: "complete" }, coordCtx());
  assert.equal(done.isError, false);
  assert.match(done.text, /Quality gate READY; task completed/);
  assert.equal(loadTask(started.recordPath).lifecycleStatus, "completed");

  // Mutating an already-completed task is rejected cleanly until a new task starts.
  const mutateCompleted = await teamTool.execute(
    {
      action: "set_route",
      isComplex: false,
      planReview: false,
      codeReview: false,
      reason: "late edit",
    },
    coordCtx(),
  );
  assert.equal(mutateCompleted.isError, true);
  assert.match(mutateCompleted.text, /already completed/);

  // Starting a 2nd task on the SAME chat automatically routes the same persistent `paseo_team`
  // tool to task #2 with ZERO reload, and supports `force: true` with user ruling reason.
  const started2 = (await h.invokeRpc(startTeamTaskRpc.name, {
    cwd: h.workspaceDir,
    workspaceId: "wks_l2",
    agentId: "launcher-1",
    rawArgs: "Second follow-up task, no review",
  })) as { taskId: string; recordPath: string };
  assert.notEqual(started2.taskId, started.taskId);
  const sum2 = await teamTool.execute({ action: "summary" }, coordCtx());
  assert.match(sum2.text, new RegExp(started2.taskId));
  assert.equal(
    (await teamTool.execute({ action: "complete", force: true }, coordCtx()))
      .isError,
    true,
  );
  const forced = await teamTool.execute(
    { action: "complete", force: true, reason: "User accepted as-is in chat" },
    coordCtx(),
  );
  assert.notEqual(forced.isError, true);
  assert.equal(loadTask(started2.recordPath).lifecycleStatus, "completed");
  h.sentMessages.length = 0;

  // Zero spurious plugin messages after task completion.
  for (const memberId of ["dev-l2", "rev-l2-0", "rev-l2-1"]) {
    await h.invokeHook("agent.turn.after", {
      agent: { id: memberId },
      turnId: `final-${memberId}`,
      outcome: { kind: "completed" },
    });
  }
  assert.equal(h.sentMessages.length, 0);
});

test("regression: task started without plan review dynamically upgrades to planReview=required when user requests plan review mid-chat", async (t) => {
  const h = createPluginHarness(t);
  saveConfig({
    schemaVersion: 5,
    default: "标准",
    projects: {},
    teams: {
      标准: {
        developer: { model: "antigravity/gemini-4-neon", thinking: "xhigh" },
        codeReviewers: [
          { model: "claude/claude-sonnet-5-5", thinking: "medium" },
          { model: "codex/gpt-6.2-astra", thinking: "high" },
        ],
        separatePlanReviewers: true,
        planReviewers: [
          { model: "claude/claude-sonnet-5-5", thinking: "medium" },
          { model: "codex/gpt-6.2-astra", thinking: "high" },
        ],
        expert: { model: "claude/claude-sonnet-5-5", thinking: "medium" },
        complexMode: "simple",
      },
    },
  });
  h.agentDirectory.set("main-chat-7e7bc091", {
    id: "main-chat-7e7bc091",
    status: "idle",
    provider: "claude",
    model: "claude-sonnet-5-5",
    thinkingOptionId: "medium",
  });

  // 1. User runs `/paseo-team 开始开发，但是先别部署。` without mentioning plan review.
  const started = (await h.invokeRpc(startTeamTaskRpc.name, {
    cwd: h.workspaceDir,
    workspaceId: "wks_pm",
    agentId: "main-chat-7e7bc091",
    rawArgs: "开始开发，但是先别部署。",
  })) as { taskId: string; recordPath: string; coordinatorAgentId: string };

  assert.equal(h.createdAgents.length, 0);
  assert.equal(started.coordinatorAgentId, "main-chat-7e7bc091");
  assert.equal(loadTask(started.recordPath).planReview, "not-required");

  // 2. User later sends "需要方案评审" in the chat -> Coordinator writes plan.md, calls update(planFile), and spawns plan reviewers.
  const openOut = (await h.invokeHook("agent.open.before", {
    request: {
      workspaceId: "wks_pm",
      cwd: h.workspaceDir,
      reason: "create",
      purpose: "interactive",
      background: false,
      agentId: "main-chat-7e7bc091",
      provider: "claude",
      title: "搭建套利系统分层 Loss 回测",
      labels: {},
      metadata: h.agentDirectory.get("main-chat-7e7bc091")?.metadata ?? {},
      appendSystemPrompt: [],
      tools: [],
      env: {},
      mcpServers: {},
    },
  })) as {
    tools: Array<{
      name: string;
      execute: (
        args: Record<string, unknown>,
        context?: Record<string, unknown>,
      ) => Promise<{
        text: string;
        isError?: boolean;
      }>;
    }>;
  };
  const coordTools = new Map(openOut.tools.map((tool) => [tool.name, tool]));
  const coordCtx = {
    agent: {
      id: "main-chat-7e7bc091",
      metadata: h.agentDirectory.get("main-chat-7e7bc091")?.metadata ?? {},
    },
  };
  const taskDir = path.dirname(started.recordPath);
  writeFileSync(path.join(taskDir, "plan.md"), "# 方案 v1\n");
  const planRes = await coordTools.get("paseo_team")!.execute(
    {
      action: "update",
      planFile: "plan.md",
      summary: "方案 v1",
    },
    coordCtx,
  );
  assert.notEqual(planRes.isError, true);

  await h.invokeHook("agent.create.after", {
    agent: {
      id: "plan-rev-1",
      parentAgentId: "main-chat-7e7bc091",
      provider: "claude",
      cwd: h.workspaceDir,
      title: "[Plan Reviewer #1] 需求规格与边界",
      background: false,
      metadata: {},
    },
  });

  const upgraded = loadTask(started.recordPath);
  assert.equal(upgraded.planReview, "required");
  const blockedGate = await coordTools.get("paseo_team")!.execute(
    {
      action: "complete",
      inspectOnly: true,
    },
    coordCtx,
  );
  assert.equal(blockedGate.isError, true);
  assert.match(blockedGate.text, /plan-rev-1/);

  // Regression (a37abfe6): when Plan Review hits R2 circuit breaker and the user chooses
  // to waive remaining plan review in chat, coordinator calls `paseo_team(update)` with decision="waive_stage"
  // to unlock the task and let the Quality Gate pass after development!
  recordReviewVerdict(started.recordPath, {
    stage: "plan",
    agentId: "plan-rev-1",
    round: 1,
    verdict: "REQUEST_CHANGES",
    summary: "Fix R1",
    findings: ["blocking: plan.md:1 fix R1"],
  });
  const broken = recordReviewVerdict(started.recordPath, {
    stage: "plan",
    agentId: "plan-rev-1",
    round: 2,
    verdict: "REQUEST_CHANGES",
    summary: "Fix R2",
    findings: ["blocking: plan.md:2 fix R2"],
  });
  assert.equal(broken.status, "CIRCUIT_BROKEN");
  assert.equal(loadTask(started.recordPath).lifecycleStatus, "blocked");

  // Validation error if reason is missing when decision is given.
  assert.equal(
    (
      await coordTools
        .get("paseo_team")!
        .execute({ action: "update", decision: "waive_stage" }, coordCtx)
    ).isError,
    true,
  );

  const waived = await coordTools.get("paseo_team")!.execute(
    {
      action: "update",
      decision: "waive_stage",
      stage: "plan",
      reason: "用户选择写前拦截后跳过第3轮方案评审直接开发",
    },
    coordCtx,
  );
  assert.notEqual(waived.isError, true);
  assert.equal(loadTask(started.recordPath).lifecycleStatus, "active");
  assert.equal(loadTask(started.recordPath).planReview, "waived");
  assert.equal(loadTask(started.recordPath).circuitBroken, null);

  // Summary includes the latest review findings directly so coordinator doesn't shell out.
  const sum = await coordTools
    .get("paseo_team")!
    .execute({ action: "summary" }, coordCtx);
  assert.match(sum.text, /blocking: plan\.md:2 fix R2/);

  // After Developer delivers with passing CI (and codeReview not-required), `complete` succeeds!
  recordCandidateDelivery(started.recordPath, {
    summary: "Implemented per user-approved v3",
    architectureImpact: "无",
    ciWaivedUserQuote: "CI waived for regression test",
  });
  const completed = await coordTools
    .get("paseo_team")!
    .execute({ action: "complete" }, coordCtx);
  assert.equal(completed.isError, false);
  assert.equal(loadTask(started.recordPath).lifecycleStatus, "completed");
});
