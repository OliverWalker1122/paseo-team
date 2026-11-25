import type { PluginTheme } from "@getpaseo/plugin";
import {
  type PluginAgentPanelProps,
  type PluginScreenProps,
  useRpc,
  useSubscription,
  useWorkspace,
} from "@getpaseo/plugin/client";
import {
  Icon,
  Loading,
  ScrollView,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import {
  Pressable,
  type PressableStateCallbackType,
  Text,
  View,
} from "react-native";
import {
  type ConversationGraphPayloadDto,
  controlTaskRpc,
  getConversationGraphRpc,
  listTasksRpc,
  type PipelineNodeViewDto,
  type PipelineStageColumnDto,
  type PipelineTaskSnapshotDto,
  watchConversationGraphSubscription,
  watchTasksSubscription,
} from "../shared/contracts.ts";
import { GATE_CHECK_LABELS, UI_TEXT, type UiLanguage } from "../shared/i18n.ts";
import { useUiLanguage } from "./locale.ts";
import { TeamConfigView } from "./TeamConfigScreen.tsx";

/** react-native-web adds `hovered` to the Pressable state on pointer devices. */
type HoverState = PressableStateCallbackType & { hovered?: boolean };

function liveStateLabel(
  lang: UiLanguage,
  liveState: PipelineNodeViewDto["liveState"],
  visualStatus: PipelineNodeViewDto["visualStatus"],
): string {
  const t = UI_TEXT[lang];
  switch (liveState) {
    case "running":
      return t.liveRunning;
    case "initializing":
      return t.liveInit;
    case "awaiting_permission":
      return t.livePerm;
    case "error":
      return t.liveError;
    case "closed":
      return t.liveClosed;
    case "idle":
      return visualStatus === "approved"
        ? t.liveIdleApproved
        : visualStatus === "changes_requested"
          ? t.liveIdleChanges
          : t.liveIdleDone;
    default:
      return visualStatus === "approved" || visualStatus === "completed"
        ? t.liveDone
        : visualStatus === "skipped"
          ? t.liveSkipped
          : t.liveWaiting;
  }
}

function statusPalette(
  theme: PluginTheme,
  lang: UiLanguage,
  visualStatus: PipelineNodeViewDto["visualStatus"],
) {
  const t = UI_TEXT[lang];
  switch (visualStatus) {
    case "running":
      return {
        dot: theme.colors.accent,
        fg: theme.colors.accent,
        iconFg: theme.colors.accent,
        label: t.visRunning,
      };
    case "awaiting_permission":
      return {
        dot: theme.colors.statusWarning,
        fg: theme.colors.statusWarning,
        iconFg: theme.colors.statusWarning,
        label: t.visAuth,
      };
    case "approved":
      return {
        dot: theme.colors.statusSuccess,
        fg: theme.colors.statusSuccess,
        iconFg: theme.colors.statusSuccess,
        label: t.visApproved,
      };
    case "completed":
      return {
        dot: theme.colors.statusSuccess,
        fg: theme.colors.statusSuccess,
        iconFg: theme.colors.foreground,
        label: t.visCompleted,
      };
    case "changes_requested":
      return {
        dot: theme.colors.statusWarning,
        fg: theme.colors.statusWarning,
        iconFg: theme.colors.statusWarning,
        label: t.visChanges,
      };
    case "blocked":
      return {
        dot: theme.colors.statusDanger,
        fg: theme.colors.statusDanger,
        iconFg: theme.colors.statusDanger,
        label: t.visBlocked,
      };
    case "skipped":
      return {
        dot: theme.colors.border,
        fg: theme.colors.foregroundMuted,
        iconFg: theme.colors.foregroundMuted,
        label: t.visSkipped,
      };
    default:
      return {
        dot: theme.colors.border,
        fg: theme.colors.foregroundMuted,
        iconFg: theme.colors.foregroundMuted,
        label: t.visPending,
      };
  }
}

function roleIconName(role: PipelineNodeViewDto["role"]): string {
  switch (role) {
    case "coordinator":
      return "Compass";
    case "expert":
      return "Sparkles";
    case "plan-reviewer":
      return "FileSearch";
    case "developer":
      return "Code2";
    case "code-reviewer":
      return "ScanEye";
    case "gate":
      return "ShieldCheck";
  }
}

function edgeStrokeColor(
  theme: PluginTheme,
  fromStatus: PipelineStageColumnDto["stageStatus"],
  toStatus: PipelineStageColumnDto["stageStatus"],
): string {
  if (toStatus === "running" || toStatus === "awaiting_permission") {
    return theme.colors.accent;
  }
  if (fromStatus === "blocked") {
    return theme.colors.statusWarning;
  }
  if (fromStatus === "completed" && toStatus !== "pending") {
    return theme.colors.foregroundMuted;
  }
  return theme.colors.border;
}

/** First clause of a task goal, capped, for collapsed task rows. */
function shortGoal(goal: string): string {
  const clause = goal.split(/[。；;\n]/)[0]?.trim() || goal;
  return clause.length > 36 ? `${clause.slice(0, 36)}…` : clause;
}

function formatShortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}`;
}

type TaskStatusTone = "danger" | "success" | "accent" | "muted";

function taskStatusInfo(
  lang: UiLanguage,
  task: PipelineTaskSnapshotDto,
): { label: string; tone: TaskStatusTone } {
  const t = UI_TEXT[lang];
  if (task.lifecycleStatus === "abandoned") {
    return { label: t.statusAbandoned, tone: "muted" };
  }
  if (task.circuitBroken) return { label: t.statusHalted, tone: "danger" };
  if (task.lifecycleStatus === "completed") {
    return { label: t.statusMerged, tone: "success" };
  }
  if (task.attentionCount > 0) {
    return {
      label: t.statusAttentionCount(task.attentionCount),
      tone: "danger",
    };
  }
  if (task.runningCount > 0) {
    return { label: t.statusRunningCount(task.runningCount), tone: "accent" };
  }
  return { label: t.statusActive, tone: "muted" };
}

function toneColor(theme: PluginTheme, tone: TaskStatusTone): string {
  switch (tone) {
    case "danger":
      return theme.colors.statusDanger;
    case "success":
      return theme.colors.statusSuccess;
    case "accent":
      return theme.colors.accent;
    default:
      return theme.colors.foregroundMuted;
  }
}

function projectLabel(projectRoot: string): string {
  return projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? projectRoot;
}

function SegmentedTabs<Id extends string>({
  theme,
  items,
  value,
  onChange,
}: {
  theme: PluginTheme;
  items: readonly { id: Id; label: string; count?: number }[];
  value: Id;
  onChange: (next: Id) => void;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignSelf: "flex-start",
        padding: 2,
        gap: 2,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
      }}
    >
      {items.map((item) => {
        const active = item.id === value;
        return (
          <Pressable
            key={item.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(item.id)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 5,
              paddingHorizontal: 12,
              paddingVertical: 5,
              borderRadius: 6,
              backgroundColor: active ? theme.colors.surface2 : "transparent",
            }}
          >
            <Text
              style={{
                color: active
                  ? theme.colors.foreground
                  : theme.colors.foregroundMuted,
                fontSize: 12,
                fontWeight: active ? "600" : "500",
              }}
            >
              {item.label}
            </Text>
            {typeof item.count === "number" ? (
              <Text
                style={{
                  color: theme.colors.foregroundMuted,
                  fontSize: 11,
                }}
              >
                {item.count}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

type FindingKind = "blocking" | "advice" | "other";

function parseFinding(text: string): { kind: FindingKind; body: string } {
  const m =
    /^\s*(blocking|blocker|must[- ]fix|阻断|advice|suggestion|nit|建议)\s*[:：]\s*/i.exec(
      text,
    );
  if (!m) return { kind: "other", body: text.trim() };
  const tag = m[1].toLowerCase();
  const kind: FindingKind =
    tag === "advice" || tag === "suggestion" || tag === "nit" || tag === "建议"
      ? "advice"
      : "blocking";
  return { kind, body: text.slice(m[0].length).trim() };
}

type ReviewRound = NonNullable<PipelineNodeViewDto["rounds"]>[number];

function findingsDigest(lang: UiLanguage, round: ReviewRound): string {
  const t = UI_TEXT[lang];
  const list = round.findings ?? [];
  if (list.length === 0) return "";
  let blocking = 0;
  let advice = 0;
  for (const f of list) {
    const kind = parseFinding(f).kind;
    if (kind === "advice") advice += 1;
    else blocking += 1;
  }
  return t.findingsDigest(blocking, advice);
}

function verdictLabel(lang: UiLanguage, verdict: ReviewRound["verdict"]) {
  const t = UI_TEXT[lang];
  return verdict === "APPROVE"
    ? t.verdictApprove
    : verdict === "REQUEST_CHANGES"
      ? t.verdictChanges
      : t.verdictBlocked;
}

function verdictColor(theme: PluginTheme, verdict: ReviewRound["verdict"]) {
  return verdict === "APPROVE"
    ? theme.colors.statusSuccess
    : verdict === "REQUEST_CHANGES"
      ? theme.colors.statusWarning
      : theme.colors.statusDanger;
}

/** Card text: concrete conclusion or brief for this exact workflow step. */
/** Fixed node tile geometry; edges use the same slot width so drops land on tile centers. */
function nodeGeometry(compact: boolean) {
  const width = compact ? 132 : 156;
  return { width, slot: width + (compact ? 12 : 24) };
}

function WorkflowNodeCard({
  theme,
  lang,
  task,
  node,
  width,
  selected,
  isViewerSelf,
  onPress,
}: {
  theme: PluginTheme;
  lang: UiLanguage;
  task: PipelineTaskSnapshotDto;
  node: PipelineNodeViewDto;
  width: number;
  selected: boolean;
  isViewerSelf: boolean;
  onPress: () => void;
}) {
  const t = UI_TEXT[lang];
  const pal = statusPalette(theme, lang, node.visualStatus);
  // The round moves into the status line ("R2 已通过") so the tile keeps just the role name.
  const cardLabel = node.round
    ? node.label.replace(/\s*·\s*(?:第\s*\d+\s*轮|Round\s*\d+)\S*\s*$/i, "")
    : node.label;
  const statusText =
    node.role === "gate"
      ? task.lifecycleStatus === "completed"
        ? t.gateCompleted
        : task.gateReady
          ? t.gateReady
          : pal.label
      : node.round
        ? `R${node.round} ${pal.label}`
        : pal.label;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${node.label} · ${statusText}`}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ hovered }: HoverState) => ({
        width,
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 12,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: selected
          ? theme.colors.accent
          : hovered
            ? theme.colors.foregroundMuted
            : theme.colors.border,
        backgroundColor: selected
          ? theme.colors.surface2
          : theme.colors.surface1,
        opacity: node.visualStatus === "skipped" ? 0.55 : 1,
      })}
    >
      <View
        style={{
          width: 34,
          height: 34,
          borderRadius: 17,
          borderWidth: 2,
          borderColor: pal.dot,
          backgroundColor: theme.colors.surface0,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name={roleIconName(node.role)} size={15} color={pal.iconFg} />
      </View>
      <Text
        numberOfLines={1}
        style={{
          maxWidth: "100%",
          color: isViewerSelf ? theme.colors.accent : theme.colors.foreground,
          fontSize: 12,
          fontWeight: "600",
          textAlign: "center",
        }}
      >
        {cardLabel}
      </Text>
      <Text
        numberOfLines={1}
        style={{ color: pal.fg, fontSize: 10.5, fontWeight: "600" }}
      >
        {statusText}
      </Text>
    </Pressable>
  );
}

const EDGE_WIDTH = 1.5;
const EDGE_RADIUS = 10;

/**
 * Pure React Native edge connector between consecutive workflow steps:
 * a centered stem, plus a rounded join bar (N -> 1) and/or fork bar (1 -> N)
 * whose drops land on each parallel tile's center.
 */
function EdgeBar({
  color,
  count,
  slot,
  direction,
}: {
  color: string;
  count: number;
  slot: number;
  direction: "join" | "fork";
}) {
  const side = direction === "join" ? "Bottom" : "Top";
  return (
    <View style={{ width: count * slot, flexDirection: "row", height: 16 }}>
      {Array.from({ length: count }).map((_, idx) => {
        const first = idx === 0;
        const last = idx === count - 1;
        const line = { [`border${side}Width`]: EDGE_WIDTH, borderColor: color };
        return (
          <View
            key={`${direction}-${idx}`}
            style={{ flex: 1, flexDirection: "row" }}
          >
            <View
              style={{
                flex: 1,
                ...(first ? {} : line),
                ...(last && !first
                  ? {
                      borderRightWidth: EDGE_WIDTH,
                      [`border${side}RightRadius`]: EDGE_RADIUS,
                    }
                  : {}),
              }}
            />
            {!first && !last ? (
              <View style={{ width: EDGE_WIDTH, backgroundColor: color }} />
            ) : null}
            <View
              style={{
                flex: 1,
                ...(last ? {} : line),
                ...(first && !last
                  ? {
                      borderLeftWidth: EDGE_WIDTH,
                      [`border${side}LeftRadius`]: EDGE_RADIUS,
                    }
                  : {}),
              }}
            />
          </View>
        );
      })}
    </View>
  );
}

function WorkflowEdgeConnector({
  color,
  fromCount,
  toCount,
  slot,
}: {
  color: string;
  fromCount: number;
  toCount: number;
  slot: number;
}) {
  const stem = (height: number) => (
    <View style={{ width: EDGE_WIDTH, height, backgroundColor: color }} />
  );
  return (
    <View style={{ width: "100%", alignItems: "center" }}>
      {fromCount > 1 ? (
        <EdgeBar color={color} count={fromCount} slot={slot} direction="join" />
      ) : null}
      {stem(
        fromCount > 1 && toCount > 1
          ? 10
          : fromCount > 1 || toCount > 1
            ? 12
            : 24,
      )}
      {toCount > 1 ? (
        <EdgeBar color={color} count={toCount} slot={slot} direction="fork" />
      ) : null}
    </View>
  );
}

function ExpandableText({
  theme,
  lang,
  text,
  lines = 3,
  fontSize = 13,
}: {
  theme: PluginTheme;
  lang: UiLanguage;
  text: string;
  lines?: number;
  fontSize?: number;
}) {
  const [open, setOpen] = useState(false);
  // shortcut: length heuristic instead of measuring lines; good enough for summaries.
  const long = text.length > lines * 55 || text.split("\n").length > lines;
  return (
    <View style={{ gap: 4 }}>
      <Text
        selectable
        numberOfLines={long && !open ? lines : undefined}
        style={{
          color: theme.colors.foreground,
          fontSize,
          lineHeight: Math.round(fontSize * 1.55),
        }}
      >
        {text}
      </Text>
      {long ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setOpen((v) => !v)}
        >
          <Text
            style={{
              color: theme.colors.accent,
              fontSize: 12,
              fontWeight: "500",
            }}
          >
            {open ? UI_TEXT[lang].showLess : UI_TEXT[lang].showMore}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function SectionLabel({ theme, text }: { theme: PluginTheme; text: string }) {
  return (
    <Text
      style={{
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "600",
      }}
    >
      {text}
    </Text>
  );
}

function ReviewRoundsList({
  theme,
  lang,
  rounds,
}: {
  theme: PluginTheme;
  lang: UiLanguage;
  rounds: ReviewRound[];
}) {
  const t = UI_TEXT[lang];
  return (
    <View style={{ gap: 6 }}>
      <SectionLabel theme={theme} text={t.reviewRoundsTitle} />
      {rounds.map((round, idx) => {
        const color = verdictColor(theme, round.verdict);
        const isLast = idx === rounds.length - 1;
        return (
          <View
            key={`${round.round}-${round.recordedAt ?? idx}`}
            style={{ flexDirection: "row", gap: 10 }}
          >
            <View style={{ alignItems: "center", width: 26 }}>
              <View
                style={{
                  paddingHorizontal: 5,
                  paddingVertical: 1,
                  borderRadius: 4,
                  borderWidth: 1,
                  borderColor: color,
                }}
              >
                <Text style={{ color, fontSize: 10, fontWeight: "700" }}>
                  R{round.round}
                </Text>
              </View>
              {!isLast ? (
                <View
                  style={{
                    flex: 1,
                    width: 1,
                    marginTop: 3,
                    backgroundColor: theme.colors.border,
                  }}
                />
              ) : null}
            </View>
            <View style={{ flex: 1, gap: 4, paddingBottom: isLast ? 0 : 10 }}>
              <Text style={{ fontSize: 12 }}>
                <Text style={{ color, fontWeight: "600" }}>
                  {verdictLabel(lang, round.verdict)}
                </Text>
                <Text style={{ color: theme.colors.foregroundMuted }}>
                  {[
                    findingsDigest(lang, round),
                    round.recordedAt ? formatShortTime(round.recordedAt) : "",
                  ]
                    .filter(Boolean)
                    .map((x) => ` · ${x}`)
                    .join("")}
                </Text>
              </Text>
              {round.summary ? (
                <ExpandableText
                  theme={theme}
                  lang={lang}
                  text={round.summary}
                />
              ) : null}
              {(round.findings ?? []).map((raw, i) => {
                const f = parseFinding(raw);
                const tagColor =
                  f.kind === "blocking"
                    ? theme.colors.statusWarning
                    : theme.colors.foregroundMuted;
                return (
                  <View
                    key={`${round.round}-${i}`}
                    style={{ flexDirection: "row", gap: 6 }}
                  >
                    <Text
                      style={{
                        color: tagColor,
                        fontSize: 11,
                        fontWeight: "600",
                        minWidth: 30,
                        lineHeight: 18,
                      }}
                    >
                      {f.kind === "blocking"
                        ? t.findingBlocking
                        : f.kind === "advice"
                          ? t.findingAdvice
                          : "•"}
                    </Text>
                    <View style={{ flex: 1 }}>
                      <ExpandableText
                        theme={theme}
                        lang={lang}
                        text={f.body}
                        lines={2}
                        fontSize={12}
                      />
                    </View>
                  </View>
                );
              })}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function NodeInspector({
  theme,
  compact,
  lang,
  task,
  node,
  viewerAgentId,
  controlling,
  onControl,
  onOpenAgent,
}: {
  theme: PluginTheme;
  compact: boolean;
  lang: UiLanguage;
  task: PipelineTaskSnapshotDto;
  node: PipelineNodeViewDto;
  viewerAgentId?: string | null;
  controlling: boolean;
  onControl: (action: "inspect_gate" | "complete_task") => void;
  onOpenAgent?: (agentId: string, serverId?: string) => void;
}) {
  const t = UI_TEXT[lang];
  const gateLabels = GATE_CHECK_LABELS[lang];
  const hasRounds = (node.rounds?.length ?? 0) > 0;
  return (
    <View
      style={{
        marginTop: 10,
        padding: 16,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.surface1,
        gap: 12,
      }}
    >
      <View
        style={{
          flexDirection: compact ? "column" : "row",
          justifyContent: "space-between",
          alignItems: compact ? "flex-start" : "center",
          gap: 10,
        }}
      >
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Icon
              name={roleIconName(node.role)}
              size={14}
              color={statusPalette(theme, lang, node.visualStatus).iconFg}
            />
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
            numberOfLines={1}
            style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}
          >
            {[
              node.modelBadge || node.profile,
              liveStateLabel(lang, node.liveState, node.visualStatus),
              node.perspectiveLabel
                ? `${t.focusPrefix} ${node.perspectiveLabel}`
                : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </View>

        <View style={{ flexDirection: "row", gap: 6 }}>
          {node.role === "gate" && task.recordPath ? (
            <>
              <Pressable
                accessibilityRole="button"
                disabled={controlling}
                onPress={() => onControl("inspect_gate")}
                style={{
                  paddingHorizontal: 11,
                  paddingVertical: 6,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                }}
              >
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 12,
                    fontWeight: "500",
                  }}
                >
                  {t.recheckGateBtn}
                </Text>
              </Pressable>
              {task.lifecycleStatus !== "completed" ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={controlling}
                  onPress={() => onControl("complete_task")}
                  style={{
                    paddingHorizontal: 11,
                    paddingVertical: 6,
                    borderRadius: 6,
                    backgroundColor: theme.colors.accent,
                  }}
                >
                  <Text
                    style={{
                      color: theme.colors.accentForeground,
                      fontSize: 12,
                      fontWeight: "600",
                    }}
                  >
                    {t.completeTaskBtn}
                  </Text>
                </Pressable>
              ) : null}
            </>
          ) : null}
          {node.agentId && node.agentId !== viewerAgentId && onOpenAgent ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => onOpenAgent(node.agentId!, node.serverId)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 5,
                paddingHorizontal: 11,
                paddingVertical: 6,
                borderRadius: 6,
                backgroundColor: theme.colors.accent,
              }}
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
                size={12}
                color={theme.colors.accentForeground}
              />
            </Pressable>
          ) : null}
        </View>
      </View>

      {node.briefSummary ? (
        <View style={{ gap: 3 }}>
          <SectionLabel theme={theme} text={t.responsibilityTitle} />
          <ExpandableText theme={theme} lang={lang} text={node.briefSummary} />
        </View>
      ) : null}

      {hasRounds ? (
        <ReviewRoundsList theme={theme} lang={lang} rounds={node.rounds!} />
      ) : node.summary ? (
        <View style={{ gap: 3 }}>
          <SectionLabel theme={theme} text={t.outcomeTitle} />
          <ExpandableText theme={theme} lang={lang} text={node.summary} />
        </View>
      ) : null}

      {node.role === "gate" && task.gateChecks ? (
        <View style={{ gap: 5 }}>
          <SectionLabel theme={theme} text={t.gateChecklistTitle} />
          {Object.entries(task.gateChecks).map(([key, passed]) => (
            <View
              key={key}
              style={{ flexDirection: "row", alignItems: "center", gap: 7 }}
            >
              <Icon
                name={passed ? "CheckCircle2" : "XCircle"}
                size={13}
                color={
                  passed
                    ? theme.colors.statusSuccess
                    : theme.colors.statusDanger
                }
              />
              <Text
                style={{
                  color: passed
                    ? theme.colors.foreground
                    : theme.colors.statusDanger,
                  fontSize: 12,
                }}
              >
                {gateLabels[key] ?? key}
              </Text>
            </View>
          ))}
          {task.gateMissing?.map((item) => (
            <Text
              key={item}
              selectable
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 11,
                lineHeight: 15,
                paddingLeft: 20,
              }}
            >
              · {item}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Unified top-to-bottom Workflow Node Graph shared identically by the Chat
 * Team Graph panel and the History detail view.
 */
function TaskFlowCanvas({
  theme,
  compact,
  lang,
  task,
  viewerAgentId,
  onOpenAgent,
  onOpenConfig,
  onTaskUpdated,
  showGoal = true,
}: {
  theme: PluginTheme;
  compact: boolean;
  lang: UiLanguage;
  task: PipelineTaskSnapshotDto;
  viewerAgentId?: string | null;
  onOpenAgent?: (agentId: string, serverId?: string) => void;
  onOpenConfig?: () => void;
  onTaskUpdated?: (next: PipelineTaskSnapshotDto) => void;
  /** Off where the goal is already shown on the row that opened this canvas. */
  showGoal?: boolean;
}) {
  const t = UI_TEXT[lang];
  const toast = useToast();
  const controlTask = useRpc(controlTaskRpc);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [goalExpanded, setGoalExpanded] = useState(false);
  const [controlling, setControlling] = useState(false);
  const [confirmAbandon, setConfirmAbandon] = useState(false);

  useEffect(() => {
    setSelectedNodeId(null);
    setGoalExpanded(false);
  }, [task.taskId]);

  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null;
    for (const stage of task.stages) {
      for (const node of stage.nodes) {
        if (node.nodeId === selectedNodeId) return node;
      }
    }
    return null;
  }, [task, selectedNodeId]);

  async function handleControl(
    action:
      | "inspect_gate"
      | "complete_task"
      | "authorize_extra_round"
      | "abandon_task",
  ) {
    if (!task.recordPath) return;
    setControlling(true);
    try {
      const res = await controlTask({
        recordPath: task.recordPath,
        action,
        language: lang,
      });
      toast.show(res.message, { variant: res.ok ? "success" : "warning" });
      if (res.task && onTaskUpdated) onTaskUpdated(res.task);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setControlling(false);
    }
  }

  const isNativeTree = task.sourceKind === "native_subagents";
  const status = taskStatusInfo(lang, task);
  const metaParts = [
    isNativeTree
      ? t.nativeTreeBadge
      : t.presetBadge(task.teamName, task.complexMode),
    ...(isNativeTree
      ? []
      : [
          `${t.ciLabel} ${
            task.ciStatus === "pass"
              ? t.ciPass
              : task.ciStatus === "waived"
                ? t.ciWaived
                : t.ciPending
          }`,
        ]),
    formatShortTime(task.updatedAt),
  ].filter(Boolean);

  const toggleNode = (nodeId: string) =>
    setSelectedNodeId((prev) => (prev === nodeId ? null : nodeId));
  const geometry = nodeGeometry(compact);
  const renderTile = (node: PipelineNodeViewDto) => (
    <WorkflowNodeCard
      key={node.nodeId}
      theme={theme}
      lang={lang}
      task={task}
      node={node}
      width={geometry.width}
      selected={selectedNode?.nodeId === node.nodeId}
      isViewerSelf={Boolean(viewerAgentId) && node.agentId === viewerAgentId}
      onPress={() => toggleNode(node.nodeId)}
    />
  );

  return (
    <View style={{ gap: 16 }}>
      {/* Header: goal + quiet meta line */}
      <View style={{ gap: 6 }}>
        <View
          style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}
        >
          <Pressable
            accessibilityRole="button"
            onPress={() => setGoalExpanded((prev) => !prev)}
            style={{ flex: 1, minWidth: 0 }}
          >
            {showGoal ? (
              <Text
                numberOfLines={goalExpanded ? undefined : 2}
                style={{
                  color: theme.colors.foreground,
                  fontSize: 15,
                  fontWeight: "600",
                  lineHeight: 22,
                }}
              >
                {task.goal}
              </Text>
            ) : (
              // The opening row already shows goal and status; keep one quiet meta line.
              <Text
                numberOfLines={goalExpanded ? undefined : 1}
                style={{
                  color: theme.colors.foregroundMuted,
                  fontSize: 12,
                  lineHeight: 20,
                  paddingVertical: 3,
                }}
              >
                {[
                  ...metaParts,
                  task.skippedStageCount
                    ? t.hiddenStagesHint(task.skippedStageCount)
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
                {goalExpanded ? `\n${task.goal}` : ""}
              </Text>
            )}
          </Pressable>
          {task.recordPath &&
          !isNativeTree &&
          task.lifecycleStatus !== "completed" &&
          task.lifecycleStatus !== "abandoned" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.abandonTask}
              disabled={controlling}
              onPress={() => {
                if (!confirmAbandon) {
                  setConfirmAbandon(true);
                  return;
                }
                setConfirmAbandon(false);
                void handleControl("abandon_task");
              }}
              style={({ hovered }: HoverState) => ({
                paddingHorizontal: 9,
                paddingVertical: 5,
                borderRadius: 6,
                backgroundColor: hovered
                  ? theme.colors.surface2
                  : "transparent",
              })}
            >
              <Text
                style={{
                  color: confirmAbandon
                    ? theme.colors.statusDanger
                    : theme.colors.foregroundMuted,
                  fontSize: 12,
                }}
              >
                {confirmAbandon ? t.abandonConfirm : t.abandonTask}
              </Text>
            </Pressable>
          ) : null}
          {onOpenConfig ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.configureTeam}
              onPress={onOpenConfig}
              style={({ hovered }: HoverState) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 5,
                paddingHorizontal: 9,
                paddingVertical: 5,
                borderRadius: 6,
                backgroundColor: hovered
                  ? theme.colors.surface2
                  : "transparent",
              })}
            >
              <Icon
                name="Settings2"
                size={13}
                color={theme.colors.foregroundMuted}
              />
              <Text
                style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}
              >
                {t.configureTeam}
              </Text>
            </Pressable>
          ) : null}
        </View>

        {showGoal ? (
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 6,
              }}
            >
              <View
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 4,
                  backgroundColor: toneColor(theme, status.tone),
                }}
              />
              <Text
                style={{
                  color: toneColor(theme, status.tone),
                  fontSize: 12,
                  fontWeight: "600",
                }}
              >
                {status.label}
              </Text>
              <Text
                style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}
              >
                {metaParts.map((part) => ` · ${part}`).join("")}
              </Text>
            </View>

            {task.skippedStageCount && task.skippedStageCount > 0 ? (
              <Text
                style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}
              >
                {t.hiddenStagesHint(task.skippedStageCount)}
              </Text>
            ) : null}
          </View>
        ) : null}

        {task.circuitBroken ? (
          <View
            style={{
              flexDirection: compact ? "column" : "row",
              alignItems: compact ? "flex-start" : "center",
              gap: 10,
              marginTop: 6,
              padding: 10,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: theme.colors.statusDanger,
              backgroundColor: theme.colors.surface1,
            }}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text
                style={{
                  color: theme.colors.statusDanger,
                  fontSize: 12,
                  fontWeight: "600",
                }}
              >
                {t.circuitBrokenTitle(task.circuitBroken.stage)}
              </Text>
              <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
                {task.circuitBroken.reason}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              disabled={controlling}
              onPress={() => void handleControl("authorize_extra_round")}
              style={{
                paddingHorizontal: 11,
                paddingVertical: 6,
                borderRadius: 6,
                backgroundColor: theme.colors.accent,
                opacity: controlling ? 0.6 : 1,
              }}
            >
              <Text
                style={{
                  color: theme.colors.accentForeground,
                  fontSize: 12,
                  fontWeight: "600",
                }}
              >
                {t.authorizeNextRound}
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      {/* Workflow Node DAG */}
      <View
        style={{
          maxWidth: 820,
          width: "100%",
          alignSelf: "center",
        }}
      >
        {task.stages.map((stage, stageIdx) => {
          const nextStage = task.stages[stageIdx + 1];
          const stackParallel = compact && stage.nodes.length > 2;
          const visualNodeCount = stackParallel ? 1 : stage.nodes.length;
          const nextVisualCount = nextStage
            ? compact && nextStage.nodes.length > 2
              ? 1
              : nextStage.nodes.length
            : 0;
          const selectedInThisStep = stage.nodes.find(
            (n) => n.nodeId === selectedNode?.nodeId,
          );

          return (
            <View key={stage.stepId} style={{ width: "100%" }}>
              {stackParallel ? (
                <View style={{ alignItems: "center", gap: 8 }}>
                  {stage.nodes.map((node) => renderTile(node))}
                </View>
              ) : (
                <View style={{ flexDirection: "row", alignSelf: "center" }}>
                  {stage.nodes.map((node) => (
                    <View
                      key={node.nodeId}
                      style={{ width: geometry.slot, alignItems: "center" }}
                    >
                      {renderTile(node)}
                    </View>
                  ))}
                </View>
              )}

              {selectedInThisStep ? (
                <View
                  style={{
                    width: "100%",
                    maxWidth: 560,
                    alignSelf: "center",
                    paddingHorizontal: 5,
                  }}
                >
                  <NodeInspector
                    theme={theme}
                    compact={compact}
                    lang={lang}
                    task={task}
                    node={selectedInThisStep}
                    viewerAgentId={viewerAgentId}
                    controlling={controlling}
                    onControl={(action) => void handleControl(action)}
                    onOpenAgent={onOpenAgent}
                  />
                </View>
              ) : null}

              {nextStage ? (
                <WorkflowEdgeConnector
                  color={edgeStrokeColor(
                    theme,
                    stage.stageStatus,
                    nextStage.stageStatus,
                  )}
                  fromCount={visualNodeCount}
                  toCount={nextVisualCount}
                  slot={geometry.slot}
                />
              ) : null}
            </View>
          );
        })}

        {!selectedNode ? (
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 11,
              textAlign: "center",
              marginTop: 10,
            }}
          >
            {t.pickNodeHint}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function SingleConversationGraphView({
  theme,
  compact,
  agentId,
  workspaceId,
  cwd,
  onOpenAgent,
  onOpenConfig,
}: {
  theme: PluginTheme;
  compact: boolean;
  agentId?: string;
  workspaceId: string;
  cwd?: string;
  onOpenAgent?: (agentId: string, serverId?: string) => void;
  onOpenConfig?: () => void;
}) {
  const fetchConv = useRpc(getConversationGraphRpc);
  const lang = useUiLanguage();

  const [payload, setPayload] = useState<ConversationGraphPayloadDto | null>(
    null,
  );

  const queryInput = useMemo(
    () => ({
      ...(agentId ? { agentId } : {}),
      workspaceId,
      ...(cwd ? { cwd } : {}),
      language: lang,
    }),
    [agentId, workspaceId, cwd, lang],
  );

  useSubscription(watchConversationGraphSubscription, queryInput, (event) => {
    setPayload({
      mode: event.mode,
      viewerAgentId: event.viewerAgentId,
      rootAgentId: event.rootAgentId,
      task: event.task,
      ...(event.tasks ? { tasks: event.tasks } : {}),
    });
  });

  useEffect(() => {
    let active = true;
    void fetchConv(queryInput)
      .then((res) => {
        if (active) setPayload(res);
      })
      .catch(() => {
        if (active) {
          setPayload({
            mode: "empty",
            viewerAgentId: agentId ?? null,
            rootAgentId: agentId ?? null,
            task: null,
          });
        }
      });
    return () => {
      active = false;
    };
  }, [agentId, cwd, fetchConv, queryInput]);

  const t = UI_TEXT[lang];

  if (payload === null) {
    return <Loading />;
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{
        padding: compact ? 12 : 20,
        gap: 14,
      }}
    >
      {payload.mode === "team_task" &&
      payload.task?.launcherAgentId &&
      payload.task.launcherAgentId !== payload.viewerAgentId &&
      onOpenAgent ? (
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            onOpenAgent(
              payload.task!.launcherAgentId!,
              payload.task!.coordinatorServerId,
            )
          }
          style={{
            alignSelf: "flex-start",
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            paddingHorizontal: 10,
            paddingVertical: 5,
            borderRadius: 999,
            backgroundColor: theme.colors.surface2,
          }}
        >
          <Icon name="ChevronLeft" size={14} color={theme.colors.foreground} />
          <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
            {t.backToMainChat}
          </Text>
        </Pressable>
      ) : null}
      {payload.task ? (
        <TaskFlowCanvas
          theme={theme}
          compact={compact}
          lang={lang}
          task={payload.task}
          viewerAgentId={payload.viewerAgentId}
          onOpenAgent={onOpenAgent}
          onOpenConfig={onOpenConfig}
          onTaskUpdated={(nextTask) =>
            setPayload((prev) => (prev ? { ...prev, task: nextTask } : prev))
          }
        />
      ) : (
        <>
          {payload.tasks?.length ? (
            <LauncherTaskTree
              theme={theme}
              compact={compact}
              lang={lang}
              tasks={payload.tasks}
              viewerAgentId={payload.viewerAgentId}
              onOpenAgent={onOpenAgent}
              onOpenConfig={onOpenConfig}
            />
          ) : (
            <View style={{ gap: 6, paddingVertical: 24, alignItems: "center" }}>
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: 15,
                  fontWeight: "600",
                }}
              >
                {t.emptyTitle}
              </Text>
              <Text
                style={{
                  color: theme.colors.foregroundMuted,
                  fontSize: 13,
                  lineHeight: 19,
                  textAlign: "center",
                }}
              >
                {t.emptyDesc}
              </Text>
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

/** One chat roots several task subtrees; each branch is one coordinator's pipeline. */
function LauncherTaskTree({
  theme,
  compact,
  lang,
  tasks,
  viewerAgentId,
  onOpenAgent,
  onOpenConfig,
}: {
  theme: PluginTheme;
  compact: boolean;
  lang: UiLanguage;
  tasks: PipelineTaskSnapshotDto[];
  viewerAgentId: string | null;
  onOpenAgent?: (agentId: string, serverId?: string) => void;
  onOpenConfig?: () => void;
}) {
  const t = UI_TEXT[lang];
  const newestId = tasks[0]?.taskId ?? null;
  const [expanded, setExpanded] = useState<string | null>(newestId);
  // A newly started task opens its branch.
  useEffect(() => setExpanded(newestId), [newestId]);
  const [showEarlier, setShowEarlier] = useState(false);
  // Keep the newest few and anything still active in view; fold the finished rest.
  const recent = tasks.filter(
    (task, i) =>
      i < 3 || task.lifecycleStatus === "active" || task.taskId === expanded,
  );
  const earlierCount = tasks.length - recent.length;
  const shown = showEarlier ? tasks : recent;

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="MessageSquare" size={14} color={theme.colors.foreground} />
        <Text
          style={{
            color: theme.colors.foreground,
            fontSize: 14,
            fontWeight: "700",
          }}
        >
          {t.launcherRoot(tasks.length)}
        </Text>
      </View>
      {shown.map((task) => {
        const open = expanded === task.taskId;
        const status = taskStatusInfo(lang, task);
        const finished =
          task.lifecycleStatus === "completed" ||
          task.lifecycleStatus === "abandoned";
        return (
          <View
            key={task.taskId}
            style={{
              marginLeft: 6,
              paddingLeft: 12,
              borderLeftWidth: 2,
              borderColor: theme.colors.border,
              gap: 8,
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              onPress={() => setExpanded(open ? null : task.taskId)}
              style={{
                flexDirection: "row",
                alignItems: open ? "flex-start" : "center",
                gap: 8,
              }}
            >
              <Icon
                name={open ? "ChevronDown" : "ChevronRight"}
                size={14}
                color={theme.colors.foregroundMuted}
              />
              <Text
                style={{
                  color: toneColor(theme, status.tone),
                  fontSize: 12,
                  fontWeight: "700",
                }}
              >
                {status.label}
              </Text>
              <Text
                numberOfLines={open ? 3 : 1}
                style={{
                  flex: 1,
                  color:
                    finished && !open
                      ? theme.colors.foregroundMuted
                      : theme.colors.foreground,
                  fontSize: 13,
                  lineHeight: 19,
                }}
              >
                {open ? task.goal : shortGoal(task.goal)}
              </Text>
              {!open ? (
                <Text
                  style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}
                >
                  {formatShortTime(task.updatedAt)}
                </Text>
              ) : null}
            </Pressable>
            {open ? (
              <TaskFlowCanvas
                theme={theme}
                compact={compact}
                lang={lang}
                task={task}
                viewerAgentId={viewerAgentId}
                onOpenAgent={onOpenAgent}
                onOpenConfig={onOpenConfig}
                showGoal={false}
              />
            ) : null}
          </View>
        );
      })}
      {earlierCount > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setShowEarlier((v) => !v)}
          style={{ marginLeft: 6, paddingLeft: 14, paddingVertical: 2 }}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {showEarlier
              ? t.hideEarlierTasks
              : t.showEarlierTasks(earlierCount)}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function AgentConversationGraphPanel({
  theme,
  layout,
  workspaceId,
  params,
  navigation,
}: PluginAgentPanelProps) {
  const directory = useWorkspace(workspaceId, (ws) => ws?.directory ?? "");
  const [viewMode, setViewMode] = useState<"graph" | "config">("graph");
  const lang = useUiLanguage();

  const t = UI_TEXT[lang];

  if (viewMode === "config") {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 16,
            paddingVertical: 10,
            borderBottomWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
          }}
        >
          <Text
            style={{
              color: theme.colors.foreground,
              fontSize: 14,
              fontWeight: "700",
            }}
          >
            {t.tabConfig}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => setViewMode("graph")}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 5,
              paddingHorizontal: 10,
              paddingVertical: 5,
              borderRadius: 6,
              backgroundColor: theme.colors.surface2,
            }}
          >
            <Icon name="Workflow" size={13} color={theme.colors.foreground} />
            <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
              {t.backToGraph}
            </Text>
          </Pressable>
        </View>
        <TeamConfigView
          theme={theme}
          compact={layout.compact}
          cwd={directory || undefined}
        />
      </View>
    );
  }

  return (
    <SingleConversationGraphView
      theme={theme}
      compact={layout.compact}
      agentId={params.agentId}
      workspaceId={workspaceId}
      cwd={directory || undefined}
      onOpenAgent={
        navigation?.openAgent
          ? (targetId, serverId) =>
              navigation.openAgent({
                agentId: targetId,
                ...(serverId ? { serverId } : {}),
              })
          : undefined
      }
      onOpenConfig={() => setViewMode("config")}
    />
  );
}

type HistoryFilter = "all" | "active" | "done";

function HistoryListItem({
  theme,
  lang,
  task,
  selected,
  onPress,
}: {
  theme: PluginTheme;
  lang: UiLanguage;
  task: PipelineTaskSnapshotDto;
  selected: boolean;
  onPress: () => void;
}) {
  const status = taskStatusInfo(lang, task);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ hovered }: HoverState) => ({
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 7,
        gap: 3,
        backgroundColor: selected
          ? theme.colors.surface2
          : hovered
            ? theme.colors.surface1
            : "transparent",
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            backgroundColor: toneColor(theme, status.tone),
          }}
        />
        <Text
          numberOfLines={1}
          style={{
            flex: 1,
            color: theme.colors.foreground,
            fontSize: 13,
            fontWeight: selected ? "600" : "400",
          }}
        >
          {task.goal}
        </Text>
      </View>
      <Text
        numberOfLines={1}
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 11,
          paddingLeft: 15,
        }}
      >
        {[projectLabel(task.projectRoot), formatShortTime(task.updatedAt)]
          .filter(Boolean)
          .join(" · ")}
      </Text>
    </Pressable>
  );
}

/** Mounted only while the History tab is open, so opening Team does not load every task. */
function TeamHistoryTab({
  theme,
  compact,
  lang,
  navigation,
}: {
  theme: PluginTheme;
  compact: boolean;
  lang: UiLanguage;
  navigation: PluginScreenProps["navigation"];
}) {
  const fetchTasks = useRpc(listTasksRpc);
  const [historyTasks, setHistoryTasks] = useState<
    PipelineTaskSnapshotDto[] | null
  >(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [filter, setFilter] = useState<HistoryFilter>("all");

  const historyInput = useMemo(
    () => ({ includeAllProjects: true, language: lang }),
    [lang],
  );
  useSubscription(watchTasksSubscription, historyInput, (event) => {
    setHistoryTasks(event.tasks);
  });

  useEffect(() => {
    let active = true;
    void fetchTasks(historyInput)
      .then((res) => {
        if (active) {
          setHistoryTasks(res.tasks);
        }
      })
      .catch(() => {
        if (active) setHistoryTasks([]);
      });
    return () => {
      active = false;
    };
  }, [fetchTasks, historyInput]);

  const counts = useMemo(() => {
    const all = historyTasks ?? [];
    const done = all.filter((x) => x.lifecycleStatus === "completed").length;
    const active = all.filter(
      (x) =>
        x.lifecycleStatus !== "completed" && x.lifecycleStatus !== "abandoned",
    ).length;
    return { all: all.length, done, active };
  }, [historyTasks]);

  const visibleTasks = useMemo(() => {
    const all = historyTasks ?? [];
    if (filter === "done") {
      return all.filter((x) => x.lifecycleStatus === "completed");
    }
    if (filter === "active") {
      return all.filter(
        (x) =>
          x.lifecycleStatus !== "completed" &&
          x.lifecycleStatus !== "abandoned",
      );
    }
    return all;
  }, [historyTasks, filter]);

  const activeHistoryTask = useMemo(() => {
    if (visibleTasks.length === 0) return null;
    return (
      visibleTasks.find((x) => x.taskId === selectedTaskId) ?? visibleTasks[0]
    );
  }, [visibleTasks, selectedTaskId]);

  const t = UI_TEXT[lang];

  return historyTasks === null ? (
    <Loading />
  ) : historyTasks.length === 0 ? (
    <View style={{ padding: compact ? 16 : 28 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
        {t.noHistoryYet}
      </Text>
    </View>
  ) : (
    <View style={{ flex: 1, flexDirection: compact ? "column" : "row" }}>
      <View
        style={{
          width: compact ? "100%" : 300,
          maxHeight: compact ? 280 : undefined,
          borderRightWidth: compact ? 0 : 1,
          borderBottomWidth: compact ? 1 : 0,
          borderColor: theme.colors.border,
        }}
      >
        <View style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
          <SegmentedTabs
            theme={theme}
            value={filter}
            onChange={setFilter}
            items={[
              { id: "all", label: t.filterAll, count: counts.all },
              { id: "active", label: t.filterActive, count: counts.active },
              { id: "done", label: t.filterDone, count: counts.done },
            ]}
          />
        </View>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingHorizontal: 6,
            paddingBottom: 12,
            gap: 1,
          }}
        >
          {visibleTasks.length === 0 ? (
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 12,
                padding: 10,
              }}
            >
              {t.noHistoryForFilter}
            </Text>
          ) : (
            visibleTasks.map((item) => (
              <HistoryListItem
                key={item.taskId}
                theme={theme}
                lang={lang}
                task={item}
                selected={activeHistoryTask?.taskId === item.taskId}
                onPress={() => setSelectedTaskId(item.taskId)}
              />
            ))
          )}
        </ScrollView>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: compact ? 12 : 20 }}
      >
        {activeHistoryTask ? (
          <TaskFlowCanvas
            theme={theme}
            compact={compact}
            lang={lang}
            task={activeHistoryTask}
            onOpenAgent={
              navigation?.openAgent
                ? (targetId, serverId) =>
                    navigation.openAgent({
                      agentId: targetId,
                      ...(serverId ? { serverId } : {}),
                    })
                : undefined
            }
            onTaskUpdated={(nextTask) =>
              setHistoryTasks((prev) =>
                prev
                  ? prev.map((x) =>
                      x.taskId === nextTask.taskId ? nextTask : x,
                    )
                  : prev,
              )
            }
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

export function GlobalTeamGraphScreen({
  theme,
  layout,
  navigation,
  params,
}: PluginScreenProps) {
  const [tab, setTab] = useState<"config" | "history">(
    params.tab === "history" ? "history" : "config",
  );
  const lang = useUiLanguage();

  useEffect(() => {
    if (params.tab === "history" || params.tab === "config") {
      setTab(params.tab);
    }
  }, [params.tab]);

  const t = UI_TEXT[lang];
  const compact = layout.compact;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View
        style={{
          paddingHorizontal: compact ? 12 : 20,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderColor: theme.colors.border,
        }}
      >
        <SegmentedTabs
          theme={theme}
          value={tab}
          onChange={setTab}
          items={[
            { id: "config", label: t.tabConfig },
            { id: "history", label: t.tabHistory },
          ]}
        />
      </View>

      {tab === "config" ? (
        <TeamConfigView
          theme={theme}
          compact={compact}
          cwd={params.cwd || undefined}
        />
      ) : (
        <TeamHistoryTab
          theme={theme}
          compact={compact}
          lang={lang}
          navigation={navigation}
        />
      )}
    </View>
  );
}
