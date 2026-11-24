import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export interface RepoSnapshot {
  root: string;
  head: string;
  fingerprint: string;
  statusPorcelain: string;
  clean: boolean;
  capturedAt: string;
}

export interface QualityGateReport {
  status: "READY" | "BLOCKED";
  fingerprint: string;
  change: { files: number; lines: number };
  checks: {
    deliveryRecorded: boolean;
    ciPassed: boolean;
    planReviewSatisfied: boolean;
    codeReviewSatisfied: boolean;
    readOnlyClean: boolean;
    notCircuitBroken: boolean;
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

// Computes a deterministic 40-char SHA-256 content fingerprint of the workspace
// (HEAD + tracked diff + non-sensitive untracked file object hashes) without reading .env files.
export function computeWorkspaceFingerprint(directory: string): string {
  const resolved = path.resolve(directory);
  const top = runGitSafe(resolved, ["rev-parse", "--show-toplevel"]);
  const root = top.ok && top.stdout.trim() ? top.stdout.trim() : resolved;

  const headRes = runGitSafe(root, ["rev-parse", "HEAD"]);
  const head = headRes.ok ? headRes.stdout.trim() : "unborn";

  const diffRes = runGitSafe(root, [
    "diff",
    "HEAD",
    "--",
    ".",
    ":(exclude).env*",
    ":(exclude)**/.env*",
  ]);
  const stagedDiffRes =
    head === "unborn"
      ? runGitSafe(root, [
          "diff",
          "--cached",
          "--",
          ".",
          ":(exclude).env*",
          ":(exclude)**/.env*",
        ])
      : { ok: true, stdout: "" };

  const untrackedRes = runGitSafe(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  const untrackedFiles = untrackedRes.ok
    ? untrackedRes.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => Boolean(s) && !isSensitiveRelativePath(s))
        .sort()
    : [];

  let untrackedHashes = "";
  if (untrackedFiles.length > 0) {
    const regularFiles = untrackedFiles.filter((rel) => {
      try {
        const st = lstatSync(path.join(root, rel));
        return (
          st.isFile() && !st.isSymbolicLink() && st.size <= 2 * 1024 * 1024
        );
      } catch {
        return false;
      }
    });
    if (regularFiles.length > 0) {
      const hashRes = runGitSafe(root, [
        "hash-object",
        "--no-filters",
        "--",
        ...regularFiles,
      ]);
      const hashes = hashRes.ok ? hashRes.stdout.trim().split("\n") : [];
      untrackedHashes = regularFiles
        .map((rel, i) => `${rel}:${hashes[i] ?? ""}`)
        .join("\n");
    }
  }

  return createHash("sha256")
    .update(`head:${head}\n`)
    .update(`diff:${diffRes.stdout}\n`)
    .update(`staged:${stagedDiffRes.stdout}\n`)
    .update(`untracked:${untrackedHashes}\n`)
    .digest("hex")
    .slice(0, 40);
}

export function computeWorkspaceChangeStats(directory: string): {
  files: number;
  lines: number;
} {
  const resolved = path.resolve(directory);
  const numstat = runGitSafe(resolved, [
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

  const untracked = runGitSafe(resolved, [
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

export function captureRepoSnapshot(directory: string): RepoSnapshot {
  const resolved = path.resolve(directory);
  const top = runGitSafe(resolved, ["rev-parse", "--show-toplevel"]);
  const root =
    top.ok && top.stdout.trim()
      ? realpathSync(top.stdout.trim())
      : realpathSync(resolved);
  const headRes = runGitSafe(root, ["rev-parse", "HEAD"]);
  const head = headRes.ok ? headRes.stdout.trim() : "";
  const statusRes = runGitSafe(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ]);
  const statusPorcelain = statusRes.stdout.trim();
  const fingerprint = computeWorkspaceFingerprint(root);
  return {
    root,
    head,
    fingerprint,
    statusPorcelain,
    clean: statusPorcelain === "",
    capturedAt: new Date().toISOString(),
  };
}

export function verifyReadOnlySnapshot(
  directory: string,
  before: RepoSnapshot,
): {
  ok: boolean;
  headUnchanged: boolean;
  statusUnchanged: boolean;
  after: RepoSnapshot;
} {
  const after = captureRepoSnapshot(directory);
  const headUnchanged = after.head === before.head;
  const fingerprintUnchanged = before.fingerprint
    ? after.fingerprint === before.fingerprint
    : after.statusPorcelain === before.statusPorcelain;
  return {
    ok: headUnchanged && fingerprintUnchanged,
    headUnchanged,
    statusUnchanged: fingerprintUnchanged,
    after,
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

function verifyReviewerSidecar(
  taskDir: string,
  reviewer: Record<string, unknown>,
  acceptedTargets: Set<string>,
): boolean {
  if (!filled(reviewer.sidecar)) {
    return true;
  }
  const reviewsDir = path.join(taskDir, "reviews");
  const sidecarPath = path.resolve(reviewsDir, reviewer.sidecar);
  if (path.dirname(sidecarPath) !== reviewsDir) {
    return false;
  }
  const sidecar = readJson(sidecarPath);
  if (!sidecar) return false;
  return (
    sidecar.stage === "code" &&
    sidecar.agentId === reviewer.agentId &&
    typeof sidecar.commit === "string" &&
    acceptedTargets.has(sidecar.commit) &&
    sidecar.status === "APPROVE"
  );
}

export function inspectQualityGate(options: {
  recordPath: string;
  cwd?: string;
}): QualityGateReport {
  const file = path.resolve(options.recordPath);
  const taskDir = path.dirname(file);
  const record = readJson(file);

  const projectRoot = filled(options.cwd)
    ? options.cwd.trim()
    : filled(record?.projectRoot)
      ? record.projectRoot.trim()
      : taskDir;

  const liveFingerprint = computeWorkspaceFingerprint(projectRoot);
  const change = computeWorkspaceChangeStats(projectRoot);

  const recordedCandidate = filled(record?.candidate)
    ? record.candidate.trim()
    : "";
  const delivery =
    record?.delivery && typeof record.delivery === "object"
      ? (record.delivery as Record<string, unknown>)
      : null;
  const deliveryRecorded = Boolean(delivery) || Boolean(recordedCandidate);

  const isCompleted =
    record?.lifecycleStatus === "merged" ||
    record?.status === "merged" ||
    record?.status === "deployed" ||
    record?.status === "done";

  const acceptedTargets = new Set<string>([liveFingerprint]);
  if (isCompleted && recordedCandidate) {
    acceptedTargets.add(recordedCandidate);
  }

  const ci =
    record?.ci && typeof record.ci === "object"
      ? (record.ci as Record<string, unknown>)
      : null;
  const ciLog = filled(ci?.log) ? path.resolve(taskDir, ci.log) : "";
  const ciResult =
    ciLog && path.dirname(ciLog) === taskDir ? readJson(`${ciLog}.json`) : null;

  const ciPassed =
    filled(ci?.waived) ||
    Boolean(
      ciResult?.status === "PASS" &&
      ((typeof ciResult.fingerprint === "string" &&
        ciResult.fingerprint === liveFingerprint) ||
        (isCompleted &&
          recordedCandidate &&
          ((typeof ciResult.fingerprint === "string" &&
            ciResult.fingerprint === recordedCandidate) ||
            (ciResult.head === recordedCandidate && ciResult.clean === true)))),
    );

  const planReview = record?.planReview;
  const planReviewers = Array.isArray(record?.planReviewers)
    ? (record.planReviewers as Record<string, unknown>[])
    : [];
  const planReviewSatisfied =
    planReview !== "required" ||
    (planReviewers.length > 0 &&
      planReviewers.every((r) => r?.status === "APPROVE"));

  const codeReview = record?.codeReview;
  const codeReviewers = Array.isArray(record?.codeReviewers)
    ? (record.codeReviewers as Record<string, unknown>[])
    : [];
  const sizeTriggered = change.files > 5 || change.lines > 200;

  const codeReviewSatisfied =
    codeReview === "required"
      ? codeReviewers.length > 0 &&
        codeReviewers.every(
          (r) =>
            r?.status === "APPROVE" &&
            typeof r.commit === "string" &&
            acceptedTargets.has(r.commit) &&
            verifyReviewerSidecar(taskDir, r, acceptedTargets),
        )
      : codeReview === "waived"
        ? filled(record?.codeReviewReason)
        : codeReview === "not-required" &&
          !sizeTriggered &&
          filled(record?.codeReviewReason);

  const violations = Array.isArray(record?.readOnlyViolations)
    ? record.readOnlyViolations
    : [];
  const readOnlyClean = violations.length === 0;
  const notCircuitBroken = !record?.circuitBroken;

  const checks = {
    deliveryRecorded,
    ciPassed,
    planReviewSatisfied,
    codeReviewSatisfied,
    readOnlyClean,
    notCircuitBroken,
  };

  return {
    status: Object.values(checks).every(Boolean) ? "READY" : "BLOCKED",
    fingerprint: liveFingerprint,
    change,
    checks,
  };
}
