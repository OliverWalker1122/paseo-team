import { defineTranslations, useTranslation } from "@getpaseo/plugin/client";
import type { UiLanguage } from "../shared/i18n.ts";

/** Host-level labels (sidebar, screen, panel, commands). Paseo resolves them in its own language. */
export const hostTitles = defineTranslations({
  resources: {
    en: {
      team: "Team",
      teamGraph: "Team graph",
      teamStatus: "Team status",
      openGraph: "Open team graph",
      openSetup: "Team setup: models and presets",
    },
    zh: {
      team: "团队",
      teamGraph: "团队状态图",
      teamStatus: "团队状态",
      openGraph: "打开团队状态图",
      openSetup: "团队配置：模型与预设",
    },
  },
});

/** The plugin UI has English and Chinese; every other Paseo locale falls back to English. */
export function toUiLanguage(locale: string | undefined): UiLanguage {
  return /^zh(?:-|$)/i.test(locale ?? "") ? "zh" : "en";
}

/** Follows the Paseo app language and re-renders when it changes. */
export function useUiLanguage(): UiLanguage {
  const { locale } = useTranslation(hostTitles);
  return toUiLanguage(locale);
}
