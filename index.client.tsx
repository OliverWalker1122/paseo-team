import {
  type PluginClientContext,
  type PluginSidebarItemProps,
  type PluginWorkspaceRowBadgeItemProps,
  useSubscription,
} from "@getpaseo/plugin/client";
import { SidebarRow, WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { registerTeamComposerPills } from "./client/composer-pill.tsx";
import { SettingsTeamConfigSurface } from "./client/TeamConfigScreen.tsx";
import {
  AgentConversationGraphPanel,
  GlobalTeamGraphScreen,
} from "./client/TeamGraphPanel.tsx";
import {
  type PipelineTaskSnapshotDto,
  startTeamTaskRpc,
  watchConversationGraphSubscription,
} from "./shared/contracts.ts";
import { UI_TEXT } from "./shared/i18n.ts";
import { hostTitles as titles, useUiLanguage } from "./client/locale.ts";

function TeamSidebarHeaderItem({
  currentScreen,
  openScreen,
}: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Workflow"
      active={currentScreen?.screenId === "team-center"}
      onPress={() => openScreen({ screenId: "team-center" })}
    />
  );
}

function TeamWorkspaceBadge({ workspaceId }: PluginWorkspaceRowBadgeItemProps) {
  const [matchedTask, setMatchedTask] =
    useState<PipelineTaskSnapshotDto | null>(null);
  const lang = useUiLanguage();
  const graphInput = useMemo(
    () => ({ workspaceId, language: lang }),
    [workspaceId, lang],
  );

  useSubscription(watchConversationGraphSubscription, graphInput, (event) => {
    setMatchedTask(event.mode === "team_task" ? event.task : null);
  });

  if (
    !matchedTask ||
    matchedTask.lifecycleStatus === "abandoned" ||
    matchedTask.lifecycleStatus === "completed"
  ) {
    return null;
  }
  const t = UI_TEXT[lang];

  if (matchedTask.circuitBroken) {
    return (
      <WorkspaceRowBadge
        icon="AlertTriangle"
        label={t.badgeHalted}
        tone="danger"
      />
    );
  }
  if (matchedTask.runningCount > 0) {
    return (
      <WorkspaceRowBadge
        icon="Workflow"
        label={t.badgeRunning(matchedTask.runningCount)}
        tone="info"
      />
    );
  }
  return null;
}

export default function contribute(client: PluginClientContext) {
  const cleanups: (() => void)[] = [];

  cleanups.push(
    client.addScreen({
      id: "team-center",
      title: titles.message("team"),
      Component: GlobalTeamGraphScreen,
    }),
  );

  cleanups.push(
    client.addSidebarHeaderItem({
      id: "team-center",
      title: titles.message("team"),
      Component: TeamSidebarHeaderItem,
    }),
  );

  cleanups.push(
    client.addSettingsScreen({
      id: "team-settings",
      title: titles.message("team"),
      icon: "Workflow",
      Component: SettingsTeamConfigSurface,
    }),
  );

  cleanups.push(
    client.addAgentPanel({
      id: "team-agent-graph",
      title: titles.message("teamGraph"),
      icon: "Workflow",
      Component: AgentConversationGraphPanel,
    }),
  );

  cleanups.push(
    client.addWorkspaceRowBadgeItem({
      id: "team-badge",
      title: titles.message("teamStatus"),
      icon: "Workflow",
      Component: TeamWorkspaceBadge,
    }),
  );

  cleanups.push(registerTeamComposerPills(client));

  cleanups.push(
    client.addCommandCenterItem({
      id: "open-team-agent-graph",
      title: titles.message("openGraph"),
      icon: "Workflow",
      keywords: ["team", "graph", "pipeline", "agents", "subagents", "状态图"],
      context: "agent",
      onSelect({ openPanel }) {
        openPanel("team-agent-graph");
      },
    }),
  );

  cleanups.push(
    client.addCommandCenterItem({
      id: "open-team-config",
      title: titles.message("openSetup"),
      icon: "Settings2",
      keywords: ["team", "setup", "config", "model", "reviewer", "配置"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: "team-center", params: { tab: "config" } });
      },
    }),
  );

  cleanups.push(
    client.addSlashCommand({
      name: "paseo-team",
      description:
        "Start a team task in this chat, or open setup (setup) / the team graph (status)",
      argumentHint: '[setup | status | task goal (e.g. "with review")]',
      context: "agent",
      async onSubmit({ args, workspace, agent, rpc, openPanel, openScreen }) {
        const trimmed = args.trim();
        if (trimmed === "setup" || trimmed === "config") {
          openScreen({
            screenId: "team-center",
            params: { tab: "config", cwd: workspace.directory },
          });
          return;
        }
        if (!trimmed || trimmed === "status" || trimmed === "graph") {
          openPanel("team-agent-graph");
          return;
        }
        await rpc(startTeamTaskRpc, {
          cwd: workspace.directory,
          workspaceId: workspace.id,
          agentId: agent.id,
          rawArgs: trimmed,
        });
        openPanel("team-agent-graph");
      },
    }),
  );

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}
