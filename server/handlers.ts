import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import {
  defineAgentTool,
  type AgentToolDefinition,
} from "@getpaseo/plugin/server";
import { z } from "zod";
import type {
  ConfigBundleDto,
  ConversationGraphPayloadDto,
  PipelineNodeViewDto,
  PipelineStageColumnDto,
  PipelineTaskSnapshotDto,
  ProviderCatalogItemDto,
  ProviderModelOptionDto,
} from "../shared/contracts.ts";
import {
  detectPromptLanguage,
  localizeNodeRoleLabel,
  STAGE_LABELS,
  type UiLanguage,
} from "../shared/i18n.ts";
import {
  AUTO_MODEL,
  type ComplexMode,
  loadConfig,
  resolveEffectiveTeam,
  resolveProjectKey,
  type RoleModelSpec,
  saveConfig,
} from "./config-store.ts";
import {
  assignReviewerPerspective,
  buildCoordinatorSystemPrompt,
  getSafetyRulesText,
  reviewerPerspectiveLabel,
} from "./prompts.ts";
import { inspectQualityGate } from "./quality-gate.ts";
import { runCheck } from "./run-check.ts";
import {
  buildRecoveryBrief,
  findTaskByAgentId,
  initTask,
  listAllRecentTasks,
  listTasksForProject,
  loadTask,
  markTaskCompleted,
  type NodeVisualStatus,
  readReviewRounds,
  type PipelineStageId,
  recordCandidateDelivery,
  recordReviewVerdict,
  registerTaskAgent,
  saveTask,
  type TaskRecord,
} from "./task-store.ts";

type Listener = () => void;
const listeners = new Set<Listener>();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function subscribeTaskChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyTaskChanges(): void {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Ignore subscriber error
      }
    }
  }, 120);
}

export async function readProviderCatalog(
  paseo: PaseoApi,
  cwd?: string,
): Promise<{
  providers: ProviderCatalogItemDto[];
  readyProviders: string[];
}> {
  const providers: ProviderCatalogItemDto[] = [];
  const readyProviders: string[] = [];

  try {
    const snap = await paseo.providers.snapshot(cwd ? { cwd } : undefined);
    const list = Array.isArray(snap?.entries) ? snap.entries : [];

    for (const entry of list) {
      if (!entry || typeof entry.provider !== "string") continue;
      if (entry.enabled === false) continue;

      const isReady = entry.status === "ready";
      if (isReady) {
        readyProviders.push(entry.provider);
      }

      let rawModels: {
        id: string;
        label?: string;
        isSelectable?: boolean;
        isDefault?: boolean;
        thinkingOptions?: { id: string; label?: string }[];
        defaultThinkingOptionId?: string;
      }[] = Array.isArray(entry.models) ? entry.models : [];
      let rawModes: { id: string; label?: string }[] = Array.isArray(
        entry.modes,
      )
        ? entry.modes
        : [];

      if (isReady && rawModels.length === 0) {
        try {
          const fetched = await paseo.providers.listModels(
            entry.provider,
            cwd ? { cwd } : undefined,
          );
          if (Array.isArray(fetched?.models)) {
            rawModels = fetched.models;
          }
        } catch {
          // Ignore
        }
      }

      if (isReady && rawModes.length === 0) {
        try {
          const fetchedModes = await paseo.providers.listModes(
            entry.provider,
            cwd ? { cwd } : undefined,
          );
          if (Array.isArray(fetchedModes?.modes)) {
            rawModes = fetchedModes.modes;
          }
        } catch {
          // Ignore
        }
      }

      const models: ProviderModelOptionDto[] = [];
      for (const m of rawModels) {
        if (!m || typeof m.id !== "string" || m.isSelectable === false)
          continue;
        const fullId = `${entry.provider}/${m.id}`;
        const rawThinking: { id: string; label?: string }[] = Array.isArray(
          m.thinkingOptions,
        )
          ? m.thinkingOptions
          : [];
        const thinkingOptions = rawThinking
          .filter((item) => Boolean(item && typeof item.id === "string"))
          .map((item) => ({ id: item.id, label: item.label || item.id }));
        models.push({
          id: m.id,
          fullId,
          label: m.label || m.id,
          ...(m.isDefault ? { isDefault: true } : {}),
          thinkingOptions,
          ...(m.defaultThinkingOptionId
            ? { defaultThinkingId: m.defaultThinkingOptionId }
            : {}),
        });
      }

      if (isReady || models.length > 0) {
        providers.push({
          provider: entry.provider,
          label: entry.label || entry.provider,
          ready: isReady,
          modes: rawModes.map((item) => item.id).filter(Boolean),
          ...(entry.defaultModeId
            ? { defaultModeId: entry.defaultModeId }
            : {}),
          models,
        });
      }
    }
  } catch {
    try {
      const avail = await paseo.providers.listAvailable();
      const list = Array.isArray(avail?.providers) ? avail.providers : [];
      for (const item of list) {
        const rec = item as Record<string, unknown>;
        if (rec.available === true && typeof rec.provider === "string") {
          readyProviders.push(rec.provider);
          providers.push({
            provider: rec.provider,
            label: rec.provider,
            ready: true,
            modes: [],
            models: [],
          });
        }
      }
    } catch {
      // Ignore
    }
  }

  return { providers, readyProviders };
}

/** Loads the config and rewrites older schema versions in place. */
function loadAndUpgradeConfig() {
  const loaded = loadConfig();
  if (!loaded.exists || loaded.rawVersion >= 5) return loaded;
  try {
    const saved = saveConfig(loaded.config, loaded.path);
    return { ...loaded, config: saved, rawVersion: 5 };
  } catch {
    return loaded;
  }
}

export async function buildConfigBundle(
  paseo: PaseoApi,
  cwd?: string,
): Promise<ConfigBundleDto> {
  const { providers } = await readProviderCatalog(paseo, cwd);
  const loaded = loadAndUpgradeConfig();

  let effectiveTeamName: string | null = loaded.config.default;
  if (cwd?.trim()) {
    try {
      const eff = resolveEffectiveTeam(loaded.config, cwd);
      effectiveTeamName = eff.teamName;
    } catch {
      // Fallback to default
    }
  }

  return {
    config: loaded.config,
    effectiveTeamName,
    providers,
  };
}

export interface LiveAgentRuntime {
  id?: string;
  workspaceId?: string;
  parentAgentId?: string | null;
  title?: string | null;
  cwd?: string;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  awaitingPermission: boolean;
  provider: string;
  model?: string | null;
  thinkingOptionId?: string | null;
  labels?: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
}

async function fetchLiveAgentMap(
  paseo: PaseoApi,
): Promise<Map<string, LiveAgentRuntime>> {
  const map = new Map<string, LiveAgentRuntime>();
  try {
    const listed = await paseo.agents.list({
      filter: { includeArchived: true },
      page: { limit: 300 },
    });
    for (const entry of listed.entries) {
      const a = entry.agent as unknown as Record<string, unknown>;
      const id = String(a.id ?? "");
      if (!id) continue;
      const pendingCount = Array.isArray(a.pendingPermissions)
        ? a.pendingPermissions.length
        : 0;
      const statusRaw = String(a.status ?? "idle");
      const status: LiveAgentRuntime["status"] =
        statusRaw === "initializing" ||
        statusRaw === "running" ||
        statusRaw === "error" ||
        statusRaw === "closed"
          ? statusRaw
          : "idle";
      map.set(id, {
        id,
        workspaceId:
          typeof a.workspaceId === "string" ? a.workspaceId : undefined,
        parentAgentId:
          typeof a.parentAgentId === "string" ? a.parentAgentId : null,
        title: typeof a.title === "string" ? a.title : null,
        cwd: typeof a.cwd === "string" ? a.cwd : "",
        status,
        awaitingPermission: pendingCount > 0,
        provider: typeof a.provider === "string" ? a.provider : "agent",
        model: typeof a.model === "string" ? a.model : null,
        thinkingOptionId:
          typeof a.thinkingOptionId === "string" ? a.thinkingOptionId : null,
        labels:
          a.labels && typeof a.labels === "object"
            ? (a.labels as Record<string, string>)
            : {},
        createdAt: typeof a.createdAt === "string" ? a.createdAt : undefined,
        updatedAt: typeof a.updatedAt === "string" ? a.updatedAt : undefined,
      });
    }
  } catch {
    // Ignore transient list errors
  }
  return map;
}

const STAGE_ORDER: PipelineStageId[] = [
  "coordinator",
  "expert",
  "plan-review",
  "development",
  "code-review",
  "merge-gate",
];

function humanizeProfileLabel(profile: string, lang: UiLanguage): string {
  if (!profile || profile === "auto" || profile === "Auto") {
    return lang === "en" ? "Auto-matched model" : "自动匹配模型";
  }
  if (profile === "workflow.ts" || profile === "quality-gate") {
    return lang === "en" ? "Quality Gate" : "质量验收门禁";
  }
  if (profile === "当前会话" || profile === "Current Chat") {
    return lang === "en" ? "Current Chat" : "当前会话";
  }
  return profile;
}

export function toPipelineSnapshot(
  recordPath: string,
  record: TaskRecord,
  liveMap: Map<string, LiveAgentRuntime>,
  lang: UiLanguage = "en",
): PipelineTaskSnapshotDto {
  let gateChecks: Record<string, boolean> | undefined;
  let gateReady: boolean | undefined;

  if (record.delivery || record.candidate || record.ci) {
    try {
      const report = inspectQualityGate({
        recordPath,
        cwd: record.projectRoot,
      });
      gateChecks = report.checks;
      gateReady = report.status === "READY";
    } catch {
      // Non-fatal
    }
  }

  let runningCount = 0;
  let attentionCount = 0;

  const nodeViews: PipelineNodeViewDto[] = record.nodes.map((node) => {
    const live = node.agentId ? liveMap.get(node.agentId) : undefined;
    let liveState: PipelineNodeViewDto["liveState"] = "not_started";
    let visualStatus: NodeVisualStatus = node.status;

    if (live) {
      if (live.awaitingPermission) {
        liveState = "awaiting_permission";
        visualStatus = "awaiting_permission";
        attentionCount += 1;
      } else {
        liveState = live.status;
        if (live.status === "running" || live.status === "initializing") {
          visualStatus = "running";
          runningCount += 1;
        } else if (live.status === "error") {
          visualStatus = "blocked";
          attentionCount += 1;
        } else if (visualStatus === "running") {
          visualStatus =
            node.role === "coordinator" && record.lifecycleStatus === "active"
              ? "running"
              : "completed";
        }
      }
    } else if (node.role === "coordinator") {
      liveState = "idle";
    } else if (
      node.nodeId === "merge-gate" &&
      record.lifecycleStatus !== "completed"
    ) {
      if (record.circuitBroken || record.readOnlyViolations.length > 0) {
        visualStatus = "blocked";
      } else if (gateReady === true) {
        visualStatus = "completed";
      }
    }

    const provider = live?.provider ?? node.provider;
    const model = live?.model ?? node.model;
    const thinking = live?.thinkingOptionId ?? node.thinkingOptionId;
    const reviewStage =
      node.role === "code-reviewer"
        ? "code"
        : node.role === "plan-reviewer"
          ? "plan"
          : null;
    const rounds =
      reviewStage && node.agentId
        ? readReviewRounds(
            recordPath,
            reviewStage,
            node.agentId,
            (reviewStage === "code"
              ? record.codeReviewers
              : record.planReviewers
            ).find((r) => r.agentId === node.agentId),
          )
        : [];

    const modelBadge = [
      provider && model ? `${provider}/${model}` : provider || model,
      thinking ? `· ${thinking}` : "",
    ]
      .filter(Boolean)
      .join(" ");

    return {
      nodeId: node.nodeId,
      stage: node.stage,
      role: node.role,
      slotIndex: node.slotIndex,
      label: localizeNodeRoleLabel(
        lang,
        node.role,
        node.slotIndex,
        node.label,
        false,
      ),
      profile: humanizeProfileLabel(node.profile, lang),
      ...(modelBadge ? { modelBadge } : {}),
      ...(node.serverId ? { serverId: node.serverId } : {}),
      ...(node.agentId ? { agentId: node.agentId } : {}),
      ...(node.perspective
        ? { perspectiveLabel: reviewerPerspectiveLabel(node.perspective, lang) }
        : {}),
      briefSummary: node.briefSummary,
      liveState,
      visualStatus,
      ...(node.round !== undefined ? { round: node.round } : {}),
      ...(node.verdict ? { verdict: node.verdict } : {}),
      ...(node.summary ? { summary: node.summary } : {}),
      ...(rounds.length > 0 ? { rounds } : {}),
      updatedAt: node.updatedAt,
    };
  });

  let skippedStageCount = 0;
  const visibleStageIds = STAGE_ORDER.filter((stageId) => {
    const stageNodes = nodeViews.filter((n) => n.stage === stageId);
    if (stageNodes.length === 0) return false;
    const allSkipped = stageNodes.every(
      (n) => n.visualStatus === "skipped" && !n.agentId,
    );
    if (allSkipped) {
      skippedStageCount += 1;
      return false;
    }
    return true;
  });

  const zh = lang === "zh";
  const stages: PipelineStageColumnDto[] = visibleStageIds.map(
    (stageId, idx) => {
      const stageNodes = nodeViews
        .filter((n) => n.stage === stageId)
        .sort((a, b) => a.slotIndex - b.slotIndex);
      const meta = STAGE_LABELS[lang][stageId];
      let subtitle = meta.subtitle;
      if (stageId === "plan-review") {
        subtitle =
          record.planReview === "required"
            ? zh
              ? `第 ${Math.max(1, record.planReviewRound)}/2 轮 · 交叉审核`
              : `Round ${Math.max(1, record.planReviewRound)}/2 · Cross review`
            : zh
              ? "已豁免"
              : "Waived";
      } else if (stageId === "code-review") {
        subtitle =
          record.codeReview === "required"
            ? zh
              ? `第 ${Math.max(1, record.codeReviewRound)}/2 轮`
              : `Round ${Math.max(1, record.codeReviewRound)}/2`
            : record.codeReview === "waived"
              ? zh
                ? "已豁免"
                : "Waived"
              : zh
                ? "按改动规模自动判定"
                : "Conditional on diff";
      } else if (stageId === "merge-gate") {
        subtitle =
          record.lifecycleStatus === "completed"
            ? zh
              ? "已完成验收"
              : "Signed off"
            : gateReady
              ? zh
                ? "验收项已就绪"
                : "Ready to complete"
              : meta.subtitle;
      }

      let stageStatus: PipelineStageColumnDto["stageStatus"] = "pending";
      if (stageNodes.every((n) => n.visualStatus === "skipped")) {
        stageStatus = "skipped";
      } else if (
        stageNodes.some((n) => n.visualStatus === "awaiting_permission")
      ) {
        stageStatus = "awaiting_permission";
      } else if (
        stageNodes.some(
          (n) =>
            n.visualStatus === "blocked" ||
            n.visualStatus === "changes_requested",
        )
      ) {
        stageStatus = "blocked";
      } else if (stageNodes.some((n) => n.visualStatus === "running")) {
        stageStatus = "running";
      } else if (
        stageNodes.every(
          (n) =>
            n.visualStatus === "approved" ||
            n.visualStatus === "completed" ||
            n.visualStatus === "skipped",
        )
      ) {
        stageStatus = "completed";
      }

      return {
        stageId,
        stepNumber: idx + 1,
        title: meta.title,
        subtitle,
        stageStatus,
        nodes: stageNodes,
      };
    },
  );

  const ciStatus: PipelineTaskSnapshotDto["ciStatus"] = record.ci?.waived
    ? "waived"
    : record.ci?.log
      ? gateChecks?.ciPassed === false
        ? "pending"
        : "pass"
      : "pending";

  return {
    recordPath,
    taskId: record.taskId,
    sourceKind: "team_task",
    projectRoot: record.projectRoot,
    goal: record.goal,
    isComplex: record.isComplex,
    teamName: record.teamName,
    complexMode: record.complexMode,
    ...(record.coordinatorAgentId
      ? { coordinatorAgentId: record.coordinatorAgentId }
      : {}),
    ...(record.coordinatorServerId
      ? { coordinatorServerId: record.coordinatorServerId }
      : {}),
    planReview: record.planReview,
    planReviewRound: record.planReviewRound,
    codeReview: record.codeReview,
    ...(record.codeReviewReason
      ? { codeReviewReason: record.codeReviewReason }
      : {}),
    codeReviewRound: record.codeReviewRound,
    ciStatus,
    ...(record.delivery?.architectureImpact
      ? { architectureImpact: record.delivery.architectureImpact }
      : {}),
    circuitBroken: record.circuitBroken,
    ...(gateChecks ? { gateChecks } : {}),
    ...(gateReady !== undefined ? { gateReady } : {}),
    lifecycleStatus: record.lifecycleStatus,
    runningCount,
    attentionCount,
    skippedStageCount,
    stages,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function resolveRootAgentId(
  agentId: string,
  liveMap: Map<string, LiveAgentRuntime>,
): string {
  let current = agentId;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    const info = liveMap.get(current);
    if (!info?.parentAgentId) break;
    current = info.parentAgentId;
  }
  return current;
}

function collectSubtreeIds(
  rootId: string,
  liveMap: Map<string, LiveAgentRuntime>,
): string[] {
  const childrenByParent = new Map<string, LiveAgentRuntime[]>();
  for (const agent of liveMap.values()) {
    if (!agent.parentAgentId || !agent.id) continue;
    const arr = childrenByParent.get(agent.parentAgentId) ?? [];
    arr.push(agent);
    childrenByParent.set(agent.parentAgentId, arr);
  }
  const all = [rootId];
  const queue = [rootId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const kids = childrenByParent.get(cur) ?? [];
    for (const k of kids) {
      if (k.id && !all.includes(k.id)) {
        all.push(k.id);
        queue.push(k.id);
      }
    }
  }
  return all;
}

function buildNativeSubagentGraph(
  rootId: string,
  liveMap: Map<string, LiveAgentRuntime>,
  lang: UiLanguage,
): PipelineTaskSnapshotDto | null {
  const root = liveMap.get(rootId);
  if (!root) return null;

  const childrenByParent = new Map<string, LiveAgentRuntime[]>();
  for (const agent of liveMap.values()) {
    if (!agent.parentAgentId || !agent.id) continue;
    const arr = childrenByParent.get(agent.parentAgentId) ?? [];
    arr.push(agent);
    childrenByParent.set(agent.parentAgentId, arr);
  }
  for (const arr of childrenByParent.values()) {
    arr.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  }

  const level1 = childrenByParent.get(rootId) ?? [];
  if (level1.length === 0) return null;

  const level2: LiveAgentRuntime[] = [];
  for (const c of level1) {
    if (c.id) {
      level2.push(...(childrenByParent.get(c.id) ?? []));
    }
  }

  let runningCount = 0;
  let attentionCount = 0;
  const zh = lang === "zh";

  const toNode = (
    agent: LiveAgentRuntime,
    stage: PipelineStageId,
    role: PipelineNodeViewDto["role"],
    slotIndex: number,
    fallbackLabel: string,
  ): PipelineNodeViewDto => {
    let visualStatus: NodeVisualStatus = "completed";
    let liveState: PipelineNodeViewDto["liveState"] = agent.status;
    if (agent.awaitingPermission) {
      visualStatus = "awaiting_permission";
      liveState = "awaiting_permission";
      attentionCount += 1;
    } else if (agent.status === "running" || agent.status === "initializing") {
      visualStatus = "running";
      runningCount += 1;
    } else if (agent.status === "error") {
      visualStatus = "blocked";
      attentionCount += 1;
    }

    const rawTitle = agent.title?.trim() || fallbackLabel;
    const roleMatch = /^\[([^\]]+)\]\s*(.*)$/.exec(rawTitle);
    const label = roleMatch ? roleMatch[1] : fallbackLabel;
    const brief = roleMatch && roleMatch[2] ? roleMatch[2] : rawTitle;
    const modelBadge = [
      agent.model ? `${agent.provider}/${agent.model}` : agent.provider,
      agent.thinkingOptionId ? `· ${agent.thinkingOptionId}` : "",
    ]
      .filter(Boolean)
      .join(" ");

    return {
      nodeId: agent.id ?? `${stage}-${slotIndex}`,
      stage,
      role,
      slotIndex,
      label,
      profile: agent.provider,
      ...(modelBadge ? { modelBadge } : {}),
      ...(agent.id ? { agentId: agent.id } : {}),
      briefSummary: brief,
      liveState,
      visualStatus,
      updatedAt: agent.updatedAt ?? new Date().toISOString(),
    };
  };

  const rootNode = toNode(
    root,
    "coordinator",
    "coordinator",
    0,
    zh ? "主对话" : "Main Chat",
  );
  const childNodes = level1.map((child, idx) => {
    const t = (child.title ?? "").toLowerCase();
    const role: PipelineNodeViewDto["role"] =
      t.includes("advisor") || t.includes("review") || t.includes("committee")
        ? "code-reviewer"
        : "developer";
    return toNode(
      child,
      "development",
      role,
      idx,
      zh ? `子 Agent #${idx + 1}` : `Subagent #${idx + 1}`,
    );
  });

  const stages: PipelineStageColumnDto[] = [
    {
      stageId: "coordinator",
      stepNumber: 1,
      title: zh ? "主对话" : "Main Chat",
      subtitle: zh ? "发起与汇总" : "Origin & synthesis",
      stageStatus:
        rootNode.visualStatus === "running" ? "running" : "completed",
      nodes: [rootNode],
    },
    {
      stageId: "development",
      stepNumber: 2,
      title: zh ? "派生子 Agent" : "Subagents",
      subtitle:
        childNodes.length > 1
          ? zh
            ? `共 ${childNodes.length} 个协作会话`
            : `${childNodes.length} sessions`
          : zh
            ? "子会话执行"
            : "Delegated session",
      stageStatus: childNodes.some((n) => n.visualStatus === "running")
        ? "running"
        : childNodes.some((n) => n.visualStatus === "blocked")
          ? "blocked"
          : "completed",
      nodes: childNodes,
    },
  ];

  if (level2.length > 0) {
    const l2Nodes = level2.map((c, idx) =>
      toNode(
        c,
        "code-review",
        "code-reviewer",
        idx,
        zh ? `二级子 Agent #${idx + 1}` : `Nested Agent #${idx + 1}`,
      ),
    );
    stages.push({
      stageId: "code-review",
      stepNumber: 3,
      title: zh ? "二级派生会话" : "Nested Sessions",
      subtitle: zh
        ? `共 ${l2Nodes.length} 个会话`
        : `${l2Nodes.length} sessions`,
      stageStatus: l2Nodes.some((n) => n.visualStatus === "running")
        ? "running"
        : "completed",
      nodes: l2Nodes,
    });
  }

  const now = new Date().toISOString();
  return {
    recordPath: "",
    taskId: rootId,
    sourceKind: "native_subagents",
    projectRoot: root.cwd || "",
    goal:
      root.title?.trim() ||
      (zh ? "当前对话子 Agent 协作拓扑" : "Subagent Collaboration Graph"),
    isComplex: false,
    teamName: zh ? "原生子 Agent" : "Native Subagents",
    complexMode: "simple",
    coordinatorAgentId: rootId,
    planReview: "not-required",
    planReviewRound: 0,
    codeReview: "not-required",
    codeReviewRound: 0,
    ciStatus: "pending",
    circuitBroken: null,
    lifecycleStatus: runningCount > 0 ? "active" : "completed",
    runningCount,
    attentionCount,
    skippedStageCount: 0,
    stages,
    createdAt: root.createdAt ?? now,
    updatedAt: root.updatedAt ?? now,
  };
}

export async function buildConversationGraph(
  paseo: PaseoApi,
  input: {
    agentId?: string;
    workspaceId?: string;
    cwd?: string;
    language?: UiLanguage;
  },
): Promise<ConversationGraphPayloadDto> {
  const lang = input.language ?? "en";
  const liveMap = await fetchLiveAgentMap(paseo);

  let viewerAgentId = input.agentId?.trim() || null;
  if (!viewerAgentId && input.workspaceId) {
    const wsAgents = [...liveMap.values()].filter(
      (a) => a.workspaceId === input.workspaceId && a.id,
    );
    const withTeam = wsAgents.find((a) => Boolean(findTaskByAgentId(a.id!)));
    const topLevel = wsAgents.find((a) => !a.parentAgentId);
    viewerAgentId = withTeam?.id ?? topLevel?.id ?? wsAgents[0]?.id ?? null;
  }

  if (!viewerAgentId) {
    return {
      mode: "empty",
      viewerAgentId: null,
      rootAgentId: null,
      task: null,
    };
  }

  const rootAgentId = resolveRootAgentId(viewerAgentId, liveMap);

  let cur: string | null = viewerAgentId;
  const seenAncestors = new Set<string>();
  while (cur && !seenAncestors.has(cur)) {
    seenAncestors.add(cur);
    const directMatch = findTaskByAgentId(cur);
    if (directMatch) {
      return {
        mode: "team_task",
        viewerAgentId,
        rootAgentId,
        task: toPipelineSnapshot(
          directMatch.recordPath,
          directMatch.record,
          liveMap,
          lang,
        ),
      };
    }
    cur = liveMap.get(cur)?.parentAgentId ?? null;
  }

  const candidateIds = [
    ...collectSubtreeIds(viewerAgentId, liveMap),
    ...collectSubtreeIds(rootAgentId, liveMap),
  ];
  for (const candidateId of candidateIds) {
    const matched = findTaskByAgentId(candidateId);
    if (matched) {
      return {
        mode: "team_task",
        viewerAgentId,
        rootAgentId,
        task: toPipelineSnapshot(
          matched.recordPath,
          matched.record,
          liveMap,
          lang,
        ),
      };
    }
  }

  const nativeGraph = buildNativeSubagentGraph(rootAgentId, liveMap, lang);
  if (nativeGraph) {
    return {
      mode: "native_subagents",
      viewerAgentId,
      rootAgentId,
      task: nativeGraph,
    };
  }

  return {
    mode: "empty",
    viewerAgentId,
    rootAgentId,
    task: null,
  };
}

export async function listPipelineSnapshots(
  paseo: PaseoApi,
  options: {
    cwd?: string;
    includeAllProjects?: boolean;
    language?: UiLanguage;
  },
): Promise<{
  projectKey: string | null;
  tasks: PipelineTaskSnapshotDto[];
}> {
  const lang = options.language ?? "en";
  const liveMap = await fetchLiveAgentMap(paseo);
  const projectKey = options.cwd?.trim()
    ? resolveProjectKey(options.cwd)
    : null;
  const rawList =
    options.includeAllProjects || !projectKey
      ? listAllRecentTasks(undefined, 30)
      : listTasksForProject(options.cwd!);
  const tasks = rawList.map(({ recordPath, record }) =>
    toPipelineSnapshot(recordPath, record, liveMap, lang),
  );
  return { projectKey, tasks };
}

export function parseInlineTaskDirectives(rawArgs: string): {
  goal: string;
  teamOverride?: string;
  complexModeOverride?: ComplexMode;
  isComplex?: boolean;
  requireReview?: boolean;
  requirePlanReview?: boolean;
  skipReviewReason?: string;
} {
  let text = rawArgs.trim();
  let teamOverride: string | undefined;
  let complexModeOverride: ComplexMode;
  let hasModeOverride = false;
  let requireReview: boolean | undefined;
  let requirePlanReview: boolean | undefined;
  let skipReviewReason: string | undefined;

  const zhTeamMatch =
    /(?:^|[，,\s])用\s*([^\s，,]+?)\s*(?:组合|预设)(?:[，,\s]|$)/.exec(text);
  const enTeamMatch =
    /(?:^|[\s,])(?:use\s+preset|preset:|team:)\s*([a-zA-Z0-9_-]+)/i.exec(text);
  if (zhTeamMatch) {
    teamOverride = zhTeamMatch[1].trim();
  } else if (enTeamMatch) {
    teamOverride = enTeamMatch[1].trim();
  }

  complexModeOverride = "simple";
  if (/用简单模式|\bsimple\s+mode\b/i.test(text)) {
    complexModeOverride = "simple";
    hasModeOverride = true;
  } else if (/用专家(?:模式)?|\bexpert\s+mode\b/i.test(text)) {
    complexModeOverride = "expert";
    hasModeOverride = true;
  }

  if (/不要审查|跳过审查|免审|\b(?:no|skip)\s+review\b/i.test(text)) {
    skipReviewReason = rawArgs.trim();
  } else if (
    /需要审查|开启审查|必须审查|方案审查|\b(?:with|require|enable|plan)\s+review\b/i.test(
      text,
    )
  ) {
    requireReview = true;
    if (/方案审查|\bplan\s+review\b/i.test(text)) {
      requirePlanReview = true;
    }
  }

  const isComplex =
    /重构|架构|迁移|并发|资金|事务|跨模块|根因|生产事故|\b(?:refactor|architecture|migration|concurrency|transaction|cross-module|root\s+cause|incident)\b/i.test(
      text,
    ) ||
    (hasModeOverride && complexModeOverride === "expert");

  text = text.replace(/^start\s+/i, "").trim();
  return {
    goal: text || rawArgs.trim(),
    ...(teamOverride ? { teamOverride } : {}),
    ...(hasModeOverride ? { complexModeOverride } : {}),
    isComplex,
    ...(requireReview ? { requireReview } : {}),
    ...(requirePlanReview ? { requirePlanReview } : {}),
    ...(skipReviewReason ? { skipReviewReason } : {}),
  };
}

function resolveRoleLaunchSpec(options: {
  role:
    "coordinator" | "developer" | "expert" | "plan-reviewer" | "code-reviewer";
  spec: RoleModelSpec;
  catalog: ProviderCatalogItemDto[];
  readyProviders: string[];
  avoidFullId?: string;
}): {
  providerArg: string;
  modeId?: string;
  thinkingOptionId?: string;
} {
  const { spec, catalog, readyProviders, avoidFullId } = options;
  let providerId = "";
  let fullId = "";

  if (!spec.model || spec.model === AUTO_MODEL) {
    const PROVIDER_PRIORITY: Record<string, number> = {
      codex: 1,
      claude: 2,
      antigravity: 3,
      gemini: 4,
      opencode: 5,
      pi: 6,
    };
    const readyCatalog = [...catalog.filter((c) => c.ready)].sort(
      (a, b) =>
        (PROVIDER_PRIORITY[a.provider] ?? 99) -
        (PROVIDER_PRIORITY[b.provider] ?? 99),
    );
    const avoidProv = avoidFullId?.split("/")[0] ?? "";
    const chosenCat =
      (avoidProv
        ? readyCatalog.find((c) => c.provider !== avoidProv)
        : undefined) ?? readyCatalog[0];

    if (chosenCat) {
      providerId = chosenCat.provider;
      const defaultModel =
        chosenCat.models.find((m) => m.isDefault && m.fullId !== avoidFullId) ??
        chosenCat.models.find((m) => m.fullId !== avoidFullId) ??
        chosenCat.models[0];
      fullId = defaultModel ? defaultModel.fullId : chosenCat.provider;
    } else {
      providerId = readyProviders[0] ?? "codex";
      fullId = providerId;
    }
  } else {
    fullId = spec.model;
    providerId = spec.model.split("/")[0] ?? spec.model;
  }

  const catEntry = catalog.find((c) => c.provider === providerId);
  const availableModes = catEntry?.modes ?? [];

  let modeId: string | undefined;
  if (availableModes.includes("auto-review")) {
    modeId = "auto-review";
  } else if (availableModes.includes("auto")) {
    modeId = "auto";
  } else if (
    (options.role === "developer" || options.role === "coordinator") &&
    availableModes.includes("acceptEdits")
  ) {
    modeId = "acceptEdits";
  } else if (catEntry?.defaultModeId) {
    modeId = catEntry.defaultModeId;
  }

  let thinkingOptionId =
    spec.thinking && spec.thinking !== "auto" ? spec.thinking : undefined;
  if (thinkingOptionId && catEntry && catEntry.models.length > 0) {
    const modelEntry = catEntry.models.find((m) => m.fullId === fullId);
    if (
      modelEntry &&
      modelEntry.thinkingOptions.length > 0 &&
      !modelEntry.thinkingOptions.some((t) => t.id === thinkingOptionId)
    ) {
      thinkingOptionId = modelEntry.defaultThinkingId;
    }
  }

  return {
    providerArg: fullId,
    ...(modeId ? { modeId } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
  };
}

export async function startTeamTask(
  paseo: PaseoApi,
  input: {
    cwd: string;
    workspaceId?: string;
    agentId?: string;
    rawArgs: string;
    teamOverride?: string;
    complexModeOverride?: ComplexMode;
    isComplex?: boolean;
    requireReview?: boolean;
    language?: UiLanguage;
  },
): Promise<{
  taskId: string;
  recordPath: string;
  coordinatorAgentId?: string;
  teamName: string;
  message: string;
}> {
  const { providers, readyProviders } = await readProviderCatalog(
    paseo,
    input.cwd,
  );
  const { config } = loadAndUpgradeConfig();

  const parsed = parseInlineTaskDirectives(input.rawArgs);
  const promptLang = detectPromptLanguage(parsed.goal, input.language ?? "en");
  const zh = promptLang === "zh";

  const eff = resolveEffectiveTeam(config, input.cwd, {
    teamOverride: input.teamOverride ?? parsed.teamOverride,
    complexModeOverride:
      input.complexModeOverride ?? parsed.complexModeOverride,
  });

  const created = initTask({
    cwd: input.cwd,
    goal: parsed.goal,
    teamName: eff.teamName,
    preset: eff.preset,
    isComplex: input.isComplex ?? parsed.isComplex,
    requireReview: input.requireReview ?? parsed.requireReview,
    requirePlanReview: parsed.requirePlanReview,
    skipReviewReason: parsed.skipReviewReason,
    coordinatorAgentId: input.agentId,
  });

  const devLaunch = resolveRoleLaunchSpec({
    role: "developer",
    spec: eff.preset.developer,
    catalog: providers,
    readyProviders,
  });

  const formatLaunchLine = (
    launch: ReturnType<typeof resolveRoleLaunchSpec>,
  ) => {
    const settingsObj: Record<string, unknown> = {};
    if (launch.modeId) settingsObj.modeId = launch.modeId;
    if (launch.thinkingOptionId)
      settingsObj.thinkingOptionId = launch.thinkingOptionId;
    const settingsPart =
      Object.keys(settingsObj).length > 0
        ? ` settings=${JSON.stringify(settingsObj)}`
        : "";
    return `provider="${launch.providerArg}"${settingsPart}`;
  };

  const rosterLines: string[] = [`- Developer: ${formatLaunchLine(devLaunch)}`];

  if (eff.preset.complexMode === "expert") {
    const expLaunch = resolveRoleLaunchSpec({
      role: "expert",
      spec: eff.preset.expert ?? { model: AUTO_MODEL },
      catalog: providers,
      readyProviders,
    });
    rosterLines.push(`- Expert: ${formatLaunchLine(expLaunch)}`);
  }

  eff.preset.codeReviewers.forEach((spec, idx) => {
    const persp = assignReviewerPerspective(
      idx,
      eff.preset.codeReviewers.length,
    );
    const revLaunch = resolveRoleLaunchSpec({
      role: "code-reviewer",
      spec,
      catalog: providers,
      readyProviders,
      avoidFullId: idx > 0 ? devLaunch.providerArg : undefined,
    });
    rosterLines.push(
      `- Code Reviewer #${idx + 1} (${reviewerPerspectiveLabel(persp, promptLang)}): ${formatLaunchLine(revLaunch)}`,
    );
  });

  const kickoffPrompt = zh
    ? [
        `[Team 任务启动] task_id=\`${created.record.taskId}\``,
        `任务目标：${parsed.goal}`,
        `任务记录文件：\`${created.recordPath}\``,
        `生效预设：\`${eff.teamName}\`（模式：\`${eff.preset.complexMode}\`）`,
        "",
        "### 直连模型派发参数",
        ...rosterLines,
        "",
        "### 执行步骤",
        "1. 明确目标、范围与验收标准（保存到任务证据目录）。",
        `2. 通过 Paseo \`create_agent\` 派发成员时直接使用上方 \`provider\` 与 \`settings\`（不传其他 workspaceId，共用当前工作区），附带 \`labels: { "task": "${created.record.taskId}", "role": "developer|plan-reviewer|code-reviewer|expert" }\` 及下方安全红线原文；返回后**立即调用 \`paseo_team_register_agent\`** 更新可视化状态流图。`,
        "3. 等待完成通知（禁止轮询），收到回报后调用 `paseo_team_record_delivery` / `paseo_team_record_review`，全部通过后调用 `paseo_team_complete` 完成验收。",
        "",
        getSafetyRulesText("zh"),
      ].join("\n")
    : [
        `[Team Kickoff] task_id=\`${created.record.taskId}\``,
        `Goal: ${parsed.goal}`,
        `Task Record: \`${created.recordPath}\``,
        `Active Preset: \`${eff.teamName}\` (mode: \`${eff.preset.complexMode}\`)`,
        "",
        "### Direct Role Model Routing",
        ...rosterLines,
        "",
        "### Execution Steps",
        "1. Define scope and acceptance criteria in the task evidence directory.",
        `2. Dispatch subagents via Paseo \`create_agent\` using the exact \`provider\` and \`settings\` above (stay in this workspace), passing \`labels: { "task": "${created.record.taskId}", "role": "developer|plan-reviewer|code-reviewer|expert" }\` and the verbatim security rules below; **immediately call \`paseo_team_register_agent\`** after each \`create_agent\`.`,
        "3. Wait for completion notifications (never poll), record delivery/reviews via `paseo_team_record_delivery` / `paseo_team_record_review`, and call `paseo_team_complete` once ready.",
        "",
        getSafetyRulesText("en"),
      ].join("\n");

  let coordinatorAgentId = input.agentId;

  if (coordinatorAgentId) {
    const handle = paseo.agents.ref(coordinatorAgentId);
    try {
      await handle.setMetadata({
        "paseo-team.task": {
          taskId: created.record.taskId,
          recordPath: created.recordPath,
          role: "coordinator",
        },
      });
      const refreshed = await handle.refresh();
      if (refreshed?.agent.status === "idle") {
        await handle.reload({
          requestId: `paseo-team-init-${created.record.taskId}`,
        });
      }
      await handle.send(kickoffPrompt);
    } catch (err) {
      throw new Error(
        `Failed to send kickoff to coordinator: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (input.workspaceId) {
    const ws = paseo.workspaces.ref(input.workspaceId);
    const coordLaunch = resolveRoleLaunchSpec({
      role: "coordinator",
      spec: { model: AUTO_MODEL },
      catalog: providers,
      readyProviders,
    });
    const createdAgent = await ws.agents.create({
      config: {
        provider: coordLaunch.providerArg,
        ...(coordLaunch.modeId ? { modeId: coordLaunch.modeId } : {}),
        ...(coordLaunch.thinkingOptionId
          ? { thinkingOptionId: coordLaunch.thinkingOptionId }
          : {}),
      },
      title: `[Team] ${parsed.goal.slice(0, 42)}`,
      labels: { task: created.record.taskId, role: "coordinator" },
      metadata: {
        "paseo-team.task": {
          taskId: created.record.taskId,
          recordPath: created.recordPath,
          role: "coordinator",
        },
      },
      prompt: kickoffPrompt,
    });
    coordinatorAgentId = createdAgent.id;
    const updated = loadTask(created.recordPath);
    updated.coordinatorAgentId = coordinatorAgentId;
    const coordNode = updated.nodes.find((n) => n.nodeId === "coordinator");
    if (coordNode) coordNode.agentId = coordinatorAgentId;
    saveTask(created.recordPath, updated);
  }

  notifyTaskChanges();
  return {
    taskId: created.record.taskId,
    recordPath: created.recordPath,
    ...(coordinatorAgentId ? { coordinatorAgentId } : {}),
    teamName: eff.teamName,
    message: zh ? "已启动团队协作流水线。" : "Team pipeline started.",
  };
}

export function createCoordinatorTools(
  recordPath: string,
): AgentToolDefinition[] {
  const summaryTool = defineAgentTool({
    name: "paseo_team_task_summary",
    title: "Get Task Recovery Summary",
    description:
      "Read the deterministic Paseo Team recovery brief, registered subagent IDs, review rounds, and pending quality checks.",
    input: z.object({}),
    async execute() {
      const record = loadTask(recordPath);
      return {
        text: buildRecoveryBrief(record),
        structuredContent: {
          taskId: record.taskId,
          recordPath,
          lifecycleStatus: record.lifecycleStatus,
          planReviewRound: record.planReviewRound,
          codeReviewRound: record.codeReviewRound,
          circuitBroken: record.circuitBroken,
        },
      };
    },
  });

  const registerAgentTool = defineAgentTool({
    name: "paseo_team_register_agent",
    title: "Register Team Subagent Node",
    description:
      "Call immediately after creating expert, plan-reviewer, developer, or code-reviewer to update the live visual graph and capture read-only snapshots.",
    input: z.object({
      role: z.enum(["expert", "plan-reviewer", "developer", "code-reviewer"]),
      slotIndex: z.number().int().min(0).optional(),
      agentId: z.string().min(1),
      serverId: z.string().optional(),
      profile: z.string().min(1),
      provider: z.string().optional(),
      model: z.string().optional(),
      thinkingOptionId: z.string().optional(),
      briefSummary: z.string().min(1),
      round: z.number().int().min(1).optional(),
    }),
    async execute(args) {
      const current = loadTask(recordPath);
      const updated = registerTaskAgent(recordPath, {
        role: args.role,
        slotIndex: args.slotIndex,
        agentId: args.agentId,
        serverId: args.serverId,
        profile: args.profile,
        provider: args.provider,
        model: args.model,
        thinkingOptionId: args.thinkingOptionId,
        briefSummary: args.briefSummary,
        round: args.round,
        captureReadOnlyCwd: current.projectRoot,
      });
      notifyTaskChanges();
      return {
        text: `Registered ${args.role} node (${args.agentId}).`,
        structuredContent: { taskId: updated.taskId, agentId: args.agentId },
      };
    },
  });

  const recordDeliveryTool = defineAgentTool({
    name: "paseo_team_record_delivery",
    title: "Record Developer Delivery",
    description:
      "Record Developer's change summary, CI log filename (e.g. ci-1.log), and architecture impact.",
    input: z.object({
      summary: z.string().min(1),
      ciLog: z.string().optional(),
      ciWaivedUserQuote: z.string().optional(),
      architectureImpact: z.string().min(1),
      requireCodeReview: z.boolean().optional(),
      codeReviewReason: z.string().optional(),
    }),
    async execute(args) {
      const updated = recordCandidateDelivery(recordPath, args);
      notifyTaskChanges();
      return {
        text: `Recorded delivery (codeReview=${updated.codeReview}).`,
        structuredContent: {
          fingerprint: updated.candidate,
          codeReview: updated.codeReview,
          codeReviewReason: updated.codeReviewReason,
        },
      };
    },
  });

  const recordReviewTool = defineAgentTool({
    name: "paseo_team_record_review",
    title: "Record Review Verdict & Circuit Breaker Check",
    description:
      "Record plan or code review verdict with anti-spoofing sidecar and 2-round circuit breaker enforcement.",
    input: z.object({
      stage: z.enum(["plan", "code"]),
      agentId: z.string().min(1),
      profile: z.string().optional(),
      targetVersionOrCommit: z.string().optional(),
      round: z.number().int().min(1),
      verdict: z.enum(["APPROVE", "REQUEST_CHANGES", "BLOCKED"]),
      summary: z.string().min(1),
      findings: z
        .array(z.string().min(1))
        .max(30)
        .optional()
        .describe(
          'Individual issues, one per item, prefixed "blocking:" or "advice:".',
        ),
      rawOutput: z.string().optional(),
      substantialChange: z.boolean().optional(),
      userAuthorizedExtraRound: z.string().optional(),
    }),
    async execute(args) {
      const res = recordReviewVerdict(recordPath, args);
      notifyTaskChanges();
      return {
        text: res.message,
        structuredContent: {
          status: res.status,
          round: res.round,
          maxRounds: res.maxRounds,
          sidecar: res.sidecar,
        },
        isError: res.status === "CIRCUIT_BROKEN",
      };
    },
  });

  const completeTool = defineAgentTool({
    name: "paseo_team_complete",
    title: "Verify Quality Gate & Complete Task",
    description:
      "Verify CI sidecar, required code review approvals, read-only integrity, and 2-round circuit breaker, then mark the task completed.",
    input: z.object({
      inspectOnly: z.boolean().optional(),
    }),
    async execute(args) {
      const record = loadTask(recordPath);
      const rep = inspectQualityGate({
        recordPath,
        cwd: record.projectRoot,
      });
      if (rep.status === "READY" && !args.inspectOnly) {
        markTaskCompleted(recordPath, rep.fingerprint);
      }
      notifyTaskChanges();
      return {
        text: JSON.stringify(rep, null, 2),
        structuredContent: rep,
        isError: rep.status !== "READY",
      };
    },
  });

  return [
    summaryTool,
    registerAgentTool,
    recordDeliveryTool,
    recordReviewTool,
    completeTool,
  ];
}

export function createDeveloperTools(
  recordPath: string,
): AgentToolDefinition[] {
  const taskDir = path.dirname(path.resolve(recordPath));

  const runCheckTool = defineAgentTool({
    name: "paseo_team_run_check",
    title: "Run Credential-Isolated Full CI Check",
    description:
      "Run full tests/CI in the workspace with SKIP_DOTENV=true and write the fingerprint-bound .log.json sidecar.",
    input: z.object({
      logFileName: z.string().min(5),
      command: z.string().min(1),
      args: z.array(z.string()),
      cwd: z.string().optional(),
    }),
    async execute(args) {
      const record = loadTask(recordPath);
      const safeBase = path.basename(args.logFileName.trim());
      const logPath = path.join(taskDir, safeBase);
      const targetCwd = args.cwd?.trim() || record.projectRoot;
      const result = runCheck(args.command, args.args, {
        log: logPath,
        cwd: targetCwd,
      });
      notifyTaskChanges();
      return {
        text: JSON.stringify(result, null, 2),
        structuredContent: result,
        isError: result.status !== "PASS",
      };
    },
  });

  return [runCheckTool];
}

export { buildCoordinatorSystemPrompt };
