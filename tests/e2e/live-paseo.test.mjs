/**
 * Level 3 Live Paseo E2E Acceptance Smoke Test for `paseo-team` v7.
 *
 * Exercises the exact composer Team toggle flow on a real Paseo daemon:
 * creates a brand-new chat with `metadata: { "paseo-team.enabled": true }`,
 * sends a plain natural-language prompt (NO `/paseo-team` prefix, ZERO `ToolSearch`
 * for plugin state tools!), and verifies the coordinator dispatches real Developer
 * and Code Reviewer subagents via Paseo's native `create_agent`.
 *
 * Usage:
 *   PASEO_E2E_LIVE=1 PASEO_E2E_CWD=/path/to/test-repo npm run test:e2e
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const LIVE_ENABLED = process.env.PASEO_E2E_LIVE === "1";
const PASEO_HOME =
  process.env.PASEO_E2E_HOME || path.join(os.homedir(), ".paseo");
const TIMEOUT_MS = Number(process.env.PASEO_E2E_TIMEOUT_MS || 420_000);
const POLL_MS = 4_000;

function resolveCliClientPath() {
  if (
    process.env.PASEO_CLI_CLIENT &&
    existsSync(process.env.PASEO_CLI_CLIENT)
  ) {
    return process.env.PASEO_CLI_CLIENT;
  }
  const paseoBin = execFileSync("which", ["paseo"], {
    encoding: "utf8",
  }).trim();
  const pkgDist = path.dirname(realpathSync(paseoBin));
  for (const candidate of [
    path.join(pkgDist, "utils", "client.js"),
    path.join(pkgDist, "..", "dist", "utils", "client.js"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Could not locate @getpaseo/cli client helper; set PASEO_CLI_CLIENT.",
  );
}

function assertPluginRunning() {
  const out = execFileSync("paseo", ["plugin", "ls"], { encoding: "utf8" });
  const line = out.split(/\r?\n/).find((l) => l.includes("paseo-team"));
  assert.ok(line, "paseo-team plugin must be installed in Paseo");
  assert.match(line, /\brunning\b/, `paseo-team must be running, got: ${line}`);
}

async function resolveWorkspaceId(client, cwd) {
  if (process.env.PASEO_E2E_WORKSPACE_ID) {
    return process.env.PASEO_E2E_WORKSPACE_ID;
  }
  const res = await client.fetchWorkspaces();
  const entries = res?.entries ?? res?.workspaces ?? res?.items ?? res;
  const normalized = realpathSync(cwd);
  for (const entry of Array.isArray(entries) ? entries : []) {
    const dir =
      entry?.workspaceDirectory ??
      entry?.directory ??
      entry?.cwd ??
      entry?.workspace?.workspaceDirectory ??
      entry?.workspace?.directory;
    if (!dir) continue;
    try {
      if (realpathSync(String(dir)) === normalized) {
        return entry?.id ?? entry?.workspace?.id;
      }
    } catch {
      if (path.resolve(String(dir)) === normalized) {
        return entry?.id ?? entry?.workspace?.id;
      }
    }
  }
  throw new Error(`No Paseo workspace found for ${cwd}`);
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

test(
  "L3 live Paseo E2E: composer Team toggle metadata starts team directly on Turn 1 and spawns Developer + Reviewers",
  { skip: !LIVE_ENABLED, timeout: TIMEOUT_MS + 60_000 },
  async () => {
    assertPluginRunning();
    const cwd = path.resolve(process.env.PASEO_E2E_CWD || "");
    assert.ok(
      cwd && existsSync(cwd),
      "Set PASEO_E2E_CWD to an existing workspace",
    );

    const clientMod = await import(pathToFileURL(resolveCliClientPath()).href);
    const client = await clientMod.connectToDaemon({
      target: { kind: "instance", home: PASEO_HOME },
    });
    const workspaceId = await resolveWorkspaceId(client, cwd);
    const probeFile = path.join(cwd, `.paseo-team-l3-${Date.now()}.txt`);
    writeFileSync(probeFile, "before=v7\n", "utf8");

    let coordId = null;
    const spawnedIds = [];
    try {
      const created = await client.createAgent({
        workspaceId,
        config: {
          provider: "claude",
          model: "claude-opus-5-5",
          cwd,
          modeId: "auto",
          thinkingOptionId: "high",
        },
        title: "[L3 E2E v7] Team Toggle Smoke",
        background: false,
        metadata: { "paseo-team.enabled": true },
      });
      coordId = created?.id ?? created?.agent?.id;
      assert.ok(coordId, "expected coordinator agent id");

      await client.sendAgentMessage(
        coordId,
        `Edit only the single temporary file ${path.basename(probeFile)}: replace its contents with "after=v7" followed by a newline. Do not edit any other file, do not add tests, and do not run git commit. with review`,
      );

      const deadline = Date.now() + TIMEOUT_MS;
      let children = [];
      let done = false;
      while (Date.now() < deadline) {
        const listed = await client.fetchAgents({ filter: { cwd }, limit: 50 });
        const all = (listed?.entries ?? listed?.agents ?? [])
          .map((e) => e?.agent ?? e)
          .filter(Boolean);
        const coord = all.find((a) => a.id === coordId);
        children = all.filter(
          (a) =>
            a.parentAgentId === coordId ||
            a.labels?.["paseo.parent-agent-id"] === coordId,
        );
        for (const c of children) {
          if (!spawnedIds.includes(c.id)) spawnedIds.push(c.id);
        }
        const allIdle =
          Boolean(coord?.lastUserMessageAt) &&
          coord?.status === "idle" &&
          children.length >= 2 &&
          children.every((c) => c.status === "idle" || c.status === "closed");
        if (
          allIdle &&
          existsSync(probeFile) &&
          readFileSync(probeFile, "utf8") === "after=v7\n"
        ) {
          done = true;
          break;
        }
        await sleep(POLL_MS);
      }

      assert.equal(
        done,
        true,
        `expected coordinator to finish via Developer + Reviewers (children=${children.length})`,
      );
      assert.equal(readFileSync(probeFile, "utf8"), "after=v7\n");
      assert.ok(
        children.some(
          (c) =>
            c.labels?.["paseo-team.role"] === "developer" ||
            /developer/i.test(c.title ?? ""),
        ),
        "expected Developer subagent",
      );
      assert.ok(
        children.some(
          (c) =>
            c.labels?.["paseo-team.role"] === "code-reviewer" ||
            /review/i.test(c.title ?? ""),
        ),
        "expected Code Reviewer subagent",
      );
    } finally {
      rmSync(probeFile, { force: true });
      const toArchive = [coordId, ...spawnedIds].filter(Boolean);
      for (const id of toArchive) {
        try {
          await client.archiveAgent?.(id);
        } catch {
          // Best-effort cleanup
        }
      }
      await client.close?.();
    }
  },
);
