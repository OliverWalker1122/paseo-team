import { useComposer } from "@getpaseo/plugin/client";
import { Toggle } from "@getpaseo/plugin/client/ui";
import {
  addTeamSlashPrefix,
  hasTeamSlashPrefix,
  stripTeamSlashPrefix,
  TEAM_ENABLED_METADATA_KEY,
  TEAM_TASK_METADATA_KEY,
} from "../shared/contracts.ts";
import { UI_TEXT } from "../shared/i18n.ts";
import { useUiLanguage } from "./locale.ts";

function getTaskMetaRole(
  metadata: Readonly<Record<string, unknown>>,
): string | null {
  const raw = metadata[TEAM_TASK_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const role = (raw as Record<string, unknown>).role;
  return typeof role === "string" && role ? role : null;
}

/**
 * Composer toggle rendered in New Workspace, draft chats, and existing chats.
 * - On `new-workspace` / `draft`: stores a one-shot `paseo-team.enabled` flag in
 *   agent metadata so the input stays clean and the new agent auto-starts Team mode
 *   on its first message via `agent.open.before`.
 * - On `agent`: toggles the `/paseo-team ` command prefix so submitting hits the
 *   instant client slash command (or attachment fallback) with zero session reload.
 */
export function TeamComposerToggle() {
  const composer = useComposer();
  const lang = useUiLanguage();
  const t = UI_TEXT[lang];

  const taskRole = getTaskMetaRole(composer.agent.metadata);
  if (taskRole && taskRole !== "coordinator") {
    return null;
  }

  const isNewChat =
    composer.context === "new-workspace" || composer.context === "draft";
  const hasMetaFlag =
    composer.agent.metadata[TEAM_ENABLED_METADATA_KEY] === true;
  const hasPrefix = hasTeamSlashPrefix(composer.prompt);
  const active = isNewChat ? hasMetaFlag || hasPrefix : hasPrefix;

  return (
    <Toggle
      title={t.composerTeamToggle}
      icon="Workflow"
      value={active}
      onValueChange={async ({ value }) => {
        if (isNewChat) {
          await composer.setMetadata({
            [TEAM_ENABLED_METADATA_KEY]: value ? true : null,
          });
          if (!value && hasPrefix) {
            composer.setPrompt(stripTeamSlashPrefix(composer.prompt));
          }
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
