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
import {
  captureRepoSnapshot,
  computeWorkspaceChangeStats,
  computeWorkspaceFingerprint,
  type RepoSnapshot,
  verifyReadOnlySnapshot,
} from "./quality-gate.ts";

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
  evidencePath?: string;
  startedAt?: string;
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
  const byRound = new Map<number, ReviewRoundView>();
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
      const prev = byRound.get(round);
      if (prev && (prev.recordedAt ?? "") > (recordedAt ?? "")) continue;
      const findings = toStringList(raw.findings);
      byRound.set(round, {
        round,
        verdict,
        summary: asNonEmptyString(raw.summary) ?? "",
        ...(findings.length > 0 ? { findings } : {}),
        ...(recordedAt ? { recordedAt } : {}),
      });
    }
  }
  if (byRound.size === 0 && latest) {
    byRound.set(latest.round, {
      round: latest.round,
      verdict: latest.status,
      summary: latest.summary,
      ...(latest.findings?.length ? { findings: latest.findings } : {}),
      recordedAt: latest.updatedAt,
    });
  }
  return [...byRound.values()].sort((a, b) => a.round - b.round);
}

export interface TaskGateEntry {
  name: string;
  status: "pending" | "passed" | "waived";
  waivedReason?: string;
}

export interface TaskDeliveryInfo {
  candidate: string;
  worktree: string;
  branch?: string;
  summary: string;
  architectureImpact: string;
  performanceStatus: "ok" | "not-applicable" | "regressed" | "waived";
  performanceSummary?: string;
  performanceWaived?: string;
  deliveredAt: string;
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
  targetBranch: string;
  baseCommit: string | null;
  candidate: string | null;
  worktree: string | null;
  branch: string | null;
  goal: string;
  isComplex: boolean;
  teamName: string;
  complexMode: ComplexMode;
  team: TeamPreset;
  coordinatorAgentId?: string;
  coordinatorServerId?: string;
  scopePaths: string[];
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
  gates: TaskGateEntry[];
  circuitBroken: CircuitBreakerInfo | null;
  readOnlySnapshots: Record<string, RepoSnapshot>;
  readOnlyViolations: {
    agentId: string;
    role: string;
    cwd: string;
    detectedAt: string;
  }[];
  nodes: TaskAgentNode[];
  lifecycleStatus: "active" | "merged" | "paused" | "abandoned" | "blocked";
  mergedAt?: string;
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

function detectGitBaseline(projectRoot: string): {
  targetBranch: string;
  baseCommit: string | null;
} {
  const git = (...args: string[]) =>
    spawnSync("git", ["--no-optional-locks", "-C", projectRoot, ...args], {
      encoding: "utf8",
    });
  const branchRes = git("symbolic-ref", "--quiet", "--short", "HEAD");
  const targetBranch =
    branchRes.status === 0 && branchRes.stdout.trim()
      ? branchRes.stdout.trim()
      : "main";
  const headRes = git("rev-parse", "HEAD");
  const baseCommit =
    headRes.status === 0 && headRes.stdout.trim()
      ? headRes.stdout.trim()
      : null;
  return { targetBranch, baseCommit };
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
      ? "核对测试通过、代码审查批准、只读完整性与两轮熔断"
      : "Verifies CI sidecar, review approvals, read-only integrity & breaker",
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

  const baseline = detectGitBaseline(projectRoot);
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
    targetBranch: baseline.targetBranch,
    baseCommit: baseline.baseCommit,
    candidate: null,
    worktree: projectRoot,
    branch: baseline.targetBranch,
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
    scopePaths: [],
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
    gates: [],
    circuitBroken: null,
    readOnlySnapshots: {},
    readOnlyViolations: [],
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
    return "merged";
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
      return "merged";
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
  const isFinished = lifecycleStatus === "merged";
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

  const targetBranch = asNonEmptyString(rawObj.targetBranch) ?? "main";
  const baseCommit =
    asNonEmptyString(rawObj.baseCommit) ??
    asNonEmptyString(rawObj.base) ??
    null;
  const candidate = asNonEmptyString(rawObj.candidate) ?? null;
  const worktree = asNonEmptyString(rawObj.worktree) ?? projectRoot;
  const branch = asNonEmptyString(rawObj.branch) ?? null;
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
    targetBranch,
    baseCommit,
    candidate,
    worktree,
    branch,
    goal,
    isComplex: Boolean(rawObj.isComplex),
    teamName,
    complexMode,
    team,
    ...(coordinatorAgentId ? { coordinatorAgentId } : {}),
    ...(asNonEmptyString(rawObj.coordinatorServerId)
      ? { coordinatorServerId: asNonEmptyString(rawObj.coordinatorServerId)! }
      : {}),
    scopePaths: [],
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
    gates: [],
    circuitBroken:
      rawObj.circuitBroken &&
      typeof rawObj.circuitBroken === "object" &&
      !Array.isArray(rawObj.circuitBroken)
        ? (rawObj.circuitBroken as CircuitBreakerInfo)
        : null,
    readOnlySnapshots:
      rawObj.readOnlySnapshots &&
      typeof rawObj.readOnlySnapshots === "object" &&
      !Array.isArray(rawObj.readOnlySnapshots)
        ? (rawObj.readOnlySnapshots as Record<string, RepoSnapshot>)
        : {},
    readOnlyViolations: Array.isArray(rawObj.readOnlyViolations)
      ? (rawObj.readOnlyViolations as TaskRecord["readOnlyViolations"])
      : [],
    nodes,
    lifecycleStatus,
    ...(asNonEmptyString(rawObj.mergedAt)
      ? { mergedAt: asNonEmptyString(rawObj.mergedAt)! }
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
    captureReadOnlyCwd?: string;
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
  const slotIndex =
    input.slotIndex ??
    existingByAgent?.slotIndex ??
    record.nodes.filter((n) => n.role === input.role && Boolean(n.agentId))
      .length;
  const nodeId =
    input.role === "expert" || input.role === "developer"
      ? input.role
      : `${input.role}-${slotIndex}`;

  let node = existingByAgent ?? record.nodes.find((n) => n.nodeId === nodeId);
  if (!node) {
    const totalSameRole =
      record.nodes.filter((n) => n.role === input.role).length + 1;
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
              : "Developer",
      profile: input.profile,
      ...(input.role === "plan-reviewer" || input.role === "code-reviewer"
        ? { perspective: assignReviewerPerspective(slotIndex, totalSameRole) }
        : {}),
      briefSummary: input.briefSummary,
      status: "running",
      updatedAt: now,
    };
    const gateIdx = record.nodes.findIndex((n) => n.nodeId === "merge-gate");
    if (gateIdx >= 0) {
      record.nodes.splice(gateIdx, 0, node);
    } else {
      record.nodes.push(node);
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

  const targetRoDir = input.captureReadOnlyCwd ?? record.projectRoot;
  if (
    targetRoDir &&
    (input.role === "expert" ||
      input.role === "plan-reviewer" ||
      input.role === "code-reviewer")
  ) {
    try {
      record.readOnlySnapshots[input.agentId] =
        captureRepoSnapshot(targetRoDir);
    } catch {
      // Ignore non-git directory
    }
  }

  return saveTask(recordPath, record);
}

export function checkAgentReadOnlyIntegrity(
  recordPath: string,
  agentId: string,
  cwd?: string,
): { ok: boolean; violated: boolean; record: TaskRecord } {
  const record = loadTask(recordPath);
  const snapshot = record.readOnlySnapshots[agentId];
  if (!snapshot) {
    return { ok: true, violated: false, record };
  }
  const targetDir = snapshot.root || cwd;
  if (!targetDir) {
    return { ok: true, violated: false, record };
  }
  const check = verifyReadOnlySnapshot(targetDir, snapshot);
  if (!check.ok) {
    const node = record.nodes.find((n) => n.agentId === agentId);
    const alreadyRecorded = record.readOnlyViolations.some(
      (v) => v.agentId === agentId,
    );
    if (!alreadyRecorded) {
      record.readOnlyViolations.push({
        agentId,
        role: node?.role ?? "unknown",
        cwd: targetDir,
        detectedAt: new Date().toISOString(),
      });
    }
    if (node) {
      node.status = "blocked";
      node.summary =
        "Read-only role modified workspace files — halted by Quality Gate";
      node.updatedAt = new Date().toISOString();
    }
    saveTask(recordPath, record);
    return { ok: false, violated: true, record };
  }
  return { ok: true, violated: false, record };
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
    rawOutput?: string;
    substantialChange?: boolean;
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
  const maxRounds = 2;
  const now = new Date().toISOString();

  if (
    (record.circuitBroken?.stage === input.stage || input.round > maxRounds) &&
    !input.userAuthorizedExtraRound?.trim()
  ) {
    const reason = `Round ${input.round} exceeds the ${maxRounds}-round circuit breaker. Stop patching and escalate trade-off options to the user.`;
    record.circuitBroken = {
      stage: input.stage,
      round: input.round,
      reason,
      triggeredAt: now,
    };
    record.lifecycleStatus = "blocked";
    saveTask(recordPath, record);
    return {
      status: "CIRCUIT_BROKEN",
      round: input.round,
      maxRounds,
      message: reason,
      record,
    };
  }

  if (input.userAuthorizedExtraRound?.trim()) {
    record.circuitBroken = null;
    if (record.lifecycleStatus === "blocked") {
      record.lifecycleStatus = "active";
    }
  }

  const targetRef =
    input.targetVersionOrCommit?.trim() ||
    (input.stage === "plan"
      ? record.planVersion
      : record.candidate || computeWorkspaceFingerprint(record.projectRoot));

  const taskDir = path.dirname(path.resolve(recordPath));
  const safeAgent = input.agentId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
  const safeTarget = targetRef.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 16);
  const sidecarName = `${input.stage}-${safeAgent}-${safeTarget}-r${input.round}.json`;
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
    rawOutputSha256: createHash("sha256")
      .update(input.rawOutput ?? input.summary)
      .digest("hex"),
    recordedAt: now,
  });

  const list =
    input.stage === "plan" ? record.planReviewers : record.codeReviewers;

  if (input.substantialChange) {
    for (const entry of list) {
      if (entry.agentId !== input.agentId && entry.commit !== targetRef) {
        entry.status = "BLOCKED";
        entry.summary = "Prior approval invalidated by substantial code change";
      }
    }
  }

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
    node.evidencePath = sidecarPath;
    node.status =
      input.verdict === "APPROVE"
        ? "approved"
        : input.verdict === "REQUEST_CHANGES"
          ? "changes_requested"
          : "blocked";
    node.updatedAt = now;
  }

  saveTask(recordPath, record);
  const integrity = checkAgentReadOnlyIntegrity(recordPath, input.agentId);
  const saved = integrity.record;

  if (
    input.round >= maxRounds &&
    !input.userAuthorizedExtraRound?.trim() &&
    (input.verdict === "REQUEST_CHANGES" || input.verdict === "BLOCKED")
  ) {
    const reason = `Round ${input.round} ${input.stage} review ended with ${input.verdict}. Hard 2-round circuit breaker triggered — stop patching and present trade-off options to the user.`;
    saved.circuitBroken = {
      stage: input.stage,
      round: input.round,
      reason,
      triggeredAt: now,
    };
    saved.lifecycleStatus = "blocked";
    saveTask(recordPath, saved);
    return {
      status: "CIRCUIT_BROKEN",
      round: input.round,
      maxRounds,
      sidecar: sidecarName,
      message: reason,
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

export function recordCandidateDelivery(
  recordPath: string,
  input: {
    candidate?: string;
    worktree?: string;
    ciLog?: string;
    ciWaivedUserQuote?: string;
    summary: string;
    architectureImpact: string;
    performanceStatus?: TaskDeliveryInfo["performanceStatus"];
    performanceSummary?: string;
    requireCodeReview?: boolean;
    codeReviewReason?: string;
  },
): TaskRecord {
  const record = loadTask(recordPath);
  const now = new Date().toISOString();
  const targetDir = input.worktree?.trim()
    ? path.resolve(input.worktree.trim())
    : record.projectRoot;

  const fingerprint =
    input.candidate?.trim() || computeWorkspaceFingerprint(targetDir);
  const stats = computeWorkspaceChangeStats(targetDir);

  record.candidate = fingerprint;
  record.worktree = targetDir;

  if (input.ciWaivedUserQuote?.trim()) {
    record.ci = { waived: input.ciWaivedUserQuote.trim() };
  } else if (input.ciLog?.trim()) {
    record.ci = { log: path.basename(input.ciLog.trim()) };
  }

  record.delivery = {
    candidate: fingerprint,
    worktree: targetDir,
    summary: input.summary.trim(),
    architectureImpact: input.architectureImpact.trim(),
    performanceStatus: input.performanceStatus ?? "not-applicable",
    ...(input.performanceSummary
      ? { performanceSummary: input.performanceSummary.trim() }
      : {}),
    deliveredAt: now,
  };

  const archNonTrivial = !["无", "none", "n/a"].includes(
    input.architectureImpact.trim().toLowerCase(),
  );
  const sizeTriggered = stats.files > 5 || stats.lines > 200;
  if (
    (input.requireCodeReview || archNonTrivial || sizeTriggered) &&
    record.codeReview !== "waived"
  ) {
    record.codeReview = "required";
    record.codeReviewReason =
      input.codeReviewReason?.trim() ||
      (archNonTrivial
        ? "non-trivial architecture impact"
        : sizeTriggered
          ? `diff size (${stats.files} files, ${stats.lines} lines)`
          : "requested");
  } else if (
    input.codeReviewReason?.trim() &&
    record.codeReview === "not-required"
  ) {
    record.codeReviewReason = input.codeReviewReason.trim();
  }

  const devNode = record.nodes.find((n) => n.role === "developer");
  if (devNode) {
    devNode.status = "completed";
    devNode.summary = input.summary.trim();
    devNode.updatedAt = now;
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

export function markTaskCompleted(
  recordPath: string,
  fingerprint?: string,
): TaskRecord {
  const record = loadTask(recordPath);
  const now = new Date().toISOString();
  record.lifecycleStatus = "merged";
  record.mergedAt = now;
  if (fingerprint) {
    record.candidate = fingerprint;
  }
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
    `- Reviews: planReview=${record.planReview}(R${record.planReviewRound}/2) | codeReview=${record.codeReview}(R${record.codeReviewRound}/2)`,
  ];
  if (record.circuitBroken) {
    lines.push(`- Circuit Breaker: ${record.circuitBroken.reason}`);
  }
  if (record.readOnlyViolations.length > 0) {
    lines.push(
      `- Read-Only Violations: ${record.readOnlyViolations.map((v) => `${v.role}(${v.agentId})`).join(", ")}`,
    );
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
