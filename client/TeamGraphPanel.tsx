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

// Shared per-workspace focus store so one `team-graph` tab switches cleanly across agents.
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

function statusPalette(
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
        bg: theme.colors.surface2,
        text: theme.colors.accent,
        label: t.statusRunning,
      };
    case "initializing":
      return {
        dot: theme.colors.accent,
        border: theme.colors.accent,
        bg: theme.colors.surface2,
        text: theme.colors.accent,
        label: t.statusInit,
      };
    case "awaiting_permission":
      return {
        dot: theme.colors.statusWarning,
        border: theme.colors.statusWarning,
        bg: theme.colors.surface2,
        text: theme.colors.statusWarning,
        label: t.statusPerm,
      };
    case "error":
      return {
        dot: theme.colors.statusDanger,
        border: theme.colors.statusDanger,
        bg: theme.colors.surface2,
        text: theme.colors.statusDanger,
        label: t.statusError,
      };
    case "closed":
      return {
        dot: theme.colors.foregroundMuted,
        border: theme.colors.border,
        bg: theme.colors.surface1,
        text: theme.colors.foregroundMuted,
        label: t.statusClosed,
      };
    case "idle":
    default:
      return {
        dot: theme.colors.statusSuccess,
        border: theme.colors.border,
        bg: theme.colors.surface1,
        text: theme.colors.statusSuccess,
        label: t.statusIdle,
      };
  }
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
  const pal = statusPalette(theme, lang, node.status);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onSelect}
      style={({ hovered }: HoverState) => ({
        minWidth: compact ? 132 : 164,
        maxWidth: compact ? 180 : 210,
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderRadius: 12,
        borderWidth: selected ? 1.5 : 1,
        borderColor: selected
          ? theme.colors.accent
          : hovered
            ? theme.colors.foregroundMuted
            : pal.border,
        backgroundColor: selected ? theme.colors.surface2 : pal.bg,
        alignItems: "center",
        gap: 6,
      })}
    >
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 14,
          backgroundColor: theme.colors.surface0,
          borderWidth: 1,
          borderColor: pal.border,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name={roleIconName(node.role)} size={14} color={pal.dot} />
      </View>
      <Text
        numberOfLines={1}
        style={{
          color: theme.colors.foreground,
          fontSize: 13,
          fontWeight: "600",
          textAlign: "center",
        }}
      >
        {node.label}
      </Text>
      <Text
        numberOfLines={1}
        style={{ color: pal.text, fontSize: 11, fontWeight: "500" }}
      >
        {pal.label}
      </Text>
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
  const pal = statusPalette(theme, lang, node.status);
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
        maxWidth: 520,
        padding: 14,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.surface1,
        gap: 8,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Icon name={roleIconName(node.role)} size={14} color={pal.dot} />
            <Text
              style={{
                color: theme.colors.foreground,
                fontSize: 14,
                fontWeight: "600",
              }}
            >
              {node.label}
            </Text>
          </View>
          <Text
            style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}
            numberOfLines={2}
          >
            {metaLine}
          </Text>
        </View>
        {onOpenAgent ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => onOpenAgent({ agentId: node.agentId })}
            style={({ hovered }: HoverState) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 5,
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 8,
              backgroundColor: theme.colors.accent,
              opacity: hovered ? 0.9 : 1,
            })}
          >
            <Text
              style={{
                color: theme.colors.accentForeground,
                fontSize: 12,
                fontWeight: "600",
              }}
            >
              {t.openSubagentBtn}
            </Text>
            <Icon
              name="ArrowUpRight"
              size={13}
              color={theme.colors.accentForeground}
            />
          </Pressable>
        ) : null}
      </View>

      <View style={{ gap: 2 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          {t.responsibilityTitle}
        </Text>
        <Text
          style={{
            color: theme.colors.foreground,
            fontSize: 12.5,
            lineHeight: 18,
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
  onOpenAgent,
}: {
  tree: AgentTreeSnapshotDto;
  theme: PluginTheme;
  compact: boolean;
  lang: UiLanguage;
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

  const summaryParts = [
    tree.runningCount > 0 ? t.statusRunningCount(tree.runningCount) : "",
    tree.attentionCount > 0 ? t.statusAttentionCount(tree.attentionCount) : "",
    t.agentCountLabel(tree.totalAgents),
    formatShortTime(tree.updatedAt),
  ].filter(Boolean);

  return (
    <View style={{ gap: 16 }}>
      <View style={{ gap: 4 }}>
        <Text
          style={{
            color: theme.colors.foreground,
            fontSize: compact ? 15 : 16,
            fontWeight: "600",
            lineHeight: 22,
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
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor:
                tree.attentionCount > 0
                  ? theme.colors.statusWarning
                  : tree.runningCount > 0
                    ? theme.colors.accent
                    : theme.colors.statusSuccess,
            }}
          />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {summaryParts.join(" · ")}
          </Text>
        </View>
      </View>

      <View style={{ alignItems: "center", gap: 0, paddingVertical: 6 }}>
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
                <View
                  style={{
                    width: 1.5,
                    height: 22,
                    backgroundColor: theme.colors.border,
                  }}
                />
              ) : null}

              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "center",
                  flexWrap: "wrap",
                  gap: 12,
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
                    marginTop: 10,
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
              fontSize: 12,
              marginTop: 14,
            }}
          >
            {t.pickNodeHint}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function HeaderActionButton({
  theme,
  icon,
  label,
  onPress,
}: {
  theme: PluginTheme;
  icon: string;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ hovered }: HoverState) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
        opacity: hovered ? 0.85 : 1,
      })}
    >
      <Icon name={icon} size={13} color={theme.colors.foreground} />
      <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
        {label}
      </Text>
    </Pressable>
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

  if (viewMode === "config") {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: layout.compact ? 14 : 20,
            paddingTop: 12,
            paddingBottom: 6,
            gap: 8,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <HeaderActionButton
              theme={theme}
              icon="Users"
              label={t.backToGraph}
              onPress={() => setViewMode("graph")}
            />
            {mainChatId && openAgent ? (
              <HeaderActionButton
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

  const padding = layout.compact ? 14 : 22;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding, gap: 16 }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {mainChatId && openAgent ? (
            <HeaderActionButton
              theme={theme}
              icon="ArrowLeft"
              label={t.backToMainChat}
              onPress={() => openAgent({ agentId: mainChatId })}
            />
          ) : null}
        </View>
        <HeaderActionButton
          theme={theme}
          icon="Settings2"
          label={t.configureTeam}
          onPress={() => setViewMode("config")}
        />
      </View>

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
            paddingVertical: 48,
            paddingHorizontal: 16,
            alignItems: "center",
            gap: 10,
          }}
        >
          <Icon name="Users" size={28} color={theme.colors.foregroundMuted} />
          <Text
            style={{
              color: theme.colors.foreground,
              fontSize: 15,
              fontWeight: "600",
              textAlign: "center",
            }}
          >
            {t.emptyTitle}
          </Text>
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 13,
              textAlign: "center",
              maxWidth: 420,
              lineHeight: 20,
            }}
          >
            {t.emptyDesc}
          </Text>
        </View>
      )}
    </ScrollView>
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
  const [tab, setTab] = useState<"trees" | "config">(
    params?.tab === "config" ? "config" : "trees",
  );
  const [filter, setFilter] = useState<"all" | "running">("all");
  const [trees, setTrees] = useState<AgentTreeSnapshotDto[] | null>(null);
  const [selectedRootId, setSelectedRootId] = useState<string | null>(null);

  useEffect(() => {
    if (params?.tab === "config") setTab("config");
  }, [params?.tab]);

  const subInput = useMemo(() => ({ language: lang }), [lang]);
  useSubscription(watchActiveTreesSubscription, subInput, (ev) => {
    setTrees(ev.trees);
  });

  const openAgent: OpenAgentFn | undefined = navigation?.openAgent
    ? ({ agentId }) => navigation.openAgent({ agentId, focusHost: true })
    : undefined;

  const filteredTrees = useMemo(() => {
    const list = trees ?? [];
    if (filter === "running") {
      return list.filter((tr) => tr.runningCount + tr.attentionCount > 0);
    }
    return list;
  }, [trees, filter]);

  const selectedTree = useMemo(
    () =>
      filteredTrees.find((tr) => tr.rootAgentId === selectedRootId) ??
      filteredTrees[0] ??
      null,
    [filteredTrees, selectedRootId],
  );

  const padding = layout.compact ? 14 : 22;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: padding,
          paddingTop: 12,
          paddingBottom: 10,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
          gap: 10,
        }}
      >
        <View style={{ flexDirection: "row", gap: 6 }}>
          {(["trees", "config"] as const).map((key) => {
            const active = tab === key;
            return (
              <Pressable
                key={key}
                accessibilityRole="tab"
                onPress={() => setTab(key)}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 8,
                  backgroundColor: active
                    ? theme.colors.surface2
                    : "transparent",
                }}
              >
                <Text
                  style={{
                    color: active
                      ? theme.colors.foreground
                      : theme.colors.foregroundMuted,
                    fontSize: 13,
                    fontWeight: active ? "600" : "500",
                  }}
                >
                  {key === "trees" ? t.tabTrees : t.tabConfig}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {tab === "trees" ? (
          <View style={{ flexDirection: "row", gap: 6 }}>
            {(["all", "running"] as const).map((f) => {
              const active = filter === f;
              return (
                <Pressable
                  key={f}
                  accessibilityRole="button"
                  onPress={() => setFilter(f)}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 4,
                    borderRadius: 6,
                    backgroundColor: active
                      ? theme.colors.accent
                      : theme.colors.surface2,
                  }}
                >
                  <Text
                    style={{
                      color: active
                        ? theme.colors.accentForeground
                        : theme.colors.foregroundMuted,
                      fontSize: 12,
                      fontWeight: "500",
                    }}
                  >
                    {f === "all" ? t.filterAll : t.filterRunning}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </View>

      {tab === "config" ? (
        <TeamConfigView
          theme={theme}
          compact={layout.compact}
          cwd={params?.cwd || undefined}
        />
      ) : trees === null ? (
        <Loading />
      ) : filteredTrees.length === 0 ? (
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            padding: 32,
            gap: 10,
          }}
        >
          <Icon name="Users" size={26} color={theme.colors.foregroundMuted} />
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 13,
              textAlign: "center",
              maxWidth: 380,
              lineHeight: 20,
            }}
          >
            {filter === "running" ? t.noTreesForFilter : t.noTreesYet}
          </Text>
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding, gap: 16 }}
        >
          {filteredTrees.length > 1 ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {filteredTrees.map((tr) => {
                const isSel = selectedTree?.rootAgentId === tr.rootAgentId;
                return (
                  <Pressable
                    key={tr.rootAgentId}
                    accessibilityRole="button"
                    onPress={() => setSelectedRootId(tr.rootAgentId)}
                    style={{
                      maxWidth: 280,
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor: isSel
                        ? theme.colors.accent
                        : theme.colors.border,
                      backgroundColor: isSel
                        ? theme.colors.surface2
                        : theme.colors.surface1,
                      gap: 2,
                    }}
                  >
                    <Text
                      numberOfLines={1}
                      style={{
                        color: theme.colors.foreground,
                        fontSize: 12,
                        fontWeight: isSel ? "600" : "500",
                      }}
                    >
                      {tr.title}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={{
                        color: theme.colors.foregroundMuted,
                        fontSize: 11,
                      }}
                    >
                      {tr.runningCount > 0
                        ? t.statusRunningCount(tr.runningCount)
                        : t.agentCountLabel(tr.totalAgents)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          {selectedTree ? (
            <View style={{ gap: 12 }}>
              {openAgent ? (
                <View style={{ flexDirection: "row" }}>
                  <HeaderActionButton
                    theme={theme}
                    icon="ArrowLeft"
                    label={t.backToMainChat}
                    onPress={() =>
                      openAgent({ agentId: selectedTree.rootAgentId })
                    }
                  />
                </View>
              ) : null}
              <AgentTreeCanvas
                tree={selectedTree}
                theme={theme}
                compact={layout.compact}
                lang={lang}
                onOpenAgent={openAgent}
              />
            </View>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}
