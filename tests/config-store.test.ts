import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AUTO_MODEL,
  createEmptyConfig,
  defaultConfigPath,
  defaultStateRoot,
  formatRoleSpecShort,
  loadConfig,
  migrateConfig,
  normalizeRoleSpec,
  resolveEffectiveTeam,
  resolveProjectKey,
  saveConfig,
} from "../server/config-store.ts";

process.env.SKIP_DOTENV = "true";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

test("createEmptyConfig, formatRoleSpecShort, and normalizeRoleSpec handle valid and legacy inputs", () => {
  const empty = createEmptyConfig();
  assert.equal(empty.schemaVersion, 5);
  assert.equal(empty.default, "Standard");
  assert.equal(empty.teams.Standard.developer.model, AUTO_MODEL);

  assert.equal(formatRoleSpecShort(undefined, "en"), "Not set");
  assert.equal(formatRoleSpecShort(undefined, "zh"), "未设置");
  assert.equal(formatRoleSpecShort("auto", "en"), "Not set");
  assert.equal(formatRoleSpecShort("codex/gpt-6", "en"), "codex/gpt-6");
  assert.equal(
    formatRoleSpecShort({ model: "claude/opus", thinking: "high" }, "zh"),
    "claude/opus · high",
  );
  assert.equal(
    formatRoleSpecShort({ model: "claude/opus", thinking: "auto" }, "en"),
    "claude/opus",
  );

  assert.deepEqual(normalizeRoleSpec("bare-profile"), { model: AUTO_MODEL });
  assert.deepEqual(normalizeRoleSpec("codex/gpt-6"), { model: "codex/gpt-6" });
  assert.deepEqual(
    normalizeRoleSpec({
      model: "claude/opus",
      thinking: "high",
      mode: "bypassPermissions",
    }),
    {
      model: "claude/opus",
      thinking: "high",
      mode: "bypassPermissions",
    },
  );
  assert.deepEqual(
    normalizeRoleSpec({
      model: "antigravity/gemini-4-neon",
      mode: "auto_default",
    }),
    {
      model: "antigravity/gemini-4-neon",
    },
  );
  assert.deepEqual(normalizeRoleSpec(null), { model: AUTO_MODEL });
});

test("migrateConfig upgrades v3/v4 schemas to v5 and resolves effective teams", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "paseo-team-cfg-"));
  const projDir = path.join(tmp, "repo");
  mkdirSync(projDir, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  assert.equal(migrateConfig(null).schemaVersion, 5);
  assert.equal(migrateConfig({ teams: {} }).default, "Standard");

  const migrated = migrateConfig({
    schemaVersion: 4,
    default: "标准",
    teams: {
      标准: {
        developer: {
          model: "antigravity/gemini-4-neon",
          thinking: "xhigh",
          mode: "full-access",
        },
        codeReviewers: [
          { model: "claude/claude-opus-5-5", thinking: "high" },
          { model: "codex/gpt-6.2-astra", thinking: "high" },
        ],
        planReviewers: [{ model: "claude/claude-opus-5-5", thinking: "high" }],
        expert: { model: "claude/claude-opus-5-5", thinking: "high" },
        complexMode: "expert",
        description: "主力双审",
      },
      快速: {
        developer: "codex/gpt-6.2-astra",
        codeReviewers: [{ model: "claude/claude-sonnet-5-5", mode: "auto" }],
        planReviewers: [
          { model: "claude/claude-sonnet-5-5", mode: "bypassPermissions" },
        ],
        complexMode: "simple",
      },
    },
    projects: {
      [resolveProjectKey(projDir)]: "快速",
      "/nonexistent/invalid": "不存在预设",
    },
  });

  assert.equal(migrated.schemaVersion, 5);
  assert.equal(migrated.teams["标准"].developer.mode, "full-access");
  assert.equal(migrated.teams["标准"].separatePlanReviewers, true);
  assert.equal(migrated.teams["快速"].separatePlanReviewers, true);
  assert.equal(
    migrated.teams["快速"].planReviewers[0].mode,
    "bypassPermissions",
  );
  assert.equal(migrated.projects["/nonexistent/invalid"], undefined);

  const byProj = resolveEffectiveTeam(migrated, projDir);
  assert.equal(byProj.source, "project");
  assert.equal(byProj.teamName, "快速");

  const byOverride = resolveEffectiveTeam(migrated, projDir, {
    teamOverride: "标准",
    complexModeOverride: "simple",
  });
  assert.equal(byOverride.source, "override");
  assert.equal(byOverride.teamName, "标准");
  assert.equal(byOverride.preset.complexMode, "simple");

  assert.throws(
    () => resolveEffectiveTeam(migrated, projDir, { teamOverride: "Missing" }),
    /does not exist/,
  );

  // Round-trip persistence & symlink protection
  const cfgPath = path.join(tmp, "config.json");
  assert.equal(loadConfig(cfgPath).exists, false);
  saveConfig(migrated, cfgPath);
  const loaded = loadConfig(cfgPath);
  assert.equal(loaded.exists, true);
  assert.equal(loaded.rawVersion, 5);
  assert.equal(loaded.config.default, "标准");

  const badJsonPath = path.join(tmp, "bad.json");
  writeFileSync(badJsonPath, "{broken", "utf8");
  assert.throws(() => loadConfig(badJsonPath), /not valid JSON/);

  const symPath = path.join(tmp, "link.json");
  symlinkSync(cfgPath, symPath);
  assert.throws(() => loadConfig(symPath), /symlinked/);
  assert.throws(() => saveConfig(migrated, symPath), /symlinked/);
});

test("defaultConfigPath and defaultStateRoot respect XDG overrides", (t) => {
  const prevCfg = process.env.XDG_CONFIG_HOME;
  const prevState = process.env.XDG_STATE_HOME;
  t.after(() => {
    if (prevCfg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevCfg;
    if (prevState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevState;
  });

  process.env.XDG_CONFIG_HOME = "/tmp/xdg-cfg";
  process.env.XDG_STATE_HOME = "/tmp/xdg-state";
  assert.equal(defaultConfigPath(), "/tmp/xdg-cfg/paseo-team/config.json");
  assert.equal(defaultStateRoot(), "/tmp/xdg-state/paseo-team");
});
