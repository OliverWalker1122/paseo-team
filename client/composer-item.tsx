import { useComposer } from "@getpaseo/plugin/client";
import { Toggle } from "@getpaseo/plugin/client/ui";
import {
  addTeamSlashPrefix,
  hasTeamSlashPrefix,
  stripTeamSlashPrefix,
  TEAM_ENABLED_METADATA_KEY,
  TEAM_SUBAGENT_METADATA_KEY,
} from "../shared/contracts.ts";
import { UI_TEXT } from "../shared/i18n.ts";
import { useUiLanguage } from "./locale.ts";

/**
 * Composer Team toggle rendered across New Workspace, draft chats, and open chats.
 * - On `new-workspace` / `draft`: sets `paseo-team.enabled` on the new agent so
 *   `agent.open.before` injects the role model roster & protocol directly on Turn 1.
 * - On `agent`: stays selected whenever `paseo-team.enabled` is true or `/paseo-team`
 *   is in the prompt; turning ON inserts `/paseo-team ` so submit triggers the instant
 *   slash command, and turning OFF clears both the metadata flag and prefix.
 */
export function TeamComposerToggle() {
  const composer = useComposer();
  const lang = useUiLanguage();
  const t = UI_TEXT[lang];

  if (composer.agent.metadata[TEAM_SUBAGENT_METADATA_KEY] === true) {
    return null;
  }

  const isNewChat =
    composer.context === "new-workspace" || composer.context === "draft";
  const hasMetaFlag =
    composer.agent.metadata[TEAM_ENABLED_METADATA_KEY] === true;
  const hasPrefix = hasTeamSlashPrefix(composer.prompt);
  const active = hasMetaFlag || hasPrefix;

  return (
    <Toggle
      title={t.composerTeamToggle}
      icon="Users"
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

        if (!value) {
          if (hasMetaFlag) {
            await composer
              .setMetadata({ [TEAM_ENABLED_METADATA_KEY]: null })
              .catch(() => {});
          }
          if (hasPrefix) {
            const next = stripTeamSlashPrefix(composer.prompt);
            composer.setPrompt(next);
            await composer
              .focus({ selection: { start: next.length, end: next.length } })
              .catch(() => {});
          }
          return;
        }

        const nextPrompt = addTeamSlashPrefix(composer.prompt);
        composer.setPrompt(nextPrompt);
        await composer
          .focus({
            selection: { start: nextPrompt.length, end: nextPrompt.length },
          })
          .catch(() => {});
      }}
    />
  );
}
