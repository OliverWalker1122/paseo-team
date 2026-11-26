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

  // 1. Coordinator via metadata (also updates coordinatorAgentId).
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
  assert.equal(coordOut.appendSystemPrompt[0], "EXISTING_SYS_PROMPT");
  assert.match(coordOut.appendSystemPrompt[1], /主控协调协议/);
  assert.deepEqual(
    coordOut.tools.map((tool) => tool.name),
    [
      "existing_tool",
      "paseo_team_task_summary",
      "paseo_team_set_route",
      "paseo_team_submit_plan",
      "paseo_team_record_delivery",
      "paseo_team_record_review",
      "paseo_team_complete",
    ],
  );
  assert.equal(loadTask(recordPath).coordinatorAgentId, "coord-open");

  // 2. Expert via labels.
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
    ["existing_tool", "paseo_team_submit_plan"],
  );

  // 3. Developer via single-active-task title fallback (no labels, no metadata).
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
    ["existing_tool", "paseo_team_run_check", "paseo_team_submit_delivery"],
  );

  // 4. Plan reviewers get plan-review guide and split perspectives.
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
    ["existing_tool", "paseo_team_submit_review"],
  );

  // 5. Code reviewers get code-review guide.
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
    ["existing_tool", "paseo_team_submit_review"],
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

  // 7. Regression (Claude resumed coordinator): even when a second active task exists in the same workspace
  // and create_agent omits `labels.task`/`labels.role`, `paseo.parent-agent-id` + colon-prefixed titles
  // ("Developer: ...", "Reviewer #1: ...") deterministically attach member tools to the parent coordinator's task.
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
    ["existing_tool", "paseo_team_run_check", "paseo_team_submit_delivery"],
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
      title: "Reviewer #1: spec & edge cases",
      labels: { "paseo.parent-agent-id": "coord-open" },
    },
  })) as { appendSystemPrompt: string[]; tools: Array<{ name: string }> };
  assert.match(colonRev.appendSystemPrompt[1], /独立代码审查指引/);
  assert.deepEqual(
    colonRev.tools.map((tool) => tool.name),
    ["existing_tool", "paseo_team_submit_review"],
  );
  assert.equal(
    loadTask(recordPath).nodes.find((n) => n.agentId === "rev-colon-1")
      ?.briefSummary,
    "spec & edge cases",
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

  // 2. Antigravity reviewer submits review -> auto-allowed AND remembered.
  await h.invokeHook("agent.permission.before", {
    agent: {
      id: "rev-ag",
      parentAgentId: "coord-ag",
      provider: "antigravity",
      cwd: h.workspaceDir,
      title: "Code Reviewer #1",
      background: false,
      metadata: {},
    },
    request: {
      id: "perm-rev-submit",
      provider: "antigravity",
      name: "mcp_paseo_paseo_team_submit_review",
      kind: "tool",
      actions: allowActions,
    },
  });

  // 3. Antigravity coordinator checks pending permissions & responds for child -> auto-allowed (T19 fix).
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
      input: { agentId: "rev-ag", requestId: "perm-rev-submit" },
      actions: allowActions,
    },
  });

  // 4. Codex dot-prefix & Claude double-underscore prefix work too.
  await h.invokeHook("agent.permission.before", {
    agent: {
      id: "dev-claude",
      parentAgentId: "coord-ag",
      provider: "claude",
      cwd: h.workspaceDir,
      title: "Dev",
      background: false,
      metadata: {},
    },
    request: {
      id: "perm-dev-check",
      provider: "claude",
      name: "mcp__paseo__paseo_team_run_check",
      kind: "tool",
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

  // 5. Blocked: foreign agent permission response, dangerous kill_agent, shell, and developer calling coordinator tool.
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

  // 6. Unregistered child fallback for run_check under active coordinator.
  await h.invokeHook("agent.permission.before", {
    agent: {
      id: "dev-race",
      parentAgentId: "coord-ag",
      provider: "antigravity",
      cwd: h.workspaceDir,
      title: "Unregistered dev",
      background: false,
      metadata: {},
    },
    request: {
      id: "perm-race-check",
      provider: "antigravity",
      name: "mcp_paseo_paseo_team_run_check",
      kind: "tool",
      actions: allowActions,
    },
  });

  assert.deepEqual(
    h.permissionResponses.map((r) => [r.agentId, r.requestId, r.response]),
    [
      [
        "rev-ag",
        "perm-rev-submit",
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
        "dev-claude",
        "perm-dev-check",
        { behavior: "allow", selectedActionId: "allow-once" },
      ],
      [
        "coord-ag",
        "perm-codex-dot",
        { behavior: "allow", selectedActionId: "allow-once" },
      ],
      [
        "dev-race",
        "perm-race-check",
        { behavior: "allow", selectedActionId: "allow-once" },
      ],
    ],
  );
});

test("agent.turn.before notifies subscribers and agent.turn.after reminds once per missed handoff without nagging coordinators or failures", async (t) => {
  const h = createPluginHarness(t);
  const { recordPath, record } = initTask({
    cwd: h.workspaceDir,
    goal: "测试交接提醒钩子",
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

  // Coordinator turn end -> never reminded.
  await h.invokeHook("agent.turn.after", {
    agent: { id: "coord-turn" },
    turnId: "t-c1",
    outcome: { kind: "completed" },
  });
  assert.equal(h.sentMessages.length, 0);

  // Reviewer before any delivery -> never reminded.
  await h.invokeHook("agent.turn.after", {
    agent: { id: "rev-turn" },
    turnId: "t-r0",
    outcome: { kind: "completed" },
  });
  assert.equal(h.sentMessages.length, 0);

  // Failed turn -> never reminded.
  await h.invokeHook("agent.turn.after", {
    agent: { id: "dev-turn" },
    turnId: "t-d0",
    outcome: { kind: "failed", error: { message: "boom" } },
  });
  assert.equal(h.sentMessages.length, 0);

  // Developer completed turn without submit_delivery -> reminded ONCE in Chinese.
  await h.invokeHook("agent.turn.after", {
    agent: { id: "dev-turn" },
    turnId: "t-d1",
    outcome: { kind: "completed" },
  });
  assert.equal(h.sentMessages.length, 1);
  assert.equal(h.sentMessages[0].agentId, "dev-turn");
  assert.match(h.sentMessages[0].text, /\[Team 交接检查\]/);
  assert.match(h.sentMessages[0].text, /`paseo_team_submit_delivery`/);

  // Second missed turn -> NO duplicate reminder.
  await h.invokeHook("agent.turn.after", {
    agent: { id: "dev-turn" },
    turnId: "t-d2",
    outcome: { kind: "completed" },
  });
  assert.equal(h.sentMessages.length, 1);

  // After delivery exists, reviewer missing submit_review gets reminded once.
  recordCandidateDelivery(recordPath, {
    agentId: "dev-turn",
    summary: "done",
    architectureImpact: "无",
    ciWaivedUserQuote: "waived for turn test",
  });
  await h.invokeHook("agent.turn.after", {
    agent: { id: "rev-turn" },
    turnId: "t-r1",
    outcome: { kind: "completed" },
  });
  assert.equal(h.sentMessages.length, 2);
  assert.equal(h.sentMessages[1].agentId, "rev-turn");
  assert.match(h.sentMessages[1].text, /`paseo_team_submit_review`/);

  // Abandoned task -> no reminders.
  await h.invokeRpc(controlTaskRpc.name, {
    recordPath,
    action: "abandon_task",
    language: "zh",
  });
  registerTaskAgent(recordPath, {
    role: "code-reviewer",
    agentId: "rev-turn-2",
    profile: "codex/gpt-6.2-astra",
    briefSummary: "Rev 2",
  });
  await h.invokeHook("agent.turn.after", {
    agent: { id: "rev-turn-2" },
    turnId: "t-r2",
    outcome: { kind: "completed" },
  });
  assert.equal(h.sentMessages.length, 2);
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

  const hookEventsBeforeStart = h.hookEvents.length;
  const started = (await h.invokeRpc(startTeamTaskRpc.name, {
    cwd: h.workspaceDir,
    workspaceId: "wks_l2",
    agentId: "launcher-1",
    rawArgs: "Update label in app.txt, with code review",
  })) as { taskId: string; recordPath: string; coordinatorAgentId: string };

  // Current chat becomes the coordinator directly without spawning a separate coordinator agent
  // and without calling reload() (instead bumping sessionOpenGeneration via agent.open.before toggle).
  assert.equal(h.createdAgents.length, 0);
  assert.equal(started.coordinatorAgentId, "launcher-1");
  assert.equal(h.metadataUpdates.length, 1);
  assert.equal(h.metadataUpdates[0].agentId, "launcher-1");
  assert.equal(h.reloadedAgents.length, 0);
  assert.deepEqual(h.hookEvents.slice(hookEventsBeforeStart), [
    { action: "remove", name: "agent.open.before" },
    { action: "add", name: "agent.open.before" },
  ]);
  assert.equal(h.hooks.has("agent.open.before"), true);
  assert.equal(h.sentMessages.length, 1);
  assert.equal(h.sentMessages[0].agentId, "launcher-1");
  assert.match(h.sentMessages[0].text, /\[Team Kickoff\]/);
  assert.match(h.sentMessages[0].text, /paseo_team_set_route/);
  assert.match(h.sentMessages[0].text, /Plan Reviewer #1/);
  assert.match(h.sentMessages[0].text, /antigravity\/gemini-4-neon/);
  // Task starts in pending-route state until coordinator declares complexity & route.
  assert.equal(loadTask(started.recordPath).routeDecided, false);
  h.sentMessages.length = 0;

  // Open coordinator and grab its real injected tools.
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
        execute: (args: Record<string, unknown>) => Promise<{
          text: string;
          isError?: boolean;
        }>;
      }>;
    };
    return new Map(out.tools.map((tool) => [tool.name, tool]));
  };

  const coordTools = await openToolMap({
    agentId: started.coordinatorAgentId,
    provider: "antigravity",
    title: "[Team] Update label",
    metadata: {
      "paseo-team.task": {
        taskId: started.taskId,
        recordPath: started.recordPath,
        role: "coordinator",
      },
    },
  });

  // Coordinator assesses complexity & locks route via paseo_team_set_route before dispatching members.
  const routeRes = await coordTools.get("paseo_team_set_route")!.execute({
    isComplex: false,
    planReview: false,
    codeReview: true,
    reason:
      "Localized single-file label update with user-requested code review",
  });
  assert.notEqual(routeRes.isError, true);
  assert.equal(loadTask(started.recordPath).routeDecided, true);
  assert.equal(loadTask(started.recordPath).planReview, "not-required");
  assert.equal(loadTask(started.recordPath).codeReview, "required");
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

  // Submitting delivery before run_check is rejected.
  const premature = await devTools.get("paseo_team_submit_delivery")!.execute({
    summary: "early",
    architectureImpact: "None",
  });
  assert.equal(premature.isError, true);

  // R1: run real passing check via node -e, then submit delivery.
  writeFileSync(path.join(h.workspaceDir, "app.txt"), "v1\n");
  const ci1 = await devTools.get("paseo_team_run_check")!.execute({
    logFileName: "ci-1.log",
    command: process.execPath,
    args: ["-e", "console.log('tests ok r1')"],
  });
  assert.equal(ci1.isError, false);
  const del1 = await devTools.get("paseo_team_submit_delivery")!.execute({
    summary: "Implemented v1",
    architectureImpact: "None",
  });
  assert.notEqual(del1.isError, true);

  // R1 review: rev0 APPROVE, rev1 REQUEST_CHANGES -> gate still blocked.
  const r1v0 = await rev0Tools.get("paseo_team_submit_review")!.execute({
    verdict: "APPROVE",
    summary: "Looks good",
    findings: [],
  });
  assert.notEqual(r1v0.isError, true);
  const r1v1 = await rev1Tools.get("paseo_team_submit_review")!.execute({
    verdict: "REQUEST_CHANGES",
    summary: "Needs edge fix",
    findings: ["blocking: app.txt:1 missing newline check"],
  });
  assert.notEqual(r1v1.isError, true);

  const blockedComplete = await coordTools
    .get("paseo_team_complete")!
    .execute({});
  assert.equal(blockedComplete.isError, true);
  assert.match(blockedComplete.text, /Quality gate BLOCKED/);

  // R2 rework: fresh CI run (ensure mtime > delivery-r1 timestamp) + delivery-r2.
  await new Promise((r) => setTimeout(r, 15));
  writeFileSync(path.join(h.workspaceDir, "app.txt"), "v2\n");
  const ci2 = await devTools.get("paseo_team_run_check")!.execute({
    logFileName: "ci-2.log",
    command: process.execPath,
    args: ["-e", "console.log('tests ok r2')"],
  });
  assert.equal(ci2.isError, false);
  const del2 = await devTools.get("paseo_team_submit_delivery")!.execute({
    summary: "Fixed blocking finding in v2",
    architectureImpact: "None",
  });
  assert.notEqual(del2.isError, true);

  // R2 reviews: both approve.
  await rev0Tools.get("paseo_team_submit_review")!.execute({
    verdict: "APPROVE",
    summary: "Verified v2",
    findings: [],
  });
  await rev1Tools.get("paseo_team_submit_review")!.execute({
    verdict: "APPROVE",
    summary: "Fix confirmed",
    findings: [],
  });

  // Final quality gate passes and marks task completed.
  const done = await coordTools.get("paseo_team_complete")!.execute({});
  assert.equal(done.isError, false);
  assert.match(done.text, /Quality gate READY; task completed/);
  assert.equal(loadTask(started.recordPath).lifecycleStatus, "completed");

  // No spurious turn.after reminders after all members submitted cleanly.
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

  // 2. User later sends "需要方案评审" in the chat -> Coordinator writes plan.md, calls submit_plan, and spawns plan reviewers.
  const openOut = (await h.invokeHook("agent.open.before", {
    request: {
      workspaceId: "wks_pm",
      cwd: h.workspaceDir,
      reason: "refresh",
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
      execute: (args: Record<string, unknown>) => Promise<{
        text: string;
        isError?: boolean;
      }>;
    }>;
  };
  const coordTools = new Map(openOut.tools.map((tool) => [tool.name, tool]));
  const taskDir = path.dirname(started.recordPath);
  writeFileSync(path.join(taskDir, "plan.md"), "# 方案 v1\n");
  const planRes = await coordTools.get("paseo_team_submit_plan")!.execute({
    planFile: "plan.md",
    summary: "方案 v1",
  });
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
  const blockedGate = await coordTools.get("paseo_team_complete")!.execute({
    inspectOnly: true,
  });
  assert.equal(blockedGate.isError, true);
  assert.match(blockedGate.text, /plan-rev-1/);
});
