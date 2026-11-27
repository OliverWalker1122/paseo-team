import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  getConfigBundleRpc,
  hasTeamSlashPrefix,
  saveConfigRpc,
  startTeamTaskRpc,
  TEAM_ENABLED_METADATA_KEY,
  TEAM_PERSPECTIVE_LABEL_KEY,
  TEAM_SUBAGENT_METADATA_KEY,
  watchActiveTreesSubscription,
  watchConversationGraphSubscription,
} from "./shared/contracts.ts";
import { detectPromptLanguage } from "./shared/i18n.ts";
import { saveConfig } from "./server/config-store.ts";
import {
  buildConfigBundle,
  buildConversationGraph,
  createRosterTool,
  inferTeamRole,
  listActiveTrees,
  notifyConfigChanges,
  parseInlineTaskDirectives,
  resolveTeamGuideForCwd,
  startTeamTask,
  subscribeConfigChanges,
} from "./server/handlers.ts";
import {
  buildDeveloperPrompt,
  buildExpertPrompt,
  buildReviewerPrompt,
  COORDINATOR_ROSTER_HINT,
  type ReviewerPerspective,
} from "./server/prompts.ts";

export function extractToolName(req: unknown): string | null {
  if (!req || typeof req !== "object") return null;
  const r = req as Record<string, unknown>;
  if (typeof r.toolName === "string" && r.toolName) return r.toolName;
  if (typeof r.name === "string" && r.name) return r.name;
  if (r.tool && typeof r.tool === "object") {
    const t = r.tool as Record<string, unknown>;
    if (typeof t.name === "string" && t.name) return t.name;
  }
  if (typeof r.title === "string" && r.title) return r.title;
  return null;
}

export function isAutoAllowedTeamPermission(options: {
  toolName: string | null;
  isTeamCoordinator: boolean;
  isTeamSubagent: boolean;
}): boolean {
  if (!options.toolName || options.isTeamSubagent) return false;
  if (/(?:^|__|_|\/|:|\.)paseo_team_roster$/.test(options.toolName)) {
    return true;
  }
  if (!options.isTeamCoordinator) return false;
  return /(?:^|__|_|\/|:|\.)(?:create_agent|send_agent_prompt|list_providers|list_models|list_profiles|inspect_provider|get_agent_status|get_agent_activity|list_agents|list_hosts|list_workspaces|list_pending_permissions)$/.test(
    options.toolName,
  );
}

function parsePerspective(raw: string | undefined): ReviewerPerspective {
  if (raw === "spec-boundary" || raw === "arch-simplicity") return raw;
  return "comprehensive";
}

export default function contribute(server: PluginServerContext) {
  const cleanups: (() => void)[] = [];

  server.handle(getConfigBundleRpc, async ({ cwd }, { paseo }) => {
    return buildConfigBundle(paseo, cwd);
  });

  server.handle(saveConfigRpc, async ({ config, cwd }, { paseo }) => {
    saveConfig(config);
    notifyConfigChanges();
    return buildConfigBundle(paseo, cwd);
  });

  server.handle(startTeamTaskRpc, async (input, { paseo }) => {
    return startTeamTask(paseo, input);
  });

  server.handle(
    watchConversationGraphSubscription,
    (input, { paseo, push, signal }) => {
      let pushing = false;
      let queued = false;

      const emit = async () => {
        if (signal.aborted) return;
        if (pushing) {
          queued = true;
          return;
        }
        pushing = true;
        try {
          do {
            queued = false;
            if (signal.aborted) break;
            const payload = await buildConversationGraph(paseo, input);
            if (!signal.aborted) {
              await push({
                ...payload,
                timestamp: new Date().toISOString(),
              });
            }
          } while (queued && !signal.aborted);
        } catch {
          // Ignore push errors after disconnect
        } finally {
          pushing = false;
        }
      };

      let debounce: ReturnType<typeof setTimeout> | null = null;
      const scheduleEmit = () => {
        if (signal.aborted || debounce) return;
        debounce = setTimeout(() => {
          debounce = null;
          void emit();
        }, 150);
      };

      const unsubConfig = subscribeConfigChanges(() => void emit());
      const unsubAgents = paseo.agents.subscribe(() => scheduleEmit());

      signal.addEventListener(
        "abort",
        () => {
          if (debounce) {
            clearTimeout(debounce);
            debounce = null;
          }
          unsubConfig();
          unsubAgents();
        },
        { once: true },
      );

      void emit();
    },
  );

  server.handle(
    watchActiveTreesSubscription,
    (input, { paseo, push, signal }) => {
      let pushing = false;
      let queued = false;

      const emit = async () => {
        if (signal.aborted) return;
        if (pushing) {
          queued = true;
          return;
        }
        pushing = true;
        try {
          do {
            queued = false;
            if (signal.aborted) break;
            const trees = await listActiveTrees(paseo, input);
            if (!signal.aborted) {
              await push({
                trees,
                timestamp: new Date().toISOString(),
              });
            }
          } while (queued && !signal.aborted);
        } catch {
          // Ignore push errors after disconnect
        } finally {
          pushing = false;
        }
      };

      let debounce: ReturnType<typeof setTimeout> | null = null;
      const scheduleEmit = () => {
        if (signal.aborted || debounce) return;
        debounce = setTimeout(() => {
          debounce = null;
          void emit();
        }, 150);
      };

      const unsubConfig = subscribeConfigChanges(() => void emit());
      const unsubAgents = paseo.agents.subscribe(() => scheduleEmit());

      signal.addEventListener(
        "abort",
        () => {
          if (debounce) {
            clearTimeout(debounce);
            debounce = null;
          }
          unsubConfig();
          unsubAgents();
        },
        { once: true },
      );

      void emit();
    },
  );

  cleanups.push(
    server.addHook("agent.open.before", async ({ request }, { paseo }) => {
      try {
        if (request.purpose === "history" || request.background) {
          return undefined;
        }

        const labels = request.labels ?? {};
        const parentAgentId = labels["paseo.parent-agent-id"];

        // 1. Team subagents get their concise role guide and ZERO custom plugin tools.
        const roleFromLabels = inferTeamRole({ labels });
        const subagentRole =
          roleFromLabels ??
          (parentAgentId ? inferTeamRole({ title: request.title }) : null);
        if (subagentRole) {
          // Non-blocking tag (never await setMetadata inside agent.open.before) so the
          // subagent composer hides the Team toggle without delaying session open.
          if (request.metadata?.[TEAM_SUBAGENT_METADATA_KEY] !== true) {
            const subHandle = paseo.agents.ref(request.agentId);
            if (typeof subHandle.setMetadata === "function") {
              void subHandle
                .setMetadata({ [TEAM_SUBAGENT_METADATA_KEY]: true })
                .catch(() => {});
            }
          }
          const lang = detectPromptLanguage(request.title ?? "", "en");
          const prompt =
            subagentRole === "developer"
              ? buildDeveloperPrompt(lang)
              : subagentRole === "expert"
                ? buildExpertPrompt(lang)
                : buildReviewerPrompt({
                    stage: subagentRole === "plan-reviewer" ? "plan" : "code",
                    perspective: parsePerspective(
                      labels[TEAM_PERSPECTIVE_LABEL_KEY],
                    ),
                    lang,
                  });
          return {
            ...request,
            appendSystemPrompt: [...(request.appendSystemPrompt ?? []), prompt],
          };
        }

        // 2. Same-workspace non-team subagents stay untouched; cross-workspace root spawns
        //    (e.g. a new worktree coordinator) proceed like top-level chats.
        if (parentAgentId) {
          const parentSnap = await paseo.agents
            .ref(parentAgentId)
            .refresh()
            .catch(() => null);
          const parentWs = (
            parentSnap?.agent as { workspaceId?: string } | undefined
          )?.workspaceId;
          if (!parentWs || parentWs === request.workspaceId) {
            return undefined;
          }
        }

        // 3. Top-level / cross-workspace interactive chats:
        //    - When Team mode is ON (composer toggle or `/paseo-team` initial prompt),
        //      directly inject the complete protocol + resolved role model roster (zero extra turns!).
        //    - Otherwise inject only the 1-line hint + read-only `paseo_team_roster` fallback tool.
        const teamEnabled =
          request.metadata?.[TEAM_ENABLED_METADATA_KEY] === true ||
          hasTeamSlashPrefix(request.title ?? "");
        const existingTools = request.tools ?? [];
        const hasRosterTool = existingTools.some(
          (t) => t.name === "paseo_team_roster",
        );
        const existingPrompts = request.appendSystemPrompt ?? [];
        const promptsToAppend: string[] = [];

        if (teamEnabled && request.cwd) {
          if (request.metadata?.[TEAM_ENABLED_METADATA_KEY] !== true) {
            const coordHandle = paseo.agents.ref(request.agentId);
            if (typeof coordHandle.setMetadata === "function") {
              void coordHandle
                .setMetadata({ [TEAM_ENABLED_METADATA_KEY]: true })
                .catch(() => {});
            }
          }
          const parsed = parseInlineTaskDirectives(request.title ?? "");
          const lang = detectPromptLanguage(
            parsed.goal || request.title || "",
            "en",
          );
          try {
            const resolved = await resolveTeamGuideForCwd(paseo, request.cwd, {
              teamOverride: parsed.teamOverride,
              complexModeOverride: parsed.complexModeOverride,
              requireReview: parsed.requireReview,
              requirePlanReview: parsed.requirePlanReview,
              skipReview: parsed.skipReview,
              lang,
            });
            if (!existingPrompts.includes(resolved.guide)) {
              promptsToAppend.push(resolved.guide);
            }
          } catch {
            if (!existingPrompts.includes(COORDINATOR_ROSTER_HINT)) {
              promptsToAppend.push(COORDINATOR_ROSTER_HINT);
            }
          }
        } else if (!existingPrompts.includes(COORDINATOR_ROSTER_HINT)) {
          promptsToAppend.push(COORDINATOR_ROSTER_HINT);
        }

        if (hasRosterTool && promptsToAppend.length === 0) {
          return undefined;
        }
        return {
          ...request,
          ...(promptsToAppend.length > 0
            ? {
                appendSystemPrompt: [...existingPrompts, ...promptsToAppend],
              }
            : {}),
          ...(hasRosterTool
            ? {}
            : { tools: [...existingTools, createRosterTool()] }),
        };
      } catch (err) {
        console.error("[paseo-team] agent.open.before error:", err);
        return undefined;
      }
    }),
  );

  cleanups.push(
    server.addHook(
      "agent.permission.before",
      async ({ agent, request }, { paseo }) => {
        try {
          if (request.kind !== "tool" && request.kind !== "other") return;
          const toolName = extractToolName(request);
          const isTeamSubagent = Boolean(
            agent.parentAgentId && inferTeamRole({ title: agent.title }),
          );
          const isTeamCoordinator =
            agent.metadata?.[TEAM_ENABLED_METADATA_KEY] === true ||
            hasTeamSlashPrefix(agent.title ?? "");

          if (
            isAutoAllowedTeamPermission({
              toolName,
              isTeamCoordinator,
              isTeamSubagent,
            })
          ) {
            const allowAction = Array.isArray(request.actions)
              ? request.actions.find((a) => a.behavior === "allow")
              : undefined;
            await paseo.agents
              .ref(agent.id)
              .respondToPermission({
                requestId: request.id,
                response: {
                  behavior: "allow",
                  ...(allowAction?.id
                    ? { selectedActionId: allowAction.id }
                    : {}),
                },
              })
              .catch(() => {});
          }
        } catch (err) {
          console.error("[paseo-team] agent.permission.before error:", err);
        }
      },
    ),
  );

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}
