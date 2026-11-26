import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";
import { UI_TEXT } from "../shared/i18n.ts";
import { useUiLanguage } from "./locale.ts";

export const KICKOFF_TIMELINE_KIND = "team-kickoff";

export const kickoffTimelineDataSchema = z.object({
  taskId: z.string(),
  goal: z.string(),
  teamName: z.string(),
  complexMode: z.string(),
  rawText: z.string(),
});

export type KickoffTimelineData = z.output<typeof kickoffTimelineDataSchema>;

const ZH_HEADER = /^\[Team 任务启动\]\s+task_id=`([^`]+)`\r?\n/;
const EN_HEADER = /^\[Team Kickoff\]\s+task_id=`([^`]+)`\r?\n/;

/**
 * Recognizes plugin-generated `/paseo-team` kickoff user messages so the
 * timeline can render a compact user-goal bubble instead of the full prompt.
 */
export function parseKickoffMessage(text: string): KickoffTimelineData | null {
  if (
    !text.startsWith("[Team 任务启动]") &&
    !text.startsWith("[Team Kickoff]")
  ) {
    return null;
  }

  const zhMatch = ZH_HEADER.exec(text);
  if (zhMatch) {
    const rest = text.slice(zhMatch[0].length);
    const body =
      /^任务目标：([\s\S]*?)\r?\n生效预设：`([^`]+)`（模式：`([^`]+)`）/.exec(
        rest,
      );
    if (!body) return null;
    return {
      taskId: zhMatch[1],
      goal: body[1].trim(),
      teamName: body[2],
      complexMode: body[3],
      rawText: text,
    };
  }

  const enMatch = EN_HEADER.exec(text);
  if (enMatch) {
    const rest = text.slice(enMatch[0].length);
    const body =
      /^Goal:\s*([\s\S]*?)\r?\nActive Preset:\s*`([^`]+)`\s*\(mode:\s*`([^`]+)`\)/.exec(
        rest,
      );
    if (!body) return null;
    return {
      taskId: enMatch[1],
      goal: body[1].trim(),
      teamName: body[2],
      complexMode: body[3],
      rawText: text,
    };
  }

  return null;
}

export function TeamKickoffBubble({
  item,
  theme,
}: PluginTimelineItemProps<KickoffTimelineData>) {
  const [expanded, setExpanded] = useState(false);
  const lang = useUiLanguage();
  const t = UI_TEXT[lang];
  const { goal, teamName, rawText } = item.data;

  return (
    <View style={{ alignItems: "flex-end", paddingVertical: 4 }}>
      <View
        style={{
          maxWidth: "88%",
          backgroundColor: theme.colors.surface2,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 12,
          paddingHorizontal: 12,
          paddingVertical: 9,
          gap: 6,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              flexShrink: 1,
            }}
          >
            <Icon name="Workflow" size={13} color={theme.colors.accent} />
            <Text
              style={{
                color: theme.colors.accent,
                fontSize: 12,
                fontWeight: "600",
              }}
            >
              /paseo-team
            </Text>
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 11,
              }}
            >
              · {teamName}
            </Text>
          </View>
          <Pressable
            onPress={() => setExpanded((prev) => !prev)}
            accessibilityRole="button"
            style={{ paddingHorizontal: 4, paddingVertical: 2 }}
          >
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 11,
              }}
            >
              {expanded ? t.kickoffHide : t.kickoffDetails}
            </Text>
          </Pressable>
        </View>

        <Text
          style={{
            color: theme.colors.foreground,
            fontSize: 14,
            lineHeight: 20,
          }}
        >
          {goal}
        </Text>

        {expanded ? (
          <View
            style={{
              marginTop: 4,
              padding: 10,
              borderRadius: 8,
              backgroundColor: theme.colors.surface1,
              borderColor: theme.colors.border,
              borderWidth: 1,
            }}
          >
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 11,
                lineHeight: 16,
              }}
            >
              {rawText}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}
