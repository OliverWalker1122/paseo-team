import { spawnSync } from "node:child_process";
import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { computeWorkspaceFingerprint } from "./quality-gate.ts";

const tailBytes = 8192;
const tailCharacters = 2000;

export interface CheckSidecar {
  status: "PASS" | "FAIL" | "ERROR";
  processExitCode: number;
  head: string | null;
  clean: boolean;
  fingerprint: string;
}

export interface RunCheckResult {
  status: "PASS" | "FAIL" | "ERROR";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  processExitCode: number;
  logPath: string;
  message?: string;
  outputTail?: string;
  truncated?: boolean;
}

export function isSensitiveLogPath(file: string): boolean {
  return file
    .replaceAll("\\", "/")
    .split("/")
    .some(
      (part) =>
        /^\.env(?:\.|$)/i.test(part) ||
        [".ssh", ".aws", ".gnupg", ".paseo", ".credentials"].includes(part) ||
        /^(?:auth|credentials?|secrets?)(?:\.|$)/i.test(part),
    );
}

function publicLogPath(file: unknown): string {
  if (typeof file !== "string" || !file.trim()) {
    throw new Error(
      "A --log path to a new log file in the task evidence directory is required.",
    );
  }
  const absolute = path.resolve(file);
  if (isSensitiveLogPath(absolute) || path.extname(absolute) !== ".log") {
    throw new Error(
      "The check log must be a .log file in a public task directory, not a credential path.",
    );
  }
  return absolute;
}

function readTail(
  fd: number,
  size: number,
): { outputTail: string; truncated: boolean } {
  const bytes = Math.min(size, tailBytes);
  const buffer = Buffer.alloc(bytes);
  const count = readSync(fd, buffer, 0, bytes, size - bytes);
  let text = buffer.subarray(0, count).toString("utf8");
  text = stripVTControlCharacters(text).replaceAll("\r", "\n");
  return {
    outputTail: text.slice(-tailCharacters),
    truncated: size > bytes || text.length > tailCharacters,
  };
}

// Records workspace state & content fingerprint so PASS cannot be reused after new edits.
export function gitCheckoutState(cwd: string): {
  head: string | null;
  clean: boolean;
  fingerprint: string;
} {
  const fingerprint = computeWorkspaceFingerprint(cwd);
  const git = (...args: string[]) =>
    spawnSync("git", ["--no-optional-locks", "-C", cwd, ...args], {
      encoding: "utf8",
    });
  const head = git("rev-parse", "HEAD");
  if (head.status !== 0) return { head: null, clean: false, fingerprint };
  const status = git("status", "--porcelain=v1", "--untracked-files=normal");
  return {
    head: head.stdout.trim(),
    clean: status.status === 0 && status.stdout === "",
    fingerprint,
  };
}

// Only ordinary, credential-isolated checks belong here. No shell interpolation,
// environment dump, command echo, dotenv loading, or reading pre-existing logs.
export function runCheck(
  command: string,
  args: string[],
  { log, cwd = process.cwd() }: { log: string; cwd?: string },
): RunCheckResult {
  if (typeof command !== "string" || !command || !Array.isArray(args)) {
    throw new Error("An executable (and optional arguments) is required.");
  }
  const requested = publicLogPath(log);
  const resolved = publicLogPath(
    path.join(realpathSync(path.dirname(requested)), path.basename(requested)),
  );
  // Exclusive creation also rejects an existing file or a leaf symlink.
  const fd = openSync(resolved, "wx+", 0o600);
  let resultFd: number | undefined;
  try {
    // Sidecar read by the workflow merge gate; created before the check runs.
    resultFd = openSync(`${resolved}.json`, "wx", 0o600);
    const checked = gitCheckoutState(cwd);
    const child = spawnSync(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", fd, fd],
      env: {
        ...process.env,
        SKIP_DOTENV: "true",
        DOTENV_CONFIG_PATH: process.platform === "win32" ? "NUL" : "/dev/null",
      },
    });
    const exitCode = child.status;
    const signal = child.signal ?? null;
    const errCode = (child.error as NodeJS.ErrnoException | undefined)?.code;
    const processExitCode = child.error
      ? errCode === "ENOENT"
        ? 127
        : 1
      : signal
        ? 128 + (os.constants.signals[signal] ?? 0)
        : (exitCode ?? 1);
    const status: RunCheckResult["status"] = child.error
      ? "ERROR"
      : processExitCode === 0
        ? "PASS"
        : "FAIL";
    const result: RunCheckResult = {
      status,
      exitCode,
      signal,
      processExitCode,
      logPath: resolved,
    };
    if (child.error) {
      result.message =
        errCode === "ENOENT"
          ? "Could not start the check: the executable does not exist."
          : "Could not run the check. Command arguments and environment are not echoed.";
    }
    const sidecar: CheckSidecar = {
      status,
      processExitCode,
      ...checked,
    };
    writeFileSync(resultFd, JSON.stringify(sidecar));
    if (status !== "PASS") {
      Object.assign(result, readTail(fd, fstatSync(fd).size));
    }
    return result;
  } finally {
    if (resultFd !== undefined) closeSync(resultFd);
    closeSync(fd);
  }
}
