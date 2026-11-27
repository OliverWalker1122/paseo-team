import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export interface QualityGateReport {
  status: "READY" | "BLOCKED";
  checks: {
    deliveryRecorded: boolean;
    ciPassed: boolean;
    planReviewSatisfied: boolean;
    codeReviewSatisfied: boolean;
  };
  /** Human-readable reasons for every failed check, naming the agent to chase. */
  missing: string[];
}

function isSensitiveRelativePath(relPath: string): boolean {
  return relPath
    .replaceAll("\\", "/")
    .split("/")
    .some(
      (part) =>
        /^\.env(?:\.|$)/i.test(part) ||
        [".ssh", ".aws", ".gnupg", ".paseo", ".credentials"].includes(part) ||
        /\.(?:pem|key|p12|pfx)$/i.test(part),
    );
}

function runGitSafe(
  cwd: string,
  args: string[],
): { ok: boolean; stdout: string } {
  const res = spawnSync("git", ["--no-optional-locks", "-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    ok: !res.error && res.status === 0,
    stdout: res.stdout ?? "",
  };
}

export function resolveGitRoot(directory: string): string {
  const resolved = path.resolve(directory);
  const top = runGitSafe(resolved, ["rev-parse", "--show-toplevel"]);
  return top.ok && top.stdout.trim() ? top.stdout.trim() : resolved;
}

export function computeWorkspaceChangeStats(directory: string): {
  files: number;
  lines: number;
} {
  const root = resolveGitRoot(directory);
  const numstat = runGitSafe(root, [
    "diff",
    "HEAD",
    "--numstat",
    "--",
    ".",
    ":(exclude).env*",
    ":(exclude)**/.env*",
  ]);
  const rows = numstat.ok
    ? numstat.stdout.trim().split("\n").filter(Boolean)
    : [];
  let lines = 0;
  for (const row of rows) {
    const [added, deleted] = row.split("\t");
    lines += (Number(added) || 0) + (Number(deleted) || 0);
  }

  const untracked = runGitSafe(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  const untrackedCount = untracked.ok
    ? untracked.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => Boolean(s) && !isSensitiveRelativePath(s)).length
    : 0;

  return {
    files: rows.length + untrackedCount,
    lines,
  };
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (lstatSync(file).isSymbolicLink()) return null;
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const filled = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

// The newest check sidecar (by write time) in the task directory, i.e. the last run.
function latestCheck(
  taskDir: string,
): { name: string; passed: boolean; at: number } | null {
  let best: { name: string; passed: boolean; at: number } | null = null;
  let names: string[];
  try {
    names = readdirSync(taskDir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith(".log.json")) continue;
    const file = path.join(taskDir, name);
    try {
      const st = lstatSync(file);
      if (!st.isFile() || (best && st.mtimeMs < best.at)) continue;
      best = {
        name: name.slice(0, -".json".length),
        passed: readJson(file)?.status === "PASS",
        at: st.mtimeMs,
      };
    } catch {
      // Ignore unreadable sidecar
    }
  }
  return best;
}

const asList = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
const roundOf = (r: Record<string, unknown>) => Number(r?.round) || 1;

/**
 * Why CI does not count for `round` (default: the latest delivery round), or
 * null when it does. A rework round needs a check newer than the previous
 * round's delivery.
 */
export function ciProblem(
  taskDir: string,
  record: Record<string, unknown> | null,
  round?: number,
): string | null {
  const ci =
    record?.ci && typeof record.ci === "object"
      ? (record.ci as Record<string, unknown>)
      : null;
  if (filled(ci?.waived)) return null;
  const deliveries = asList(record?.deliveries);
  const current = round ?? Math.max(1, ...deliveries.map(roundOf));
  const previousDeliveryAt = Math.max(
    0,
    ...deliveries
      .filter((d) => roundOf(d) < current)
      .map((d) => Date.parse(String(d?.deliveredAt)) || 0),
  );
  const check = latestCheck(taskDir);
  if (!check) return "No paseo_team_run_check result in the task directory.";
  if (!check.passed) return `Latest check ${check.name} did not pass.`;
  // mtimeMs has sub-millisecond precision; deliveredAt is whole ms, so compare at ms resolution.
  if (Math.floor(check.at) <= previousDeliveryAt) {
    return `Latest check ${check.name} predates the round ${current - 1} delivery; rerun paseo_team_run_check after the rework.`;
  }
  return null;
}

// Reviewers of the newest round must all approve, every dispatched reviewer
// must have submitted and hold an APPROVE verdict (so an unresolved earlier
// REQUEST_CHANGES cannot be bypassed while that reviewer is still re-reviewing),
// and the latest review round must cover the newest delivery/plan submission.
function reviewProblems(
  stage: "plan" | "code",
  reviewers: Record<string, unknown>[],
  nodes: Record<string, unknown>[],
  requiredRound: number,
): string[] {
  const role = stage === "plan" ? "plan-reviewer" : "code-reviewer";
  const registeredNodes = nodes.filter(
    (n) => n?.role === role && filled(n.agentId),
  );
  const registeredIds = new Set(registeredNodes.map((n) => n.agentId));
  const submitted = new Set(reviewers.map((r) => r?.agentId));
  const problems = registeredNodes
    .filter((n) => !submitted.has(n.agentId))
    .map(
      (n) =>
        `${String(n.label ?? role)} (${String(n.agentId)}) has not submitted a ${stage} verdict via paseo_team_submit_review.`,
    );
  if (reviewers.length === 0) {
    return problems.length > 0 ? problems : [`No ${stage} review submitted.`];
  }
  const latest = Math.max(...reviewers.map(roundOf));
  if (latest < requiredRound) {
    problems.push(
      `No ${stage} review submitted for round ${requiredRound} yet.`,
    );
  }
  for (const r of reviewers) {
    const rRound = roundOf(r);
    if (
      (rRound === latest || registeredIds.has(r?.agentId)) &&
      r?.status !== "APPROVE"
    ) {
      problems.push(
        `${stage} reviewer ${String(r?.agentId)} round ${rRound}: ${String(r?.status)}.`,
      );
    }
  }
  return problems;
}

// Evidence-only gate: no workspace hashing, so user edits or commits never invalidate it.
export function inspectQualityGate(options: {
  recordPath: string;
}): QualityGateReport {
  const file = path.resolve(options.recordPath);
  const taskDir = path.dirname(file);
  const record = readJson(file);
  const nodes = asList(record?.nodes);

  const deliveryRecorded =
    Boolean(record?.delivery && typeof record.delivery === "object") ||
    filled(record?.candidate) ||
    asList(record?.deliveries).length > 0;
  const deliveryProblems = deliveryRecorded
    ? []
    : ["No delivery: the Developer must call paseo_team_submit_delivery."];

  const ciIssue = ciProblem(taskDir, record);
  // Dispatching a reviewer makes its stage required, so an unsubmitted one always blocks.
  const dispatched = (role: string) =>
    nodes.some((n) => n?.role === role && filled(n.agentId));
  const requiredPlanRound = Math.max(1, Number(record?.planSubmissions) || 0);
  const requiredCodeRound = Math.max(
    1,
    ...asList(record?.deliveries).map(roundOf),
  );
  const planProblems =
    record?.planReview === "waived"
      ? filled(record?.planReviewReason)
        ? []
        : ["Plan review waived without a reason."]
      : record?.planReview === "required" || dispatched("plan-reviewer")
        ? reviewProblems(
            "plan",
            asList(record?.planReviewers),
            nodes,
            requiredPlanRound,
          )
        : [];
  const codeProblems =
    record?.codeReview === "waived"
      ? filled(record?.codeReviewReason)
        ? []
        : ["Code review waived without a reason."]
      : record?.codeReview === "required" || dispatched("code-reviewer")
        ? reviewProblems(
            "code",
            asList(record?.codeReviewers),
            nodes,
            requiredCodeRound,
          )
        : [];

  const checks = {
    deliveryRecorded,
    ciPassed: !ciIssue,
    planReviewSatisfied: planProblems.length === 0,
    codeReviewSatisfied: codeProblems.length === 0,
  };

  return {
    status: Object.values(checks).every(Boolean) ? "READY" : "BLOCKED",
    checks,
    missing: [
      ...deliveryProblems,
      ...(ciIssue ? [ciIssue] : []),
      ...planProblems,
      ...codeProblems,
    ],
  };
}
