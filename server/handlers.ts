import path from "node:path";
import { existsSync } from "node:fs";
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
  localizeStepTitle,
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
  type TeamPreset,
} from "./config-store.ts";
import {
  assignReviewerPerspective,
  buildCoordinatorSystemPrompt,
  buildKickoffPrompt,
  reviewerPerspectiveLabel,
} from "./prompts.ts";
import {
  evaluateCodeReviewTrigger,
  inspectQualityGate,
} from "./quality-gate.ts";
import {
  buildRecoveryBrief,
  findTaskByAgentId,
  initTask,
  listAllRecentTasks,
  listTasksForProject,
  loadTask,
  markTaskCompleted,
  type NodeVisualStatus,
  nextReviewRound,
  readReviewRounds,
  type PipelineStageId,
  recordCandidateDelivery,
  recordPlanSubmission,
  recordReviewVerdict,
  resolveCircuitBreaker,
  saveTask,
  setTaskRoute,
  type TaskRecord,
} from "./task-store.ts";

type Listener = () => void;
const listeners = new Set<Listener>();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function subscribeTaskChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
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
      page: { limit: 200 }, // daemon rejects larger pages, which emptied all live state
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
  } catch (err) {
    // Non-fatal, but log it: a silent failure here blanks every live status.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/Daemon client closed/i.test(msg)) {
      console.error("[paseo-team] agents.list failed:", err);
    }
  }
  return map;
}

function humanizeProfileLabel(profile: string, lang: UiLanguage): string {
  if (!profile || profile === "auto" || profile === "Auto") {
    return lang === "en" ? "No model set" : "未设置模型";
  }
  if (profile === "workflow.ts" || profile === "quality-gate") {
    return lang === "en" ? "Quality Gate" : "质量验收门禁";
  }
  if (profile === "当前会话" || profile === "Current Chat") {
    return lang === "en" ? "Current Chat" : "当前会话";
  }
  return profile;
}

function computeStageStatus(
  stageNodes: PipelineNodeViewDto[],
): PipelineStageColumnDto["stageStatus"] {
  if (
    stageNodes.length === 0 ||
    stageNodes.every((n) => n.visualStatus === "skipped")
  ) {
    return "skipped";
  }
  if (stageNodes.some((n) => n.visualStatus === "awaiting_permission")) {
    return "awaiting_permission";
  }
  if (
    stageNodes.some(
      (n) =>
        n.visualStatus === "blocked" || n.visualStatus === "changes_requested",
    )
  ) {
    return "blocked";
  }
  if (stageNodes.some((n) => n.visualStatus === "running")) {
    return "running";
  }
  if (
    stageNodes.every(
      (n) =>
        n.visualStatus === "approved" ||
        n.visualStatus === "completed" ||
        n.visualStatus === "skipped",
    )
  ) {
    return "completed";
  }
  return "pending";
}

function verdictToVisualStatus(
  verdict: NonNullable<PipelineNodeViewDto["verdict"]>,
): NodeVisualStatus {
  return verdict === "APPROVE"
    ? "approved"
    : verdict === "REQUEST_CHANGES"
      ? "changes_requested"
      : "blocked";
}

const KNOWN_DEFAULT_COORD_BRIEFS = new Set([
  "兼任架构设计 · 统筹目标、派发与验收",
  "Drafts design · Scopes, dispatches & adjudicates",
  "目标拆解、派发协调与证据裁决",
  "Scopes goal, dispatches roles & adjudicates by evidence",
]);

const KNOWN_DEFAULT_DEV_BRIEFS = new Set([
  "直接在当前工作区实现修改并运行完整测试",
  "Implements changes & runs full CI in this workspace",
]);

function localizeNodeBrief(
  node: TaskRecord["nodes"][number],
  record: TaskRecord,
  gateReady: boolean | undefined,
  lang: UiLanguage,
): string {
  const zh = lang === "zh";
  if (node.role === "gate") {
    if (record.lifecycleStatus === "completed") {
      return zh
        ? "最新测试/CI 与所需审查均已通过，已完成验收"
        : "Latest CI run and required reviews verified";
    }
    if (gateReady === true) {
      return zh
        ? "测试/CI 与交叉审查已就绪，可确认完成验收"
        : "CI and cross-review checks satisfied — ready to complete";
    }
    return zh
      ? "核对最新一次测试/CI 与最新一轮审查批准"
      : "Verifies latest CI run and latest-round review approvals";
  }
  if (
    node.role === "coordinator" &&
    KNOWN_DEFAULT_COORD_BRIEFS.has(node.briefSummary)
  ) {
    if (record.routeDecided === false) {
      return zh
        ? "正在结合上下文评估需求复杂度，决定是否启用方案评审与代码审查"
        : "Evaluating task complexity from chat context to decide plan & code review";
    }
    return record.complexMode === "simple" && record.isComplex
      ? zh
        ? "兼任架构设计 · 统筹目标、派发与验收"
        : "Drafts design · Scopes, dispatches & adjudicates"
      : zh
        ? "目标拆解、派发协调与证据裁决"
        : "Scopes goal, dispatches roles & adjudicates by evidence";
  }
  if (
    node.role === "developer" &&
    KNOWN_DEFAULT_DEV_BRIEFS.has(node.briefSummary)
  ) {
    return zh
      ? "直接在当前工作区实现修改并运行完整测试"
      : "Implements changes & runs full CI in this workspace";
  }
  return node.briefSummary;
}

export function toPipelineSnapshot(
  recordPath: string,
  record: TaskRecord,
  liveMap: Map<string, LiveAgentRuntime>,
  lang: UiLanguage = "en",
): PipelineTaskSnapshotDto {
  let gateChecks: Record<string, boolean> | undefined;
  let gateReady: boolean | undefined;
  let gateMissing: string[] | undefined;

  if (record.delivery || record.candidate || record.ci) {
    try {
      const report = inspectQualityGate({ recordPath });
      gateChecks = report.checks;
      gateReady = report.status === "READY";
      gateMissing = report.missing;
    } catch {
      // Non-fatal
    }
  }

  let runningCount = 0;
  let attentionCount = 0;
  const totalDevelopers = record.nodes.filter(
    (n) => n.role === "developer",
  ).length;
  const zh = lang === "zh";

  interface BaseResolvedNode {
    raw: TaskRecord["nodes"][number];
    view: PipelineNodeViewDto;
    rounds: NonNullable<PipelineNodeViewDto["rounds"]>;
    isLiveActive: boolean;
  }

  const resolvedNodes: BaseResolvedNode[] = record.nodes.map((node) => {
    const live = node.agentId ? liveMap.get(node.agentId) : undefined;
    let liveState: PipelineNodeViewDto["liveState"] = "not_started";
    let visualStatus: NodeVisualStatus = node.status;
    let isLiveActive = false;

    if (live) {
      if (live.awaitingPermission) {
        liveState = "awaiting_permission";
        visualStatus = "awaiting_permission";
        attentionCount += 1;
        isLiveActive = true;
      } else {
        liveState = live.status;
        if (live.status === "running" || live.status === "initializing") {
          visualStatus = "running";
          runningCount += 1;
          isLiveActive = true;
        } else if (live.status === "error") {
          visualStatus = "blocked";
          attentionCount += 1;
        } else if (visualStatus === "running") {
          if (node.role === "coordinator") {
            visualStatus =
              record.lifecycleStatus === "active"
                ? "running"
                : record.lifecycleStatus === "completed"
                  ? "completed"
                  : record.lifecycleStatus === "blocked"
                    ? "blocked"
                    : "pending";
          } else {
            visualStatus =
              record.lifecycleStatus === "completed" ? "completed" : "pending";
          }
        }
      }
    } else if (node.role === "coordinator") {
      liveState = "idle";
      if (visualStatus === "running" && record.lifecycleStatus !== "active") {
        visualStatus =
          record.lifecycleStatus === "completed"
            ? "completed"
            : record.lifecycleStatus === "blocked"
              ? "blocked"
              : "pending";
      }
    } else if (
      node.nodeId === "merge-gate" &&
      record.lifecycleStatus !== "completed"
    ) {
      if (record.circuitBroken) {
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
      raw: node,
      rounds,
      isLiveActive,
      view: {
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
          node.role === "developer" ? totalDevelopers : undefined,
        ),
        profile: humanizeProfileLabel(node.profile, lang),
        ...(modelBadge ? { modelBadge } : {}),
        ...(node.serverId ? { serverId: node.serverId } : {}),
        ...(node.agentId ? { agentId: node.agentId } : {}),
        ...(node.perspective
          ? {
              perspectiveLabel: reviewerPerspectiveLabel(
                node.perspective,
                lang,
              ),
            }
          : {}),
        briefSummary: localizeNodeBrief(node, record, gateReady, lang),
        liveState,
        visualStatus,
        ...(node.round !== undefined ? { round: node.round } : {}),
        ...(node.verdict ? { verdict: node.verdict } : {}),
        ...(node.summary ? { summary: node.summary } : {}),
        ...(rounds.length > 0 ? { rounds } : {}),
        updatedAt: node.updatedAt,
      },
    };
  });

  const isStageSkipped = (list: BaseResolvedNode[]): boolean =>
    list.length > 0 &&
    list.every((n) => n.view.visualStatus === "skipped" && !n.view.agentId);

  let skippedStageCount = 0;
  const stages: PipelineStageColumnDto[] = [];
  const pushStep = (
    stepId: string,
    stageId: PipelineStageId,
    nodes: PipelineNodeViewDto[],
    options?: { round?: number; multiRound?: boolean; subtitle?: string },
  ) => {
    if (nodes.length === 0) return;
    const sorted = [...nodes].sort((a, b) => a.slotIndex - b.slotIndex);
    const meta = STAGE_LABELS[lang][stageId];
    stages.push({
      stepId,
      stageId,
      ...(options?.round !== undefined ? { round: options.round } : {}),
      stepNumber: stages.length + 1,
      title: localizeStepTitle(
        lang,
        stageId,
        options?.round,
        options?.multiRound,
      ),
      subtitle: options?.subtitle ?? meta.subtitle,
      stageStatus: computeStageStatus(sorted),
      nodes: sorted,
    });
  };

  const hasDispatchedMember = record.nodes.some(
    (n) => n.role !== "coordinator" && n.role !== "gate" && Boolean(n.agentId),
  );
  const routePending = record.routeDecided === false && !hasDispatchedMember;

  // 1. Coordinator
  const coordNodes = resolvedNodes
    .filter((n) => n.raw.stage === "coordinator")
    .map((n) => n.view);
  pushStep("coordinator", "coordinator", coordNodes, {
    ...(routePending
      ? {
          subtitle: zh
            ? "评估需求复杂度与执行路径"
            : "Assessing complexity & execution route",
        }
      : {}),
  });

  if (!routePending) {
    // 2. Expert + Plan Review (expands dynamically across revision rounds)
    const expertBase = resolvedNodes.filter((n) => n.raw.stage === "expert");
    const planRevBase = resolvedNodes.filter(
      (n) => n.raw.stage === "plan-review",
    );
    const expertSkipped = isStageSkipped(expertBase);
    const planRevSkipped = isStageSkipped(planRevBase);
    if (expertSkipped) skippedStageCount += 1;
    if (planRevSkipped) skippedStageCount += 1;

    const expertVisible = expertBase.length > 0 && !expertSkipped;
    const planRevVisible = planRevBase.length > 0 && !planRevSkipped;

    const maxRounds = 2 + (record.extraRounds ?? 0);
    const ownMaxRound = (item: BaseResolvedNode) =>
      item.rounds.reduce((m, r) => Math.max(m, r.round), 0);

    if (expertVisible || planRevVisible) {
      const recordedPlanRoundSet = new Set<number>();
      for (const item of planRevBase) {
        for (const r of item.rounds) recordedPlanRoundSet.add(r.round);
      }
      const recordedPlanRounds = [...recordedPlanRoundSet].sort(
        (a, b) => a - b,
      );
      const maxPlanRecorded =
        recordedPlanRounds.length > 0 ? Math.max(...recordedPlanRounds) : 0;
      const planSubmissions = record.planSubmissions ?? 0;
      const lastPlanRoundFailed =
        maxPlanRecorded >= 1 &&
        planRevBase.some((item) => {
          const last = item.rounds
            .filter((x) => x.round === maxPlanRecorded)
            .at(-1);
          return Boolean(last && last.verdict !== "APPROVE");
        });

      const nextLiveExpertRound =
        maxPlanRecorded >= 1 &&
        maxPlanRecorded >= planSubmissions &&
        lastPlanRoundFailed &&
        expertBase.some((n) => n.isLiveActive)
          ? maxPlanRecorded + 1
          : 0;
      const planTargetRound = Math.max(1, maxPlanRecorded, planSubmissions);
      const nextLivePlanRevRound = planRevBase.some(
        (n) => n.isLiveActive && ownMaxRound(n) < planTargetRound,
      )
        ? planTargetRound
        : 0;

      const planCycleRounds = [
        ...new Set<number>([
          ...(recordedPlanRounds.length > 0 ? recordedPlanRounds : [1]),
          ...(nextLiveExpertRound ? [nextLiveExpertRound] : []),
          ...(nextLivePlanRevRound ? [nextLivePlanRevRound] : []),
        ]),
      ].sort((a, b) => a - b);
      const multiPlan = planCycleRounds.length > 1;
      const maxPlanCycle = planCycleRounds[planCycleRounds.length - 1] ?? 1;

      for (const r of planCycleRounds) {
        if (
          expertVisible &&
          (r === 1 || r <= planSubmissions || r === nextLiveExpertRound)
        ) {
          const expRoundNodes = expertBase.map((item): PipelineNodeViewDto => {
            const settledEarlier = r < maxPlanCycle || r <= maxPlanRecorded;
            return {
              ...item.view,
              nodeId: r === 1 ? item.view.nodeId : `${item.view.nodeId}-r${r}`,
              label: localizeNodeRoleLabel(
                lang,
                "expert",
                item.raw.slotIndex,
                item.raw.label,
                false,
                expertBase.length,
                r,
                multiPlan,
              ),
              round: r,
              visualStatus:
                r === maxPlanCycle && item.isLiveActive
                  ? item.view.visualStatus
                  : settledEarlier
                    ? "completed"
                    : item.view.visualStatus,
              liveState:
                settledEarlier && r < maxPlanCycle && item.isLiveActive
                  ? "idle"
                  : item.view.liveState,
            };
          });
          pushStep(
            r === 1 ? "expert" : `expert-r${r}`,
            "expert",
            expRoundNodes,
            {
              round: multiPlan || r > 1 ? r : undefined,
              multiRound: multiPlan,
            },
          );
        }

        const shouldEmitPlanRev =
          planRevVisible &&
          (recordedPlanRoundSet.has(r) ||
            r === nextLivePlanRevRound ||
            recordedPlanRounds.length === 0);

        if (shouldEmitPlanRev) {
          const prNodes: PipelineNodeViewDto[] = [];
          for (const item of planRevBase) {
            const roundEntries = item.rounds.filter((x) => x.round === r);
            const roundEntry = roundEntries.at(-1);
            const include =
              recordedPlanRounds.length === 0 ||
              Boolean(roundEntry) ||
              (r === nextLivePlanRevRound && item.isLiveActive);
            if (!include) continue;

            prNodes.push({
              ...item.view,
              nodeId: r === 1 ? item.view.nodeId : `${item.view.nodeId}-r${r}`,
              label: localizeNodeRoleLabel(
                lang,
                "plan-reviewer",
                item.raw.slotIndex,
                item.raw.label,
                false,
                planRevBase.length,
                r,
                multiPlan,
              ),
              round: r,
              verdict:
                roundEntry?.verdict ??
                (r === 1 ? item.view.verdict : undefined),
              summary:
                roundEntry?.summary ||
                (recordedPlanRounds.length === 0
                  ? item.view.summary
                  : undefined),
              rounds: roundEntries.length > 0 ? roundEntries : undefined,
              visualStatus: roundEntry
                ? verdictToVisualStatus(roundEntry.verdict)
                : r === nextLivePlanRevRound && item.isLiveActive
                  ? item.view.visualStatus
                  : item.view.visualStatus,
              liveState:
                roundEntry && r < maxPlanCycle && item.isLiveActive
                  ? "idle"
                  : item.view.liveState,
            });
          }
          pushStep(
            r === 1 ? "plan-review" : `plan-review-r${r}`,
            "plan-review",
            prNodes,
            {
              round: multiPlan || r > 1 ? r : undefined,
              multiRound: multiPlan,
              subtitle:
                record.planReview === "required"
                  ? zh
                    ? `第 ${r}/${maxRounds} 轮 · 交叉审核`
                    : `Round ${r}/${maxRounds} · Cross review`
                  : zh
                    ? "已豁免"
                    : "Waived",
            },
          );
        }
      }
    }

    // 3. Development + Code Review (expands dynamically as revisions & re-reviews occur)
    const devBase = resolvedNodes.filter((n) => n.raw.stage === "development");
    const codeRevBase = resolvedNodes.filter(
      (n) => n.raw.stage === "code-review",
    );
    const codeRevSkipped = isStageSkipped(codeRevBase);
    if (codeRevSkipped) skippedStageCount += 1;
    const codeRevVisible = codeRevBase.length > 0 && !codeRevSkipped;

    const recordedCodeRoundSet = new Set<number>();
    for (const item of codeRevBase) {
      for (const r of item.rounds) recordedCodeRoundSet.add(r.round);
    }
    const recordedCodeRounds = [...recordedCodeRoundSet].sort((a, b) => a - b);
    const maxCodeRecorded =
      recordedCodeRounds.length > 0 ? Math.max(...recordedCodeRounds) : 0;

    const deliveries = record.deliveries ?? [];
    const recordedDevRoundSet = new Set<number>(deliveries.map((d) => d.round));
    const maxDeliveryRound = deliveries.reduce(
      (m, d) => Math.max(m, d.round),
      0,
    );
    const lastCodeRoundFailed =
      maxCodeRecorded >= 1 &&
      codeRevBase.some((item) => {
        const last = item.rounds
          .filter((x) => x.round === maxCodeRecorded)
          .at(-1);
        return Boolean(last && last.verdict !== "APPROVE");
      });

    const nextLiveDevRound =
      maxCodeRecorded >= 1 &&
      maxCodeRecorded >= maxDeliveryRound &&
      lastCodeRoundFailed &&
      devBase.some((n) => n.isLiveActive)
        ? Math.max(maxCodeRecorded + 1, ...devBase.map((n) => n.raw.round ?? 0))
        : 0;
    const codeTargetRound = Math.max(1, maxCodeRecorded, maxDeliveryRound);
    const nextLiveCodeRound = codeRevBase.some(
      (n) => n.isLiveActive && ownMaxRound(n) < codeTargetRound,
    )
      ? codeTargetRound
      : 0;

    const codeCycleRounds = [
      ...new Set<number>([
        ...(recordedCodeRounds.length > 0 ? recordedCodeRounds : [1]),
        ...recordedDevRoundSet,
        ...(nextLiveDevRound ? [nextLiveDevRound] : []),
        ...(nextLiveCodeRound ? [nextLiveCodeRound] : []),
      ]),
    ].sort((a, b) => a - b);

    const multiCodeCycle = codeCycleRounds.length > 1;
    const maxCodeCycle = codeCycleRounds[codeCycleRounds.length - 1] ?? 1;

    for (const r of codeCycleRounds) {
      if (
        devBase.length > 0 &&
        (r === 1 || recordedDevRoundSet.has(r) || r === nextLiveDevRound)
      ) {
        const roundDeliveries = deliveries.filter((d) => d.round === r);
        const settledDevRound =
          r < maxCodeCycle ||
          roundDeliveries.length > 0 ||
          recordedCodeRoundSet.has(r) ||
          (codeCycleRounds.length === 1 &&
            (Boolean(record.delivery) ||
              Boolean(record.candidate) ||
              record.lifecycleStatus === "completed"));

        const devRoundNodes = devBase.map((item): PipelineNodeViewDto => {
          const matchedDelivery =
            roundDeliveries.find((d) => d.agentId === item.raw.agentId) ??
            (devBase.length === 1 ? roundDeliveries[0] : undefined);
          const fallbackSummary =
            matchedDelivery?.summary ??
            (r === maxCodeCycle
              ? item.view.summary || record.delivery?.summary
              : roundDeliveries[0]?.summary);

          return {
            ...item.view,
            nodeId: r === 1 ? item.view.nodeId : `${item.view.nodeId}-r${r}`,
            label: localizeNodeRoleLabel(
              lang,
              "developer",
              item.raw.slotIndex,
              item.raw.label,
              false,
              totalDevelopers,
              multiCodeCycle ? r : undefined,
              multiCodeCycle,
            ),
            ...(multiCodeCycle ? { round: r } : {}),
            summary:
              fallbackSummary ||
              (r > 1 && item.isLiveActive
                ? undefined
                : r === 1 && !multiCodeCycle
                  ? item.view.summary
                  : undefined),
            briefSummary:
              r > 1 && !matchedDelivery
                ? zh
                  ? `根据第 ${r - 1} 轮审查意见修订代码并重跑完整测试`
                  : `Revises code for Round ${r - 1} review findings & reruns CI`
                : item.view.briefSummary,
            visualStatus:
              r === maxCodeCycle && item.isLiveActive
                ? item.view.visualStatus
                : settledDevRound
                  ? "completed"
                  : item.view.visualStatus,
            liveState:
              settledDevRound && r < maxCodeCycle && item.isLiveActive
                ? "idle"
                : item.view.liveState,
          };
        });

        pushStep(
          r === 1 ? "development" : `development-r${r}`,
          "development",
          devRoundNodes,
          {
            round: multiCodeCycle ? r : undefined,
            multiRound: multiCodeCycle,
          },
        );
      }

      const shouldEmitCodeRev =
        codeRevVisible &&
        (recordedCodeRoundSet.has(r) ||
          r === nextLiveCodeRound ||
          (recordedCodeRounds.length === 0 && r === 1));

      if (shouldEmitCodeRev) {
        const crNodes: PipelineNodeViewDto[] = [];
        for (const item of codeRevBase) {
          const roundEntries = item.rounds.filter((x) => x.round === r);
          const roundEntry = roundEntries.at(-1);
          const include =
            recordedCodeRounds.length === 0 ||
            Boolean(roundEntry) ||
            (r === nextLiveCodeRound &&
              (item.isLiveActive || item.raw.round === r));
          if (!include) continue;

          const showRoundTag = multiCodeCycle || r > 1;
          crNodes.push({
            ...item.view,
            nodeId: r === 1 ? item.view.nodeId : `${item.view.nodeId}-r${r}`,
            label: localizeNodeRoleLabel(
              lang,
              "code-reviewer",
              item.raw.slotIndex,
              item.raw.label,
              false,
              codeRevBase.length,
              showRoundTag ? r : undefined,
              multiCodeCycle,
            ),
            round:
              roundEntry?.round ??
              (recordedCodeRounds.length === 0 ? item.view.round : r),
            verdict:
              roundEntry?.verdict ??
              (recordedCodeRounds.length === 0 ? item.view.verdict : undefined),
            summary:
              roundEntry?.summary ||
              (recordedCodeRounds.length === 0 ? item.view.summary : undefined),
            rounds: roundEntries.length > 0 ? roundEntries : undefined,
            visualStatus: roundEntry
              ? verdictToVisualStatus(roundEntry.verdict)
              : r === nextLiveCodeRound && item.isLiveActive
                ? item.view.visualStatus
                : item.view.visualStatus,
            liveState:
              roundEntry && r < maxCodeCycle && item.isLiveActive
                ? "idle"
                : item.view.liveState,
          });
        }

        pushStep(
          r === 1 ? "code-review" : `code-review-r${r}`,
          "code-review",
          crNodes,
          {
            round: multiCodeCycle || r > 1 ? r : undefined,
            multiRound: multiCodeCycle,
            subtitle:
              record.codeReview === "required"
                ? zh
                  ? `第 ${r}/${maxRounds} 轮`
                  : `Round ${r}/${maxRounds}`
                : record.codeReview === "waived"
                  ? zh
                    ? "已豁免"
                    : "Waived"
                  : zh
                    ? "按改动规模自动判定"
                    : "Conditional on diff",
          },
        );
      }
    }

    // 4. Quality Gate
    const gateNodes = resolvedNodes
      .filter((n) => n.raw.stage === "merge-gate")
      .map((n) => n.view);
    pushStep("merge-gate", "merge-gate", gateNodes, {
      subtitle:
        record.lifecycleStatus === "completed"
          ? zh
            ? "已完成验收"
            : "Signed off"
          : gateReady
            ? zh
              ? "验收项已就绪"
              : "Ready to complete"
            : STAGE_LABELS[lang]["merge-gate"].subtitle,
    });
  }

  const ciStatus: PipelineTaskSnapshotDto["ciStatus"] = record.ci?.waived
    ? "waived"
    : record.ci?.status === "pass"
      ? gateChecks?.ciPassed === false
        ? "pending"
        : "pass"
      : record.ci?.status === "fail"
        ? "pending"
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
    routeDecided: !routePending,
    ...(record.routeReason ? { routeReason: record.routeReason } : {}),
    teamName: record.teamName,
    complexMode: record.complexMode,
    ...(record.coordinatorAgentId
      ? { coordinatorAgentId: record.coordinatorAgentId }
      : {}),
    ...(record.coordinatorServerId
      ? { coordinatorServerId: record.coordinatorServerId }
      : {}),
    ...(record.launcherAgentId
      ? { launcherAgentId: record.launcherAgentId }
      : {}),
    planReview: record.planReview,
    ...(record.planReviewReason
      ? { planReviewReason: record.planReviewReason }
      : {}),
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
    ...(gateMissing?.length ? { gateMissing } : {}),
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
      stepId: "coordinator",
      stageId: "coordinator",
      stepNumber: 1,
      title: zh ? "主对话" : "Main Chat",
      subtitle: zh ? "发起与汇总" : "Origin & synthesis",
      stageStatus:
        rootNode.visualStatus === "running" ? "running" : "completed",
      nodes: [rootNode],
    },
    {
      stepId: "development",
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
      stepId: "nested-sessions",
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
  const recentTasks = listAllRecentTasks(undefined, 100);
  const isOpenTask = (status: TaskRecord["lifecycleStatus"]) =>
    status !== "completed" && status !== "abandoned";
  const openTasks = recentTasks.filter((t) =>
    isOpenTask(t.record.lifecycleStatus),
  );
  const matchInList = (
    list: typeof recentTasks,
    agentId: string,
    includeLauncher = false,
  ) =>
    list.find(
      (item) =>
        item.record.coordinatorAgentId === agentId ||
        (includeLauncher && item.record.launcherAgentId === agentId) ||
        (Array.isArray(item.record.nodes) &&
          item.record.nodes.some((n) => n?.agentId === agentId)),
    ) ?? null;
  const matchTask = (agentId: string) =>
    matchInList(openTasks, agentId) ?? matchInList(recentTasks, agentId);

  let viewerAgentId = input.agentId?.trim() || null;
  if (!viewerAgentId && input.workspaceId) {
    const wsAgents = [...liveMap.values()]
      .filter((a) => a.workspaceId === input.workspaceId && a.id)
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    const wsAgentIds = new Set(wsAgents.map((a) => a.id!));
    const pickTaskViewer = (list: typeof recentTasks): string | null => {
      for (const item of list) {
        const candidates = [
          item.record.coordinatorAgentId,
          item.record.launcherAgentId,
          ...(Array.isArray(item.record.nodes)
            ? item.record.nodes.map((n) => n?.agentId)
            : []),
        ];
        const hit = candidates.find((id) => Boolean(id && wsAgentIds.has(id)));
        if (hit) return hit;
      }
      return null;
    };
    const topLevel = wsAgents.find((a) => !a.parentAgentId);
    viewerAgentId =
      pickTaskViewer(openTasks) ??
      pickTaskViewer(recentTasks) ??
      topLevel?.id ??
      wsAgents[0]?.id ??
      null;
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

  // One chat can run multiple team tasks sequentially as coordinator (and may
  // also hold legacy tasks it launched). A single coordinated task renders
  // directly; multiple tasks or legacy launcher-only tasks render as subtrees.
  const ownedTasks = recentTasks
    .filter(
      (item) =>
        item.record.coordinatorAgentId === viewerAgentId ||
        item.record.launcherAgentId === viewerAgentId,
    )
    .sort((a, b) => {
      const aOpen = isOpenTask(a.record.lifecycleStatus) ? 1 : 0;
      const bOpen = isOpenTask(b.record.lifecycleStatus) ? 1 : 0;
      if (aOpen !== bOpen) return bOpen - aOpen;
      return b.record.createdAt.localeCompare(a.record.createdAt);
    });
  if (
    ownedTasks.length > 1 ||
    (ownedTasks.length === 1 &&
      ownedTasks[0].record.coordinatorAgentId !== viewerAgentId)
  ) {
    return {
      mode: "launcher",
      viewerAgentId,
      rootAgentId,
      task: null,
      tasks: ownedTasks.map((item) =>
        toPipelineSnapshot(item.recordPath, item.record, liveMap, lang),
      ),
    };
  }
  if (ownedTasks.length === 1) {
    return {
      mode: "team_task",
      viewerAgentId,
      rootAgentId,
      task: toPipelineSnapshot(
        ownedTasks[0].recordPath,
        ownedTasks[0].record,
        liveMap,
        lang,
      ),
    };
  }

  let cur: string | null = viewerAgentId;
  const seenAncestors = new Set<string>();
  while (cur && !seenAncestors.has(cur)) {
    seenAncestors.add(cur);
    const directMatch = matchTask(cur);
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
    const matched = matchTask(candidateId);
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
    /(?:^|[，,；;。\s])用\s*([^\s，,；;。]+?)\s*(?:组合|预设)(?:[，,；;。\s]|$)/.exec(
      text,
    );
  const enTeamMatch =
    /(?:^|[\s,;])(?:use\s+preset|preset:|team:)\s*([a-zA-Z0-9_-]+)/i.exec(text);
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

  if (
    /(?:不要|不需要|免除|跳过)(?:代码|方案)?(?:审查|评审)|免审|\b(?:no|skip|without)\s+(?:(?:code|plan)\s+)?review\b/i.test(
      text,
    )
  ) {
    skipReviewReason = rawArgs.trim();
  } else if (
    /(?:需要|开启|必须)(?:代码|方案)?(?:审查|评审)|方案(?:审查|评审)|\b(?:with|require|enable)\s+(?:(?:code|plan)\s+)?review\b|\bplan\s+review\b/i.test(
      text,
    )
  ) {
    requireReview = true;
    if (/方案(?:审查|评审)|\bplan\s+review\b/i.test(text)) {
      requirePlanReview = true;
    }
  }

  // Only explicit expert-mode directives pre-mark isComplex; otherwise the coordinator
  // assesses real complexity from full conversation & codebase context via paseo_team(set_route).
  const isComplex = hasModeOverride && complexModeOverride === "expert";

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

const isUnsetSpec = (spec: RoleModelSpec | undefined) =>
  !spec?.model || spec.model === AUTO_MODEL;

/** Roles of a preset that still have no model; an "off" reviewer is simply absent from the list. */
export function unsetRoles(preset: TeamPreset): string[] {
  return [
    isUnsetSpec(preset.developer) ? "Developer" : "",
    preset.complexMode === "expert" && isUnsetSpec(preset.expert)
      ? "Expert"
      : "",
    ...preset.codeReviewers.map((spec, i) =>
      isUnsetSpec(spec) ? `Code Reviewer #${i + 1}` : "",
    ),
    ...preset.planReviewers.map((spec, i) =>
      isUnsetSpec(spec) ? `Plan Reviewer #${i + 1}` : "",
    ),
  ].filter(Boolean);
}

function resolveRoleLaunchSpec(options: {
  role:
    "coordinator" | "developer" | "expert" | "plan-reviewer" | "code-reviewer";
  spec: RoleModelSpec;
  catalog: ProviderCatalogItemDto[];
}): {
  providerArg: string;
  modeId?: string;
  thinkingOptionId?: string;
} {
  const { spec, catalog } = options;
  if (!spec.model || spec.model === AUTO_MODEL) {
    // Guessing a model picks badly; startTeamTask reports unset roles before this.
    throw new Error(`No model is set for the ${options.role} role.`);
  }
  const fullId = spec.model;
  const providerId = spec.model.split("/")[0] ?? spec.model;

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

async function prepareTeamTaskKickoff(
  paseo: PaseoApi,
  input: {
    cwd: string;
    coordinatorAgentId: string;
    rawArgs: string;
    teamOverride?: string;
    complexModeOverride?: ComplexMode;
    isComplex?: boolean;
    requireReview?: boolean;
    language?: UiLanguage;
    allowRunningAgent?: boolean;
  },
): Promise<{
  taskId: string;
  recordPath: string;
  coordinatorAgentId: string;
  teamName: string;
  complexMode: ComplexMode;
  kickoffPrompt: string;
  zh: boolean;
  coordHandle: ReturnType<PaseoApi["agents"]["ref"]>;
}> {
  const cleanedRawArgs = input.rawArgs
    .trim()
    .replace(/^\/paseo-team(?:\s+|$)/i, "")
    .trim();
  const promptLangHint = detectPromptLanguage(
    cleanedRawArgs || input.rawArgs,
    input.language ?? "en",
  );
  if (!cleanedRawArgs) {
    throw new Error(
      promptLangHint === "zh"
        ? "请提供任务目标，例如：/paseo-team 修复登录页超时问题。"
        : 'Please provide a task goal after /paseo-team (for example: "/paseo-team fix login timeout").',
    );
  }

  const { providers } = await readProviderCatalog(paseo, input.cwd);
  const { config } = loadAndUpgradeConfig();

  const parsed = parseInlineTaskDirectives(cleanedRawArgs);
  const promptLang = detectPromptLanguage(parsed.goal, input.language ?? "en");
  const zh = promptLang === "zh";

  const eff = resolveEffectiveTeam(config, input.cwd, {
    teamOverride: input.teamOverride ?? parsed.teamOverride,
    complexModeOverride:
      input.complexModeOverride ?? parsed.complexModeOverride,
  });

  const unset = unsetRoles(eff.preset);
  if (unset.length > 0) {
    throw new Error(
      zh
        ? `预设「${eff.teamName}」还有角色没选模型：${unset.join("、")}。请在团队配置里为它们选择模型（审查员也可以设为“不启用”）。`
        : `Preset "${eff.teamName}" has roles without a model: ${unset.join(", ")}. Pick a model for each in Team settings (a reviewer can also be turned off).`,
    );
  }

  const coordinatorAgentId = input.coordinatorAgentId.trim();
  if (!coordinatorAgentId) {
    throw new Error(
      zh
        ? "请在已打开的对话里用 /paseo-team 启动团队任务。"
        : "Start a team task with /paseo-team inside an open chat.",
    );
  }

  const coordHandle = paseo.agents.ref(coordinatorAgentId);
  const refreshed = await coordHandle.refresh().catch(() => null);
  const currentAgent = refreshed?.agent as Record<string, unknown> | undefined;
  if (
    !input.allowRunningAgent &&
    (currentAgent?.status === "running" ||
      currentAgent?.status === "initializing")
  ) {
    throw new Error(
      zh
        ? "当前对话正在运行中，请等本轮回复结束后再启动 /paseo-team。"
        : "This chat is currently running a turn. Wait for it to finish before starting /paseo-team.",
    );
  }

  const created = initTask({
    cwd: input.cwd,
    goal: parsed.goal,
    teamName: eff.teamName,
    preset: eff.preset,
    isComplex: input.isComplex ?? parsed.isComplex,
    routeDecided: Boolean(parsed.skipReviewReason),
    requireReview: input.requireReview ?? parsed.requireReview,
    requirePlanReview: parsed.requirePlanReview,
    skipReviewReason: parsed.skipReviewReason,
    coordinatorAgentId,
  });

  if (typeof currentAgent?.provider === "string" && currentAgent.provider) {
    const updated = loadTask(created.recordPath);
    const coordNode = updated.nodes.find((n) => n.nodeId === "coordinator");
    if (coordNode) {
      const provider = currentAgent.provider;
      const model =
        typeof currentAgent.model === "string" && currentAgent.model
          ? currentAgent.model
          : undefined;
      const thinking =
        typeof currentAgent.thinkingOptionId === "string" &&
        currentAgent.thinkingOptionId
          ? currentAgent.thinkingOptionId
          : undefined;
      coordNode.agentId = coordinatorAgentId;
      coordNode.provider = provider;
      if (model) coordNode.model = model;
      if (thinking) coordNode.thinkingOptionId = thinking;
      coordNode.profile = model ? `${provider}/${model}` : provider;
      saveTask(created.recordPath, updated);
    }
  }

  const devLaunch = resolveRoleLaunchSpec({
    role: "developer",
    spec: eff.preset.developer,
    catalog: providers,
  });

  const formatLaunchLine = (
    launch: ReturnType<typeof resolveRoleLaunchSpec>,
    role: "developer" | "expert" | "plan-reviewer" | "code-reviewer",
  ) => {
    const settingsObj: Record<string, unknown> = {};
    if (launch.modeId) settingsObj.modeId = launch.modeId;
    if (launch.thinkingOptionId)
      settingsObj.thinkingOptionId = launch.thinkingOptionId;
    const settingsPart =
      Object.keys(settingsObj).length > 0
        ? ` settings=${JSON.stringify(settingsObj)}`
        : "";
    const labelsPart = ` labels=${JSON.stringify({
      task: created.record.taskId,
      role,
    })}`;
    return `provider="${launch.providerArg}"${settingsPart}${labelsPart}`;
  };

  const rosterLines: string[] = [
    `- Developer: ${formatLaunchLine(devLaunch, "developer")}`,
  ];

  if (
    eff.preset.expert?.model &&
    eff.preset.expert.model !== AUTO_MODEL &&
    (eff.preset.complexMode === "expert" ||
      created.record.planReview !== "waived")
  ) {
    const expLaunch = resolveRoleLaunchSpec({
      role: "expert",
      spec: eff.preset.expert,
      catalog: providers,
    });
    const note =
      eff.preset.complexMode === "expert"
        ? ""
        : zh
          ? "（可选，需独立起草方案时使用）"
          : " (optional, for dedicated plan drafting)";
    rosterLines.push(
      `- Expert${note}: ${formatLaunchLine(expLaunch, "expert")}`,
    );
  }

  if (created.record.planReview === "waived") {
    rosterLines.push(
      zh
        ? "- 方案评审：用户已豁免（无需派发方案审查员）"
        : "- Plan Review: waived by user (do not dispatch plan reviewers)",
    );
  } else {
    eff.preset.planReviewers.forEach((spec, idx) => {
      const launch = resolveRoleLaunchSpec({
        role: "plan-reviewer",
        spec,
        catalog: providers,
      });
      const persp = assignReviewerPerspective(
        idx,
        eff.preset.planReviewers.length,
      );
      rosterLines.push(
        `- Plan Reviewer #${idx + 1} (${reviewerPerspectiveLabel(persp, promptLang)}): ${formatLaunchLine(launch, "plan-reviewer")}`,
      );
    });
  }

  if (created.record.codeReview === "waived") {
    rosterLines.push(
      zh
        ? "- 代码审查：用户已豁免（无需派发审查员）"
        : "- Code Review: waived by user (do not dispatch reviewers)",
    );
  } else {
    eff.preset.codeReviewers.forEach((spec, idx) => {
      const persp = assignReviewerPerspective(
        idx,
        eff.preset.codeReviewers.length,
      );
      const revLaunch = resolveRoleLaunchSpec({
        role: "code-reviewer",
        spec,
        catalog: providers,
      });
      rosterLines.push(
        `- Code Reviewer #${idx + 1} (${reviewerPerspectiveLabel(persp, promptLang)}): ${formatLaunchLine(revLaunch, "code-reviewer")}`,
      );
    });
  }

  const userConstraints: string[] = [];
  if (created.record.planReview === "required") {
    userConstraints.push(
      zh
        ? "- 用户已明确要求**方案评审**（`planReview: true` 不可降级）。"
        : "- User explicitly requested **plan review** (`planReview: true` cannot be downgraded).",
    );
  }
  if (created.record.codeReview === "required") {
    userConstraints.push(
      zh
        ? "- 用户已明确要求**代码审查**（`codeReview: true` 不可降级）。"
        : "- User explicitly requested **code review** (`codeReview: true` cannot be downgraded).",
    );
  }
  if (created.record.codeReview === "waived") {
    userConstraints.push(
      zh
        ? "- 用户已明确豁免本任务审查（免审）。"
        : "- User explicitly waived review for this task.",
    );
  }

  const kickoffPrompt = buildKickoffPrompt({
    taskId: created.record.taskId,
    goal: parsed.goal,
    teamName: eff.teamName,
    complexMode: eff.preset.complexMode,
    taskDir: path.dirname(path.resolve(created.recordPath)),
    rosterLines,
    ...(userConstraints.length > 0 ? { userConstraints } : {}),
    lang: promptLang,
  });

  if (typeof coordHandle.setMetadata === "function") {
    await coordHandle
      .setMetadata({
        "paseo-team.task": {
          taskId: created.record.taskId,
          recordPath: created.recordPath,
          role: "coordinator",
        },
      })
      .catch(() => {});
  }

  notifyTaskChanges();
  return {
    taskId: created.record.taskId,
    recordPath: created.recordPath,
    coordinatorAgentId,
    teamName: eff.teamName,
    complexMode: eff.preset.complexMode,
    kickoffPrompt,
    zh,
    coordHandle,
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
  const prepared = await prepareTeamTaskKickoff(paseo, {
    cwd: input.cwd,
    coordinatorAgentId: input.agentId ?? "",
    rawArgs: input.rawArgs,
    teamOverride: input.teamOverride,
    complexModeOverride: input.complexModeOverride,
    isComplex: input.isComplex,
    requireReview: input.requireReview,
    language: input.language,
    allowRunningAgent: false,
  });

  // Use the current chat directly as coordinator with zero session reload:
  // `paseo_team` is already persistently attached at initial open, so sending
  // the kickoff message preserves the entire prompt cache.
  try {
    await prepared.coordHandle.send(prepared.kickoffPrompt);
  } catch (err) {
    throw new Error(
      `Failed to start team task in current chat: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    taskId: prepared.taskId,
    recordPath: prepared.recordPath,
    coordinatorAgentId: prepared.coordinatorAgentId,
    teamName: prepared.teamName,
    message: prepared.zh
      ? "已在当前对话启动团队协作。"
      : "Team pipeline started in this chat.",
  };
}

const verdictSchema = z.enum(["APPROVE", "REQUEST_CHANGES", "BLOCKED"]);
const findingsSchema = z
  .array(z.string().min(1))
  .max(30)
  .optional()
  .describe('One issue per item, prefixed "blocking:" or "advice:".');

const coordinatorToolInputSchema = z.object({
  action: z.enum(["start", "set_route", "update", "complete", "summary"]),
  rawArgs: z
    .string()
    .min(1)
    .optional()
    .describe(
      'For action="start": the exact goal and flags after /paseo-team (e.g. "fix login timeout with review").',
    ),
  teamOverride: z.string().min(1).optional(),
  isComplex: z.boolean().optional(),
  planReview: z.boolean().optional(),
  codeReview: z.boolean().optional(),
  useExpert: z.boolean().optional(),
  decision: z.enum(["extra_round", "waive_stage"]).optional(),
  reason: z.string().min(1).optional(),
  planFile: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  architectureImpact: z.string().min(1).optional(),
  ciStatus: z.enum(["pass", "fail"]).optional(),
  ciSummary: z.string().optional(),
  ciWaivedUserQuote: z.string().optional(),
  stage: z.enum(["plan", "code"]).optional(),
  verdict: verdictSchema.optional(),
  findings: findingsSchema,
  round: z.number().int().min(1).optional(),
  force: z.boolean().optional(),
  inspectOnly: z.boolean().optional(),
});

function resolveCoordinatorRecordPath(
  fixedRecordPath: string | undefined,
  context:
    { agent?: { id?: string; metadata?: Record<string, unknown> } } | undefined,
): string | null {
  if (fixedRecordPath) return fixedRecordPath;
  const meta = context?.agent?.metadata?.["paseo-team.task"];
  const metaObj =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)
      : null;
  const metaRecordPath =
    metaObj?.role === "coordinator" &&
    typeof metaObj.recordPath === "string" &&
    existsSync(metaObj.recordPath)
      ? metaObj.recordPath
      : null;
  const agentId = context?.agent?.id;
  if (agentId) {
    const matched = findTaskByAgentId(agentId);
    if (matched?.matchedRole === "coordinator") {
      if (metaRecordPath && metaRecordPath !== matched.recordPath) {
        try {
          const metaRec = loadTask(metaRecordPath);
          if (
            metaRec.lifecycleStatus !== "completed" &&
            metaRec.lifecycleStatus !== "abandoned"
          ) {
            return metaRecordPath;
          }
        } catch {
          // Fall back to disk lookup result.
        }
      }
      return matched.recordPath;
    }
  }
  return metaRecordPath;
}

export function createCoordinatorTool(
  fixedRecordPath?: string,
): AgentToolDefinition {
  return defineAgentTool({
    name: "paseo_team",
    title: "Paseo Team Coordinator",
    description:
      'Paseo Team coordinator tool. If a user message invokes `/paseo-team <goal>` directly without a `[Team 任务启动]` / `[Team Kickoff]` kickoff block, IMMEDIATELY call action="start" with rawArgs="<everything after /paseo-team>" BEFORE reading/editing files or running commands (never claim /paseo-team is uninstalled). Otherwise use only during an active Paseo Team task: set_route, update, complete, summary.',
    input: coordinatorToolInputSchema,
    async execute(args, context) {
      if (args.action === "start") {
        if (context?.agent?.parentAgentId) {
          return {
            text: 'action="start" can only be called from a top-level chat, not a subagent.',
            isError: true,
          };
        }
        const rawArgs = args.rawArgs?.trim() ?? "";
        if (!rawArgs) {
          return {
            text: 'action="start" requires non-empty rawArgs (the goal and flags after /paseo-team).',
            isError: true,
          };
        }

        // Guard against accidental double-start when client slash command already kicked off this turn.
        const existingPath = resolveCoordinatorRecordPath(
          fixedRecordPath,
          context,
        );
        if (existingPath) {
          try {
            const existing = loadTask(existingPath);
            const ageMs = Date.now() - Date.parse(existing.createdAt);
            if (
              existing.lifecycleStatus === "active" &&
              !existing.routeDecided &&
              !existing.delivery &&
              (existing.deliveries?.length ?? 0) === 0 &&
              Number.isFinite(ageMs) &&
              ageMs >= 0 &&
              ageMs < 120_000
            ) {
              return {
                text: `Task ${existing.taskId} is already initialized on this chat. Proceed directly with action="set_route" and member dispatch.\n\n${buildRecoveryBrief(existing)}`,
              };
            }
          } catch {
            // Fall through to start a fresh task.
          }
        }

        const agentId = context?.agent?.id?.trim();
        const cwd = context?.agent?.cwd?.trim();
        const paseo = context?.paseo;
        if (!agentId || !cwd || !paseo) {
          return {
            text: 'action="start" requires active agent and Paseo context.',
            isError: true,
          };
        }

        try {
          const prepared = await prepareTeamTaskKickoff(paseo, {
            cwd,
            coordinatorAgentId: agentId,
            rawArgs,
            ...(args.teamOverride ? { teamOverride: args.teamOverride } : {}),
            allowRunningAgent: true,
          });
          const nextStepBanner = prepared.zh
            ? `任务已初始化（task_id=${prepared.taskId}）。下一步必须先调用 paseo_team(action="set_route", ...)，再调用 Paseo 的 create_agent 按下方参数派发成员（严禁主控自己编辑仓库文件或跑测试；派发后不要调用 update，直接结束本轮等待 [Agent finished]；如工具被延迟加载请先检索加载 create_agent）。`
            : `Task initialized (task_id=${prepared.taskId}). REQUIRED NEXT STEP: call paseo_team(action="set_route", ...) and dispatch Developer via Paseo's create_agent with the exact parameters below (NEVER edit repository files or run tests yourself; do NOT call update after dispatch — end your turn and wait for [Agent finished]; load create_agent first if MCP tools are deferred).`;
          // Return text-only (no structuredContent): Paseo's MCP bridge unwraps
          // structuredContent in preference to text, which would drop the protocol.
          return {
            text: `${nextStepBanner}\n\n${prepared.kickoffPrompt}`,
          };
        } catch (err) {
          return {
            text: err instanceof Error ? err.message : String(err),
            isError: true,
          };
        }
      }

      const recordPath = resolveCoordinatorRecordPath(fixedRecordPath, context);
      if (!recordPath) {
        return {
          text: 'No active Paseo Team task on this chat. If the user invoked /paseo-team directly, call action="start" with rawArgs first.',
          isError: true,
        };
      }

      if (args.action === "summary") {
        const record = loadTask(recordPath);
        return {
          text: buildRecoveryBrief(record),
        };
      }

      const current = loadTask(recordPath);
      if (
        args.action !== "complete" &&
        (current.lifecycleStatus === "completed" ||
          current.lifecycleStatus === "abandoned")
      ) {
        return {
          text: `Task ${current.taskId} is already ${current.lifecycleStatus}. Start a new task with /paseo-team first.`,
          isError: true,
        };
      }

      if (args.action === "set_route") {
        if (
          typeof args.isComplex !== "boolean" ||
          typeof args.planReview !== "boolean" ||
          typeof args.codeReview !== "boolean" ||
          !args.reason?.trim()
        ) {
          return {
            text: 'action="set_route" requires boolean isComplex, planReview, codeReview, and non-empty reason.',
            isError: true,
          };
        }
        const { record, preserved } = setTaskRoute(recordPath, {
          isComplex: args.isComplex,
          planReview: args.planReview,
          codeReview: args.codeReview,
          ...(args.useExpert !== undefined
            ? { useExpert: args.useExpert }
            : {}),
          reason: args.reason,
        });
        notifyTaskChanges();
        const preservedNote =
          preserved.length > 0
            ? ` (preserved user-required: ${preserved.join(", ")})`
            : "";
        return {
          text: `Route locked: isComplex=${record.isComplex}, planReview=${record.planReview}, codeReview=${record.codeReview}, complexMode=${record.complexMode}.${preservedNote}`,
        };
      }

      if (args.action === "update") {
        // 1. Resolve circuit breaker / user ruling (extra_round or waive_stage).
        if (args.decision) {
          if (!args.reason?.trim()) {
            return {
              text: 'action="update" with decision requires a non-empty reason quoting the user ruling.',
              isError: true,
            };
          }
          try {
            const res = resolveCircuitBreaker(recordPath, {
              decision: args.decision,
              ...(args.stage ? { stage: args.stage } : {}),
              reason: args.reason,
            });
            notifyTaskChanges();
            return {
              text:
                args.decision === "extra_round"
                  ? `Breaker lifted (${res.stage}): extra round granted (maxRounds=${res.maxRounds}).`
                  : `Stage "${res.stage}" waived per user decision; task resumed.`,
            };
          } catch (err) {
            return {
              text: err instanceof Error ? err.message : String(err),
              isError: true,
            };
          }
        }

        // 2. Record a plan draft (e.g., Coordinator drafted plan.md in simple mode).
        if (args.planFile?.trim()) {
          if (!args.summary?.trim()) {
            return {
              text: 'action="update" with planFile requires non-empty summary.',
              isError: true,
            };
          }
          try {
            const updated = recordPlanSubmission(recordPath, {
              planFile: args.planFile,
              summary: args.summary,
            });
            notifyTaskChanges();
            return { text: `Recorded plan ${updated.planVersion}.` };
          } catch (err) {
            return {
              text: err instanceof Error ? err.message : String(err),
              isError: true,
            };
          }
        }

        // 3. Manual review verdict override (only if passive turn observation missed a non-standard reply).
        if (args.stage && args.verdict) {
          if (!args.agentId?.trim() || !args.summary?.trim()) {
            return {
              text: 'action="update" with stage/verdict requires agentId and non-empty summary.',
              isError: true,
            };
          }
          const problem = reviewInputProblem(args.verdict, args.findings);
          if (problem) return { text: problem, isError: true };
          const res = recordReviewVerdict(recordPath, {
            stage: args.stage,
            agentId: args.agentId,
            round:
              args.round ?? nextReviewRound(current, args.stage, args.agentId),
            verdict: args.verdict,
            summary: args.summary,
            ...(args.findings ? { findings: args.findings } : {}),
            source: "coordinator",
          });
          notifyTaskChanges();
          return {
            text: `${res.message} (status=${res.status}, round=${res.round}/${res.maxRounds})`,
          };
        }

        // 4. Manual delivery / CI update (e.g., user-quoted CI waiver or manual delivery sync).
        if (
          args.summary?.trim() ||
          args.ciStatus ||
          args.ciWaivedUserQuote?.trim()
        ) {
          const dispatchedDevNode = current.nodes.find(
            (n) => n.role === "developer" && Boolean(n.agentId),
          );
          const targetDevAgentId =
            args.agentId?.trim() &&
            args.agentId.trim() !== current.coordinatorAgentId
              ? args.agentId.trim()
              : dispatchedDevNode?.agentId;
          if (!targetDevAgentId && !current.delivery) {
            return {
              text: "Cannot record a Developer delivery before dispatching a Developer agent via Paseo's create_agent. Role separation: Coordinator must dispatch Developer instead of editing files directly.",
              isError: true,
            };
          }
          // Never mark Developer delivered while its session is still actively running.
          if (targetDevAgentId && context?.paseo?.agents?.ref) {
            const devSnap = await context.paseo.agents
              .ref(targetDevAgentId)
              .refresh()
              .catch(() => null);
            const devStatus = (
              devSnap?.agent as { status?: string } | undefined
            )?.status;
            if (devStatus === "running" || devStatus === "initializing") {
              return {
                text: `Developer agent ${targetDevAgentId} is still ${devStatus}. Do NOT call action="update" right after dispatching — end your turn and wait for [Agent finished]; the plugin syncs Developer delivery automatically.`,
                isError: true,
              };
            }
          }
          if (
            args.summary?.trim() &&
            !args.ciStatus &&
            !args.ciWaivedUserQuote?.trim() &&
            /^(?:Developer\s*)?(?:已派发|已派出|已启动|正在执行|派发给|(?:dispatched|started|in progress)\b)/i.test(
              args.summary.trim(),
            )
          ) {
            return {
              text: 'Do NOT call action="update" to report that Developer was dispatched. End your turn and wait for [Agent finished]; the plugin updates the Team Graph passively.',
              isError: true,
            };
          }
          const architectureImpact =
            args.architectureImpact?.trim() ||
            current.delivery?.architectureImpact ||
            "None";
          const trigger = evaluateCodeReviewTrigger({
            projectRoot: current.projectRoot,
            architectureImpact,
            hasCodeReviewers: current.team.codeReviewers.length > 0,
          });
          const shouldUpgradeReview =
            current.codeReview === "not-required" && trigger.requireCodeReview;
          const updated = recordCandidateDelivery(recordPath, {
            ...(targetDevAgentId ? { agentId: targetDevAgentId } : {}),
            summary:
              args.summary?.trim() ||
              current.delivery?.summary ||
              "Updated delivery state",
            architectureImpact,
            ...(args.ciStatus ? { ciStatus: args.ciStatus } : {}),
            ...(args.ciSummary ? { ciSummary: args.ciSummary } : {}),
            ...(args.ciWaivedUserQuote
              ? { ciWaivedUserQuote: args.ciWaivedUserQuote }
              : {}),
            ...(shouldUpgradeReview
              ? {
                  requireCodeReview: true,
                  codeReviewReason: trigger.reason,
                }
              : {}),
          });
          notifyTaskChanges();
          const upgradeNote = shouldUpgradeReview
            ? ` — ${trigger.reason}; dispatch Code Reviewers before calling complete.`
            : "";
          return {
            text: `Updated delivery ${updated.candidate} (${trigger.change.files} files, ${trigger.change.lines} lines, codeReview=${updated.codeReview})${upgradeNote}`,
          };
        }

        return {
          text: 'action="update" needs one of: decision+reason, planFile+summary, stage+verdict+agentId+summary, or summary/ciStatus/ciWaivedUserQuote.',
          isError: true,
        };
      }

      if (current.lifecycleStatus === "abandoned") {
        return {
          text: `Task ${current.taskId} was abandoned.`,
          isError: true,
        };
      }
      const rep = inspectQualityGate({ recordPath });
      if (args.force && !args.inspectOnly) {
        if (!args.reason?.trim()) {
          return {
            text: "force=true requires a non-empty reason quoting the user approval to close despite open checks.",
            isError: true,
          };
        }
        markTaskCompleted(recordPath);
        notifyTaskChanges();
        return {
          text: `Task completed per user ruling (${args.reason.trim()}).`,
        };
      }
      if (rep.status === "READY" && !args.inspectOnly) {
        markTaskCompleted(recordPath);
      }
      notifyTaskChanges();
      return {
        text:
          rep.status === "READY"
            ? args.inspectOnly
              ? "Quality gate READY."
              : "Quality gate READY; task completed."
            : `Quality gate BLOCKED:\n${rep.missing.map((m) => `- ${m}`).join("\n")}`,
        isError: rep.status !== "READY",
      };
    },
  });
}

export function createCoordinatorTools(
  recordPath?: string,
): AgentToolDefinition[] {
  return [createCoordinatorTool(recordPath)];
}

/** Handoff format check for a review: finding prefixes must match the verdict. */
export function reviewInputProblem(
  verdict: z.infer<typeof verdictSchema>,
  findings: string[] = [],
): string | null {
  const bad = findings.find(
    (f) => !/^(?:blocking|advice)\s*[:：]\s*\S/i.test(f.trim()),
  );
  if (bad) {
    return `Each finding must start with "blocking:" or "advice:" (got "${bad.trim().slice(0, 60)}").`;
  }
  const blocking = findings.filter((f) => /^blocking/i.test(f.trim())).length;
  if (verdict === "APPROVE" && blocking > 0) {
    return "APPROVE cannot carry blocking findings: use REQUEST_CHANGES, or downgrade them to advice.";
  }
  if (verdict !== "APPROVE" && blocking === 0) {
    return `${verdict} needs at least one "blocking:" finding with file:line and the concrete failure path.`;
  }
  return null;
}

export { buildCoordinatorSystemPrompt };
