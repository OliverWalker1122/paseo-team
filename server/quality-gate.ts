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
function latestCheck(taskDir: string): { passed: boolean; at: number } | null {
  let best: { passed: boolean; at: number } | null = null;
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
      best = { passed: readJson(file)?.status === "PASS", at: st.mtimeMs };
    } catch {
      // Ignore unreadable sidecar
    }
  }
  return best;
}

const asList = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? (value as Record<string, unknown>[]) : [];

// Reviewers of the newest round must all approve; older rounds are superseded.
function latestRoundApproved(reviewers: Record<string, unknown>[]): boolean {
  const roundOf = (r: Record<string, unknown>) => Number(r?.round) || 0;
  const latest = Math.max(0, ...reviewers.map(roundOf));
  const current = reviewers.filter((r) => roundOf(r) === latest);
  return current.length > 0 && current.every((r) => r?.status === "APPROVE");
}

// Evidence-only gate: no workspace hashing, so user edits or commits never invalidate it.
export function inspectQualityGate(options: {
  recordPath: string;
}): QualityGateReport {
  const file = path.resolve(options.recordPath);
  const taskDir = path.dirname(file);
  const record = readJson(file);

  const deliveries = asList(record?.deliveries);
  const deliveryRecorded =
    Boolean(record?.delivery && typeof record.delivery === "object") ||
    filled(record?.candidate) ||
    deliveries.length > 0;

  // A rework round must be re-verified: the last check has to run after the
  // previous round's delivery.
  const roundOf = (d: Record<string, unknown>) => Number(d?.round) || 1;
  const currentRound = Math.max(1, ...deliveries.map(roundOf));
  const previousDeliveryAt = Math.max(
    0,
    ...deliveries
      .filter((d) => roundOf(d) < currentRound)
      .map((d) => Date.parse(String(d?.deliveredAt)) || 0),
  );
  const ci =
    record?.ci && typeof record.ci === "object"
      ? (record.ci as Record<string, unknown>)
      : null;
  const check = latestCheck(taskDir);
  const ciPassed =
    filled(ci?.waived) ||
    Boolean(check?.passed && check.at > previousDeliveryAt);

  const planReviewSatisfied =
    record?.planReview !== "required" ||
    latestRoundApproved(asList(record?.planReviewers));

  const codeReviewSatisfied =
    record?.codeReview === "required"
      ? latestRoundApproved(asList(record?.codeReviewers))
      : record?.codeReview === "waived"
        ? filled(record?.codeReviewReason)
        : true;

  const checks = {
    deliveryRecorded,
    ciPassed,
    planReviewSatisfied,
    codeReviewSatisfied,
  };

  return {
    status: Object.values(checks).every(Boolean) ? "READY" : "BLOCKED",
    checks,
  };
}
