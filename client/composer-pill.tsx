import type {
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { watchTasksSubscription } from "../shared/contracts.ts";
import { UI_TEXT } from "../shared/i18n.ts";
import { toUiLanguage } from "./locale.ts";

interface TrackedAgent {
  id: string;
  workspaceId: string;
  parentAgentId: string | null;
  status: string;
  requiresAttention: boolean;
  background: boolean;
}

export function registerTeamComposerPills(
  client: PluginClientContext,
): () => void {
  const pills = new Map<string, PluginButtonRegistration>();
  const agents = new Map<string, TrackedAgent>();
  const teamLabelByAgent = new Map<string, string>();
  const currentLang = () => toUiLanguage(client.i18n.locale);
  const lifetime = new AbortController();

  const findRootId = (agentId: string): string => {
    let cur = agentId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const a = agents.get(cur);
      if (!a?.parentAgentId) break;
      cur = a.parentAgentId;
    }
    return cur;
  };

  const computeLabelForAgent = (agentId: string): string => {
    const t = UI_TEXT[currentLang()];
    const rootId = findRootId(agentId);
    const teamDirect =
      teamLabelByAgent.get(agentId) ?? teamLabelByAgent.get(rootId);
    if (teamDirect) return teamDirect;

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

    if (attentionChildren > 0) {
      return t.pillAttention(attentionChildren);
    }
    if (runningChildren > 0) {
      return t.pillRunning(runningChildren);
    }
    if (childCount > 0) {
      return t.pillSubagents(childCount);
    }
    return t.pillDefault;
  };

  const syncAllPills = () => {
    for (const [agentId, info] of agents.entries()) {
      if (info.background || !info.workspaceId) continue;
      const label = computeLabelForAgent(agentId);
      const existing = pills.get(agentId);
      if (existing) {
        existing.update({
          label,
          title: label,
        });
      } else {
        pills.set(
          agentId,
          client.addComposerPill({
            id: "paseo-team-flow",
            workspaceId: info.workspaceId,
            agentId,
            button: {
              title: label,
              icon: "Workflow",
              label,
              behavior: {
                kind: "action",
                onPress() {
                  client.openPanel("team-agent-graph", {
                    workspaceId: info.workspaceId,
                    agentId,
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

  const subHandle = client.subscribe(
    watchTasksSubscription,
    { includeAllProjects: true, language: currentLang() },
    (event) => {
      const t = UI_TEXT[currentLang()];
      teamLabelByAgent.clear();
      for (const task of event.tasks) {
        let badge = `Team · ${task.teamName}`;
        if (task.lifecycleStatus === "abandoned") {
          badge = t.pillDefault;
        } else if (task.circuitBroken) {
          badge = t.pillBreaker;
        } else if (task.attentionCount > 0) {
          badge = t.pillAttention(task.attentionCount);
        } else if (task.runningCount > 0) {
          badge = t.pillRunning(task.runningCount);
        } else if (task.lifecycleStatus === "completed") {
          badge = t.pillDone;
        } else if (task.codeReviewRound > 0) {
          badge = `Team · R${task.codeReviewRound}/2`;
        } else if (task.planReviewRound > 0) {
          badge = `Team · Plan R${task.planReviewRound}/2`;
        }

        if (
          task.coordinatorAgentId &&
          !teamLabelByAgent.has(task.coordinatorAgentId)
        ) {
          teamLabelByAgent.set(task.coordinatorAgentId, badge);
        }
        for (const st of task.stages) {
          for (const n of st.nodes) {
            if (n.agentId && !teamLabelByAgent.has(n.agentId)) {
              teamLabelByAgent.set(n.agentId, `${n.label} · ${t.pillDefault}`);
            }
          }
        }
      }
      syncAllPills();
    },
    { signal: lifetime.signal },
  );

  const recordAgent = (raw: {
    id: string;
    workspaceId?: string | null;
    parentAgentId?: string | null;
    status?: string;
    pendingPermissions?: unknown[];
    background?: boolean;
  }) => {
    if (!raw.workspaceId) return;
    agents.set(raw.id, {
      id: raw.id,
      workspaceId: raw.workspaceId,
      parentAgentId: raw.parentAgentId ?? null,
      status: raw.status ?? "idle",
      requiresAttention:
        Array.isArray(raw.pendingPermissions) &&
        raw.pendingPermissions.length > 0,
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
    void subHandle.release();
    removeAll();
  };
}
