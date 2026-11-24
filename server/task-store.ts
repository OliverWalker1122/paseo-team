import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { detectPromptLanguage, type UiLanguage } from "../shared/i18n.ts";
import {
  type ComplexMode,
  defaultStateRoot,
  formatRoleSpecShort,
  normalizeRoleSpec,
  type TeamPreset,
} from "./config-store.ts";
import {
  assignReviewerPerspective,
  type ReviewerPerspective,
  reviewerPerspectiveLabel,
} from "./prompts.ts";

export type PipelineStageId =
  | "coordinator"
  | "expert"
  | "plan-review"
  | "development"
  | "code-review"
  | "merge-gate";

export type AgentRole =
  | "coordinator"
  | "expert"
  | "plan-reviewer"
  | "developer"
  | "code-reviewer"
  | "gate";

export type NodeVisualStatus =
  | "pending"
  | "running"
  | "awaiting_permission"
  | "completed"
  | "approved"
  | "changes_requested"
  | "blocked"
  | "skipped";

export type ReviewVerdict = "APPROVE" | "REQUEST_CHANGES" | "BLOCKED";

export interface TaskAgentNode {
  nodeId: string;
  stage: PipelineStageId;
  role: AgentRole;
  slotIndex: number;
  label: string;
  profile: string;
  provider?: string;
  model?: string;
  thinkingOptionId?: string;
  serverId?: string;
  agentId?: string;
  perspective?: ReviewerPerspective;
  briefSummary: string;
  status: NodeVisualStatus;
  round?: number;
  verdict?: ReviewVerdict;
  summary?: string;
  startedAt?: string;
  /** Handoff bookkeeping written by the turn hooks and submit tools. */
  turnStartedAt?: string;
  submittedAt?: string;
  reminded?: boolean;
  updatedAt: string;
}

export interface ReviewerRecordEntry {
  agentId: string;
  profile: string;
  commit: string;
  round: number;
  status: ReviewVerdict;
  summary: string;
  findings?: string[];
  sidecar: string;
  /** "coordinator" when the coordinator recorded it on the reviewer's behalf. */
  source?: "self" | "coordinator";
  updatedAt: string;
}

export interface ReviewRoundView {
  round: number;
  verdict: ReviewVerdict;
  summary: string;
  findings?: string[];
  recordedAt?: string;
}

function toStringList(raw: unknown, prefix = ""): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => {
      const v = x.trim();
      return prefix && !/^[a-z]+\s*[:：]/i.test(v) ? `${prefix}${v}` : v;
    });
}

/** Every recorded round for one reviewer, oldest first. Falls back to the latest entry for legacy records. */
export function readReviewRounds(
  recordPath: string,
  stage: "plan" | "code",
  agentId: string,
  latest?: ReviewerRecordEntry,
): ReviewRoundView[] {
  const reviewsDir = path.join(
    path.dirname(path.resolve(recordPath)),
    "reviews",
  );
  // Every submission is kept: a re-review of the same delivery is a second verdict in that round.
  const out: ReviewRoundView[] = [];
  if (existsSync(reviewsDir)) {
    for (const name of readdirSync(reviewsDir)) {
      if (!name.startsWith(`${stage}-`) || !name.endsWith(".json")) continue;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(readFileSync(path.join(reviewsDir, name), "utf8"));
      } catch {
        continue;
      }
      if (raw.agentId !== agentId || raw.stage !== stage) continue;
      const verdict = normalizeVerdict(raw.status);
      const round = typeof raw.round === "number" ? raw.round : 0;
      if (!verdict || round < 1) continue;
      const recordedAt = asNonEmptyString(raw.recordedAt) ?? undefined;
      const findings = toStringList(raw.findings);
      out.push({
        round,
        verdict,
        summary: asNonEmptyString(raw.summary) ?? "",
        ...(findings.length > 0 ? { findings } : {}),
        ...(recordedAt ? { recordedAt } : {}),
      });
    }
  }
  if (out.length === 0 && latest) {
    out.push({
      round: latest.round,
      verdict: latest.status,
      summary: latest.summary,
      ...(latest.findings?.length ? { findings: latest.findings } : {}),
      recordedAt: latest.updatedAt,
    });
  }
  return out.sort(
    (a, b) =>
      a.round - b.round ||
      (a.recordedAt ?? "").localeCompare(b.recordedAt ?? ""),
  );
}

export interface TaskDeliveryInfo {
  candidate: string;
  summary: string;
  architectureImpact: string;
  deliveredAt: string;
}

export interface TaskDeliveryRoundEntry extends TaskDeliveryInfo {
  round: number;
  agentId?: string;
  ciLog?: string;
}

export interface CircuitBreakerInfo {
  stage: "plan" | "code";
  round: number;
  reason: string;
  triggeredAt: string;
}

export interface TaskRecord {
  schemaVersion: 2;
  taskId: string;
  projectRoot: string;
  projectSlug: string;
  candidate: string | null;
  goal: string;
  isComplex: boolean;
  teamName: string;
  complexMode: ComplexMode;
  team: TeamPreset;
  coordinatorAgentId?: string;
  coordinatorServerId?: string;
  /** The chat that started this task; one chat can root many task subtrees. */
  launcherAgentId?: string;
  planReview: "required" | "not-required" | "waived";
  planReviewReason?: string;
  planReviewRound: number;
  planVersion: string;
  planReviewers: ReviewerRecordEntry[];
  codeReview: "required" | "not-required" | "waived";
  codeReviewReason?: string;
  codeReviewRound: number;
  codeReviewers: ReviewerRecordEntry[];
  ci: { log?: string; waived?: string } | null;
  delivery: TaskDeliveryInfo | null;
  deliveries?: TaskDeliveryRoundEntry[];
  circuitBroken: CircuitBreakerInfo | null;
  /** Review rounds the user allowed beyond the default two. */
  extraRounds?: number;
  /** Plans submitted so far; plan review round N reviews plan vN. */
  planSubmissions?: number;
  nodes: TaskAgentNode[];
  lifecycleStatus: "active" | "completed" | "paused" | "abandoned" | "blocked";
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// Preserves Paseo's workspace directory (whether main checkout or Paseo-managed worktree).
export function resolveWorkspaceDirectory(cwd: string): string {
  const resolved = path.resolve(cwd);
  const git = spawnSync(
    "git",
    ["--no-optional-locks", "-C", resolved, "rev-parse", "--show-toplevel"],
    { encoding: "utf8" },
  );
  if (git.status === 0 && git.stdout.trim()) {
    try {
      return realpathSync(git.stdout.trim());
    } catch {
      return git.stdout.trim();
    }
  }
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function slugify(input: string, fallback = "task"): string {
  const safe = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28)
    .replace(/-+$/g, "");
  if (safe.replace(/-/g, "").length >= 3) return safe;
  return `${fallback}-${createHash("sha1").update(input).digest("hex").slice(0, 6)}`;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const resolved = path.resolve(filePath);
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new Error("Refusing to overwrite symlinked task file.");
  }
  mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const temp = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temp, resolved);
}

export function buildInitialNodes(options: {
  preset: TeamPreset;
  isComplex: boolean;
  planReviewRequired: boolean;
  codeReviewRequired: boolean;
  coordinatorAgentId?: string;
  coordinatorServerId?: string;
  goal: string;
  now: string;
  lang?: UiLanguage;
}): TaskAgentNode[] {
  const { preset, isComplex, planReviewRequired, codeReviewRequired, now } =
    options;
  const lang = options.lang ?? detectPromptLanguage(options.goal, "en");
  const zh = lang === "zh";
  const nodes: TaskAgentNode[] = [];

  nodes.push({
    nodeId: "coordinator",
    stage: "coordinator",
    role: "coordinator",
    slotIndex: 0,
    label: zh ? "主控 Coordinator" : "Coordinator",
    profile: zh ? "当前会话" : "Current Chat",
    ...(options.coordinatorAgentId
      ? { agentId: options.coordinatorAgentId }
      : {}),
    ...(options.coordinatorServerId
      ? { serverId: options.coordinatorServerId }
      : {}),
    briefSummary:
      preset.complexMode === "simple" && isComplex
        ? zh
          ? "兼任架构设计 · 统筹目标、派发与验收"
          : "Drafts design · Scopes, dispatches & adjudicates"
        : zh
          ? "目标拆解、派发协调与证据裁决"
          : "Scopes goal, dispatches roles & adjudicates by evidence",
    status: "running",
    updatedAt: now,
  });

  if (preset.complexMode === "expert") {
    nodes.push({
      nodeId: "expert",
      stage: "expert",
      role: "expert",
      slotIndex: 0,
      label: zh ? "专家 Expert" : "Expert",
      profile: formatRoleSpecShort(preset.expert, lang),
      briefSummary: isComplex
        ? zh
          ? "起草复杂方案与根因分析（只写任务目录）"
          : "Drafts architecture & root-cause analysis in task dir"
        : zh
          ? "简单任务默认跳过"
          : "Skipped for non-complex tasks",
      status: isComplex ? "pending" : "skipped",
      updatedAt: now,
    });
  }

  const planSpecs =
    preset.planReviewers.length > 0
      ? preset.planReviewers
      : [{ model: "auto" }];
  planSpecs.forEach((spec, idx) => {
    const perspective = assignReviewerPerspective(idx, planSpecs.length);
    nodes.push({
      nodeId: `plan-reviewer-${idx}`,
      stage: "plan-review",
      role: "plan-reviewer",
      slotIndex: idx,
      label: zh ? `方案审查 #${idx + 1}` : `Plan Reviewer #${idx + 1}`,
      profile: formatRoleSpecShort(spec, lang),
      perspective,
      briefSummary: planReviewRequired
        ? zh
          ? `首轮交叉审核 · ${reviewerPerspectiveLabel(perspective, "zh")}`
          : `Cross review · ${reviewerPerspectiveLabel(perspective, "en")}`
        : zh
          ? "未触发方案审查"
          : "Plan review not required",
      status: planReviewRequired ? "pending" : "skipped",
      updatedAt: now,
    });
  });

  nodes.push({
    nodeId: "developer",
    stage: "development",
    role: "developer",
    slotIndex: 0,
    label: "Developer",
    profile: formatRoleSpecShort(preset.developer, lang),
    briefSummary: zh
      ? "直接在当前工作区实现修改并运行完整测试"
      : "Implements changes & runs full CI in this workspace",
    status: "pending",
    updatedAt: now,
  });

  const codeSpecs =
    preset.codeReviewers.length > 0
      ? preset.codeReviewers
      : [{ model: "auto" }];
  codeSpecs.forEach((spec, idx) => {
    const perspective = assignReviewerPerspective(idx, codeSpecs.length);
    nodes.push({
      nodeId: `code-reviewer-${idx}`,
      stage: "code-review",
      role: "code-reviewer",
      slotIndex: idx,
      label: zh ? `代码审查 #${idx + 1}` : `Code Reviewer #${idx + 1}`,
      profile: formatRoleSpecShort(spec, lang),
      perspective,
      briefSummary: codeReviewRequired
        ? zh
          ? `候选代码审查 · ${reviewerPerspectiveLabel(perspective, "zh")}`
          : `Cross review · ${reviewerPerspectiveLabel(perspective, "en")}`
        : zh
          ? "按改动规模或架构影响自动判定"
          : "Triggered if diff size or architecture impact requires",
      status: "pending",
      updatedAt: now,
    });
  });

  nodes.push({
    nodeId: "merge-gate",
    stage: "merge-gate",
    role: "gate",
    slotIndex: 0,
    label: zh ? "验收门禁" : "Quality Gate",
    profile: "quality-gate",
    briefSummary: zh
      ? "核对最新一次测试通过与最新一轮审查批准"
      : "Verifies latest CI run and latest-round review approvals",
    status: "pending",
    updatedAt: now,
  });

  return nodes;
}

export function initTask(options: {
  cwd: string;
  goal: string;
  teamName: string;
  preset: TeamPreset;
  isComplex?: boolean;
  requireReview?: boolean;
  requirePlanReview?: boolean;
  skipReviewReason?: string;
  coordinatorAgentId?: string;
  coordinatorServerId?: string;
  launcherAgentId?: string;
  stateRoot?: string;
}): {
  recordPath: string;
  taskDir: string;
  record: TaskRecord;
} {
  const stateRoot = options.stateRoot ?? defaultStateRoot();
  const projectRoot = resolveWorkspaceDirectory(options.cwd);
  const projectSlug = `${path.basename(projectRoot)}-${createHash("sha1").update(projectRoot).digest("hex").slice(0, 6)}`;
  const projectDir = path.join(stateRoot, projectSlug);
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });

  const datePart = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const baseId = `${datePart}-${slugify(options.goal)}`;
  let taskId = baseId;
  let suffix = 2;
  while (existsSync(path.join(projectDir, taskId))) {
    taskId = `${baseId}-${suffix}`;
    suffix += 1;
  }

  const taskDir = path.join(projectDir, taskId);
  mkdirSync(path.join(taskDir, "reviews"), { recursive: true, mode: 0o700 });

  const isComplex = Boolean(options.isComplex);
  const skipRequested = Boolean(options.skipReviewReason?.trim());
  const planReviewRequired =
    !skipRequested && (isComplex || Boolean(options.requirePlanReview));
  const codeReviewRequired =
    !skipRequested && (isComplex || Boolean(options.requireReview));
  const now = new Date().toISOString();

  const record: TaskRecord = {
    schemaVersion: 2,
    taskId,
    projectRoot,
    projectSlug,
    candidate: null,
    goal: options.goal.trim(),
    isComplex,
    teamName: options.teamName,
    complexMode: options.preset.complexMode,
    team: options.preset,
    ...(options.coordinatorAgentId
      ? { coordinatorAgentId: options.coordinatorAgentId }
      : {}),
    ...(options.coordinatorServerId
      ? { coordinatorServerId: options.coordinatorServerId }
      : {}),
    ...(options.launcherAgentId
      ? { launcherAgentId: options.launcherAgentId }
      : {}),
    planReview: skipRequested
      ? "waived"
      : planReviewRequired
        ? "required"
        : "not-required",
    ...(skipRequested
      ? { planReviewReason: options.skipReviewReason!.trim() }
      : {}),
    planReviewRound: 0,
    planVersion: "v1",
    planReviewers: [],
    codeReview: skipRequested
      ? "waived"
      : codeReviewRequired
        ? "required"
        : "not-required",
    codeReviewReason: skipRequested
      ? options.skipReviewReason!.trim()
      : codeReviewRequired
        ? "complex or explicitly requested"
        : "within single-pass threshold",
    codeReviewRound: 0,
    codeReviewers: [],
    ci: null,
    delivery: null,
    circuitBroken: null,
    nodes: buildInitialNodes({
      preset: options.preset,
      isComplex,
      planReviewRequired,
      codeReviewRequired,
      coordinatorAgentId: options.coordinatorAgentId,
      coordinatorServerId: options.coordinatorServerId,
      goal: options.goal,
      now,
    }),
    lifecycleStatus: "active",
    createdAt: now,
    updatedAt: now,
  };

  const recordPath = path.join(taskDir, "task.json");
  writeJsonAtomic(recordPath, record);
  return { recordPath, taskDir, record };
}

function asNonEmptyString(val: unknown): string | null {
  return typeof val === "string" && val.trim() ? val.trim() : null;
}

function normalizeReviewPolicy(
  val: unknown,
): "required" | "not-required" | "waived" {
  if (val === "required" || val === true) return "required";
  if (val === "waived") return "waived";
  return "not-required";
}

function normalizeVerdict(val: unknown): ReviewVerdict | undefined {
  if (val === "APPROVE" || val === "approved" || val === "PASS") {
    return "APPROVE";
  }
  if (val === "REQUEST_CHANGES" || val === "changes_requested") {
    return "REQUEST_CHANGES";
  }
  if (val === "BLOCKED" || val === "blocked") {
    return "BLOCKED";
  }
  return undefined;
}

function normalizeLifecycleStatus(
  raw: Record<string, unknown>,
): TaskRecord["lifecycleStatus"] {
  const s =
    asNonEmptyString(raw.lifecycleStatus) ?? asNonEmptyString(raw.status);
  if (raw.merged === true || (raw.merged && typeof raw.merged === "object")) {
    return "completed";
  }
  if (s) {
    const low = s.toLowerCase();
    if (
      low === "merged" ||
      low.startsWith("merged-") ||
      low === "deployed" ||
      low === "done" ||
      low === "completed"
    ) {
      return "completed";
    }
    if (low === "paused") return "paused";
    if (low === "abandoned" || low === "cancelled" || low === "canceled") {
      return "abandoned";
    }
    if (low === "blocked") return "blocked";
  }
  return "active";
}

function normalizeLegacyReviewers(
  rawList: unknown,
  fallbackNow: string,
): ReviewerRecordEntry[] {
  if (!Array.isArray(rawList)) return [];
  const out: ReviewerRecordEntry[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const agentId = asNonEmptyString(r.agentId);
    if (!agentId) continue;
    const verdict = normalizeVerdict(r.status) ?? "BLOCKED";
    const summary = asNonEmptyString(r.summary) ?? "";
    const findings = [
      ...toStringList(r.findings),
      ...toStringList(r.advice, "advice: "),
    ];
    out.push({
      agentId,
      profile: asNonEmptyString(r.profile) ?? "Reviewer",
      commit: asNonEmptyString(r.commit) ?? "unknown",
      round: typeof r.round === "number" && r.round >= 1 ? r.round : 1,
      status: verdict,
      summary,
      ...(findings.length > 0 ? { findings } : {}),
      sidecar: asNonEmptyString(r.sidecar) ?? "",
      ...(r.source === "self" || r.source === "coordinator"
        ? { source: r.source }
        : {}),
      updatedAt: asNonEmptyString(r.updatedAt) ?? fallbackNow,
    });
  }
  return out;
}

function synthesizeNodesFromLegacy(
  raw: Record<string, unknown>,
  preset: TeamPreset,
  planReview: TaskRecord["planReview"],
  codeReview: TaskRecord["codeReview"],
  planReviewers: ReviewerRecordEntry[],
  codeReviewers: ReviewerRecordEntry[],
  lifecycleStatus: TaskRecord["lifecycleStatus"],
  candidate: string | null,
  fallbackNow: string,
): TaskAgentNode[] {
  const isFinished = lifecycleStatus === "completed";
  const nodes = buildInitialNodes({
    preset,
    isComplex: Boolean(raw.isComplex) || planReview === "required",
    planReviewRequired: planReview === "required",
    codeReviewRequired: codeReview === "required" || codeReviewers.length > 0,
    coordinatorAgentId: asNonEmptyString(raw.coordinatorAgentId) ?? undefined,
    goal: asNonEmptyString(raw.goal) ?? "",
    now: fallbackNow,
  });

  if (isFinished) {
    const coord = nodes.find((n) => n.nodeId === "coordinator");
    if (coord) coord.status = "completed";
    const gate = nodes.find((n) => n.nodeId === "merge-gate");
    if (gate) {
      gate.status = "approved";
      gate.summary = "Completed";
    }
  }

  const rawAgents = Array.isArray(raw.agents) ? raw.agents : [];
  let planIdx = 0;
  let codeIdx = 0;
  for (const entry of rawAgents) {
    if (!entry || typeof entry !== "object") continue;
    const a = entry as Record<string, unknown>;
    const agentId = asNonEmptyString(a.agentId);
    const roleRaw = (asNonEmptyString(a.role) ?? "").toLowerCase();
    const profile = asNonEmptyString(a.profile) ?? "Agent";
    const serverId = asNonEmptyString(a.serverId) ?? undefined;
    if (!agentId) continue;

    if (roleRaw === "coordinator" || roleRaw === "lead") {
      const coord = nodes.find((n) => n.nodeId === "coordinator");
      if (coord) {
        coord.agentId = agentId;
        coord.profile = profile;
        if (serverId) coord.serverId = serverId;
      }
    } else if (roleRaw === "expert" || roleRaw === "architect") {
      const exp = nodes.find((n) => n.role === "expert");
      if (exp) {
        exp.agentId = agentId;
        exp.profile = profile;
        exp.status = "completed";
        if (serverId) exp.serverId = serverId;
      }
    } else if (roleRaw === "developer" || roleRaw === "dev") {
      const dev = nodes.find((n) => n.role === "developer");
      if (dev) {
        dev.agentId = agentId;
        dev.profile = profile;
        dev.status = isFinished || candidate ? "completed" : "running";
        if (serverId) dev.serverId = serverId;
      }
    } else if (roleRaw.includes("plan")) {
      const planNodes = nodes.filter((n) => n.role === "plan-reviewer");
      const target = planNodes[planIdx];
      planIdx += 1;
      if (target) {
        target.agentId = agentId;
        target.profile = profile;
        target.status = isFinished ? "approved" : "completed";
        if (serverId) target.serverId = serverId;
      }
    } else if (roleRaw.includes("review") || roleRaw === "qa") {
      const codeNodes = nodes.filter((n) => n.role === "code-reviewer");
      const target = codeNodes[codeIdx];
      codeIdx += 1;
      if (target) {
        target.agentId = agentId;
        target.profile = profile;
        target.status = isFinished ? "approved" : "completed";
        if (serverId) target.serverId = serverId;
      } else {
        const gateIdx = nodes.findIndex((n) => n.nodeId === "merge-gate");
        const extra: TaskAgentNode = {
          nodeId: `code-reviewer-${codeIdx - 1}`,
          stage: "code-review",
          role: "code-reviewer",
          slotIndex: codeIdx - 1,
          label: `Code Reviewer #${codeIdx}`,
          profile,
          agentId,
          ...(serverId ? { serverId } : {}),
          briefSummary: "Independent code review",
          status: isFinished ? "approved" : "completed",
          updatedAt: fallbackNow,
        };
        if (gateIdx >= 0) nodes.splice(gateIdx, 0, extra);
        else nodes.push(extra);
      }
    }
  }

  codeReviewers.forEach((cr, idx) => {
    let node = nodes.find((n) => n.agentId === cr.agentId);
    if (!node) {
      node = nodes.filter((n) => n.role === "code-reviewer")[idx];
    }
    if (node) {
      node.agentId = cr.agentId;
      if (cr.profile && cr.profile !== "Reviewer") node.profile = cr.profile;
      node.round = cr.round;
      node.verdict = cr.status;
      node.summary = cr.summary;
      node.status =
        cr.status === "APPROVE"
          ? "approved"
          : cr.status === "REQUEST_CHANGES"
            ? "changes_requested"
            : "blocked";
    }
  });

  planReviewers.forEach((pr, idx) => {
    let node = nodes.find((n) => n.agentId === pr.agentId);
    if (!node) {
      node = nodes.filter((n) => n.role === "plan-reviewer")[idx];
    }
    if (node) {
      node.agentId = pr.agentId;
      if (pr.profile && pr.profile !== "Reviewer") node.profile = pr.profile;
      node.round = pr.round;
      node.verdict = pr.status;
      node.summary = pr.summary;
      node.status =
        pr.status === "APPROVE"
          ? "approved"
          : pr.status === "REQUEST_CHANGES"
            ? "changes_requested"
            : "blocked";
    }
  });

  const devNode = nodes.find((n) => n.role === "developer");
  if (devNode && (candidate || isFinished) && devNode.status === "pending") {
    devNode.status = "completed";
  }

  return nodes;
}

function normalizeLoadedTaskRecord(
  rawObj: Record<string, unknown>,
  resolvedPath: string,
  mtimeIso: string,
): TaskRecord {
  const taskId =
    asNonEmptyString(rawObj.taskId) ??
    asNonEmptyString(rawObj.task_id) ??
    path.basename(path.dirname(resolvedPath));

  const rawRoot =
    asNonEmptyString(rawObj.projectRoot) ??
    asNonEmptyString(rawObj.project) ??
    asNonEmptyString(rawObj.repo) ??
    asNonEmptyString(rawObj.cwd);
  const projectRoot = rawRoot
    ? existsSync(rawRoot)
      ? resolveWorkspaceDirectory(rawRoot)
      : path.resolve(rawRoot)
    : path.dirname(path.dirname(resolvedPath));
  const projectSlug =
    asNonEmptyString(rawObj.projectSlug) ??
    path.basename(path.dirname(path.dirname(resolvedPath)));

  const candidate = asNonEmptyString(rawObj.candidate) ?? null;
  const goal =
    asNonEmptyString(rawObj.goal) ??
    asNonEmptyString(rawObj.request) ??
    asNonEmptyString(rawObj.target) ??
    asNonEmptyString(rawObj.userInstruction) ??
    taskId;

  const complexMode: ComplexMode =
    rawObj.complexMode === "simple" || rawObj.complexMode === "deep"
      ? "simple"
      : "expert";
  const teamName =
    asNonEmptyString(rawObj.teamName) ??
    (typeof rawObj.team === "string" && rawObj.team.trim()
      ? rawObj.team.trim()
      : "Standard");

  const rawTeamObj =
    rawObj.team &&
    typeof rawObj.team === "object" &&
    !Array.isArray(rawObj.team)
      ? (rawObj.team as Record<string, unknown>)
      : rawObj.members &&
          typeof rawObj.members === "object" &&
          !Array.isArray(rawObj.members)
        ? (rawObj.members as Record<string, unknown>)
        : null;

  const team: TeamPreset = {
    developer: normalizeRoleSpec(rawTeamObj?.developer),
    planReviewers: Array.isArray(rawTeamObj?.planReviewers)
      ? rawTeamObj!.planReviewers.map((x) => normalizeRoleSpec(x))
      : [{ model: "auto" }],
    codeReviewers: Array.isArray(rawTeamObj?.codeReviewers)
      ? rawTeamObj!.codeReviewers.map((x) => normalizeRoleSpec(x))
      : [{ model: "auto" }],
    ...(rawTeamObj?.expert !== undefined
      ? { expert: normalizeRoleSpec(rawTeamObj.expert) }
      : {}),
    complexMode,
  };

  const createdAt = asNonEmptyString(rawObj.createdAt) ?? mtimeIso;
  const updatedAt = asNonEmptyString(rawObj.updatedAt) ?? mtimeIso;
  const lifecycleStatus = normalizeLifecycleStatus(rawObj);
  const planReviewers = normalizeLegacyReviewers(
    rawObj.planReviewers,
    updatedAt,
  );
  const codeReviewers = normalizeLegacyReviewers(
    rawObj.codeReviewers,
    updatedAt,
  );
  const planReview = normalizeReviewPolicy(rawObj.planReview);
  const codeReview =
    codeReviewers.length > 0 && rawObj.codeReview === undefined
      ? "required"
      : normalizeReviewPolicy(rawObj.codeReview);

  let ci: TaskRecord["ci"] = null;
  if (rawObj.ci && typeof rawObj.ci === "object" && !Array.isArray(rawObj.ci)) {
    const ciObj = rawObj.ci as Record<string, unknown>;
    const log = asNonEmptyString(ciObj.log);
    const waived = asNonEmptyString(ciObj.waived);
    if (log || waived) {
      ci = { ...(log ? { log } : {}), ...(waived ? { waived } : {}) };
    }
  }

  const nodes: TaskAgentNode[] =
    Array.isArray(rawObj.nodes) && rawObj.nodes.length > 0
      ? (rawObj.nodes as TaskAgentNode[])
      : synthesizeNodesFromLegacy(
          rawObj,
          team,
          planReview,
          codeReview,
          planReviewers,
          codeReviewers,
          lifecycleStatus,
          candidate,
          updatedAt,
        );

  const coordinatorFromNode = nodes.find(
    (n) => n.role === "coordinator",
  )?.agentId;
  const coordinatorAgentId =
    asNonEmptyString(rawObj.coordinatorAgentId) ?? coordinatorFromNode;

  return {
    schemaVersion: 2,
    taskId,
    projectRoot,
    projectSlug,
    candidate,
    goal,
    isComplex: Boolean(rawObj.isComplex),
    teamName,
    complexMode,
    team,
    ...(coordinatorAgentId ? { coordinatorAgentId } : {}),
    ...(asNonEmptyString(rawObj.launcherAgentId)
      ? { launcherAgentId: asNonEmptyString(rawObj.launcherAgentId)! }
      : {}),
    ...(asNonEmptyString(rawObj.coordinatorServerId)
      ? { coordinatorServerId: asNonEmptyString(rawObj.coordinatorServerId)! }
      : {}),
    planReview,
    ...(asNonEmptyString(rawObj.planReviewReason)
      ? { planReviewReason: asNonEmptyString(rawObj.planReviewReason)! }
      : {}),
    planReviewRound:
      typeof rawObj.planReviewRound === "number" ? rawObj.planReviewRound : 0,
    planVersion: asNonEmptyString(rawObj.planVersion) ?? "v1",
    planReviewers,
    codeReview,
    ...(asNonEmptyString(rawObj.codeReviewReason)
      ? { codeReviewReason: asNonEmptyString(rawObj.codeReviewReason)! }
      : {}),
    codeReviewRound:
      typeof rawObj.codeReviewRound === "number"
        ? rawObj.codeReviewRound
        : codeReviewers.reduce((m, r) => Math.max(m, r.round), 0),
    codeReviewers,
    ci,
    delivery:
      rawObj.delivery &&
      typeof rawObj.delivery === "object" &&
      !Array.isArray(rawObj.delivery) &&
      typeof (rawObj.delivery as Record<string, unknown>).architectureImpact ===
        "string" &&
      typeof (rawObj.delivery as Record<string, unknown>).candidate === "string"
        ? (rawObj.delivery as TaskDeliveryInfo)
        : null,
    ...(Array.isArray(rawObj.deliveries)
      ? {
          deliveries: rawObj.deliveries.filter(
            (d): d is TaskDeliveryRoundEntry =>
              Boolean(
                d &&
                typeof d === "object" &&
                typeof (d as Record<string, unknown>).round === "number" &&
                typeof (d as Record<string, unknown>).summary === "string",
              ),
          ),
        }
      : {}),
    circuitBroken:
      rawObj.circuitBroken &&
      typeof rawObj.circuitBroken === "object" &&
      !Array.isArray(rawObj.circuitBroken)
        ? (rawObj.circuitBroken as CircuitBreakerInfo)
        : null,
    ...(typeof rawObj.extraRounds === "number" && rawObj.extraRounds > 0
      ? { extraRounds: rawObj.extraRounds }
      : {}),
    ...(typeof rawObj.planSubmissions === "number" && rawObj.planSubmissions > 0
      ? { planSubmissions: rawObj.planSubmissions }
      : {}),
    nodes,
    lifecycleStatus,
    ...((asNonEmptyString(rawObj.completedAt) ??
    asNonEmptyString(rawObj.mergedAt))
      ? {
          completedAt: (asNonEmptyString(rawObj.completedAt) ??
            asNonEmptyString(rawObj.mergedAt))!,
        }
      : {}),
    createdAt,
    updatedAt,
  };
}

export function loadTask(recordPath: string): TaskRecord {
  const resolved = path.resolve(recordPath);
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink()) {
    throw new Error("Refusing to read symlinked task file.");
  }
  const parsed: unknown = JSON.parse(readFileSync(resolved, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid task.json.");
  }
  return normalizeLoadedTaskRecord(
    parsed as Record<string, unknown>,
    resolved,
    stat.mtime.toISOString(),
  );
}

export function saveTask(recordPath: string, record: TaskRecord): TaskRecord {
  record.updatedAt = new Date().toISOString();
  writeJsonAtomic(recordPath, record);
  return record;
}

export function listTasksForProject(
  cwdOrProjectRoot: string,
  stateRoot = defaultStateRoot(),
): { recordPath: string; record: TaskRecord }[] {
  if (!existsSync(stateRoot)) return [];
  const projectRoot = resolveWorkspaceDirectory(cwdOrProjectRoot);
  const out: { recordPath: string; record: TaskRecord }[] = [];
  for (const projEntry of readdirSync(stateRoot, { withFileTypes: true })) {
    if (!projEntry.isDirectory()) continue;
    const projDir = path.join(stateRoot, projEntry.name);
    for (const taskEntry of readdirSync(projDir, { withFileTypes: true })) {
      if (!taskEntry.isDirectory()) continue;
      const recordPath = path.join(projDir, taskEntry.name, "task.json");
      if (!existsSync(recordPath)) continue;
      try {
        const record = loadTask(recordPath);
        if (record.projectRoot === projectRoot) {
          out.push({ recordPath, record });
        }
      } catch {
        // Ignore malformed historical folders
      }
    }
  }
  out.sort((a, b) => b.record.updatedAt.localeCompare(a.record.updatedAt));
  return out;
}

export function listAllRecentTasks(
  stateRoot = defaultStateRoot(),
  limit = 40,
): { recordPath: string; record: TaskRecord }[] {
  if (!existsSync(stateRoot)) return [];
  const out: { recordPath: string; record: TaskRecord }[] = [];
  for (const projEntry of readdirSync(stateRoot, { withFileTypes: true })) {
    if (!projEntry.isDirectory()) continue;
    const projDir = path.join(stateRoot, projEntry.name);
    for (const taskEntry of readdirSync(projDir, { withFileTypes: true })) {
      if (!taskEntry.isDirectory()) continue;
      const recordPath = path.join(projDir, taskEntry.name, "task.json");
      if (!existsSync(recordPath)) continue;
      try {
        out.push({ recordPath, record: loadTask(recordPath) });
      } catch {
        // Ignore
      }
    }
  }
  out.sort((a, b) => b.record.updatedAt.localeCompare(a.record.updatedAt));
  return out.slice(0, limit);
}

/** Task subtrees started from one chat, newest first. */
export function listTasksByLauncher(
  launcherAgentId: string,
  stateRoot = defaultStateRoot(),
): { recordPath: string; record: TaskRecord }[] {
  return listAllRecentTasks(stateRoot, 100)
    .filter((item) => item.record.launcherAgentId === launcherAgentId)
    .sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt));
}

export function findTaskByAgentId(
  agentId: string,
  stateRoot = defaultStateRoot(),
): { recordPath: string; record: TaskRecord; matchedRole: AgentRole } | null {
  for (const item of listAllRecentTasks(stateRoot, 100)) {
    if (item.record.coordinatorAgentId === agentId) {
      return { ...item, matchedRole: "coordinator" };
    }
    const nodes = Array.isArray(item.record.nodes) ? item.record.nodes : [];
    const node = nodes.find((n) => n?.agentId === agentId);
    if (node) {
      return { ...item, matchedRole: node.role };
    }
  }
  return null;
}

export function registerTaskAgent(
  recordPath: string,
  input: {
    role: Exclude<AgentRole, "coordinator" | "gate">;
    slotIndex?: number;
    agentId: string;
    serverId?: string;
    profile: string;
    provider?: string;
    model?: string;
    thinkingOptionId?: string;
    briefSummary: string;
    round?: number;
  },
): TaskRecord {
  const record = loadTask(recordPath);
  const now = new Date().toISOString();
  const stage: PipelineStageId =
    input.role === "expert"
      ? "expert"
      : input.role === "plan-reviewer"
        ? "plan-review"
        : input.role === "developer"
          ? "development"
          : "code-review";

  if (stage === "plan-review" && record.planReview !== "required") {
    record.planReview = "required";
  }
  if (stage === "code-review" && record.codeReview !== "required") {
    record.codeReview = "required";
    record.codeReviewReason = "triggered by coordinator dispatch";
  }

  const existingByAgent = record.nodes.find(
    (n) => n.agentId && n.agentId === input.agentId,
  );
  const sameRoleNodes = record.nodes.filter((n) => n.role === input.role);
  const unassigned =
    input.slotIndex === undefined
      ? sameRoleNodes.find((n) => !n.agentId)
      : sameRoleNodes.find(
          (n) => n.slotIndex === input.slotIndex && !n.agentId,
        );

  const slotIndex =
    existingByAgent?.slotIndex ??
    input.slotIndex ??
    unassigned?.slotIndex ??
    Math.max(-1, ...sameRoleNodes.map((n) => n.slotIndex)) + 1;

  const nodeId =
    input.role === "expert"
      ? "expert"
      : input.role === "developer" && slotIndex === 0
        ? "developer"
        : `${input.role}-${slotIndex}`;

  let node =
    existingByAgent ??
    unassigned ??
    record.nodes.find((n) => n.nodeId === nodeId && !n.agentId);

  if (!node) {
    const totalSameRole = sameRoleNodes.length + 1;
    node = {
      nodeId,
      stage,
      role: input.role,
      slotIndex,
      label:
        input.role === "plan-reviewer"
          ? `Plan Reviewer #${slotIndex + 1}`
          : input.role === "code-reviewer"
            ? `Code Reviewer #${slotIndex + 1}`
            : input.role === "expert"
              ? "Expert"
              : `Developer #${slotIndex + 1}`,
      profile: input.profile,
      ...(input.role === "plan-reviewer" || input.role === "code-reviewer"
        ? { perspective: assignReviewerPerspective(slotIndex, totalSameRole) }
        : {}),
      briefSummary: input.briefSummary,
      status: "running",
      updatedAt: now,
    };
    const lastSameIdx = record.nodes.findLastIndex(
      (n) => n.role === input.role,
    );
    if (lastSameIdx >= 0) {
      record.nodes.splice(lastSameIdx + 1, 0, node);
    } else {
      const gateIdx = record.nodes.findIndex((n) => n.nodeId === "merge-gate");
      if (gateIdx >= 0) {
        record.nodes.splice(gateIdx, 0, node);
      } else {
        record.nodes.push(node);
      }
    }
  } else {
    if (input.profile && (input.profile !== "auto" || !node.profile)) {
      node.profile = input.profile;
    }
    if (input.briefSummary) {
      node.briefSummary = input.briefSummary;
    }
    if (node.status === "pending" || node.status === "skipped") {
      node.status = "running";
    }
    node.updatedAt = now;
  }

  node.agentId = input.agentId;
  if (input.serverId) node.serverId = input.serverId;
  if (input.provider) node.provider = input.provider;
  if (input.model) node.model = input.model;
  if (input.thinkingOptionId) node.thinkingOptionId = input.thinkingOptionId;
  if (input.round !== undefined) node.round = input.round;
  node.startedAt = node.startedAt ?? now;

  if (input.role === "developer") {
    const devs = record.nodes.filter((n) => n.role === "developer");
    if (devs.length > 1) {
      for (const d of devs) {
        d.label = `Developer #${d.slotIndex + 1}`;
      }
    }
  }

  return saveTask(recordPath, record);
}

export function recordReviewVerdict(
  recordPath: string,
  input: {
    stage: "plan" | "code";
    agentId: string;
    profile?: string;
    targetVersionOrCommit?: string;
    round: number;
    verdict: ReviewVerdict;
    summary: string;
    findings?: string[];
    source?: "self" | "coordinator";
    userAuthorizedExtraRound?: string;
  },
): {
  status: "RECORDED" | "CIRCUIT_BROKEN";
  round: number;
  maxRounds: number;
  sidecar?: string;
  message: string;
  record: TaskRecord;
} {
  const record = loadTask(recordPath);
  const now = new Date().toISOString();

  if (input.userAuthorizedExtraRound?.trim()) {
    record.extraRounds = Math.max(record.extraRounds ?? 0, input.round - 2);
    record.circuitBroken = null;
    if (record.lifecycleStatus === "blocked") {
      record.lifecycleStatus = "active";
    }
  }
  const maxRounds = 2 + (record.extraRounds ?? 0);

  // Code reviews are tagged with the delivery they reviewed; informational only.
  const targetRef =
    input.stage === "plan"
      ? input.targetVersionOrCommit?.trim() || record.planVersion
      : input.targetVersionOrCommit?.trim() || record.candidate || "workspace";

  const taskDir = path.dirname(path.resolve(recordPath));
  const safeAgent = input.agentId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
  const safeTarget = targetRef.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 16);
  const base = `${input.stage}-${safeAgent}-${safeTarget}-r${input.round}`;
  let sidecarName = `${base}.json`;
  for (let n = 2; existsSync(path.join(taskDir, "reviews", sidecarName)); n++) {
    sidecarName = `${base}-${n}.json`;
  }
  const sidecarPath = path.join(taskDir, "reviews", sidecarName);

  writeJsonAtomic(sidecarPath, {
    stage: input.stage,
    agentId: input.agentId,
    profile: input.profile ?? "unknown",
    commit: targetRef,
    round: input.round,
    status: input.verdict,
    summary: input.summary,
    ...(input.findings?.length ? { findings: input.findings } : {}),
    recordedAt: now,
  });

  const list =
    input.stage === "plan" ? record.planReviewers : record.codeReviewers;

  const existingIdx = list.findIndex((r) => r.agentId === input.agentId);
  const entry: ReviewerRecordEntry = {
    agentId: input.agentId,
    profile:
      input.profile ??
      record.nodes.find((n) => n.agentId === input.agentId)?.profile ??
      "unknown",
    commit: targetRef,
    round: input.round,
    status: input.verdict,
    summary: input.summary,
    ...(input.findings?.length ? { findings: input.findings } : {}),
    sidecar: sidecarName,
    ...(input.source ? { source: input.source } : {}),
    updatedAt: now,
  };
  if (existingIdx >= 0) {
    list[existingIdx] = entry;
  } else {
    list.push(entry);
  }

  if (input.stage === "plan") {
    record.planReview = "required";
    record.planReviewRound = Math.max(record.planReviewRound, input.round);
    record.planVersion = targetRef;
  } else {
    record.codeReview = "required";
    record.codeReviewRound = Math.max(record.codeReviewRound, input.round);
  }

  const node = record.nodes.find((n) => n.agentId === input.agentId);
  if (node) {
    node.round = input.round;
    node.verdict = input.verdict;
    node.summary = input.summary;
    node.submittedAt = now;
    node.reminded = false;
    node.status =
      input.verdict === "APPROVE"
        ? "approved"
        : input.verdict === "REQUEST_CHANGES"
          ? "changes_requested"
          : "blocked";
    node.updatedAt = now;
  }

  // Soft breaker: the verdict is always recorded; the flag only asks for a user decision.
  const overLimit =
    input.round > maxRounds ||
    (input.round === maxRounds && input.verdict !== "APPROVE");
  if (overLimit) {
    const reason = `Round ${input.round}/${maxRounds} ${input.stage} review ended with ${input.verdict}. Verdict recorded; stop patching and present trade-off options to the user.`;
    record.circuitBroken = {
      stage: input.stage,
      round: input.round,
      reason,
      triggeredAt: now,
    };
    record.lifecycleStatus = "blocked";
  }

  const saved = saveTask(recordPath, record);

  if (overLimit) {
    return {
      status: "CIRCUIT_BROKEN",
      round: input.round,
      maxRounds,
      sidecar: sidecarName,
      message: saved.circuitBroken!.reason,
      record: saved,
    };
  }

  return {
    status: "RECORDED",
    round: input.round,
    maxRounds,
    sidecar: sidecarName,
    message: `Recorded ${input.stage} review: ${input.verdict} (round ${input.round}/${maxRounds}).`,
    record: saved,
  };
}

// Newest check log in the task directory, matching what the quality gate verifies.
function findLatestCiLog(taskDir: string): string | undefined {
  if (!existsSync(taskDir)) return undefined;
  let bestName: string | undefined;
  let bestMtime = -1;
  for (const name of readdirSync(taskDir)) {
    if (!name.endsWith(".log.json")) continue;
    try {
      const st = lstatSync(path.join(taskDir, name));
      if (st.isFile() && st.mtimeMs >= bestMtime) {
        bestMtime = st.mtimeMs;
        bestName = name.slice(0, -".json".length);
      }
    } catch {
      // Ignore unreadable sidecar
    }
  }
  return bestName;
}

/** Round of the next delivery: a delivery after code review N starts round N + 1. */
export function nextDeliveryRound(record: TaskRecord): number {
  const hadPriorDelivery = Boolean(
    record.delivery || (record.deliveries && record.deliveries.length > 0),
  );
  return hadPriorDelivery ? Math.max(1, record.codeReviewRound + 1) : 1;
}

/** Round a new review belongs to, derived from deliveries or plan submissions. */
export function nextReviewRound(
  record: TaskRecord,
  stage: "plan" | "code",
  agentId?: string,
): number {
  // A new plan version or delivery opens its round...
  const base =
    stage === "plan"
      ? Math.max(1, record.planSubmissions ?? 0)
      : Math.max(1, ...(record.deliveries ?? []).map((d) => d.round));
  const current =
    stage === "plan" ? record.planReviewRound : record.codeReviewRound;
  if (current < base) return base;
  // ...and a reviewer asked to look again at the same target counts as the next
  // round, so rulings cannot bypass the round limit.
  const list = stage === "plan" ? record.planReviewers : record.codeReviewers;
  const again = list.some((r) => r.agentId === agentId && r.round === current);
  return again ? current + 1 : current;
}

export function recordPlanSubmission(
  recordPath: string,
  input: { agentId?: string; planFile: string; summary: string },
): TaskRecord {
  const record = loadTask(recordPath);
  const taskDir = path.dirname(path.resolve(recordPath));
  const file = path.resolve(taskDir, input.planFile.trim());
  if (path.dirname(file) !== taskDir) {
    throw new Error(
      "The plan file must be directly in the task evidence directory.",
    );
  }
  const st = existsSync(file) ? lstatSync(file) : null;
  if (!st?.isFile() || st.size === 0) {
    throw new Error(
      `Plan file ${path.basename(file)} is missing or empty; write it first.`,
    );
  }
  const now = new Date().toISOString();
  const n = (record.planSubmissions ?? 0) + 1;
  record.planSubmissions = n;
  record.planVersion = `v${n}`;
  const node = input.agentId
    ? record.nodes.find((x) => x.agentId === input.agentId)
    : undefined;
  if (node) {
    node.status = "completed";
    node.summary = input.summary.trim();
    node.submittedAt = now;
    node.reminded = false;
    node.updatedAt = now;
  }
  return saveTask(recordPath, record);
}

/** turn.before: remember when this agent's turn started. */
export function markTurnStarted(recordPath: string, agentId: string): void {
  const record = loadTask(recordPath);
  const node = record.nodes.find((n) => n.agentId === agentId);
  if (!node) return;
  node.turnStartedAt = new Date().toISOString();
  saveTask(recordPath, record);
}

/**
 * turn.after: did this turn end with the role's submit tool? Returns "remind"
 * once, then "missing" (node flagged in the graph) so reminders never loop.
 */
export function checkTurnHandoff(
  recordPath: string,
  agentId: string,
): "ok" | "remind" | "missing" {
  const record = loadTask(recordPath);
  const node = record.nodes.find((n) => n.agentId === agentId);
  if (
    !node ||
    !["developer", "expert", "plan-reviewer", "code-reviewer"].includes(
      node.role,
    )
  ) {
    return "ok";
  }
  if (node.submittedAt && node.submittedAt >= (node.turnStartedAt ?? "")) {
    return "ok";
  }
  const now = new Date().toISOString();
  if (!node.reminded) {
    node.reminded = true;
    saveTask(recordPath, record);
    return "remind";
  }
  node.reminded = false;
  node.status = "blocked";
  node.summary = "Turn ended without the required submit tool call";
  node.updatedAt = now;
  saveTask(recordPath, record);
  return "missing";
}

export function recordCandidateDelivery(
  recordPath: string,
  input: {
    agentId?: string;
    candidate?: string;
    ciLog?: string;
    ciWaivedUserQuote?: string;
    summary: string;
    architectureImpact: string;
    requireCodeReview?: boolean;
    codeReviewReason?: string;
  },
): TaskRecord {
  const record = loadTask(recordPath);
  const now = new Date().toISOString();
  const taskDir = path.dirname(path.resolve(recordPath));

  const deliveryRound = nextDeliveryRound(record);

  // A readable delivery label, not a content hash.
  const candidate = input.candidate?.trim() || `delivery-r${deliveryRound}`;
  record.candidate = candidate;

  let resolvedCiLog: string | undefined;
  if (input.ciWaivedUserQuote?.trim()) {
    record.ci = { waived: input.ciWaivedUserQuote.trim() };
  } else if (input.ciLog?.trim()) {
    resolvedCiLog = path.basename(input.ciLog.trim());
    record.ci = { log: resolvedCiLog };
  } else if (!record.ci?.waived) {
    const autoLog = findLatestCiLog(taskDir);
    if (autoLog) {
      resolvedCiLog = autoLog;
      record.ci = { log: autoLog };
    }
  }

  record.delivery = {
    candidate,
    summary: input.summary.trim(),
    architectureImpact: input.architectureImpact.trim(),
    deliveredAt: now,
  };

  const deliveries = Array.isArray(record.deliveries)
    ? [...record.deliveries]
    : [];
  const existingRoundIdx = deliveries.findIndex(
    (d) =>
      d.round === deliveryRound &&
      (d.agentId ?? "") === (input.agentId?.trim() ?? ""),
  );
  const roundEntry: TaskDeliveryRoundEntry = {
    round: deliveryRound,
    ...(input.agentId?.trim() ? { agentId: input.agentId.trim() } : {}),
    candidate,
    ...(resolvedCiLog ? { ciLog: resolvedCiLog } : {}),
    summary: input.summary.trim(),
    architectureImpact: input.architectureImpact.trim(),
    deliveredAt: now,
  };
  if (existingRoundIdx >= 0) {
    deliveries[existingRoundIdx] = roundEntry;
  } else {
    deliveries.push(roundEntry);
  }
  record.deliveries = deliveries;

  // The coordinator decides on review; diff size is only reported back as advice.
  if (input.requireCodeReview && record.codeReview !== "waived") {
    record.codeReview = "required";
    record.codeReviewReason = input.codeReviewReason?.trim() || "requested";
  } else if (
    input.codeReviewReason?.trim() &&
    record.codeReview === "not-required"
  ) {
    record.codeReviewReason = input.codeReviewReason.trim();
  }

  if (input.agentId?.trim()) {
    const devNode = record.nodes.find(
      (n) => n.role === "developer" && n.agentId === input.agentId!.trim(),
    );
    if (devNode) {
      devNode.status = "completed";
      devNode.summary = input.summary.trim();
      devNode.submittedAt = now;
      devNode.reminded = false;
      devNode.updatedAt = now;
    }
  } else {
    for (const devNode of record.nodes.filter((n) => n.role === "developer")) {
      devNode.status = "completed";
      if (!devNode.summary) {
        devNode.summary = input.summary.trim();
      }
      devNode.updatedAt = now;
    }
  }

  if (record.codeReview === "not-required" || record.codeReview === "waived") {
    for (const n of record.nodes) {
      if (n.role === "code-reviewer" && !n.agentId) {
        n.status = "skipped";
        n.briefSummary =
          record.codeReview === "waived"
            ? `Waived: ${record.codeReviewReason ?? ""}`
            : `Not triggered: ${record.codeReviewReason ?? ""}`;
      }
    }
  }

  return saveTask(recordPath, record);
}

export function markTaskCompleted(recordPath: string): TaskRecord {
  const record = loadTask(recordPath);
  const now = new Date().toISOString();
  record.lifecycleStatus = "completed";
  record.completedAt = now;
  record.circuitBroken = null;
  const gateNode = record.nodes.find((n) => n.nodeId === "merge-gate");
  if (gateNode) {
    gateNode.status = "approved";
    gateNode.summary = "All quality gate checks passed";
    gateNode.updatedAt = now;
  }
  const coordNode = record.nodes.find((n) => n.nodeId === "coordinator");
  if (coordNode) {
    coordNode.status = "completed";
    coordNode.summary = "Verification & sign-off completed";
    coordNode.updatedAt = now;
  }
  return saveTask(recordPath, record);
}

export function buildRecoveryBrief(record: TaskRecord): string {
  const lines: string[] = [
    `# Task Recovery Brief [${record.taskId}] (${record.lifecycleStatus})`,
    `- Goal: ${record.goal}`,
    `- Preset/Mode: ${record.teamName} (${record.complexMode}) | Workspace: ${record.projectRoot}`,
    `- Reviews: planReview=${record.planReview}(R${record.planReviewRound}/${2 + (record.extraRounds ?? 0)}) | codeReview=${record.codeReview}(R${record.codeReviewRound}/${2 + (record.extraRounds ?? 0)})`,
  ];
  if (record.circuitBroken) {
    lines.push(`- Circuit Breaker: ${record.circuitBroken.reason}`);
  }
  const activeAgents = record.nodes.filter((n) => n.agentId);
  if (activeAgents.length > 0) {
    lines.push(
      "- Registered Subagents (reuse existing agentIds, never re-create):",
    );
    for (const a of activeAgents) {
      lines.push(
        `  - [${a.label}] model=${a.profile} agentId=${a.agentId} status=${a.status}${a.verdict ? `(${a.verdict})` : ""} — ${a.summary ?? a.briefSummary}`,
      );
    }
  }
  return lines.join("\n");
}
