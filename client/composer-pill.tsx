import type {
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { TEAM_ENABLED_METADATA_KEY } from "../shared/contracts.ts";
import { UI_TEXT } from "../shared/i18n.ts";
import { toUiLanguage } from "./locale.ts";
import { focusWorkspaceGraphAgent } from "./TeamGraphPanel.tsx";

interface TrackedAgent {
  id: string;
  workspaceId: string;
  parentAgentId: string | null;
  status: string;
  requiresAttention: boolean;
  isTeamEnabled: boolean;
  background: boolean;
}

/**
 * Pure Paseo live-state composer pill: derives status solely from Paseo's
 * real-time agent stream (supporting both `parentAgentId` and
 * `labels["paseo.parent-agent-id"]`), with zero secondary state machine.
 */
export function registerTeamComposerPills(
  client: PluginClientContext,
): () => void {
  const pills = new Map<string, PluginButtonRegistration>();
  const agents = new Map<string, TrackedAgent>();
  const currentLang = () => toUiLanguage(client.i18n.locale);
  const lifetime = new AbortController();

  const findRootId = (agentId: string): string => {
    let cur = agentId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const a = agents.get(cur);
      if (!a?.parentAgentId || !agents.has(a.parentAgentId)) break;
      cur = a.parentAgentId;
    }
    return cur;
  };

  const computeLabelForAgent = (agentId: string): string | null => {
    const t = UI_TEXT[currentLang()];
    const rootId = findRootId(agentId);
    const root = agents.get(rootId);

    let childCount = 0;
    let runningChildren = 0;
    let attentionChildren = 0;
    for (const candidate of agents.values()) {
      if (candidate.id === rootId || candidate.background) continue;
      if (findRootId(candidate.id) === rootId) {
        childCount += 1;
        if (
          candidate.status === "running" ||
          candidate.status === "initializing"
        ) {
          runningChildren += 1;
        }
        if (candidate.requiresAttention || candidate.status === "error") {
          attentionChildren += 1;
        }
      }
    }

    if (attentionChildren > 0) return t.pillAttention(attentionChildren);
    if (runningChildren > 0) return t.pillRunning(runningChildren);
    if (childCount > 0) return t.pillSubagents(childCount);
    if (root?.isTeamEnabled) return t.pillDefault;
    return null;
  };

  const syncAllPills = () => {
    for (const [agentId, info] of agents.entries()) {
      if (info.background || !info.workspaceId) continue;
      const label = computeLabelForAgent(agentId);
      const existing = pills.get(agentId);
      if (!label) {
        if (existing) {
          existing.remove();
          pills.delete(agentId);
        }
        continue;
      }
      if (existing) {
        existing.update({ label, title: label });
      } else {
        pills.set(
          agentId,
          client.addComposerPill({
            id: "paseo-team-flow",
            workspaceId: info.workspaceId,
            agentId,
            button: {
              title: label,
              icon: "Users",
              label,
              behavior: {
                kind: "action",
                onPress() {
                  focusWorkspaceGraphAgent(info.workspaceId, agentId);
                  client.openPanel("team-graph", {
                    workspaceId: info.workspaceId,
                  });
                },
              },
            },
          }),
        );
      }
    }
  };

  const removeAll = () => {
    for (const pill of pills.values()) pill.remove();
    pills.clear();
    agents.clear();
  };

  const recordAgent = (raw: {
    id: string;
    workspaceId?: string | null;
    parentAgentId?: string | null;
    labels?: Record<string, string> | null;
    metadata?: Record<string, unknown> | null;
    status?: string;
    pendingPermissions?: unknown[];
    background?: boolean;
  }) => {
    if (!raw.workspaceId) return;
    const labelParent =
      raw.labels && typeof raw.labels === "object"
        ? raw.labels["paseo.parent-agent-id"]
        : undefined;
    const parentAgentId =
      (typeof raw.parentAgentId === "string" && raw.parentAgentId) ||
      (typeof labelParent === "string" && labelParent) ||
      null;
    const isTeamEnabled = Boolean(
      raw.metadata &&
      typeof raw.metadata === "object" &&
      raw.metadata[TEAM_ENABLED_METADATA_KEY] === true,
    );
    agents.set(raw.id, {
      id: raw.id,
      workspaceId: raw.workspaceId,
      parentAgentId,
      status: raw.status ?? "idle",
      requiresAttention:
        Array.isArray(raw.pendingPermissions) &&
        raw.pendingPermissions.length > 0,
      isTeamEnabled,
      background: Boolean(raw.background),
    });
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAll();
          for (const { agent } of entries) {
            recordAgent(agent as unknown as Parameters<typeof recordAgent>[0]);
          }
          syncAllPills();
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") {
            recordAgent(
              update.agent as unknown as Parameters<typeof recordAgent>[0],
            );
            syncAllPills();
            return;
          }
          pills.get(update.agentId)?.remove();
          pills.delete(update.agentId);
          agents.delete(update.agentId);
          syncAllPills();
        },
      });
      return undefined;
    })
    .catch(() => {});

  return () => {
    lifetime.abort();
    removeAll();
  };
}
