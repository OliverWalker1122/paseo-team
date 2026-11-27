import type { PaseoApi } from "@getpaseo/client";
import {
  defineAgentTool,
  type AgentToolDefinition,
} from "@getpaseo/plugin/server";
import { z } from "zod";
import {
  type AgentRoleDto,
  type AgentTreeSnapshotDto,
  type ConfigBundleDto,
  type ConversationGraphPayloadDto,
  type GraphLayerDto,
  type GraphNodeDto,
  type LiveAgentStatusDto,
  type ProviderCatalogItemDto,
  type ProviderModelOptionDto,
  TEAM_ENABLED_METADATA_KEY,
  TEAM_PERSPECTIVE_LABEL_KEY,
  TEAM_ROLE_LABEL_KEY,
} from "../shared/contracts.ts";
import {
  detectPromptLanguage,
  PERSPECTIVE_LABELS,
  type UiLanguage,
} from "../shared/i18n.ts";
import {
  AUTO_MODEL,
  type ComplexMode,
  loadConfig,
  resolveEffectiveTeam,
  type RoleModelSpec,
  saveConfig,
  type TeamPreset,
} from "./config-store.ts";
import {
  assignReviewerPerspective,
  buildCoordinatorTeamGuide,
  buildKickoffPrompt,
  type ReviewerPerspective,
  reviewerPerspectiveLabel,
} from "./prompts.ts";

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeConfigChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyConfigChanges(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Ignore subscriber error
    }
  }
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
      if (isReady) readyProviders.push(entry.provider);

      let rawModels: {
        id: string;
        label?: string;
        isSelectable?: boolean;
        isDefault?: boolean;
        thinkingOptions?: { id: string; label?: string }[];
        defaultThinkingOptionId?: string;
      }[] = Array.isArray(entry.models) ? entry.models : [];
      let rawModes: { id: string; label?: string; description?: string }[] =
        Array.isArray(entry.modes) ? entry.modes : [];

      if (isReady && rawModels.length === 0) {
        try {
          const fetched = await paseo.providers.listModels(
            entry.provider,
            cwd ? { cwd } : undefined,
          );
          if (Array.isArray(fetched?.models)) rawModels = fetched.models;
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
          if (Array.isArray(fetchedModes?.modes)) rawModes = fetchedModes.modes;
        } catch {
          // Ignore
        }
      }

      const models: ProviderModelOptionDto[] = [];
      for (const m of rawModels) {
        if (!m || typeof m.id !== "string" || m.isSelectable === false)
          continue;
        const fullId = `${entry.provider}/${m.id}`;
        const rawThinking = Array.isArray(m.thinkingOptions)
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
        const modeOptions = rawModes
          .filter((item) => Boolean(item && typeof item.id === "string"))
          .map((item) => ({
            id: item.id,
            label: item.label || item.id,
            ...(item.description ? { description: item.description } : {}),
          }));
        providers.push({
          provider: entry.provider,
          label: entry.label || entry.provider,
          ready: isReady,
          modes: modeOptions.map((item) => item.id),
          modeOptions,
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
      effectiveTeamName = resolveEffectiveTeam(loaded.config, cwd).teamName;
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

export function parseInlineTaskDirectives(rawArgs: string): {
  goal: string;
  teamOverride?: string;
  complexModeOverride?: ComplexMode;
  requireReview?: boolean;
  requirePlanReview?: boolean;
  skipReview?: boolean;
} {
  let text = rawArgs
    .trim()
    .replace(/^\/paseo-team(?:\s+|$)/i, "")
    .trim();
  let teamOverride: string | undefined;
  let complexModeOverride: ComplexMode | undefined;
  let requireReview: boolean | undefined;
  let requirePlanReview: boolean | undefined;
  let skipReview: boolean | undefined;

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

  if (/用简单模式|\bsimple\s+mode\b/i.test(text)) {
    complexModeOverride = "simple";
  } else if (/用专家(?:模式)?|\bexpert\s+mode\b/i.test(text)) {
    complexModeOverride = "expert";
  }

  if (
    /(?:不要|不需要|免除|跳过)(?:代码|方案)?(?:审查|评审)|免审|\b(?:no|skip|without)\s+(?:(?:code|plan)\s+)?review\b/i.test(
      text,
    )
  ) {
    skipReview = true;
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

  text = text.replace(/^start\s+/i, "").trim();
  return {
    goal: text || rawArgs.trim(),
    ...(teamOverride ? { teamOverride } : {}),
    ...(complexModeOverride ? { complexModeOverride } : {}),
    ...(requireReview ? { requireReview } : {}),
    ...(requirePlanReview ? { requirePlanReview } : {}),
    ...(skipReview ? { skipReview } : {}),
  };
}

const isUnsetSpec = (spec: RoleModelSpec | undefined) =>
  !spec?.model || spec.model === AUTO_MODEL;

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
  role: "developer" | "expert" | "plan-reviewer" | "code-reviewer";
  spec: RoleModelSpec;
  catalog: ProviderCatalogItemDto[];
}): {
  providerArg: string;
  modeId?: string;
  thinkingOptionId?: string;
} {
  const { spec, catalog } = options;
  if (!spec.model || spec.model === AUTO_MODEL) {
    throw new Error(`No model is set for the ${options.role} role.`);
  }
  const fullId = spec.model;
  const providerId = spec.model.split("/")[0] ?? spec.model;

  const catEntry = catalog.find((c) => c.provider === providerId);
  const availableModes = catEntry?.modes ?? [];

  let modeId: string | undefined;
  const configuredMode = spec.mode?.trim();
  if (
    configuredMode &&
    configuredMode !== "auto_default" &&
    (availableModes.length === 0 || availableModes.includes(configuredMode))
  ) {
    modeId = configuredMode;
  } else if (availableModes.includes("auto-review")) {
    modeId = "auto-review";
  } else if (availableModes.includes("auto")) {
    modeId = "auto";
  } else if (
    options.role === "developer" &&
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

function formatRosterLines(options: {
  preset: TeamPreset;
  providers: ProviderCatalogItemDto[];
  lang: UiLanguage;
  skipReview?: boolean;
}): string[] {
  const { preset, providers, lang, skipReview } = options;
  const zh = lang === "zh";

  const formatLine = (
    role: "developer" | "expert" | "plan-reviewer" | "code-reviewer",
    spec: RoleModelSpec,
    perspective?: ReviewerPerspective,
  ) => {
    const launch = resolveRoleLaunchSpec({ role, spec, catalog: providers });
    const settingsObj: Record<string, unknown> = {};
    if (launch.modeId) settingsObj.modeId = launch.modeId;
    if (launch.thinkingOptionId) {
      settingsObj.thinkingOptionId = launch.thinkingOptionId;
    }
    const settingsPart =
      Object.keys(settingsObj).length > 0
        ? ` settings=${JSON.stringify(settingsObj)}`
        : "";
    const labelsObj: Record<string, string> = { [TEAM_ROLE_LABEL_KEY]: role };
    if (perspective) labelsObj[TEAM_PERSPECTIVE_LABEL_KEY] = perspective;
    return `provider="${launch.providerArg}"${settingsPart} labels=${JSON.stringify(labelsObj)}`;
  };

  const lines: string[] = [
    `- Developer: ${formatLine("developer", preset.developer)}`,
  ];

  if (preset.expert?.model && preset.expert.model !== AUTO_MODEL) {
    const note =
      preset.complexMode === "expert"
        ? ""
        : zh
          ? "（可选，需独立起草方案时使用）"
          : " (optional, for dedicated plan drafting)";
    lines.push(`- Expert${note}: ${formatLine("expert", preset.expert)}`);
  }

  if (skipReview) {
    lines.push(
      zh
        ? "- 方案/代码审查：用户已明确免审（无需派发审查员）"
        : "- Plan / Code Review: waived by user (do not dispatch reviewers)",
    );
    return lines;
  }

  preset.planReviewers.forEach((spec, idx) => {
    const persp = assignReviewerPerspective(idx, preset.planReviewers.length);
    lines.push(
      `- Plan Reviewer #${idx + 1} (${reviewerPerspectiveLabel(persp, lang)}): ${formatLine("plan-reviewer", spec, persp)}`,
    );
  });

  preset.codeReviewers.forEach((spec, idx) => {
    const persp = assignReviewerPerspective(idx, preset.codeReviewers.length);
    lines.push(
      `- Code Reviewer #${idx + 1} (${reviewerPerspectiveLabel(persp, lang)}): ${formatLine("code-reviewer", spec, persp)}`,
    );
  });

  return lines;
}

export async function resolveTeamGuideForCwd(
  paseo: PaseoApi,
  cwd: string,
  options?: {
    teamOverride?: string;
    complexModeOverride?: ComplexMode;
    requireReview?: boolean;
    requirePlanReview?: boolean;
    skipReview?: boolean;
    lang?: UiLanguage;
  },
): Promise<{
  teamName: string;
  complexMode: ComplexMode;
  rosterLines: string[];
  unset: string[];
  userConstraints: string[];
  guide: string;
}> {
  const { providers } = await readProviderCatalog(paseo, cwd);
  const { config } = loadAndUpgradeConfig();
  const eff = resolveEffectiveTeam(config, cwd, {
    teamOverride: options?.teamOverride,
    complexModeOverride: options?.complexModeOverride,
  });

  const lang = options?.lang ?? "en";
  const zh = lang === "zh";
  const unset = unsetRoles(eff.preset);
  const userConstraints: string[] = [];
  if (options?.requirePlanReview) {
    userConstraints.push(
      zh
        ? "- 用户已明确要求**方案评审**（编码前必须先做方案审查）。"
        : "- User explicitly requested **plan review** before coding.",
    );
  }
  if (options?.requireReview) {
    userConstraints.push(
      zh
        ? "- 用户已明确要求**代码审查**。"
        : "- User explicitly requested **code review**.",
    );
  }
  if (options?.skipReview) {
    userConstraints.push(
      zh
        ? "- 用户已明确免审（跳过方案与代码审查）。"
        : "- User explicitly waived review for this task.",
    );
  }

  const rosterLines =
    unset.length === 0
      ? formatRosterLines({
          preset: eff.preset,
          providers,
          lang,
          skipReview: options?.skipReview,
        })
      : [];

  const guide = buildCoordinatorTeamGuide({
    teamName: eff.teamName,
    complexMode: eff.preset.complexMode,
    rosterLines,
    unsetRoles: unset,
    userConstraints,
    lang,
  });

  return {
    teamName: eff.teamName,
    complexMode: eff.preset.complexMode,
    rosterLines,
    unset,
    userConstraints,
    guide,
  };
}

export async function startTeamTask(
  paseo: PaseoApi,
  input: {
    cwd: string;
    workspaceId?: string;
    agentId: string;
    rawArgs: string;
    language?: UiLanguage;
  },
): Promise<{
  coordinatorAgentId: string;
  teamName: string;
  message: string;
}> {
  const cleanedRawArgs = input.rawArgs
    .trim()
    .replace(/^\/paseo-team(?:\s+|$)/i, "")
    .trim();
  const langHint = detectPromptLanguage(cleanedRawArgs, input.language ?? "en");
  if (!cleanedRawArgs) {
    throw new Error(
      langHint === "zh"
        ? "请提供任务目标，例如：/paseo-team 修复登录页超时问题。"
        : 'Please provide a task goal after /paseo-team (for example: "/paseo-team fix login timeout").',
    );
  }

  const parsed = parseInlineTaskDirectives(cleanedRawArgs);
  const promptLang = detectPromptLanguage(parsed.goal, input.language ?? "en");
  const zh = promptLang === "zh";

  const resolved = await resolveTeamGuideForCwd(paseo, input.cwd, {
    teamOverride: parsed.teamOverride,
    complexModeOverride: parsed.complexModeOverride,
    requireReview: parsed.requireReview,
    requirePlanReview: parsed.requirePlanReview,
    skipReview: parsed.skipReview,
    lang: promptLang,
  });

  if (resolved.unset.length > 0) {
    throw new Error(
      zh
        ? `预设「${resolved.teamName}」还有角色没选模型：${resolved.unset.join("、")}。请在团队配置里为它们选择模型（审查员也可以设为“不启用”）。`
        : `Preset "${resolved.teamName}" has roles without a model: ${resolved.unset.join(", ")}. Pick a model for each in Team settings.`,
    );
  }

  const coordHandle = paseo.agents.ref(input.agentId);
  const refreshed = await coordHandle.refresh().catch(() => null);
  const status = (refreshed?.agent as { status?: string } | undefined)?.status;
  if (status === "running" || status === "initializing") {
    throw new Error(
      zh
        ? "当前对话正在运行中，请等本轮回复结束后再运行 /paseo-team。"
        : "This chat is currently running a turn. Wait for it to finish before running /paseo-team.",
    );
  }

  const kickoffPrompt = buildKickoffPrompt({
    goal: parsed.goal,
    teamName: resolved.teamName,
    complexMode: resolved.complexMode,
    rosterLines: resolved.rosterLines,
    userConstraints: resolved.userConstraints,
    lang: promptLang,
  });

  if (typeof coordHandle.setMetadata === "function") {
    await coordHandle
      .setMetadata({ [TEAM_ENABLED_METADATA_KEY]: true })
      .catch(() => {});
  }

  await coordHandle.send(kickoffPrompt);

  return {
    coordinatorAgentId: input.agentId,
    teamName: resolved.teamName,
    message: zh
      ? "已在当前对话启动团队协作。"
      : "Team collaboration started in this chat.",
  };
}

/**
 * Single stateless read-only fallback tool: returns the configured role models
 * and team protocol as plain text (never writes disk state, never locks anything,
 * and omits `structuredContent` so Paseo's MCP bridge preserves the full text).
 */
export function createRosterTool(): AgentToolDefinition {
  return defineAgentTool({
    name: "paseo_team_roster",
    title: "Paseo Team Roster",
    description:
      "Read-only lookup for the user's configured Paseo Team role models (Developer, Expert, Plan/Code Reviewers) and workflow protocol. Call when `/paseo-team` is invoked directly or when switching presets.",
    input: z.object({
      preset: z
        .string()
        .min(1)
        .optional()
        .describe("Optional preset name override."),
      rawArgs: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Optional raw task goal/directives to parse language and flags.",
        ),
    }),
    async execute(args, context) {
      const cwd = context?.agent?.cwd?.trim();
      const paseo = context?.paseo;
      if (!cwd || !paseo) {
        return {
          text: "Missing active agent working directory or Paseo context.",
          isError: true,
        };
      }
      const parsed = args.rawArgs
        ? parseInlineTaskDirectives(args.rawArgs)
        : undefined;
      const lang = detectPromptLanguage(
        parsed?.goal || context?.agent?.title || "",
        "en",
      );
      try {
        const resolved = await resolveTeamGuideForCwd(paseo, cwd, {
          teamOverride: args.preset ?? parsed?.teamOverride,
          complexModeOverride: parsed?.complexModeOverride,
          requireReview: parsed?.requireReview,
          requirePlanReview: parsed?.requirePlanReview,
          skipReview: parsed?.skipReview,
          lang,
        });
        const agentId = context?.agent?.id?.trim();
        if (agentId) {
          const handle = paseo.agents.ref(agentId);
          if (typeof handle.setMetadata === "function") {
            await handle
              .setMetadata({ [TEAM_ENABLED_METADATA_KEY]: true })
              .catch(() => {});
          }
        }
        return { text: resolved.guide };
      } catch (err) {
        return {
          text: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Live Paseo Agent Tree Graph (Single Source of Truth)
// ---------------------------------------------------------------------------

const ROLE_SLOT_SUFFIX = String.raw`(?:\s*(?:#?\d+|[一二三四]))?`;
const UNBRACKETED_ROLE_DELIM = String.raw`\s*(?:[:：\-–—·/]|$)`;

export function inferTeamRole(options: {
  labels?: Record<string, string>;
  title?: string | null;
}): Exclude<AgentRoleDto, "coordinator" | "subagent"> | null {
  const explicit = (
    options.labels?.[TEAM_ROLE_LABEL_KEY] ||
    options.labels?.["role"] ||
    ""
  )
    .trim()
    .toLowerCase();
  if (
    explicit === "developer" ||
    explicit === "expert" ||
    explicit === "plan-reviewer" ||
    explicit === "code-reviewer"
  ) {
    return explicit;
  }

  const title = (options.title ?? "").trim();
  if (!title) return null;
  if (
    new RegExp(
      `^(?:\\[(?:Developer|Handoff|开发(?:者|成员)?)${ROLE_SLOT_SUFFIX}\\]|(?:Developer|Handoff|开发(?:者|成员)?)${ROLE_SLOT_SUFFIX}${UNBRACKETED_ROLE_DELIM})`,
      "i",
    ).test(title)
  ) {
    return "developer";
  }
  if (
    new RegExp(
      `^(?:\\[(?:Expert|Architect|专家)${ROLE_SLOT_SUFFIX}\\]|(?:Expert|Architect|专家)${ROLE_SLOT_SUFFIX}${UNBRACKETED_ROLE_DELIM})`,
      "i",
    ).test(title)
  ) {
    return "expert";
  }
  if (
    new RegExp(
      `^(?:\\[(?:Plan\\s*Review(?:er)?|方案(?:审查|评审)(?:员)?)${ROLE_SLOT_SUFFIX}\\]|(?:Plan\\s*Review(?:er)?|方案(?:审查|评审)(?:员)?)${ROLE_SLOT_SUFFIX}${UNBRACKETED_ROLE_DELIM})`,
      "i",
    ).test(title)
  ) {
    return "plan-reviewer";
  }
  if (
    new RegExp(
      `^(?:\\[(?:Code\\s*Review(?:er)?|Reviewer|Advisor|(?:代码)?(?:审查|评审)(?:员)?)${ROLE_SLOT_SUFFIX}\\]|(?:Code\\s*Review(?:er)?|Reviewer|Advisor|(?:代码)?(?:审查|评审)(?:员)?)${ROLE_SLOT_SUFFIX}${UNBRACKETED_ROLE_DELIM})`,
      "i",
    ).test(title)
  ) {
    return "code-reviewer";
  }
  return null;
}

export interface LiveAgentRecord {
  id: string;
  workspaceId: string | null;
  parentAgentId: string | null;
  title: string;
  cwd: string;
  status: LiveAgentStatusDto;
  provider: string;
  model: string | null;
  thinkingOptionId: string | null;
  labels: Record<string, string>;
  isTeamEnabled: boolean;
  background: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function fetchLiveAgentMap(
  paseo: PaseoApi,
): Promise<Map<string, LiveAgentRecord>> {
  const map = new Map<string, LiveAgentRecord>();
  try {
    const listed = await paseo.agents.list({
      filter: { includeArchived: true },
      page: { limit: 200 },
    });
    const now = new Date().toISOString();
    for (const entry of listed.entries) {
      const a = entry.agent as unknown as Record<string, unknown>;
      const id = String(a.id ?? "");
      if (!id) continue;
      const labels =
        a.labels && typeof a.labels === "object"
          ? (a.labels as Record<string, string>)
          : {};
      const metadata =
        a.metadata && typeof a.metadata === "object"
          ? (a.metadata as Record<string, unknown>)
          : {};
      const pendingCount = Array.isArray(a.pendingPermissions)
        ? a.pendingPermissions.length
        : 0;
      const rawStatus = String(a.status ?? "idle");
      let status: LiveAgentStatusDto = "idle";
      if (pendingCount > 0) {
        status = "awaiting_permission";
      } else if (
        rawStatus === "initializing" ||
        rawStatus === "running" ||
        rawStatus === "error" ||
        rawStatus === "closed"
      ) {
        status = rawStatus;
      }
      const parentAgentId =
        (typeof a.parentAgentId === "string" && a.parentAgentId) ||
        (typeof labels["paseo.parent-agent-id"] === "string" &&
          labels["paseo.parent-agent-id"]) ||
        null;
      const createdAt =
        typeof a.createdAt === "string" && a.createdAt ? a.createdAt : now;
      const updatedAt =
        typeof a.updatedAt === "string" && a.updatedAt
          ? a.updatedAt
          : createdAt;

      map.set(id, {
        id,
        workspaceId: typeof a.workspaceId === "string" ? a.workspaceId : null,
        parentAgentId,
        title: typeof a.title === "string" ? a.title.trim() : "",
        cwd: typeof a.cwd === "string" ? a.cwd : "",
        status,
        provider: typeof a.provider === "string" ? a.provider : "agent",
        model: typeof a.model === "string" ? a.model : null,
        thinkingOptionId:
          typeof a.thinkingOptionId === "string" ? a.thinkingOptionId : null,
        labels,
        isTeamEnabled: metadata[TEAM_ENABLED_METADATA_KEY] === true,
        background: Boolean(a.background),
        archivedAt: typeof a.archivedAt === "string" ? a.archivedAt : null,
        createdAt,
        updatedAt,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/Daemon client closed/i.test(msg)) {
      console.error("[paseo-team] agents.list failed:", err);
    }
  }
  return map;
}

function resolveRootAgentId(
  agentId: string,
  liveMap: Map<string, LiveAgentRecord>,
): string {
  let current = agentId;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    const info = liveMap.get(current);
    if (!info?.parentAgentId || !liveMap.has(info.parentAgentId)) break;
    current = info.parentAgentId;
  }
  return current;
}

function roleDisplayLabel(
  role: AgentRoleDto,
  slotIndex: number,
  groupSize: number,
  lang: UiLanguage,
): string {
  const zh = lang === "zh";
  const suffix = groupSize > 1 ? ` #${slotIndex + 1}` : "";
  switch (role) {
    case "coordinator":
      return zh ? "主控 Coordinator" : "Coordinator";
    case "expert":
      return (zh ? "专家 Expert" : "Expert") + suffix;
    case "plan-reviewer":
      return `${zh ? "方案审查" : "Plan Reviewer"} #${slotIndex + 1}`;
    case "developer":
      return `Developer${suffix}`;
    case "code-reviewer":
      return `${zh ? "代码审查" : "Code Reviewer"} #${slotIndex + 1}`;
    case "subagent":
      return `${zh ? "子 Agent" : "Subagent"}${suffix}`;
  }
}

function layerTitleForRole(
  role: AgentRoleDto,
  waveIndex: number,
  lang: UiLanguage,
): string {
  const zh = lang === "zh";
  const roundSuffix =
    waveIndex > 1
      ? zh
        ? ` · 第 ${waveIndex} 轮`
        : ` · Round ${waveIndex}`
      : "";
  switch (role) {
    case "coordinator":
      return zh ? "主控协调" : "Coordinator";
    case "expert":
      return (zh ? "专家方案" : "Expert Plan") + roundSuffix;
    case "plan-reviewer":
      return (zh ? "方案审查" : "Plan Review") + roundSuffix;
    case "developer":
      return (zh ? "开发实现" : "Development") + roundSuffix;
    case "code-reviewer":
      return (zh ? "代码审查" : "Code Review") + roundSuffix;
    case "subagent":
      return (zh ? "子会话" : "Subagents") + roundSuffix;
  }
}

function formatModelBadge(agent: LiveAgentRecord): string {
  const base = agent.model
    ? `${agent.provider}/${agent.model}`
    : agent.provider;
  return agent.thinkingOptionId ? `${base} · ${agent.thinkingOptionId}` : base;
}

function summarizeLayerStatus(nodes: GraphNodeDto[]): GraphLayerDto["status"] {
  if (nodes.some((n) => n.status === "awaiting_permission")) {
    return "awaiting_permission";
  }
  if (
    nodes.some((n) => n.status === "running" || n.status === "initializing")
  ) {
    return "running";
  }
  if (nodes.some((n) => n.status === "error")) {
    return "error";
  }
  return "idle";
}

function toGraphNode(
  agent: LiveAgentRecord,
  role: AgentRoleDto,
  slotIndex: number,
  groupSize: number,
  lang: UiLanguage,
): GraphNodeDto {
  const rawPersp = agent.labels[TEAM_PERSPECTIVE_LABEL_KEY];
  const perspectiveLabel =
    rawPersp === "spec-boundary" ||
    rawPersp === "arch-simplicity" ||
    rawPersp === "comprehensive"
      ? PERSPECTIVE_LABELS[lang][rawPersp]
      : undefined;

  return {
    agentId: agent.id,
    parentAgentId: agent.parentAgentId,
    workspaceId: agent.workspaceId,
    role,
    label: roleDisplayLabel(role, slotIndex, groupSize, lang),
    title: agent.title || roleDisplayLabel(role, slotIndex, groupSize, lang),
    modelBadge: formatModelBadge(agent),
    ...(perspectiveLabel ? { perspectiveLabel } : {}),
    status: agent.status,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

export function buildAgentTree(
  rootId: string,
  liveMap: Map<string, LiveAgentRecord>,
  lang: UiLanguage,
): AgentTreeSnapshotDto | null {
  const root = liveMap.get(rootId);
  if (!root || root.background) return null;

  const childrenByParent = new Map<string, LiveAgentRecord[]>();
  for (const agent of liveMap.values()) {
    if (agent.background || !agent.parentAgentId) continue;
    const list = childrenByParent.get(agent.parentAgentId) ?? [];
    list.push(agent);
    childrenByParent.set(agent.parentAgentId, list);
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  const directKids = childrenByParent.get(rootId) ?? [];
  const isTeamChat =
    root.isTeamEnabled ||
    directKids.some(
      (k) => inferTeamRole({ labels: k.labels, title: k.title }) !== null,
    );

  const rootNode = toGraphNode(root, "coordinator", 0, 1, lang);
  const layers: GraphLayerDto[] = [
    {
      layerId: "coordinator",
      title: layerTitleForRole("coordinator", 1, lang),
      status: summarizeLayerStatus([rootNode]),
      nodes: [rootNode],
    },
  ];

  // Group direct children into consecutive same-role parallel waves in real chronological order.
  const roleWaveCounts = new Map<AgentRoleDto, number>();
  const waves: Array<{ role: AgentRoleDto; members: LiveAgentRecord[] }> = [];
  for (const child of directKids) {
    const role: AgentRoleDto =
      inferTeamRole({ labels: child.labels, title: child.title }) ?? "subagent";
    const prev = waves[waves.length - 1];
    if (prev && prev.role === role) {
      prev.members.push(child);
    } else {
      waves.push({ role, members: [child] });
    }
  }

  const allTreeAgents: LiveAgentRecord[] = [root];
  for (const wave of waves) {
    const waveNum = (roleWaveCounts.get(wave.role) ?? 0) + 1;
    roleWaveCounts.set(wave.role, waveNum);
    const nodes = wave.members.map((agent, idx) => {
      allTreeAgents.push(agent);
      return toGraphNode(agent, wave.role, idx, wave.members.length, lang);
    });
    layers.push({
      layerId: `${wave.role}-${waveNum}`,
      title: layerTitleForRole(wave.role, waveNum, lang),
      status: summarizeLayerStatus(nodes),
      nodes,
    });

    // If any member spawned nested children (e.g. cross-worktree coordinator), render them below.
    const nested: LiveAgentRecord[] = [];
    for (const member of wave.members) {
      nested.push(...(childrenByParent.get(member.id) ?? []));
    }
    if (nested.length > 0) {
      nested.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const nestedNodes = nested.map((agent, idx) => {
        allTreeAgents.push(agent);
        const role: AgentRoleDto =
          inferTeamRole({ labels: agent.labels, title: agent.title }) ??
          "subagent";
        return toGraphNode(agent, role, idx, nested.length, lang);
      });
      layers.push({
        layerId: `${wave.role}-${waveNum}-nested`,
        title: lang === "zh" ? "二级子会话" : "Nested Sessions",
        status: summarizeLayerStatus(nestedNodes),
        nodes: nestedNodes,
      });
    }
  }

  let runningCount = 0;
  let attentionCount = 0;
  let latestUpdated = root.updatedAt;
  for (const agent of allTreeAgents) {
    if (agent.status === "running" || agent.status === "initializing") {
      runningCount += 1;
    } else if (
      agent.status === "awaiting_permission" ||
      agent.status === "error"
    ) {
      attentionCount += 1;
    }
    if (agent.updatedAt > latestUpdated) {
      latestUpdated = agent.updatedAt;
    }
  }

  return {
    rootAgentId: root.id,
    workspaceId: root.workspaceId,
    title:
      root.title ||
      (lang === "zh" ? "团队协作对话" : "Team Collaboration Session"),
    cwd: root.cwd,
    isTeamChat,
    totalAgents: allTreeAgents.length,
    runningCount,
    attentionCount,
    layers,
    createdAt: root.createdAt,
    updatedAt: latestUpdated,
  };
}

export async function buildConversationGraph(
  paseo: PaseoApi,
  input: {
    agentId?: string;
    workspaceId?: string;
    language?: UiLanguage;
  },
): Promise<ConversationGraphPayloadDto> {
  const lang = input.language ?? "en";
  const liveMap = await fetchLiveAgentMap(paseo);

  let rootId: string | null = null;
  if (input.agentId && liveMap.has(input.agentId)) {
    rootId = resolveRootAgentId(input.agentId, liveMap);
  } else if (input.workspaceId) {
    const candidates = [...liveMap.values()]
      .filter(
        (a) =>
          !a.background &&
          !a.archivedAt &&
          a.workspaceId === input.workspaceId &&
          (!a.parentAgentId || !liveMap.has(a.parentAgentId)),
      )
      .map((a) => buildAgentTree(a.id, liveMap, lang))
      .filter((t): t is AgentTreeSnapshotDto =>
        Boolean(t && (t.isTeamChat || t.totalAgents > 1)),
      )
      .sort((a, b) => {
        const aLive = a.runningCount + a.attentionCount > 0 ? 1 : 0;
        const bLive = b.runningCount + b.attentionCount > 0 ? 1 : 0;
        if (aLive !== bLive) return bLive - aLive;
        return b.updatedAt.localeCompare(a.updatedAt);
      });
    rootId = candidates[0]?.rootAgentId ?? null;
  }

  if (!rootId) {
    return {
      viewerAgentId: input.agentId ?? null,
      rootAgentId: null,
      tree: null,
    };
  }

  const tree = buildAgentTree(rootId, liveMap, lang);
  if (!tree || (!tree.isTeamChat && tree.totalAgents <= 1)) {
    return {
      viewerAgentId: input.agentId ?? null,
      rootAgentId: rootId,
      tree: null,
    };
  }

  return {
    viewerAgentId: input.agentId ?? null,
    rootAgentId: rootId,
    tree,
  };
}

export async function listActiveTrees(
  paseo: PaseoApi,
  options?: { language?: UiLanguage },
): Promise<AgentTreeSnapshotDto[]> {
  const lang = options?.language ?? "en";
  const liveMap = await fetchLiveAgentMap(paseo);
  const trees: AgentTreeSnapshotDto[] = [];

  for (const agent of liveMap.values()) {
    if (agent.background || agent.archivedAt) continue;
    if (agent.parentAgentId && liveMap.has(agent.parentAgentId)) continue;
    const tree = buildAgentTree(agent.id, liveMap, lang);
    if (!tree) continue;
    if (tree.isTeamChat || tree.totalAgents > 1) {
      trees.push(tree);
    }
  }

  trees.sort((a, b) => {
    const aLive = a.runningCount + a.attentionCount > 0 ? 1 : 0;
    const bLive = b.runningCount + b.attentionCount > 0 ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive;
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  return trees.slice(0, 30);
}
