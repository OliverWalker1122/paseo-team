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
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runCheck } from "../server/run-check.ts";

const script = fileURLToPath(
  new URL("../server/run-check.ts", import.meta.url),
);

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-check-output-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, log: path.join(dir, "check.log") };
}

function cli(log: string, source: string) {
  return spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      script,
      "--log",
      log,
      "--",
      process.execPath,
      "-e",
      source,
    ],
    {
      encoding: "utf8",
      timeout: 10000,
    },
  );
}

test("成功检查只回报结果，stdout/stderr 完整保存在新日志", (t) => {
  const { log } = fixture(t);
  const child = cli(
    log,
    'process.stdout.write("ordinary stdout\\n"); process.stderr.write("ordinary stderr\\n");',
  );
  assert.equal(child.status, 0);
  const result = JSON.parse(child.stdout) as Record<string, unknown>;
  assert.equal(result.status, "PASS");
  assert.equal(result.exitCode, 0);
  assert.equal(result.logPath, log);
  assert.equal(result.outputTail, undefined);
  assert.ok(child.stdout.length < 600);
  const output = readFileSync(log, "utf8");
  assert.match(output, /ordinary stdout/);
  assert.match(output, /ordinary stderr/);
});

test("长失败日志不吞掉退出码；截断摘要有界，原始输出完整", (t) => {
  const { log } = fixture(t);
  const child = cli(
    log,
    'process.stdout.write("START\\n" + "x".repeat(50000) + "\\nFAIL end\\n"); process.exitCode = 7;',
  );
  assert.equal(child.status, 7);
  const result = JSON.parse(child.stdout) as {
    status: string;
    exitCode: number;
    truncated: boolean;
    outputTail: string;
  };
  assert.equal(result.status, "FAIL");
  assert.equal(result.exitCode, 7);
  assert.equal(result.truncated, true);
  assert.ok(result.outputTail.length <= 2000);
  assert.match(result.outputTail, /FAIL end/);
  assert.equal(
    readFileSync(log, "utf8"),
    "START\n" + "x".repeat(50000) + "\nFAIL end\n",
  );
});

test("短失败内容保留且没有伪称截断，清除摘要中的终端转义", (t) => {
  const { log } = fixture(t);
  const child = cli(
    log,
    'process.stderr.write("\\u001b[31mFAIL detail\\u001b[0m\\n"); process.exitCode = 2;',
  );
  const result = JSON.parse(child.stdout) as {
    outputTail: string;
    truncated: boolean;
  };
  assert.equal(child.status, 2);
  assert.equal(result.outputTail, "FAIL detail\n");
  assert.equal(result.truncated, false);
  assert.ok(readFileSync(log, "utf8").includes("\u001b[31m"));
});

test("不存在的程序和无效参数不回显命令参数，也不报告通过", (t) => {
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
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      script,
      "--unknown",
      "private-looking-placeholder",
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 1);
  assert.ok(!child.stderr.includes("private-looking-placeholder"));
});

test("已有日志不覆盖，日志创建失败前不会运行命令", (t) => {
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
    /凭据路径/,
  );
});

test(
  "日志符号链接不能覆盖目标",
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

test("参数按字面传递，工作目录保持指定值，隔离变量只输出存在状态", (t) => {
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
  "信号终止保留 signal 并以非零退出，不能误报成功",
  { skip: process.platform === "win32" },
  (t) => {
    const { log } = fixture(t);
    const child = cli(log, 'process.kill(process.pid, "SIGTERM");');
    const result = JSON.parse(child.stdout) as {
      status: string;
      exitCode: number | null;
      signal: string;
    };
    assert.equal(child.status, 143);
    assert.equal(result.status, "FAIL");
    assert.equal(result.exitCode, null);
    assert.equal(result.signal, "SIGTERM");
  },
);

test("结果文件记录检查时的 commit 与工作区状态，不含命令参数", (t) => {
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
