/**
 * Level 3 (Highest-Tier) Live Paseo E2E Acceptance Suite for `paseo-team`.
 *
 * Exercises real Paseo daemon RPCs, real providers (Codex, Claude Code, Antigravity Gemini,
 * Pi Deepseek), and all 5 live plugin hooks (`agent.create.after`, `agent.open.before`,
 * `agent.permission.before`, `agent.turn.before`, `agent.turn.after`).
 *
 * Intentionally skipped during normal `npm test` / CI because it requires a live Paseo daemon,
 * loaded `paseo-team` plugin, a target test workspace, and real model quota.
 *
 * Usage:
 *   PASEO_E2E_LIVE=1 PASEO_E2E_CWD=/path/to/test-repo npm run test:e2e
 *
 * Optional env vars:
 *   PASEO_E2E_SUITE=smoke|standard|claude-coord|antigravity-coord|all  (default: smoke)
 *   PASEO_E2E_CWD=/path/to/test-workspace                              (required when PASEO_E2E_LIVE=1)
 *   PASEO_E2E_SMOKE_PRESET=<preset-name>                               (defaults to config.default)
 *   PASEO_E2E_STANDARD_PRESET=<preset-name>                            (defaults to config.default)
 *   PASEO_E2E_HOME=~/.paseo                                            (default: ~/.paseo)
 *   PASEO_E2E_TIMEOUT_MS=600000                                        (default: 10 minutes per scenario)
 *   PASEO_E2E_PERMISSION_STALL_MS=25000                                (fail if a task agent stays stuck on a tool permission)
 *   PASEO_E2E_CODEX_LAUNCHER=<agentId>                                 (optional override)
 *   PASEO_E2E_CLAUDE_LAUNCHER=<agentId>                                (optional override)
 *   PASEO_E2E_ANTIGRAVITY_LAUNCHER=<agentId>                           (optional override)
 *   PASEO_CLI_CLIENT=/path/to/@getpaseo/cli/dist/utils/client.js       (optional override)
 *
 * Safety rules enforced by this harness:
 * - Never reads `.env*` files or dumps environment variables.
 * - Never commits in the test workspace; operates only on an isolated temporary probe file
 *   that is removed in `finally`.
 * - Only stops sessions created by the active E2E case; never touches user sessions.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const LIVE_ENABLED = process.env.PASEO_E2E_LIVE === "1";
const SUITE = (process.env.PASEO_E2E_SUITE || "smoke").trim().toLowerCase();
const PASEO_HOME =
  process.env.PASEO_E2E_HOME || path.join(os.homedir(), ".paseo");
const TIMEOUT_MS = Number(process.env.PASEO_E2E_TIMEOUT_MS || 600_000);
const PERMISSION_STALL_MS = Number(
  process.env.PASEO_E2E_PERMISSION_STALL_MS || 25_000,
);
const POLL_MS = 4_000;

function resolveCliClientPath() {
  if (
    process.env.PASEO_CLI_CLIENT &&
    existsSync(process.env.PASEO_CLI_CLIENT)
  ) {
    return process.env.PASEO_CLI_CLIENT;
  }
  const paseoBin = execFileSync("which", ["paseo"], {
    encoding: "utf8",
  }).trim();
  const realBin = realpathSync(paseoBin);
  // Global @getpaseo/cli layout: <pkg>/dist/cli.js -> <pkg>/dist/utils/client.js
  const pkgDist = path.dirname(realBin);
  const candidates = [
    path.join(pkgDist, "utils", "client.js"),
    path.join(pkgDist, "..", "dist", "utils", "client.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Could not locate @getpaseo/cli client helper; set PASEO_CLI_CLIENT.",
  );
}

function resolveTargetCwd() {
  if (process.env.PASEO_E2E_CWD) {
    return path.resolve(process.env.PASEO_E2E_CWD);
  }
  throw new Error(
    "Set PASEO_E2E_CWD to a local test workspace registered in Paseo.",
  );
}

function readPluginLogLines() {
  const out = execFileSync("paseo", ["plugin", "logs", "paseo-team"], {
    encoding: "utf8",
  });
  return out.split(/\r?\n/).filter(Boolean);
}

function assertPluginRunning() {
  const out = execFileSync("paseo", ["plugin", "ls"], { encoding: "utf8" });
  const line = out.split(/\r?\n/).find((l) => l.includes("paseo-team"));
  assert.ok(line, "paseo-team plugin must be installed in Paseo");
  assert.match(line, /\brunning\b/, `paseo-team must be running, got: ${line}`);
}

function stopSessions(agentIds) {
  const unique = [...new Set(agentIds.filter(Boolean))];
  if (unique.length === 0) return;
  try {
    execFileSync("paseo", ["stop", ...unique], { stdio: "ignore" });
  } catch {
    // Best-effort cleanup of test-owned sessions only.
  }
}

async function listWorkspaceAgents(client, cwd) {
  const res = await client.fetchAgents({ filter: { cwd }, limit: 50 });
  const entries = res?.entries ?? res?.agents ?? [];
  return Array.isArray(entries)
    ? entries.map((entry) => entry?.agent ?? entry).filter(Boolean)
    : [];
}

async function listOwnedPendingPermissions(client, ownedSessionIds) {
  const found = [];
  for (const aid of ownedSessionIds) {
    try {
      const res = await client.fetchAgent(aid);
      const agent = res?.agent ?? res;
      const pending = Array.isArray(agent?.pendingPermissions)
        ? agent.pendingPermissions
        : [];
      for (const req of pending) {
        if (req?.id) found.push({ agentId: aid, request: req });
      }
    } catch {
      // Ignore transient refresh errors on closing sessions.
    }
  }
  return found;
}

async function openDaemonClient() {
  const clientMod = await import(pathToFileURL(resolveCliClientPath()).href);
  return clientMod.connectToDaemon({
    target: { kind: "instance", home: PASEO_HOME },
  });
}

async function resolveWorkspaceId(client, cwd) {
  if (process.env.PASEO_E2E_WORKSPACE_ID) {
    return process.env.PASEO_E2E_WORKSPACE_ID;
  }
  const res = await client.fetchWorkspaces();
  const entries = res?.entries ?? res?.workspaces ?? res?.items ?? res;
  const normalized = realpathSync(cwd);
  for (const entry of Array.isArray(entries) ? entries : []) {
    const dir =
      entry?.workspaceDirectory ??
      entry?.directory ??
      entry?.cwd ??
      entry?.workspace?.workspaceDirectory ??
      entry?.workspace?.directory;
    if (!dir) continue;
    try {
      if (realpathSync(String(dir)) === normalized) {
        return entry?.id ?? entry?.workspace?.id;
      }
    } catch {
      if (path.resolve(String(dir)) === normalized) {
        return entry?.id ?? entry?.workspace?.id;
      }
    }
  }
  throw new Error(`No Paseo workspace found for ${cwd}`);
}

async function resolveLauncherAgentId({
  client,
  workspaceId,
  cwd,
  provider,
  defaultModel,
  catalogProviders,
  envOverride,
}) {
  if (envOverride) return { agentId: envOverride, ephemeral: false };

  const cat = Array.isArray(catalogProviders)
    ? catalogProviders.find((p) => p?.provider === provider)
    : null;
  const models = Array.isArray(cat?.models) ? cat.models : [];
  const modelEntry =
    models.find((m) => m.id === defaultModel) ??
    models.find((m) => m.isDefault) ??
    models[0];
  const resolvedModelId = modelEntry?.id ?? defaultModel;
  const thinkingOptions = Array.isArray(modelEntry?.thinkingOptions)
    ? modelEntry.thinkingOptions
    : [];
  const preferredThinking =
    thinkingOptions.find((t) => t.id === "medium")?.id ??
    modelEntry?.defaultThinkingId;

  // Create a clean interactive chat in the target workspace, complete one real user turn
  // so it has live session state + prior conversation history (matching a user's open chat),
  // and archive it in `finally` so user history is never polluted.
  const created = await client.createAgent({
    workspaceId,
    config: {
      provider,
      model: resolvedModelId,
      cwd,
      modeId: provider === "codex" ? "auto-review" : "auto",
      ...(preferredThinking ? { thinkingOptionId: preferredThinking } : {}),
    },
    title: `[L3 E2E Coordinator] ${provider}/${resolvedModelId}`,
    background: false,
  });
  const agentId = created?.id ?? created?.agent?.id;
  assert.ok(agentId, `Failed to create ephemeral coordinator for ${provider}`);
  await client.sendAgentMessage(
    agentId,
    "Remember marker E2E_PRIOR_CHAT_OK and reply with OK only. Do not run tools or edit files.",
  );
  let sawTurnComplete = false;
  const readyDeadline = Date.now() + 90_000;
  while (Date.now() < readyDeadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    const snap = await client.fetchAgent(agentId).catch(() => null);
    const agent = snap?.agent ?? snap;
    if (agent?.lastUserMessageAt && agent?.status === "idle") {
      sawTurnComplete = true;
      break;
    }
  }
  assert.ok(
    sawTurnComplete,
    `Ephemeral chat ${agentId} did not finish its initial pre-team turn within 90s`,
  );
  return { agentId, ephemeral: true };
}

async function runLiveScenario({
  name,
  launcherProvider,
  launcherModel,
  launcherEnvVar,
  presetName,
  requireReview = true,
  expectedProviders = [],
  directPromptStart = false,
}) {
  assertPluginRunning();
  const cwd = resolveTargetCwd();
  const client = await openDaemonClient();
  const pluginLogBaseline = readPluginLogLines().length;
  const probeFile = `.paseo-team-l3-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.txt`;
  const probePath = path.join(cwd, probeFile);
  writeFileSync(probePath, "before=0\n", "utf8");

  let recordPath = null;
  let launcherInfo = null;
  const ownedSessionIds = new Set();

  try {
    const workspaceId = await resolveWorkspaceId(client, cwd);
    const configBundle = await client.invokePluginRpc(
      "paseo-team",
      "paseo_team.config.get",
      { cwd },
    );
    const resolvedPreset =
      presetName ||
      configBundle?.effectiveTeamName ||
      configBundle?.config?.default;
    assert.ok(
      resolvedPreset && configBundle?.config?.teams?.[resolvedPreset],
      `Preset "${resolvedPreset ?? "(default)"}" must exist in paseo-team config for scenario "${name}"`,
    );

    const reviewPhrase = requireReview ? "with code review" : "no code review";
    const expectedLine = `after=${name}`;
    const rawArgs = [
      `Edit only the single temporary file ${probeFile}: replace its contents with "${expectedLine}" followed by a newline. `,
      `Do not edit any other file in the repository, do not add tests, and do not run git commit. `,
      `${reviewPhrase}, use preset ${resolvedPreset}.`,
    ].join("");

    const preAgents = await listWorkspaceAgents(client, cwd);
    const preAgentIds = new Set(preAgents.map((a) => a?.id).filter(Boolean));
    let startedTaskId = null;

    if (directPromptStart) {
      // Simulate a brand-new chat draft where Paseo sends raw "/paseo-team ..." directly
      // without client slash-command interception (regression for ee921d96).
      const cat = Array.isArray(configBundle?.providers)
        ? configBundle.providers.find((p) => p?.provider === launcherProvider)
        : null;
      const models = Array.isArray(cat?.models) ? cat.models : [];
      const modelEntry =
        models.find((m) => m.id === launcherModel) ??
        models.find((m) => m.isDefault) ??
        models[0];
      const resolvedModelId = modelEntry?.id ?? launcherModel;
      const thinkingOptions = Array.isArray(modelEntry?.thinkingOptions)
        ? modelEntry.thinkingOptions
        : [];
      const preferredThinking =
        thinkingOptions.find((t) => t.id === "medium")?.id ??
        modelEntry?.defaultThinkingId;
      const created = await client.createAgent({
        workspaceId,
        config: {
          provider: launcherProvider,
          model: resolvedModelId,
          cwd,
          modeId: launcherProvider === "codex" ? "auto-review" : "auto",
          ...(preferredThinking ? { thinkingOptionId: preferredThinking } : {}),
        },
        title: `[L3 E2E Draft] ${launcherProvider}/${resolvedModelId}`,
        background: false,
      });
      const agentId = created?.id ?? created?.agent?.id;
      assert.ok(agentId, `Failed to create draft chat for ${launcherProvider}`);
      launcherInfo = { agentId, ephemeral: true };
      ownedSessionIds.add(agentId);

      await client.sendAgentMessage(agentId, `/paseo-team ${rawArgs}`);

      const startDeadline = Date.now() + 90_000;
      while (Date.now() < startDeadline) {
        const graph = await client
          .invokePluginRpc("paseo-team", "paseo_team.conversation.get", {
            workspaceId,
            agentId,
            cwd,
            language: "zh",
          })
          .catch(() => null);
        const task =
          graph?.mode === "team_task" ? graph.task : graph?.tasks?.[0];
        if (task?.recordPath && task?.coordinatorAgentId === agentId) {
          recordPath = task.recordPath;
          startedTaskId = task.taskId;
          break;
        }
        await new Promise((r) => setTimeout(r, 2_000));
      }
      assert.ok(
        recordPath && startedTaskId,
        `Draft chat ${agentId} did not call paseo_team(action="start") within 90s`,
      );
    } else {
      launcherInfo = await resolveLauncherAgentId({
        client,
        workspaceId,
        cwd,
        provider: launcherProvider,
        defaultModel: launcherModel,
        catalogProviders: configBundle?.providers,
        envOverride: process.env[launcherEnvVar],
      });
      if (launcherInfo.ephemeral) {
        ownedSessionIds.add(launcherInfo.agentId);
      }

      const started = await client.invokePluginRpc(
        "paseo-team",
        "paseo_team.tasks.start",
        {
          cwd,
          workspaceId,
          agentId: launcherInfo.agentId,
          rawArgs,
        },
      );
      assert.ok(started?.taskId, "tasks.start must return taskId");
      assert.ok(started?.recordPath, "tasks.start must return recordPath");
      assert.equal(
        started?.coordinatorAgentId,
        launcherInfo.agentId,
        "tasks.start must reuse the open chat directly as coordinatorAgentId",
      );
      recordPath = started.recordPath;
      startedTaskId = started.taskId;
    }

    // Verify no extra "[Team] ..." coordinator session was spawned alongside the open chat,
    // and workspace-scoped conversation.get (used by the single Team Graph tab) resolves cleanly without cross-project bleed.
    const postStartAgents = await listWorkspaceAgents(client, cwd);
    const extraTeamCoords = postStartAgents.filter(
      (a) =>
        a?.id &&
        !preAgentIds.has(a.id) &&
        String(a.title ?? "").startsWith("[Team]"),
    );
    assert.deepEqual(
      extraTeamCoords.map((a) => a.id),
      [],
      "must not spawn a separate [Team] coordinator chat",
    );

    if (launcherInfo.ephemeral && !directPromptStart) {
      const promptHistory = await client.listAgentTimelinePrompts(
        launcherInfo.agentId,
      );
      const promptTexts = JSON.stringify(promptHistory ?? {});
      assert.match(
        promptTexts,
        /E2E_PRIOR_CHAT_OK/,
        "reusing the open chat as coordinator must preserve prior conversation timeline",
      );
    }

    const wsGraph = await client.invokePluginRpc(
      "paseo-team",
      "paseo_team.conversation.get",
      {
        workspaceId,
        cwd,
        language: "zh",
      },
    );
    assert.ok(
      wsGraph?.mode === "team_task" || wsGraph?.mode === "launcher",
      `expected workspace graph mode team_task/launcher, got ${wsGraph?.mode}`,
    );
    const activeGraphTask =
      wsGraph.mode === "team_task" ? wsGraph.task : wsGraph.tasks?.[0];
    assert.equal(activeGraphTask?.taskId, startedTaskId);
    assert.equal(activeGraphTask?.projectRoot, realpathSync(cwd));
    if (requireReview) {
      // Before coordinator decides route or dispatches members, graph starts with Coordinator only.
      assert.ok(
        activeGraphTask?.stages?.[0]?.stageId === "coordinator",
        "first stage must be coordinator",
      );
    }

    // Unrelated standalone chat ID must resolve to mode="empty" without leaking another project's task.
    const emptyGraph = await client.invokePluginRpc(
      "paseo-team",
      "paseo_team.conversation.get",
      {
        agentId: "00000000-0000-0000-0000-000000000000",
        workspaceId,
        cwd,
        language: "zh",
      },
    );
    assert.equal(emptyGraph?.mode, "empty");

    const deadline = Date.now() + TIMEOUT_MS;
    const permissionFirstSeen = new Map();
    let finalRecord = null;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const record = JSON.parse(readFileSync(recordPath, "utf8"));
      for (const node of record.nodes ?? []) {
        if (node?.agentId) ownedSessionIds.add(node.agentId);
      }

      // Check for hung permissions (catches agent.permission.before regressions live).
      const pending = await listOwnedPendingPermissions(
        client,
        ownedSessionIds,
      );
      const activePendingIds = new Set();
      for (const item of pending) {
        const aid = item?.agentId;
        const req = item?.request;
        if (!aid || !req?.id) continue;
        if (req.kind === "question") {
          throw new Error(
            `Scenario "${name}" triggered request_user_input on ${aid}; probe goal must be unambiguous.`,
          );
        }
        const key = `${aid}:${req.id}`;
        activePendingIds.add(key);
        if (!permissionFirstSeen.has(key)) {
          permissionFirstSeen.set(key, Date.now());
        } else if (
          Date.now() - permissionFirstSeen.get(key) >
          PERMISSION_STALL_MS
        ) {
          throw new Error(
            `Permission hook stalled >${PERMISSION_STALL_MS}ms on ${aid} (${req.provider} / ${req.name} / ${req.kind})`,
          );
        }
      }
      for (const key of permissionFirstSeen.keys()) {
        if (!activePendingIds.has(key)) permissionFirstSeen.delete(key);
      }

      if (record.lifecycleStatus === "completed") {
        finalRecord = record;
        break;
      }
      if (
        record.lifecycleStatus === "abandoned" ||
        record.lifecycleStatus === "blocked"
      ) {
        throw new Error(
          `Scenario "${name}" ended in lifecycleStatus=${record.lifecycleStatus}`,
        );
      }
    }

    assert.ok(
      finalRecord,
      `Scenario "${name}" timed out after ${TIMEOUT_MS}ms (record: ${recordPath})`,
    );

    // 1. Probe file must hold exact expected content & route must be decided.
    assert.equal(readFileSync(probePath, "utf8").trim(), expectedLine);
    assert.equal(finalRecord.routeDecided, true);

    // 2. Developer & (if required) Reviewers must be registered and passively observed via native Paseo replies.
    const devNode = finalRecord.nodes.find((n) => n.role === "developer");
    assert.ok(devNode?.agentId, "developer node must be registered");
    assert.equal(devNode.status, "completed");
    assert.ok(
      finalRecord.ci?.status === "pass" ||
        finalRecord.ci?.log ||
        finalRecord.ci?.waived,
      "CI pass/log/waiver must be recorded",
    );

    if (requireReview) {
      const reviewers = finalRecord.nodes.filter(
        (n) => n.role === "code-reviewer",
      );
      assert.ok(reviewers.length >= 1, "at least one code reviewer required");
      for (const rev of reviewers) {
        assert.ok(rev.agentId, `reviewer ${rev.nodeId} must be registered`);
        assert.equal(rev.status, "approved");
      }
      assert.ok(
        (finalRecord.codeReviewers ?? []).every((r) => r.source === "self"),
        "all live reviewers should have verdicts observed passively from native replies",
      );
    }

    // 3. Process-level zero-error gate (regression for bcd00383):
    //    Verify Coordinator timeline had ZERO failed `paseo_team` or `create_agent` calls,
    //    and that `paseo_team(action="start")` delivered full protocol text (not stripped JSON).
    const coordTimeline = await client
      .fetchAgentTimeline(launcherInfo.agentId, {
        direction: "tail",
        limit: 80,
      })
      .catch(() => ({ entries: [] }));
    const failedTeamCalls = [];
    let sawStartProtocolText = !directPromptStart;
    for (const entry of coordTimeline?.entries ?? []) {
      const it = entry?.item;
      if (it?.type !== "tool_call") continue;
      const toolName = String(it.name ?? "");
      if (!/(?:paseo_team|create_agent)$/i.test(toolName)) continue;
      if (it.status === "failed" || it.status === "error") {
        failedTeamCalls.push({
          name: toolName,
          input: it.detail?.input,
          output: it.detail?.output,
        });
      }
      if (
        directPromptStart &&
        /paseo_team$/i.test(toolName) &&
        it.detail?.input?.action === "start"
      ) {
        const outStr = JSON.stringify(it.detail?.output ?? "");
        if (
          outStr.includes("create_agent") &&
          outStr.includes("set_route") &&
          outStr.includes("labels=")
        ) {
          sawStartProtocolText = true;
        }
      }
    }
    assert.deepEqual(
      failedTeamCalls,
      [],
      `Coordinator timeline had failed paseo_team/create_agent tool calls:\n${JSON.stringify(failedTeamCalls, null, 2)}`,
    );
    assert.equal(
      sawStartProtocolText,
      true,
      'paseo_team(action="start") output must deliver full kickoff protocol text (not stripped by structuredContent)',
    );

    // Verify spawned Developer carries standard labels `{ task, role }` from the kickoff protocol.
    const devAgentSnap = await client
      .fetchAgent(devNode.agentId)
      .catch(() => null);
    const devLabels = (devAgentSnap?.agent ?? devAgentSnap)?.labels ?? {};
    assert.equal(
      devLabels.task,
      finalRecord.taskId,
      `Developer labels.task should match taskId (${finalRecord.taskId}), got ${JSON.stringify(devLabels)}`,
    );
    assert.equal(
      devLabels.role,
      "developer",
      `Developer labels.role should be "developer", got ${JSON.stringify(devLabels)}`,
    );

    // 4. Verify expected providers actually participated.
    const seenProviders = new Set(
      finalRecord.nodes.map((n) => n.provider).filter(Boolean),
    );
    for (const expected of expectedProviders) {
      assert.ok(
        seenProviders.has(expected),
        `Expected provider "${expected}" in nodes, saw: ${[...seenProviders].join(", ")}`,
      );
    }

    // 5. Verify zero new plugin errors in daemon logs during this scenario.
    const newLogs = readPluginLogLines().slice(pluginLogBaseline);
    const errorLines = newLogs.filter((line) =>
      /\[paseo-team\].*error|UnhandledPromiseRejection|TypeError|ReferenceError/i.test(
        line,
      ),
    );
    assert.deepEqual(
      errorLines,
      [],
      `Unexpected plugin errors during "${name}":\n${errorLines.join("\n")}`,
    );
  } finally {
    rmSync(probePath, { force: true });
    if (recordPath && existsSync(recordPath)) {
      try {
        const rec = JSON.parse(readFileSync(recordPath, "utf8"));
        if (rec.lifecycleStatus === "active") {
          await client.invokePluginRpc(
            "paseo-team",
            "paseo_team.tasks.control",
            {
              recordPath,
              action: "abandon_task",
              language: "zh",
            },
          );
        }
      } catch {
        // Best effort
      }
      // Remove ephemeral E2E task state directory so user's Team Graph & History stay clean.
      rmSync(path.dirname(recordPath), { recursive: true, force: true });
    }
    stopSessions([...ownedSessionIds]);
    for (const sid of ownedSessionIds) {
      await client.archiveAgent(sid).catch(() => {});
    }
    await client.close();
  }
}

const SCENARIOS = [
  {
    id: "smoke",
    title:
      "L3 Live E2E [smoke]: Codex Coordinator + smoke/default preset (no review)",
    launcherProvider: "codex",
    launcherModel: "gpt-6.2-astra",
    launcherEnvVar: "PASEO_E2E_CODEX_LAUNCHER",
    presetName: process.env.PASEO_E2E_SMOKE_PRESET || "",
    requireReview: false,
    expectedProviders: ["codex"],
  },
  {
    id: "standard",
    title:
      "L3 Live E2E [standard]: Codex Coordinator + default/standard preset (with code review)",
    launcherProvider: "codex",
    launcherModel: "gpt-6.2-astra",
    launcherEnvVar: "PASEO_E2E_CODEX_LAUNCHER",
    presetName: process.env.PASEO_E2E_STANDARD_PRESET || "",
    requireReview: true,
    expectedProviders: ["codex"],
  },
  {
    id: "claude-coord",
    title:
      "L3 Live E2E [claude-coord]: Claude Code Coordinator + smoke/default preset",
    launcherProvider: "claude",
    launcherModel: "claude-opus-5-5",
    launcherEnvVar: "PASEO_E2E_CLAUDE_LAUNCHER",
    presetName: process.env.PASEO_E2E_SMOKE_PRESET || "",
    requireReview: true,
    expectedProviders: ["claude"],
  },
  {
    id: "draft-start",
    title:
      "L3 Live E2E [draft-start]: Brand-new Claude draft receiving raw /paseo-team invokes paseo_team(action='start') with code review",
    launcherProvider: "claude",
    launcherModel: "claude-opus-5-5",
    launcherEnvVar: "PASEO_E2E_CLAUDE_LAUNCHER",
    presetName: process.env.PASEO_E2E_SMOKE_PRESET || "",
    requireReview: true,
    expectedProviders: ["claude"],
    directPromptStart: true,
  },
  {
    id: "antigravity-coord",
    title:
      "L3 Live E2E [antigravity-coord]: Antigravity Gemini Coordinator + default/standard preset (parent+child permission hook regression)",
    launcherProvider: "antigravity",
    launcherModel: "gemini-4-carbon",
    launcherEnvVar: "PASEO_E2E_ANTIGRAVITY_LAUNCHER",
    presetName: process.env.PASEO_E2E_STANDARD_PRESET || "",
    requireReview: true,
    expectedProviders: ["antigravity"],
  },
];

for (const scenario of SCENARIOS) {
  const selected =
    LIVE_ENABLED && (SUITE === "all" || SUITE.split(",").includes(scenario.id));
  test(
    scenario.title,
    {
      skip: !selected
        ? LIVE_ENABLED
          ? `Excluded by PASEO_E2E_SUITE=${SUITE}`
          : "Set PASEO_E2E_LIVE=1 (or run `npm run test:e2e`) to execute Level 3 live Paseo acceptance tests"
        : false,
      timeout: TIMEOUT_MS + 30_000,
    },
    async () => {
      await runLiveScenario({
        name: scenario.id,
        launcherProvider: scenario.launcherProvider,
        launcherModel: scenario.launcherModel,
        launcherEnvVar: scenario.launcherEnvVar,
        presetName: scenario.presetName,
        requireReview: scenario.requireReview,
        expectedProviders: scenario.expectedProviders,
        directPromptStart: Boolean(scenario.directPromptStart),
      });
    },
  );
}
