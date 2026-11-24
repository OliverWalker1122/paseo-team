import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCheck } from "../server/run-check.ts";

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-check-output-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, log: path.join(dir, "check.log") };
}

function check(log: string, source: string) {
  return runCheck(process.execPath, ["-e", source], { log });
}

test("a passing check reports only the result and saves full stdout/stderr to a new log", (t) => {
  const { log } = fixture(t);
  const result = check(
    log,
    'process.stdout.write("ordinary stdout\\n"); process.stderr.write("ordinary stderr\\n");',
  );
  assert.equal(result.status, "PASS");
  assert.equal(result.exitCode, 0);
  assert.equal(result.logPath, log);
  assert.equal(result.outputTail, undefined);
  assert.ok(JSON.stringify(result).length < 600);
  const output = readFileSync(log, "utf8");
  assert.match(output, /ordinary stdout/);
  assert.match(output, /ordinary stderr/);
});

test("a long failure keeps its exit code, bounds the summary tail and keeps the full log", (t) => {
  const { log } = fixture(t);
  const result = check(
    log,
    'process.stdout.write("START\\n" + "x".repeat(50000) + "\\nFAIL end\\n"); process.exitCode = 7;',
  );
  assert.equal(result.status, "FAIL");
  assert.equal(result.exitCode, 7);
  assert.equal(result.processExitCode, 7);
  assert.equal(result.truncated, true);
  assert.ok((result.outputTail ?? "").length <= 2000);
  assert.match(result.outputTail ?? "", /FAIL end/);
  assert.equal(
    readFileSync(log, "utf8"),
    "START\n" + "x".repeat(50000) + "\nFAIL end\n",
  );
});

test("a short failure is kept whole without a truncation marker and strips terminal escapes", (t) => {
  const { log } = fixture(t);
  const result = check(
    log,
    'process.stderr.write("\\u001b[31mFAIL detail\\u001b[0m\\n"); process.exitCode = 2;',
  );
  assert.equal(result.processExitCode, 2);
  assert.equal(result.outputTail, "FAIL detail\n");
  assert.equal(result.truncated, false);
  assert.ok(readFileSync(log, "utf8").includes("\u001b[31m"));
});

test("a missing executable never echoes arguments or reports a pass", (t) => {
  const { dir, log } = fixture(t);
  const result = runCheck(
    path.join(dir, "not-an-executable"),
    ["private-looking-placeholder"],
    { log },
  );
  assert.equal(result.status, "ERROR");
  assert.equal(result.exitCode, null);
  assert.equal(result.processExitCode, 127);
  assert.ok(!JSON.stringify(result).includes("private-looking-placeholder"));
});

test("an existing log is never overwritten and nothing runs before the log is created", (t) => {
  const { dir, log } = fixture(t);
  const marker = path.join(dir, "should-not-exist");
  writeFileSync(log, "original evidence");
  assert.throws(() =>
    runCheck(
      process.execPath,
      [
        "-e",
        'require("node:fs").writeFileSync(process.argv[1], "ran")',
        marker,
      ],
      { log },
    ),
  );
  assert.equal(readFileSync(log, "utf8"), "original evidence");
  assert.equal(existsSync(marker), false);
  assert.throws(
    () =>
      runCheck(process.execPath, ["-e", ""], {
        log: path.join(dir, ".env.log"),
      }),
    /credential path/,
  );
});

test(
  "a symlinked log cannot overwrite its target",
  { skip: process.platform === "win32" },
  (t) => {
    const { dir, log } = fixture(t);
    const target = path.join(dir, "original.log");
    writeFileSync(target, "original evidence");
    symlinkSync(target, log);
    assert.throws(() => runCheck(process.execPath, ["-e", ""], { log }));
    assert.equal(readFileSync(target, "utf8"), "original evidence");
  },
);

test("arguments pass literally, cwd is honored, and isolation variables report presence only", (t) => {
  const { dir, log } = fixture(t);
  const literal = 'spaces ; $(not-a-command) "quoted"';
  const result = runCheck(
    process.execPath,
    [
      "-e",
      'console.log(process.argv[1]); console.log(process.cwd()); for (const name of ["SKIP_DOTENV", "DOTENV_CONFIG_PATH"]) console.log(name + ": " + (process.env[name] ? "configured" : "missing"));',
      literal,
    ],
    { log, cwd: dir },
  );
  assert.equal(result.status, "PASS");
  const lines = readFileSync(log, "utf8").trimEnd().split(/\r?\n/);
  assert.deepEqual(lines, [
    literal,
    dir,
    "SKIP_DOTENV: configured",
    "DOTENV_CONFIG_PATH: configured",
  ]);
});

test(
  "a signal-terminated check keeps the signal and exits non-zero",
  { skip: process.platform === "win32" },
  (t) => {
    const { log } = fixture(t);
    const result = check(log, 'process.kill(process.pid, "SIGTERM");');
    assert.equal(result.processExitCode, 143);
    assert.equal(result.status, "FAIL");
    assert.equal(result.exitCode, null);
    assert.equal(result.signal, "SIGTERM");
  },
);

test("the result file records commit and workspace state without command arguments", (t) => {
  const { dir, log } = fixture(t);
  const git = (...args: string[]) =>
    spawnSync(
      "git",
      ["-c", "user.name=F", "-c", "user.email=f@example.invalid", ...args],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "base");
  const result = runCheck(process.execPath, ["-e", "", "secret-like-arg"], {
    log,
    cwd: dir,
  });
  assert.equal(result.status, "PASS");
  const saved = readFileSync(`${log}.json`, "utf8");
  assert.doesNotMatch(saved, /secret-like-arg/);
  const parsed = JSON.parse(saved) as Record<string, unknown>;
  assert.equal(parsed.status, "PASS");
  assert.equal(parsed.processExitCode, 0);
  assert.equal(parsed.head, git("rev-parse", "HEAD").stdout.trim());
  assert.equal(parsed.clean, false);
  assert.equal(typeof parsed.fingerprint, "string");
  assert.equal((parsed.fingerprint as string).length, 40);
});
