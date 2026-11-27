import type { PluginTheme } from "@getpaseo/plugin";
import {
  type PluginScreenProps,
  type PluginWorkspacePanelProps,
  useSubscription,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { Icon, Loading, ScrollView } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import {
  Pressable,
  type PressableStateCallbackType,
  Text,
  View,
} from "react-native";
import {
  type AgentRoleDto,
  type AgentTreeSnapshotDto,
  type ConversationGraphPayloadDto,
  type GraphNodeDto,
  type LiveAgentStatusDto,
  watchActiveTreesSubscription,
  watchConversationGraphSubscription,
} from "../shared/contracts.ts";
import { UI_TEXT, type UiLanguage } from "../shared/i18n.ts";
import { useUiLanguage } from "./locale.ts";
import { TeamConfigView } from "./TeamConfigScreen.tsx";

type HoverState = PressableStateCallbackType & { hovered?: boolean };
type OpenAgentFn = (input: { agentId: string; focusHost?: boolean }) => void;

const focusedAgentByWorkspace = new Map<string, string>();
const focusListeners = new Map<string, Set<() => void>>();

export function focusWorkspaceGraphAgent(
  workspaceId: string,
  agentId: string,
): void {
  if (!workspaceId || !agentId) return;
  focusedAgentByWorkspace.set(workspaceId, agentId);
  for (const fn of focusListeners.get(workspaceId) ?? []) fn();
}

function subscribeWorkspaceFocus(
  workspaceId: string,
  listener: () => void,
): () => void {
  let set = focusListeners.get(workspaceId);
  if (!set) {
    set = new Set();
    focusListeners.set(workspaceId, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set && set.size === 0) focusListeners.delete(workspaceId);
  };
}

function formatShortTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${mm}-${dd} ${hh}:${mi}`;
  } catch {
    return "";
  }
}

function folderBasename(cwd: string): string {
  const cleaned = cwd.replace(/[\\/]+$/, "");
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

function roleIconName(role: AgentRoleDto): string {
  switch (role) {
    case "coordinator":
      return "Compass";
    case "expert":
      return "Brain";
    case "plan-reviewer":
      return "FileSearch";
    case "developer":
      return "Code2";
    case "code-reviewer":
      return "ScanSearch";
    case "subagent":
      return "Bot";
  }
}

function statusMeta(
  theme: PluginTheme,
  lang: UiLanguage,
  status: LiveAgentStatusDto,
) {
  const t = UI_TEXT[lang];
  switch (status) {
    case "running":
      return {
        dot: theme.colors.accent,
        border: theme.colors.accent,
        labelColor: theme.colors.foreground,
        pillBg: theme.colors.surface2,
        pillBorder: theme.colors.accent,
        label: t.statusRunning,
      };
    case "initializing":
      return {
        dot: theme.colors.accent,
        border: theme.colors.accent,
        labelColor: theme.colors.foreground,
        pillBg: theme.colors.surface2,
        pillBorder: theme.colors.accent,
        label: t.statusInit,
      };
    case "awaiting_permission":
      return {
        dot: theme.colors.statusWarning,
        border: theme.colors.statusWarning,
        labelColor: theme.colors.statusWarning,
        pillBg: theme.colors.surface2,
        pillBorder: theme.colors.statusWarning,
        label: t.statusPerm,
      };
    case "error":
      return {
        dot: theme.colors.statusDanger,
        border: theme.colors.statusDanger,
        labelColor: theme.colors.statusDanger,
        pillBg: theme.colors.surface2,
        pillBorder: theme.colors.statusDanger,
        label: t.statusError,
      };
    case "closed":
      return {
        dot: theme.colors.foregroundMuted,
        border: theme.colors.border,
        labelColor: theme.colors.foregroundMuted,
        pillBg: theme.colors.surface0,
        pillBorder: theme.colors.border,
        label: t.statusClosed,
      };
    case "idle":
    default:
      return {
        dot: theme.colors.statusSuccess,
        border: theme.colors.border,
        labelColor: theme.colors.foreground,
        pillBg: theme.colors.surface0,
        pillBorder: theme.colors.border,
        label: t.statusIdle,
      };
  }
}

function ToolbarButton({
  theme,
  icon,
  label,
  primary,
  onPress,
}: {
  theme: PluginTheme;
  icon: string;
  label: string;
  primary?: boolean;
  onPress: () => void;
}) {
  const fg = primary ? theme.colors.accentForeground : theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ hovered }: HoverState) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 7,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: primary ? theme.colors.accent : theme.colors.border,
        backgroundColor: primary
          ? theme.colors.accent
          : hovered
            ? theme.colors.surface2
            : theme.colors.surface0,
        opacity: primary && hovered ? 0.9 : 1,
      })}
    >
      <Icon name={icon} size={15} color={fg} />
      <Text style={{ color: fg, fontSize: 13, fontWeight: "600" }}>
        {label}
      </Text>
    </Pressable>
  );
}

function StatusChip({
  theme,
  dotColor,
  borderColor,
  textColor,
  label,
}: {
  theme: PluginTheme;
  dotColor?: string;
  borderColor?: string;
  textColor?: string;
  label: string;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 9,
        paddingVertical: 4,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: borderColor ?? theme.colors.border,
        backgroundColor: theme.colors.surface0,
      }}
    >
      {dotColor ? (
        <View
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            backgroundColor: dotColor,
          }}
        />
      ) : null}
      <Text
        numberOfLines={1}
        style={{
          color: textColor ?? theme.colors.foregroundMuted,
          fontSize: 12,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </View>
  );
}

function NodeCard({
  node,
  theme,
  lang,
  selected,
  compact,
  onSelect,
}: {
  node: GraphNodeDto;
  theme: PluginTheme;
  lang: UiLanguage;
  selected: boolean;
  compact: boolean;
  onSelect: () => void;
}) {
  const pal = statusMeta(theme, lang, node.status);
  const isActive =
    node.status === "running" ||
    node.status === "initializing" ||
    node.status === "awaiting_permission";

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onSelect}
      style={({ hovered }: HoverState) => ({
        width: compact ? "100%" : 272,
        maxWidth: compact ? 360 : 300,
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderRadius: 14,
        borderWidth: selected || isActive ? 1.5 : 1,
        borderColor: selected
          ? theme.colors.accent
          : isActive
            ? pal.border
            : hovered
              ? theme.colors.foregroundMuted
              : theme.colors.border,
        backgroundColor: selected
          ? theme.colors.surface2
          : hovered
            ? theme.colors.surface2
            : theme.colors.surface1,
        gap: 10,
      })}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            flex: 1,
            minWidth: 0,
          }}
        >
          <View
            style={{
              width: 32,
              height: 32,
              borderRadius: 9,
              backgroundColor: theme.colors.surface0,
              borderWidth: 1,
              borderColor: pal.border,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name={roleIconName(node.role)} size={16} color={pal.dot} />
          </View>
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              color: theme.colors.foreground,
              fontSize: 14,
              fontWeight: "700",
            }}
          >
            {node.label}
          </Text>
        </View>

        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 5,
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: pal.pillBorder,
            backgroundColor: pal.pillBg,
          }}
        >
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: pal.dot,
            }}
          />
          <Text
            numberOfLines={1}
            style={{
              color: pal.labelColor,
              fontSize: 11.5,
              fontWeight: "600",
            }}
          >
            {pal.label}
          </Text>
        </View>
      </View>

      <View style={{ gap: 3 }}>
        <Text
          numberOfLines={1}
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            fontWeight: "500",
          }}
        >
          {node.modelBadge}
        </Text>
        {node.perspectiveLabel ? (
          <Text
            numberOfLines={1}
            style={{ color: theme.colors.foregroundMuted, fontSize: 11.5 }}
          >
            {UI_TEXT[lang].focusPrefix} {node.perspectiveLabel}
          </Text>
        ) : node.title && node.title !== node.label ? (
          <Text
            numberOfLines={1}
            style={{ color: theme.colors.foregroundMuted, fontSize: 11.5 }}
          >
            {node.title}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function NodeInspectorCard({
  node,
  theme,
  lang,
  onOpenAgent,
}: {
  node: GraphNodeDto;
  theme: PluginTheme;
  lang: UiLanguage;
  onOpenAgent?: OpenAgentFn;
}) {
  const t = UI_TEXT[lang];
  const pal = statusMeta(theme, lang, node.status);
  const metaLine = [
    node.modelBadge,
    pal.label,
    node.perspectiveLabel ? `${t.focusPrefix} ${node.perspectiveLabel}` : "",
    formatShortTime(node.updatedAt),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <View
      style={{
        width: "100%",
        maxWidth: 580,
        padding: 16,
        borderRadius: 14,
        borderWidth: 1.5,
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.surface1,
        gap: 12,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <View style={{ flex: 1, minWidth: 180, gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
            <Icon name={roleIconName(node.role)} size={15} color={pal.dot} />
            <Text
              style={{
                color: theme.colors.foreground,
                fontSize: 15,
                fontWeight: "700",
              }}
            >
              {node.label}
            </Text>
          </View>
          <Text
            style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}
            numberOfLines={2}
          >
            {metaLine}
          </Text>
        </View>
        {onOpenAgent ? (
          <ToolbarButton
            theme={theme}
            primary
            icon="ArrowUpRight"
            label={t.openSubagentBtn}
            onPress={() => onOpenAgent({ agentId: node.agentId })}
          />
        ) : null}
      </View>

      <View
        style={{
          paddingTop: 10,
          borderTopWidth: 1,
          borderTopColor: theme.colors.border,
          gap: 4,
        }}
      >
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 11.5,
            fontWeight: "600",
          }}
        >
          {t.responsibilityTitle}
        </Text>
        <Text
          style={{
            color: theme.colors.foreground,
            fontSize: 13.5,
            lineHeight: 20,
          }}
        >
          {node.title}
        </Text>
      </View>
    </View>
  );
}

function AgentTreeCanvas({
  tree,
  theme,
  compact,
  lang,
  hideHeader,
  onOpenAgent,
}: {
  tree: AgentTreeSnapshotDto;
  theme: PluginTheme;
  compact: boolean;
  lang: UiLanguage;
  hideHeader?: boolean;
  onOpenAgent?: OpenAgentFn;
}) {
  const t = UI_TEXT[lang];
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const allNodes = useMemo(
    () => tree.layers.flatMap((l) => l.nodes),
    [tree.layers],
  );
  const selectedNode = useMemo(
    () => allNodes.find((n) => n.agentId === selectedId) ?? null,
    [allNodes, selectedId],
  );

  return (
    <View
      style={{
        width: "100%",
        maxWidth: 820,
        alignSelf: "center",
        gap: 20,
      }}
    >
      {!hideHeader ? (
        <View
          style={{
            padding: compact ? 14 : 18,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
            gap: 10,
          }}
        >
          <Text
            style={{
              color: theme.colors.foreground,
              fontSize: compact ? 16 : 18,
              fontWeight: "700",
              lineHeight: 25,
            }}
            numberOfLines={3}
          >
            {tree.title}
          </Text>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            {tree.runningCount > 0 ? (
              <StatusChip
                theme={theme}
                dotColor={theme.colors.accent}
                borderColor={theme.colors.accent}
                textColor={theme.colors.foreground}
                label={t.statusRunningCount(tree.runningCount)}
              />
            ) : null}
            {tree.attentionCount > 0 ? (
              <StatusChip
                theme={theme}
                dotColor={theme.colors.statusWarning}
                borderColor={theme.colors.statusWarning}
                textColor={theme.colors.statusWarning}
                label={t.statusAttentionCount(tree.attentionCount)}
              />
            ) : null}
            {tree.runningCount === 0 && tree.attentionCount === 0 ? (
              <StatusChip
                theme={theme}
                dotColor={theme.colors.statusSuccess}
                textColor={theme.colors.foreground}
                label={t.statusIdle}
              />
            ) : null}
            <StatusChip
              theme={theme}
              label={`${t.agentCountLabel(tree.totalAgents)} · ${formatShortTime(tree.updatedAt)}`}
            />
          </View>
        </View>
      ) : null}

      <View
        style={{
          alignItems: "center",
          paddingVertical: hideHeader ? 8 : 12,
          paddingHorizontal: compact ? 4 : 12,
        }}
      >
        {tree.layers.map((layer, idx) => {
          const selectedInLayer =
            selectedNode &&
            layer.nodes.some((n) => n.agentId === selectedNode.agentId)
              ? selectedNode
              : null;
          return (
            <View
              key={layer.layerId}
              style={{ width: "100%", alignItems: "center" }}
            >
              {idx > 0 ? (
                <View style={{ alignItems: "center", paddingVertical: 4 }}>
                  <View
                    style={{
                      width: 2,
                      height: 16,
                      backgroundColor: theme.colors.border,
                    }}
                  />
                  <Text
                    style={{
                      color: theme.colors.foregroundMuted,
                      fontSize: 11,
                      fontWeight: "600",
                      paddingVertical: 3,
                    }}
                  >
                    {layer.title}
                  </Text>
                  <View
                    style={{
                      width: 2,
                      height: 12,
                      backgroundColor: theme.colors.border,
                    }}
                  />
                </View>
              ) : null}

              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "center",
                  flexWrap: "wrap",
                  gap: 14,
                  width: "100%",
                }}
              >
                {layer.nodes.map((node) => (
                  <NodeCard
                    key={node.agentId}
                    node={node}
                    theme={theme}
                    lang={lang}
                    selected={selectedId === node.agentId}
                    compact={compact}
                    onSelect={() =>
                      setSelectedId((prev) =>
                        prev === node.agentId ? null : node.agentId,
                      )
                    }
                  />
                ))}
              </View>

              {selectedInLayer ? (
                <View
                  style={{
                    width: "100%",
                    alignItems: "center",
                    marginTop: 12,
                  }}
                >
                  <NodeInspectorCard
                    node={selectedInLayer}
                    theme={theme}
                    lang={lang}
                    onOpenAgent={onOpenAgent}
                  />
                </View>
              ) : null}
            </View>
          );
        })}

        {!selectedNode ? (
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 12.5,
              marginTop: 18,
            }}
          >
            {t.pickNodeHint}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export function WorkspaceConversationGraphPanel({
  theme,
  layout,
  workspaceId,
  navigation,
}: PluginWorkspacePanelProps) {
  const lang = useUiLanguage();
  const t = UI_TEXT[lang];
  const directory = useWorkspace(workspaceId, (ws) => ws.directory);
  const [viewMode, setViewMode] = useState<"graph" | "config">("graph");
  const [focusedAgentId, setFocusedAgentId] = useState<string | undefined>(() =>
    focusedAgentByWorkspace.get(workspaceId),
  );
  const [payload, setPayload] = useState<ConversationGraphPayloadDto | null>(
    null,
  );

  useEffect(() => {
    setFocusedAgentId(focusedAgentByWorkspace.get(workspaceId));
    return subscribeWorkspaceFocus(workspaceId, () => {
      setFocusedAgentId(focusedAgentByWorkspace.get(workspaceId));
    });
  }, [workspaceId]);

  const subInput = useMemo(
    () => ({
      workspaceId,
      ...(focusedAgentId ? { agentId: focusedAgentId } : {}),
      language: lang,
    }),
    [workspaceId, focusedAgentId, lang],
  );

  useSubscription(watchConversationGraphSubscription, subInput, (ev) => {
    setPayload(ev);
  });

  const openAgent: OpenAgentFn | undefined = navigation?.openAgent
    ? ({ agentId, focusHost }) =>
        navigation.openAgent({
          agentId,
          ...(focusHost ? { focusHost } : {}),
        })
    : undefined;

  const mainChatId =
    payload?.tree?.rootAgentId ?? payload?.rootAgentId ?? focusedAgentId;

  const topBarPadding = layout.compact ? 14 : 22;

  if (viewMode === "config") {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: topBarPadding,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
            gap: 10,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <ToolbarButton
              theme={theme}
              icon="Users"
              label={t.backToGraph}
              onPress={() => setViewMode("graph")}
            />
            {mainChatId && openAgent ? (
              <ToolbarButton
                theme={theme}
                icon="ArrowLeft"
                label={t.backToMainChat}
                onPress={() => openAgent({ agentId: mainChatId })}
              />
            ) : null}
          </View>
        </View>
        <TeamConfigView
          theme={theme}
          compact={layout.compact}
          cwd={directory || undefined}
        />
      </View>
    );
  }

  if (!payload) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
        <Loading />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: topBarPadding,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          gap: 10,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {mainChatId && openAgent ? (
            <ToolbarButton
              theme={theme}
              icon="ArrowLeft"
              label={t.backToMainChat}
              onPress={() => openAgent({ agentId: mainChatId })}
            />
          ) : null}
        </View>
        <ToolbarButton
          theme={theme}
          icon="Settings2"
          label={t.configureTeam}
          onPress={() => setViewMode("config")}
        />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: topBarPadding,
          paddingVertical: layout.compact ? 16 : 24,
        }}
      >
        {payload.tree ? (
          <AgentTreeCanvas
            tree={payload.tree}
            theme={theme}
            compact={layout.compact}
            lang={lang}
            onOpenAgent={openAgent}
          />
        ) : (
          <View
            style={{
              paddingVertical: 56,
              paddingHorizontal: 16,
              alignItems: "center",
              gap: 12,
            }}
          >
            <Icon name="Users" size={30} color={theme.colors.foregroundMuted} />
            <Text
              style={{
                color: theme.colors.foreground,
                fontSize: 16,
                fontWeight: "700",
                textAlign: "center",
              }}
            >
              {t.emptyTitle}
            </Text>
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 13.5,
                textAlign: "center",
                maxWidth: 440,
                lineHeight: 21,
              }}
            >
              {t.emptyDesc}
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

export function GlobalTeamGraphScreen({
  theme,
  layout,
  params,
  navigation,
}: PluginScreenProps) {
  const lang = useUiLanguage();
  const t = UI_TEXT[lang];
  const [tab, setTab] = useState<"running" | "history" | "config">(
    params?.tab === "config"
      ? "config"
      : params?.tab === "history"
        ? "history"
        : "running",
  );
  const [trees, setTrees] = useState<AgentTreeSnapshotDto[] | null>(null);
  const [selectedRunningId, setSelectedRunningId] = useState<string | null>(
    null,
  );
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (params?.tab === "config") setTab("config");
    else if (params?.tab === "history") setTab("history");
  }, [params?.tab]);

  const subInput = useMemo(() => ({ language: lang }), [lang]);
  useSubscription(watchActiveTreesSubscription, subInput, (ev) => {
    setTrees(ev.trees);
  });

  const openAgent: OpenAgentFn | undefined = navigation?.openAgent
    ? ({ agentId }) => navigation.openAgent({ agentId, focusHost: true })
    : undefined;

  const runningTrees = useMemo(
    () => (trees ?? []).filter((tr) => tr.runningCount + tr.attentionCount > 0),
    [trees],
  );
  const historyTrees = useMemo(
    () =>
      (trees ?? []).filter((tr) => tr.runningCount + tr.attentionCount === 0),
    [trees],
  );

  const selectedRunningTree = useMemo(
    () =>
      runningTrees.find((tr) => tr.rootAgentId === selectedRunningId) ??
      runningTrees[0] ??
      null,
    [runningTrees, selectedRunningId],
  );

  const padding = layout.compact ? 14 : 24;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: padding,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          gap: 10,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {(
            [
              {
                key: "running" as const,
                label:
                  runningTrees.length > 0
                    ? `${t.tabRunning} (${runningTrees.length})`
                    : t.tabRunning,
              },
              {
                key: "history" as const,
                label:
                  historyTrees.length > 0
                    ? `${t.tabHistory} (${historyTrees.length})`
                    : t.tabHistory,
              },
              { key: "config" as const, label: t.tabConfig },
            ] as const
          ).map((item) => {
            const active = tab === item.key;
            return (
              <Pressable
                key={item.key}
                accessibilityRole="tab"
                onPress={() => setTab(item.key)}
                style={({ hovered }: HoverState) => ({
                  paddingHorizontal: 14,
                  paddingVertical: 7,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: active ? theme.colors.accent : "transparent",
                  backgroundColor: active
                    ? theme.colors.surface2
                    : hovered
                      ? theme.colors.surface0
                      : "transparent",
                })}
              >
                <Text
                  style={{
                    color: active
                      ? theme.colors.foreground
                      : theme.colors.foregroundMuted,
                    fontSize: 13.5,
                    fontWeight: active ? "700" : "500",
                  }}
                >
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {tab === "config" ? (
        <TeamConfigView
          theme={theme}
          compact={layout.compact}
          cwd={params?.cwd || undefined}
        />
      ) : trees === null ? (
        <Loading />
      ) : tab === "running" ? (
        runningTrees.length === 0 ? (
          <View
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              padding: 36,
              gap: 14,
            }}
          >
            <Icon name="Users" size={30} color={theme.colors.foregroundMuted} />
            <Text
              style={{
                color: theme.colors.foreground,
                fontSize: 15,
                fontWeight: "600",
                textAlign: "center",
              }}
            >
              {t.noRunningYet}
            </Text>
            {historyTrees.length > 0 ? (
              <ToolbarButton
                theme={theme}
                icon="History"
                label={`${t.viewHistoryBtn} (${historyTrees.length})`}
                onPress={() => setTab("history")}
              />
            ) : null}
          </View>
        ) : (
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding, gap: 18 }}
          >
            {runningTrees.length > 1 ? (
              <View
                style={{
                  width: "100%",
                  maxWidth: 820,
                  alignSelf: "center",
                  flexDirection: "row",
                  flexWrap: "wrap",
                  gap: 10,
                }}
              >
                {runningTrees.map((tr) => {
                  const isSel =
                    selectedRunningTree?.rootAgentId === tr.rootAgentId;
                  return (
                    <Pressable
                      key={tr.rootAgentId}
                      accessibilityRole="button"
                      onPress={() => setSelectedRunningId(tr.rootAgentId)}
                      style={({ hovered }: HoverState) => ({
                        maxWidth: 300,
                        paddingHorizontal: 14,
                        paddingVertical: 10,
                        borderRadius: 10,
                        borderWidth: isSel ? 1.5 : 1,
                        borderColor: isSel
                          ? theme.colors.accent
                          : hovered
                            ? theme.colors.foregroundMuted
                            : theme.colors.border,
                        backgroundColor: isSel
                          ? theme.colors.surface2
                          : theme.colors.surface1,
                        gap: 3,
                      })}
                    >
                      <Text
                        numberOfLines={1}
                        style={{
                          color: theme.colors.foreground,
                          fontSize: 13,
                          fontWeight: isSel ? "700" : "500",
                        }}
                      >
                        {tr.title}
                      </Text>
                      <Text
                        numberOfLines={1}
                        style={{
                          color: theme.colors.foregroundMuted,
                          fontSize: 11.5,
                        }}
                      >
                        {[
                          tr.runningCount > 0
                            ? t.statusRunningCount(tr.runningCount)
                            : "",
                          tr.attentionCount > 0
                            ? t.statusAttentionCount(tr.attentionCount)
                            : "",
                          folderBasename(tr.cwd),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}

            {selectedRunningTree ? (
              <View
                style={{
                  width: "100%",
                  maxWidth: 820,
                  alignSelf: "center",
                  gap: 14,
                }}
              >
                {openAgent ? (
                  <View style={{ flexDirection: "row" }}>
                    <ToolbarButton
                      theme={theme}
                      icon="ArrowLeft"
                      label={t.backToMainChat}
                      onPress={() =>
                        openAgent({ agentId: selectedRunningTree.rootAgentId })
                      }
                    />
                  </View>
                ) : null}
                <AgentTreeCanvas
                  tree={selectedRunningTree}
                  theme={theme}
                  compact={layout.compact}
                  lang={lang}
                  onOpenAgent={openAgent}
                />
              </View>
            ) : null}
          </ScrollView>
        )
      ) : historyTrees.length === 0 ? (
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            padding: 36,
            gap: 12,
          }}
        >
          <Icon name="History" size={28} color={theme.colors.foregroundMuted} />
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 13.5,
              textAlign: "center",
              maxWidth: 420,
              lineHeight: 20,
            }}
          >
            {t.noHistoryYet}
          </Text>
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding, gap: 10 }}
        >
          <View
            style={{
              width: "100%",
              maxWidth: 860,
              alignSelf: "center",
              gap: 10,
            }}
          >
            {historyTrees.map((tr) => {
              const expanded = expandedHistoryId === tr.rootAgentId;
              return (
                <View
                  key={tr.rootAgentId}
                  style={{
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: expanded
                      ? theme.colors.accent
                      : theme.colors.border,
                    backgroundColor: theme.colors.surface1,
                    overflow: "hidden",
                  }}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                      paddingRight: openAgent ? 14 : 0,
                      gap: 10,
                    }}
                  >
                    <Pressable
                      accessibilityRole="button"
                      onPress={() =>
                        setExpandedHistoryId((prev) =>
                          prev === tr.rootAgentId ? null : tr.rootAgentId,
                        )
                      }
                      style={({ hovered }: HoverState) => ({
                        flex: 1,
                        minWidth: 0,
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 12,
                        paddingHorizontal: 16,
                        paddingVertical: 14,
                        backgroundColor: hovered
                          ? theme.colors.surface2
                          : "transparent",
                      })}
                    >
                      <Icon
                        name={expanded ? "ChevronDown" : "ChevronRight"}
                        size={16}
                        color={theme.colors.foregroundMuted}
                      />
                      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                        <Text
                          numberOfLines={1}
                          style={{
                            color: theme.colors.foreground,
                            fontSize: 14,
                            fontWeight: "600",
                          }}
                        >
                          {tr.title}
                        </Text>
                        <Text
                          numberOfLines={1}
                          style={{
                            color: theme.colors.foregroundMuted,
                            fontSize: 12,
                          }}
                        >
                          {[
                            folderBasename(tr.cwd),
                            t.agentCountLabel(tr.totalAgents),
                            formatShortTime(tr.updatedAt),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </Text>
                      </View>
                    </Pressable>

                    {openAgent ? (
                      <ToolbarButton
                        theme={theme}
                        icon="ArrowUpRight"
                        label={t.openSubagentBtn}
                        onPress={() => openAgent({ agentId: tr.rootAgentId })}
                      />
                    ) : null}
                  </View>

                  {expanded ? (
                    <View
                      style={{
                        borderTopWidth: 1,
                        borderTopColor: theme.colors.border,
                        backgroundColor: theme.colors.surface0,
                        padding: layout.compact ? 12 : 18,
                      }}
                    >
                      <AgentTreeCanvas
                        tree={tr}
                        theme={theme}
                        compact={layout.compact}
                        lang={lang}
                        hideHeader
                        onOpenAgent={openAgent}
                      />
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        </ScrollView>
      )}
    </View>
  );
}
