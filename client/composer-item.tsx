import { useComposer } from "@getpaseo/plugin/client";
import { Toggle, useToast } from "@getpaseo/plugin/client/ui";
import {
  addTeamSlashPrefix,
  hasTeamSlashPrefix,
  stripTeamSlashPrefix,
  TEAM_ENABLED_METADATA_KEY,
  TEAM_TASK_METADATA_KEY,
} from "../shared/contracts.ts";
import { UI_TEXT } from "../shared/i18n.ts";
import { useUiLanguage } from "./locale.ts";

function getTaskMeta(metadata: Readonly<Record<string, unknown>>): {
  role: string | null;
  active: boolean;
} {
  const raw = metadata[TEAM_TASK_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { role: null, active: false };
  }
  const rec = raw as Record<string, unknown>;
  const role = typeof rec.role === "string" && rec.role ? rec.role : null;
  return { role, active: rec.active === true };
}

/**
 * Composer toggle rendered in New Workspace, draft chats, and existing chats.
 * - On `new-workspace` / `draft`: stores a one-shot `paseo-team.enabled` flag in
 *   agent metadata so the input stays clean and the new agent auto-starts Team mode
 *   on its first message via `agent.open.before`.
 * - On `agent`: stays selected while the initial auto-start is pending or while a
 *   team task is actively running on this chat; otherwise toggles the `/paseo-team `
 *   command prefix so submitting hits the instant client slash command with zero reload.
 */
export function TeamComposerToggle() {
  const composer = useComposer();
  const toast = useToast();
  const lang = useUiLanguage();
  const t = UI_TEXT[lang];

  const taskMeta = getTaskMeta(composer.agent.metadata);
  if (taskMeta.role && taskMeta.role !== "coordinator") {
    return null;
  }

  const isNewChat =
    composer.context === "new-workspace" || composer.context === "draft";
  const hasMetaFlag =
    composer.agent.metadata[TEAM_ENABLED_METADATA_KEY] === true;
  const hasActiveTask = taskMeta.role === "coordinator" && taskMeta.active;
  const hasPrefix = hasTeamSlashPrefix(composer.prompt);
  const active = hasMetaFlag || hasActiveTask || hasPrefix;

  return (
    <Toggle
      title={t.composerTeamToggle}
      icon="Users"
      value={active}
      onValueChange={async ({ value }) => {
        if (hasActiveTask) {
          toast.show(t.composerTeamActiveHint, { variant: "info" });
          return;
        }

        if (isNewChat) {
          await composer.setMetadata({
            [TEAM_ENABLED_METADATA_KEY]: value ? true : null,
          });
          if (!value && hasPrefix) {
            composer.setPrompt(stripTeamSlashPrefix(composer.prompt));
          }
          return;
        }

        if (!value && hasMetaFlag && !hasPrefix) {
          await composer
            .setMetadata({ [TEAM_ENABLED_METADATA_KEY]: null })
            .catch(() => {});
          return;
        }

        const nextPrompt = value
          ? addTeamSlashPrefix(composer.prompt)
          : stripTeamSlashPrefix(composer.prompt);
        composer.setPrompt(nextPrompt);
        if (!value && hasMetaFlag) {
          await composer
            .setMetadata({ [TEAM_ENABLED_METADATA_KEY]: null })
            .catch(() => {});
        }
        await composer
          .focus({
            selection: { start: nextPrompt.length, end: nextPrompt.length },
          })
          .catch(() => {});
      }}
    />
  );
}
