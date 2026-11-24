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
} from "./config-store.ts";
import {
  assignReviewerPerspective,
  buildCoordinatorSystemPrompt,
  reviewerPerspectiveLabel,
} from "./prompts.ts";
import {
  ciProblem,
  computeWorkspaceChangeStats,
  inspectQualityGate,
} from "./quality-gate.ts";
import { runCheck } from "./run-check.ts";
import {
  buildRecoveryBrief,
  findTaskByAgentId,
  initTask,
  listAllRecentTasks,
  listTasksByLauncher,
  listTasksForProject,
  loadTask,
  markTaskCompleted,
  type NodeVisualStatus,
  nextDeliveryRound,
  nextReviewRound,
  readReviewRounds,
  type PipelineStageId,
  recordCandidateDelivery,
  recordPlanSubmission,
  recordReviewVerdict,
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

  // 1. Coordinator
  const coordNodes = resolvedNodes
    .filter((n) => n.raw.stage === "coordinator")
    .map((n) => n.view);
  pushStep("coordinator", "coordinator", coordNodes);

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

  if (expertVisible || planRevVisible) {
    const recordedPlanRoundSet = new Set<number>();
    for (const item of planRevBase) {
      for (const r of item.rounds) recordedPlanRoundSet.add(r.round);
    }
    const recordedPlanRounds = [...recordedPlanRoundSet].sort((a, b) => a - b);
    const maxPlanRecorded =
      recordedPlanRounds.length > 0 ? Math.max(...recordedPlanRounds) : 0;

    const nextLiveExpertRound =
      maxPlanRecorded >= 1 && expertBase.some((n) => n.isLiveActive)
        ? maxPlanRecorded + 1
        : 0;
    const nextLivePlanRevRound =
      maxPlanRecorded >= 1 && planRevBase.some((n) => n.isLiveActive)
        ? maxPlanRecorded + 1
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
      if (expertVisible) {
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
            visualStatus: settledEarlier ? "completed" : item.view.visualStatus,
            liveState:
              settledEarlier && item.isLiveActive
                ? "idle"
                : item.view.liveState,
          };
        });
        pushStep(r === 1 ? "expert" : `expert-r${r}`, "expert", expRoundNodes, {
          round: multiPlan || r > 1 ? r : undefined,
          multiRound: multiPlan,
        });
      }

      const shouldEmitPlanRev =
        planRevVisible &&
        (recordedPlanRoundSet.has(r) ||
          r === nextLivePlanRevRound ||
          recordedPlanRounds.length === 0);

      if (shouldEmitPlanRev) {
        const prNodes: PipelineNodeViewDto[] = [];
        for (const item of planRevBase) {
          const roundEntry = item.rounds.find((x) => x.round === r);
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
              roundEntry?.verdict ?? (r === 1 ? item.view.verdict : undefined),
            summary:
              roundEntry?.summary ||
              (recordedPlanRounds.length === 0 ? item.view.summary : undefined),
            rounds: roundEntry ? [roundEntry] : undefined,
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
                  ? `第 ${r}/2 轮 · 交叉审核`
                  : `Round ${r}/2 · Cross review`
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

  const nextLiveDevRound =
    maxCodeRecorded >= 1 && devBase.some((n) => n.isLiveActive)
      ? Math.max(maxCodeRecorded + 1, ...devBase.map((n) => n.raw.round ?? 0))
      : 0;
  const nextLiveCodeRound =
    maxCodeRecorded >= 1 && codeRevBase.some((n) => n.isLiveActive)
      ? Math.max(
          maxCodeRecorded + 1,
          ...codeRevBase.map((n) => n.raw.round ?? 0),
        )
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
    if (devBase.length > 0) {
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
            r === nextLiveDevRound &&
            item.isLiveActive &&
            roundDeliveries.length === 0
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
        const roundEntry = item.rounds.find((x) => x.round === r);
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
          rounds: roundEntry ? [roundEntry] : undefined,
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
                ? `第 ${r}/2 轮`
                : `Round ${r}/2`
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

  // A chat that launched tasks shows them as subtrees, plus any task it
  // coordinates itself (older tasks used the launching chat as coordinator).
  const launched = listTasksByLauncher(viewerAgentId);
  if (launched.length > 0) {
    const own = findTaskByAgentId(viewerAgentId);
    const items =
      own && !launched.some((x) => x.recordPath === own.recordPath)
        ? [...launched, own].sort((a, b) =>
            b.record.createdAt.localeCompare(a.record.createdAt),
          )
        : launched;
    return {
      mode: "launcher",
      viewerAgentId,
      rootAgentId,
      task: null,
      tasks: items.map((item) =>
        toPipelineSnapshot(item.recordPath, item.record, liveMap, lang),
      ),
    };
  }

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
    ...(input.agentId ? { launcherAgentId: input.agentId } : {}),
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

  if (created.record.planReview === "required" || created.record.isComplex) {
    eff.preset.planReviewers.forEach((spec, idx) => {
      const launch = resolveRoleLaunchSpec({
        role: "plan-reviewer",
        spec,
        catalog: providers,
        readyProviders,
      });
      const persp = assignReviewerPerspective(
        idx,
        eff.preset.planReviewers.length,
      );
      rosterLines.push(
        `- Plan Reviewer #${idx + 1} (${reviewerPerspectiveLabel(persp, promptLang)}): ${formatLaunchLine(launch)}`,
      );
    });
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

  // Task-specific facts only; the protocol and safety rules arrive through the
  // coordinator's system prompt (agent.open.before), so nothing is sent twice.
  const kickoffPrompt = zh
    ? [
        `[Team 任务启动] task_id=\`${created.record.taskId}\``,
        `任务目标：${parsed.goal}`,
        `生效预设：\`${eff.teamName}\`（模式：\`${eff.preset.complexMode}\`）`,
        "",
        "### 成员派发参数（create_agent 直接使用）",
        ...rosterLines,
        "",
        "按系统提示中的协调协议执行。",
      ].join("\n")
    : [
        `[Team Kickoff] task_id=\`${created.record.taskId}\``,
        `Goal: ${parsed.goal}`,
        `Active Preset: \`${eff.teamName}\` (mode: \`${eff.preset.complexMode}\`)`,
        "",
        "### Member Routing (use as-is in create_agent)",
        ...rosterLines,
        "",
        "Follow the coordinator protocol in your system prompt.",
      ].join("\n");

  if (!input.workspaceId) {
    throw new Error("A workspace is required to start a team task.");
  }

  // Each task gets its own new coordinator session, so one chat can start
  // several tasks; the coordinator inherits the launching chat's model.
  let coordSpec: RoleModelSpec = { model: AUTO_MODEL };
  if (input.agentId) {
    const launcher = (
      await paseo.agents
        .ref(input.agentId)
        .refresh()
        .catch(() => null)
    )?.agent as Record<string, unknown> | undefined;
    if (typeof launcher?.provider === "string") {
      coordSpec = {
        model:
          typeof launcher.model === "string" && launcher.model
            ? `${launcher.provider}/${launcher.model}`
            : launcher.provider,
        ...(typeof launcher.thinkingOptionId === "string"
          ? { thinking: launcher.thinkingOptionId }
          : {}),
      };
    }
  }
  const coordLaunch = resolveRoleLaunchSpec({
    role: "coordinator",
    spec: coordSpec,
    catalog: providers,
    readyProviders,
  });
  const createdAgent = await paseo.workspaces
    .ref(input.workspaceId)
    .agents.create({
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
  const coordinatorAgentId = createdAgent.id;
  const updated = loadTask(created.recordPath);
  updated.coordinatorAgentId = coordinatorAgentId;
  const coordNode = updated.nodes.find((n) => n.nodeId === "coordinator");
  if (coordNode) coordNode.agentId = coordinatorAgentId;
  saveTask(created.recordPath, updated);

  notifyTaskChanges();
  return {
    taskId: created.record.taskId,
    recordPath: created.recordPath,
    coordinatorAgentId,
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

  const recordDeliveryTool = defineAgentTool({
    name: "paseo_team_record_delivery",
    title: "Record Developer Delivery",
    description:
      "Fallback: record a delivery on the Developer's behalf (or a user-quoted CI waiver) when it did not call paseo_team_submit_delivery itself.",
    input: z.object({
      agentId: z.string().min(1).optional(),
      summary: z.string().min(1),
      ciLog: z.string().optional(),
      ciWaivedUserQuote: z.string().optional(),
      architectureImpact: z.string().min(1),
      requireCodeReview: z.boolean().optional(),
      codeReviewReason: z.string().optional(),
    }),
    async execute(args) {
      const owned = memberOwnsHandoff(recordPath, args.agentId, "developer");
      if (owned) return { text: owned, isError: true };
      return deliveryResult(recordCandidateDelivery(recordPath, args));
    },
  });

  const recordReviewTool = defineAgentTool({
    name: "paseo_team_record_review",
    title: "Record Review Verdict & Circuit Breaker Check",
    description:
      "Fallback: record a reviewer's verdict on its behalf when it did not call paseo_team_submit_review. The round is derived automatically; past the limit (default 2) the task is flagged for a user decision.",
    input: z.object({
      stage: z.enum(["plan", "code"]),
      agentId: z.string().min(1),
      profile: z.string().optional(),
      targetVersionOrCommit: z
        .string()
        .optional()
        .describe(
          "Plan version tag (for plan stage only; ignored for code stage).",
        ),
      round: z.number().int().min(1).optional(),
      verdict: verdictSchema,
      summary: z.string().min(1),
      findings: findingsSchema,
      userAuthorizedExtraRound: z.string().optional(),
    }),
    async execute(args) {
      const owned = memberOwnsHandoff(recordPath, args.agentId);
      if (owned) return { text: owned, isError: true };
      return submitReview(recordPath, {
        ...args,
        source: "coordinator",
      });
    },
  });

  const completeTool = defineAgentTool({
    name: "paseo_team_complete",
    title: "Verify Quality Gate & Complete Task",
    description:
      "Verify the latest CI run passed and required reviews approved in their latest round, then mark the task completed.",
    input: z.object({
      inspectOnly: z.boolean().optional(),
    }),
    async execute(args) {
      const rep = inspectQualityGate({ recordPath });
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
        structuredContent: rep,
        isError: rep.status !== "READY",
      };
    },
  });

  return [
    summaryTool,
    createSubmitPlanTool(recordPath),
    recordDeliveryTool,
    recordReviewTool,
    completeTool,
  ];
}

const verdictSchema = z.enum(["APPROVE", "REQUEST_CHANGES", "BLOCKED"]);
const findingsSchema = z
  .array(z.string().min(1))
  .max(30)
  .optional()
  .describe('One issue per item, prefixed "blocking:" or "advice:".');

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

function submitReview(
  recordPath: string,
  input: {
    stage: "plan" | "code";
    agentId: string;
    verdict: z.infer<typeof verdictSchema>;
    summary: string;
    findings?: string[];
    round?: number;
    profile?: string;
    targetVersionOrCommit?: string;
    userAuthorizedExtraRound?: string;
    source: "self" | "coordinator";
  },
) {
  const problem = reviewInputProblem(input.verdict, input.findings);
  if (problem) return { text: problem, isError: true };
  const record = loadTask(recordPath);
  if (
    input.stage === "code" &&
    !record.delivery &&
    !record.deliveries?.length
  ) {
    return {
      text: "No delivery is recorded yet, so there is nothing to review.",
      isError: true,
    };
  }
  const res = recordReviewVerdict(recordPath, {
    ...input,
    round: input.round ?? nextReviewRound(record, input.stage),
  });
  notifyTaskChanges();
  return {
    text: res.message,
    structuredContent: {
      status: res.status,
      round: res.round,
      maxRounds: res.maxRounds,
    },
  };
}

/**
 * Paseo forwards a member's final reply to the coordinator while the turn.after
 * hook reminds the member, so both could record the same handoff. The member
 * owns it until the reminder has failed (node blocked); only then may the
 * coordinator record on its behalf.
 */
export function memberOwnsHandoff(
  recordPath: string,
  agentId: string | undefined,
  fallbackRole?: "developer",
): string | null {
  const nodes = loadTask(recordPath).nodes;
  const node = agentId
    ? nodes.find((n) => n.agentId === agentId)
    : nodes.findLast((n) => n.role === fallbackRole && n.agentId);
  if (!node) return null;
  const who = `${node.label} (${node.agentId})`;
  if (node.reminded) {
    return `${who} was reminded to submit itself and is retrying; wait for its next reply instead of recording for it.`;
  }
  if (
    node.submittedAt &&
    (!node.turnStartedAt || node.submittedAt >= node.turnStartedAt)
  ) {
    return `${who} already submitted this handoff itself; nothing to record.`;
  }
  return null;
}

function deliveryResult(updated: TaskRecord) {
  const change = computeWorkspaceChangeStats(updated.projectRoot);
  const advice =
    updated.codeReview !== "required" &&
    (change.files > 5 || change.lines > 200)
      ? ` Diff is ${change.files} files / ${change.lines} lines; consider code review.`
      : "";
  notifyTaskChanges();
  return {
    text: `Recorded delivery (codeReview=${updated.codeReview}).${advice}`,
    structuredContent: {
      delivery: updated.candidate,
      change,
      codeReview: updated.codeReview,
      codeReviewReason: updated.codeReviewReason,
    },
  };
}

function createSubmitPlanTool(recordPath: string, agentId?: string) {
  return defineAgentTool({
    name: "paseo_team_submit_plan",
    title: "Submit Plan",
    description:
      "Hand off a finished plan or root-cause analysis. The file must already exist in the task evidence directory; each submission is the next plan version reviewers judge.",
    input: z.object({
      planFile: z
        .string()
        .min(1)
        .describe("File name in the task evidence directory, e.g. plan.md"),
      summary: z.string().min(1),
    }),
    async execute(args) {
      try {
        const updated = recordPlanSubmission(recordPath, { ...args, agentId });
        notifyTaskChanges();
        return { text: `Recorded plan ${updated.planVersion}.` };
      } catch (err) {
        return {
          text: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    },
  });
}

export function createExpertTools(
  recordPath: string,
  agentId: string,
): AgentToolDefinition[] {
  return [createSubmitPlanTool(recordPath, agentId)];
}

export function createReviewerTools(
  recordPath: string,
  agentId: string,
  stage: "plan" | "code",
): AgentToolDefinition[] {
  return [
    defineAgentTool({
      name: "paseo_team_submit_review",
      title: "Submit Review Verdict",
      description:
        'Hand off your verdict when the review is finished. REQUEST_CHANGES/BLOCKED need at least one "blocking:" finding; APPROVE allows only "advice:" findings. The round is derived automatically.',
      input: z.object({
        verdict: verdictSchema,
        summary: z.string().min(1),
        findings: findingsSchema,
      }),
      async execute(args) {
        return submitReview(recordPath, {
          ...args,
          stage,
          agentId,
          source: "self",
        });
      },
    }),
  ];
}

export function createDeveloperTools(
  recordPath: string,
  agentId: string,
): AgentToolDefinition[] {
  const taskDir = path.dirname(path.resolve(recordPath));

  const runCheckTool = defineAgentTool({
    name: "paseo_team_run_check",
    title: "Run Credential-Isolated Full CI Check",
    description:
      "Run full tests/CI in the workspace with SKIP_DOTENV=true and write the .log plus a .log.json result sidecar.",
    input: z.object({
      logFileName: z.string().min(5),
      command: z.string().min(1),
      args: z.array(z.string()),
      cwd: z.string().optional(),
    }),
    async execute(args) {
      const record = loadTask(recordPath);
      // Never overwrite a previous run: ci-1.log -> ci-1-2.log, ci-1-3.log, ...
      const requested = path.basename(args.logFileName.trim());
      const stem = requested.replace(/\.log$/i, "");
      let safeBase = `${stem}.log`;
      for (let n = 2; existsSync(path.join(taskDir, safeBase)); n += 1) {
        safeBase = `${stem}-${n}.log`;
      }
      const logPath = path.join(taskDir, safeBase);
      const targetCwd = args.cwd?.trim() || record.projectRoot;
      const result = runCheck(args.command, args.args, {
        log: logPath,
        cwd: targetCwd,
      });
      // Track the latest run (pass or fail) so the UI matches what the gate checks.
      try {
        const latest = loadTask(recordPath);
        if (!latest.ci?.waived) {
          latest.ci = { log: safeBase };
          saveTask(recordPath, latest);
        }
      } catch {
        // Non-fatal
      }
      notifyTaskChanges();
      return {
        text: JSON.stringify(result, null, 2),
        structuredContent: result,
        isError: result.status !== "PASS",
      };
    },
  });

  const submitDeliveryTool = defineAgentTool({
    name: "paseo_team_submit_delivery",
    title: "Submit Delivery",
    description:
      "Hand off finished work. Requires a passing paseo_team_run_check that ran after the previous round's delivery.",
    input: z.object({
      summary: z.string().min(1),
      architectureImpact: z
        .string()
        .min(1)
        .describe('Architecture/performance impact, or "None".'),
      ciLog: z.string().optional(),
    }),
    async execute(args) {
      const record = loadTask(recordPath);
      const problem = ciProblem(
        taskDir,
        record as unknown as Record<string, unknown>,
        nextDeliveryRound(record),
      );
      if (problem) {
        return {
          text: `${problem} Run the full project checks with paseo_team_run_check, then submit again.`,
          isError: true,
        };
      }
      return deliveryResult(
        recordCandidateDelivery(recordPath, { ...args, agentId }),
      );
    },
  });

  return [runCheckTool, submitDeliveryTool];
}

export { buildCoordinatorSystemPrompt };
