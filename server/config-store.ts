import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UiLanguage } from "../shared/i18n.ts";

export type ComplexMode = "expert" | "simple";

export interface RoleModelSpec {
  model: string;
  thinking?: string;
}

export interface TeamPreset {
  developer: RoleModelSpec;
  codeReviewers: RoleModelSpec[];
  separatePlanReviewers?: boolean;
  planReviewers: RoleModelSpec[];
  expert?: RoleModelSpec;
  complexMode: ComplexMode;
  description?: string;
}

export interface PaseoTeamConfig {
  schemaVersion: 5;
  teams: Record<string, TeamPreset>;
  default: string | null;
  projects: Record<string, string>;
}

export const AUTO_MODEL = "auto";

export function formatRoleSpecShort(
  spec: RoleModelSpec | string | undefined,
  lang: UiLanguage = "en",
): string {
  if (!spec) return lang === "en" ? "Auto" : "自动匹配";
  if (typeof spec === "string") {
    return spec === AUTO_MODEL ? (lang === "en" ? "Auto" : "自动匹配") : spec;
  }
  if (!spec.model || spec.model === AUTO_MODEL) {
    return lang === "en" ? "Auto" : "自动匹配";
  }
  return spec.thinking && spec.thinking !== "auto"
    ? `${spec.model} · ${spec.thinking}`
    : spec.model;
}

export function defaultConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg ? path.resolve(xdg) : path.join(os.homedir(), ".config");
  return path.join(base, "paseo-team", "config.json");
}

export function defaultStateRoot(): string {
  const xdg = process.env.XDG_STATE_HOME?.trim();
  const base = xdg
    ? path.resolve(xdg)
    : path.join(os.homedir(), ".local", "state");
  return path.join(base, "paseo-team");
}

// Resolves the main repository root so all git worktrees share one project key.
export function resolveProjectKey(cwd: string): string {
  const resolvedCwd = path.resolve(cwd);
  const git = spawnSync(
    "git",
    [
      "--no-optional-locks",
      "-C",
      resolvedCwd,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ],
    { encoding: "utf8" },
  );
  if (git.status === 0) {
    const commonDir = git.stdout.trim();
    if (commonDir.endsWith(`${path.sep}.git`) || commonDir.endsWith("/.git")) {
      const repoRoot = path.dirname(commonDir);
      try {
        return realpathSync(repoRoot);
      } catch {
        return repoRoot;
      }
    }
  }
  try {
    return realpathSync(resolvedCwd);
  } catch {
    return resolvedCwd;
  }
}

function normalizeMode(raw: unknown): ComplexMode {
  if (raw === "expert") return "expert";
  return "simple";
}

export function normalizeRoleSpec(
  raw: unknown,
  legacyLookup?: Map<string, RoleModelSpec>,
): RoleModelSpec {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === AUTO_MODEL) {
      return { model: AUTO_MODEL };
    }
    const mapped = legacyLookup?.get(trimmed);
    if (mapped) {
      return {
        model: mapped.model,
        ...(mapped.thinking ? { thinking: mapped.thinking } : {}),
      };
    }
    return { model: trimmed };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    const rawModel =
      typeof r.model === "string" && r.model.trim()
        ? r.model.trim()
        : AUTO_MODEL;
    const mapped = legacyLookup?.get(rawModel);
    if (mapped) {
      return {
        model: mapped.model,
        ...(typeof r.thinking === "string" && r.thinking.trim()
          ? { thinking: r.thinking.trim() }
          : mapped.thinking
            ? { thinking: mapped.thinking }
            : {}),
      };
    }
    const thinking =
      typeof r.thinking === "string" &&
      r.thinking.trim() &&
      r.thinking.trim() !== "auto"
        ? r.thinking.trim()
        : undefined;
    return {
      model: rawModel,
      ...(thinking ? { thinking } : {}),
    };
  }
  return { model: AUTO_MODEL };
}

function normalizeRoleSpecList(
  raw: unknown,
  legacyLookup?: Map<string, RoleModelSpec>,
): RoleModelSpec[] {
  if (!Array.isArray(raw)) return [{ model: AUTO_MODEL }];
  const out: RoleModelSpec[] = [];
  for (const item of raw) {
    if (item === null || item === undefined) continue;
    if (typeof item === "string" && !item.trim()) continue;
    const spec = normalizeRoleSpec(item, legacyLookup);
    out.push(spec);
  }
  return out.length > 0 ? out : [{ model: AUTO_MODEL }];
}

function specsEqual(a: RoleModelSpec[], b: RoleModelSpec[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (item, idx) =>
      item.model === b[idx]?.model &&
      (item.thinking ?? "") === (b[idx]?.thinking ?? ""),
  );
}

export function createEmptyConfig(): PaseoTeamConfig {
  return {
    schemaVersion: 5,
    teams: {
      Standard: {
        developer: { model: AUTO_MODEL },
        codeReviewers: [{ model: AUTO_MODEL }, { model: AUTO_MODEL }],
        separatePlanReviewers: false,
        planReviewers: [{ model: AUTO_MODEL }, { model: AUTO_MODEL }],
        complexMode: "simple",
        description:
          "Auto-matched developer with adversarial cross review by two reviewers",
      },
      Fast: {
        developer: { model: AUTO_MODEL },
        codeReviewers: [{ model: AUTO_MODEL }],
        separatePlanReviewers: false,
        planReviewers: [{ model: AUTO_MODEL }],
        complexMode: "simple",
        description: "Lightweight single-reviewer preset for quick iterations",
      },
    },
    default: "Standard",
    projects: {},
  };
}

export function migrateConfig(
  raw: unknown,
  legacyLookup?: Map<string, RoleModelSpec>,
): PaseoTeamConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return createEmptyConfig();
  }
  const obj = raw as Record<string, unknown>;
  const rawTeams =
    obj.teams && typeof obj.teams === "object" && !Array.isArray(obj.teams)
      ? (obj.teams as Record<string, unknown>)
      : {};
  const teams: Record<string, TeamPreset> = {};

  for (const [name, entry] of Object.entries(rawTeams)) {
    if (
      !name.trim() ||
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry)
    ) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    const developer = normalizeRoleSpec(e.developer, legacyLookup);
    const codeReviewers = normalizeRoleSpecList(e.codeReviewers, legacyLookup);
    const rawPlan = Array.isArray(e.planReviewers)
      ? normalizeRoleSpecList(e.planReviewers, legacyLookup)
      : [...codeReviewers];
    const separatePlanReviewers =
      typeof e.separatePlanReviewers === "boolean"
        ? e.separatePlanReviewers
        : !specsEqual(rawPlan, codeReviewers);
    const planReviewers = separatePlanReviewers ? rawPlan : [...codeReviewers];
    const complexMode =
      e.complexMode === "expert" ? "expert" : normalizeMode(e.complexMode);
    const expert =
      e.expert !== undefined
        ? normalizeRoleSpec(e.expert, legacyLookup)
        : undefined;
    const description =
      typeof e.description === "string" && e.description.trim()
        ? e.description.trim()
        : undefined;

    teams[name.trim()] = {
      developer,
      codeReviewers,
      separatePlanReviewers,
      planReviewers,
      ...(expert ? { expert } : {}),
      complexMode,
      ...(description ? { description } : {}),
    };
  }

  const projects: Record<string, string> = {};
  if (
    obj.projects &&
    typeof obj.projects === "object" &&
    !Array.isArray(obj.projects)
  ) {
    for (const [projPath, teamName] of Object.entries(
      obj.projects as Record<string, unknown>,
    )) {
      if (
        typeof projPath === "string" &&
        projPath.trim() &&
        typeof teamName === "string" &&
        teams[teamName.trim()]
      ) {
        projects[projPath.trim()] = teamName.trim();
      }
    }
  }

  const teamNames = Object.keys(teams);
  if (teamNames.length === 0) {
    return createEmptyConfig();
  }

  let defaultTeam: string | null = null;
  if (typeof obj.default === "string" && teams[obj.default.trim()]) {
    defaultTeam = obj.default.trim();
  } else {
    defaultTeam = teamNames[0];
  }

  return {
    schemaVersion: 5,
    teams,
    default: defaultTeam,
    projects,
  };
}

export function loadConfig(configPath = defaultConfigPath()): {
  config: PaseoTeamConfig;
  rawVersion: number;
  exists: boolean;
  path: string;
} {
  const resolved = path.resolve(configPath);
  if (!existsSync(resolved)) {
    return {
      config: createEmptyConfig(),
      rawVersion: 5,
      exists: false,
      path: resolved,
    };
  }
  if (lstatSync(resolved).isSymbolicLink()) {
    throw new Error("Refusing to read symlinked config file.");
  }
  const text = readFileSync(resolved, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("paseo-team config.json is not valid JSON.");
  }
  const rawVersion =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Number((parsed as Record<string, unknown>).schemaVersion ?? 0)
      : 0;
  return {
    config: migrateConfig(parsed),
    rawVersion,
    exists: true,
    path: resolved,
  };
}

export function saveConfig(
  config: PaseoTeamConfig,
  configPath = defaultConfigPath(),
  legacyLookup?: Map<string, RoleModelSpec>,
): PaseoTeamConfig {
  const resolved = path.resolve(configPath);
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new Error("Refusing to write symlinked config file.");
  }
  const normalized = migrateConfig(config, legacyLookup);
  mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const temp = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temp, resolved);
  return normalized;
}

export interface EffectiveTeamResolution {
  projectKey: string;
  teamName: string;
  source: "override" | "project" | "default" | "fallback";
  preset: TeamPreset;
}

export function resolveEffectiveTeam(
  config: PaseoTeamConfig,
  cwd: string,
  options?: {
    teamOverride?: string;
    complexModeOverride?: ComplexMode;
    roleOverrides?: Partial<
      Pick<
        TeamPreset,
        "developer" | "planReviewers" | "codeReviewers" | "expert"
      >
    >;
  },
): EffectiveTeamResolution {
  const projectKey = resolveProjectKey(cwd);
  let teamName = "";
  let source: EffectiveTeamResolution["source"] = "fallback";

  if (options?.teamOverride?.trim()) {
    const requested = options.teamOverride.trim();
    if (!config.teams[requested]) {
      throw new Error(`Preset "${requested}" does not exist.`);
    }
    teamName = requested;
    source = "override";
  } else if (
    config.projects[projectKey] &&
    config.teams[config.projects[projectKey]]
  ) {
    teamName = config.projects[projectKey];
    source = "project";
  } else if (config.default && config.teams[config.default]) {
    teamName = config.default;
    source = "default";
  } else {
    const first = Object.keys(config.teams)[0];
    if (!first) {
      throw new Error("No team presets configured in Paseo Team.");
    }
    teamName = first;
    source = "fallback";
  }

  const base = config.teams[teamName];
  const effectivePlanReviewers = base.separatePlanReviewers
    ? [...base.planReviewers]
    : [...base.codeReviewers];

  const preset: TeamPreset = {
    ...base,
    codeReviewers: [...base.codeReviewers],
    planReviewers: effectivePlanReviewers,
    ...(options?.complexModeOverride
      ? { complexMode: options.complexModeOverride }
      : {}),
    ...(options?.roleOverrides?.developer
      ? { developer: options.roleOverrides.developer }
      : {}),
    ...(options?.roleOverrides?.planReviewers
      ? { planReviewers: [...options.roleOverrides.planReviewers] }
      : {}),
    ...(options?.roleOverrides?.codeReviewers
      ? { codeReviewers: [...options.roleOverrides.codeReviewers] }
      : {}),
    ...(options?.roleOverrides?.expert
      ? { expert: options.roleOverrides.expert }
      : {}),
  };

  return { projectKey, teamName, source, preset };
}
