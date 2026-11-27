import type { PaseoApi } from "@getpaseo/client";
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
  buildConversationGraphFromMap,
  createRosterTool,
  fetchLiveAgentMap,
  inferTeamRole,
  listActiveTreesFromMap,
  type LiveAgentRecord,
  notifyConfigChanges,
  parseAgentEntriesToMap,
  parseInlineTaskDirectives,
  resolveTeamGuideForCwd,
  startTeamTask,
  subscribeConfigChanges,
  toLiveAgentRecord,
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

type LiveMapListener = (liveMap: Map<string, LiveAgentRecord>) => void;

const ACTIVE_RECONCILE_INTERVAL_MS = 15_000;

interface SharedAgentHub {
  listeners: Set<LiveMapListener>;
  liveMap: Map<string, LiveAgentRecord> | null;
  debounce: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  reconcileTimer: ReturnType<typeof setInterval> | null;
  unsubStream: (() => void) | null;
  unsubLocal: (() => void) | null;
  unsubConfig: (() => void) | null;
  releaseStream: (() => Promise<void>) | null;
  disposed: boolean;
}

function hasActiveAgents(
  liveMap: Map<string, LiveAgentRecord> | null,
): boolean {
  if (!liveMap) return false;
  for (const agent of liveMap.values()) {
    if (agent.background || agent.archivedAt) continue;
    if (
      agent.status === "running" ||
      agent.status === "initializing" ||
      agent.status === "awaiting_permission"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Maintains ONE ref-counted daemon `agents.list({ subscribe: {} })` stream per
 * `PaseoApi` instance. Note: `paseo.agents.subscribe()` alone only listens to
 * locally-forwarded events and never opens a daemon subscription on its own —
 * opening `agents.list({ subscribe: {} })` is what actually streams live
 * `agent_update` (upsert/remove) and reconnect `snapshot` events from Paseo.
 */
function createLiveAgentHubManager() {
  const hubs = new Map<PaseoApi, SharedAgentHub>();

  const teardownHub = (paseo: PaseoApi, hub: SharedAgentHub) => {
    if (hub.disposed) return;
    hub.disposed = true;
    hubs.delete(paseo);
    if (hub.debounce) {
      clearTimeout(hub.debounce);
      hub.debounce = null;
    }
    if (hub.retryTimer) {
      clearTimeout(hub.retryTimer);
      hub.retryTimer = null;
    }
    if (hub.reconcileTimer) {
      clearInterval(hub.reconcileTimer);
      hub.reconcileTimer = null;
    }
    hub.unsubStream?.();
    hub.unsubStream = null;
    hub.unsubLocal?.();
    hub.unsubLocal = null;
    hub.unsubConfig?.();
    hub.unsubConfig = null;
    const release = hub.releaseStream;
    hub.releaseStream = null;
    if (release) {
      void release().catch(() => {});
    }
    hub.listeners.clear();
  };

  const syncReconcileTimer = (paseo: PaseoApi, hub: SharedAgentHub) => {
    if (hub.disposed) return;
    const needsReconcile =
      hub.listeners.size > 0 && hasActiveAgents(hub.liveMap);
    if (needsReconcile && !hub.reconcileTimer) {
      const timer = setInterval(() => {
        if (hub.disposed || hub.listeners.size === 0) return;
        void fetchLiveAgentMap(paseo).then((fresh) => {
          if (hub.disposed) return;
          hub.liveMap = fresh;
          broadcastNow(paseo, hub);
        });
      }, ACTIVE_RECONCILE_INTERVAL_MS);
      if (typeof timer.unref === "function") timer.unref();
      hub.reconcileTimer = timer;
    } else if (!needsReconcile && hub.reconcileTimer) {
      clearInterval(hub.reconcileTimer);
      hub.reconcileTimer = null;
    }
  };

  const broadcastNow = (paseo: PaseoApi, hub: SharedAgentHub) => {
    if (hub.disposed || !hub.liveMap) return;
    syncReconcileTimer(paseo, hub);
    const snapshot = hub.liveMap;
    for (const listener of hub.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Ignore individual listener failure
      }
    }
  };

  const scheduleBroadcast = (paseo: PaseoApi, hub: SharedAgentHub) => {
    if (hub.disposed || hub.debounce) return;
    hub.debounce = setTimeout(() => {
      hub.debounce = null;
      broadcastNow(paseo, hub);
    }, 80);
  };

  const startHubStream = (paseo: PaseoApi, hub: SharedAgentHub) => {
    const applyUpdate = (payload: {
      kind?: string;
      agent?: unknown;
      agentId?: string;
    }) => {
      if (hub.disposed) return;
      if (!hub.liveMap) hub.liveMap = new Map();
      if (payload.kind === "upsert") {
        const rec = toLiveAgentRecord(payload.agent);
        if (rec) {
          hub.liveMap.set(rec.id, rec);
          scheduleBroadcast(paseo, hub);
        }
        return;
      }
      if (payload.kind === "remove" && typeof payload.agentId === "string") {
        if (hub.liveMap.delete(payload.agentId)) {
          scheduleBroadcast(paseo, hub);
        }
      }
    };

    const refreshViaFetch = () => {
      void fetchLiveAgentMap(paseo).then((fresh) => {
        if (hub.disposed) return;
        hub.liveMap = fresh;
        broadcastNow(paseo, hub);
      });
    };

    const openSubscription = () => {
      if (hub.disposed) return;
      void paseo.agents
        .list({
          filter: { includeArchived: true },
          page: { limit: 200 },
          subscribe: {},
        })
        .then((res) => {
          const maybeSub = (
            res as unknown as {
              entries?: Array<{ agent?: unknown }>;
              subscription?: {
                subscribe?: (obs: {
                  snapshot?: (data: {
                    entries?: Array<{ agent?: unknown }>;
                  }) => void;
                  update?: (msg: {
                    type?: string;
                    payload?: {
                      kind?: string;
                      agent?: unknown;
                      agentId?: string;
                    };
                  }) => void;
                }) => () => void;
                release?: () => Promise<void>;
              };
            }
          ).subscription;

          if (hub.disposed) {
            if (maybeSub?.release) void maybeSub.release().catch(() => {});
            return;
          }

          hub.liveMap = parseAgentEntriesToMap(res.entries);
          broadcastNow(paseo, hub);

          if (maybeSub && typeof maybeSub.subscribe === "function") {
            hub.releaseStream = maybeSub.release
              ? () => maybeSub.release!()
              : null;
            hub.unsubStream = maybeSub.subscribe({
              snapshot: (snap) => {
                if (hub.disposed) return;
                hub.liveMap = parseAgentEntriesToMap(snap?.entries);
                broadcastNow(paseo, hub);
              },
              update: (msg) => {
                if (msg?.type === "agent_update" && msg.payload) {
                  applyUpdate(msg.payload);
                }
              },
            });
          } else if (typeof paseo.agents.subscribe === "function") {
            // Fallback for simple test harnesses that emit via agents.subscribe()
            hub.unsubLocal = paseo.agents.subscribe((payload) => {
              if (payload && typeof payload === "object") {
                applyUpdate(
                  payload as {
                    kind?: string;
                    agent?: unknown;
                    agentId?: string;
                  },
                );
              } else {
                refreshViaFetch();
              }
            });
          }
        })
        .catch((err) => {
          if (hub.disposed) return;
          const msg = err instanceof Error ? err.message : String(err);
          if (!/Daemon client closed/i.test(msg)) {
            console.error("[paseo-team] agents.list subscribe failed:", err);
          }
          refreshViaFetch();
          if (!hub.retryTimer) {
            hub.retryTimer = setTimeout(() => {
              hub.retryTimer = null;
              openSubscription();
            }, 2_000);
          }
        });
    };

    hub.unsubConfig = subscribeConfigChanges(() => {
      if (hub.liveMap) broadcastNow(paseo, hub);
      else refreshViaFetch();
    });

    openSubscription();
  };

  return {
    subscribe(
      paseo: PaseoApi,
      signal: AbortSignal,
      listener: LiveMapListener,
    ): void {
      if (signal.aborted) return;
      let hub = hubs.get(paseo);
      if (!hub) {
        hub = {
          listeners: new Set(),
          liveMap: null,
          debounce: null,
          retryTimer: null,
          reconcileTimer: null,
          unsubStream: null,
          unsubLocal: null,
          unsubConfig: null,
          releaseStream: null,
          disposed: false,
        };
        hubs.set(paseo, hub);
        hub.listeners.add(listener);
        startHubStream(paseo, hub);
      } else {
        hub.listeners.add(listener);
        if (hub.liveMap) {
          listener(hub.liveMap);
        }
      }

      signal.addEventListener(
        "abort",
        () => {
          const current = hubs.get(paseo);
          if (!current) return;
          current.listeners.delete(listener);
          if (current.listeners.size === 0) {
            teardownHub(paseo, current);
          }
        },
        { once: true },
      );
    },
    disposeAll(): void {
      for (const [paseo, hub] of [...hubs.entries()]) {
        teardownHub(paseo, hub);
      }
    },
  };
}

export default function contribute(server: PluginServerContext) {
  const cleanups: (() => void)[] = [];
  const liveAgentHubs = createLiveAgentHubManager();
  cleanups.push(() => liveAgentHubs.disposeAll());

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
      let pendingMap: Map<string, LiveAgentRecord> | null = null;
      let lastSerialized: string | null = null;

      const deliver = async (initialMap: Map<string, LiveAgentRecord>) => {
        if (signal.aborted) return;
        if (pushing) {
          pendingMap = initialMap;
          return;
        }
        pushing = true;
        let currentMap: Map<string, LiveAgentRecord> | null = initialMap;
        try {
          while (currentMap && !signal.aborted) {
            const payload = buildConversationGraphFromMap(currentMap, input);
            const serialized = JSON.stringify(payload);
            if (serialized !== lastSerialized) {
              lastSerialized = serialized;
              await push({
                ...payload,
                timestamp: new Date().toISOString(),
              });
            }
            currentMap = pendingMap;
            pendingMap = null;
          }
        } catch {
          // Ignore push errors after disconnect
        } finally {
          pushing = false;
        }
      };

      liveAgentHubs.subscribe(paseo, signal, (liveMap) => {
        void deliver(liveMap);
      });
    },
  );

  server.handle(
    watchActiveTreesSubscription,
    (input, { paseo, push, signal }) => {
      let pushing = false;
      let pendingMap: Map<string, LiveAgentRecord> | null = null;
      let lastSerialized: string | null = null;

      const deliver = async (initialMap: Map<string, LiveAgentRecord>) => {
        if (signal.aborted) return;
        if (pushing) {
          pendingMap = initialMap;
          return;
        }
        pushing = true;
        let currentMap: Map<string, LiveAgentRecord> | null = initialMap;
        try {
          while (currentMap && !signal.aborted) {
            const trees = listActiveTreesFromMap(currentMap, input);
            const serialized = JSON.stringify(trees);
            if (serialized !== lastSerialized) {
              lastSerialized = serialized;
              await push({
                trees,
                timestamp: new Date().toISOString(),
              });
            }
            currentMap = pendingMap;
            pendingMap = null;
          }
        } catch {
          // Ignore push errors after disconnect
        } finally {
          pushing = false;
        }
      };

      liveAgentHubs.subscribe(paseo, signal, (liveMap) => {
        void deliver(liveMap);
      });
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
