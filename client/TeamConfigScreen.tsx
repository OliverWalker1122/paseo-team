import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import {
  Icon,
  Loading,
  Modal,
  ScrollView,
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  TextInput,
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
  type ConfigBundleDto,
  getConfigBundleRpc,
  type PaseoTeamConfigDto,
  type ProviderCatalogItemDto,
  type ProviderModelOptionDto,
  type RoleModelSpecDto,
  saveConfigRpc,
  type TeamPresetDto,
} from "../shared/contracts.ts";
import { UI_TEXT, type UiLanguage } from "../shared/i18n.ts";
import { useUiLanguage } from "./locale.ts";

/** react-native-web adds `hovered` to the Pressable state on pointer devices. */
type HoverState = PressableStateCallbackType & { hovered?: boolean };

const NONE_MODEL = "__none__";
const AUTO_EFFORT = "auto";
const MODEL_BUTTON_WIDTH = 230;
const EFFORT_BUTTON_WIDTH = 112;

function findModelMeta(
  fullId: string,
  providers: ProviderCatalogItemDto[],
): ProviderModelOptionDto | undefined {
  for (const p of providers) {
    const found = p.models.find((m) => m.fullId === fullId);
    if (found) return found;
  }
  return undefined;
}

function formatModelButtonLabel(
  modelValue: string,
  providers: ProviderCatalogItemDto[],
  lang: UiLanguage,
): string {
  const t = UI_TEXT[lang];
  if (modelValue === NONE_MODEL) return t.noneReviewerLabel;
  // "auto" is the stored marker for a role nobody has picked a model for yet.
  if (!modelValue || modelValue === "auto") return t.unsetModelLabel;
  const meta = findModelMeta(modelValue, providers);
  if (meta) {
    const prov = modelValue.split("/")[0] ?? "";
    return `${prov} / ${meta.label || meta.id}`;
  }
  return modelValue;
}

function effortChoicesFor(
  spec: RoleModelSpecDto | null,
  providers: ProviderCatalogItemDto[],
): { id: string; label: string }[] {
  if (!spec || !spec.model || spec.model === "auto") return [];
  const meta = findModelMeta(spec.model, providers);
  if (meta && meta.thinkingOptions.length > 0) return meta.thinkingOptions;
  return [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
  ];
}

function PickerButton({
  theme,
  label,
  width,
  muted,
  disabled,
  onPress,
}: {
  theme: PluginTheme;
  label: string;
  width: number;
  muted?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ hovered }: HoverState) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 6,
        width,
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor:
          hovered && !disabled ? theme.colors.surface2 : theme.colors.surface1,
        opacity: disabled ? 0.55 : 1,
      })}
    >
      <Text
        numberOfLines={1}
        style={{
          flex: 1,
          color: muted ? theme.colors.foregroundMuted : theme.colors.foreground,
          fontSize: 12,
          fontWeight: "500",
        }}
      >
        {label}
      </Text>
      {disabled ? null : (
        <Icon
          name="ChevronsUpDown"
          size={13}
          color={theme.colors.foregroundMuted}
        />
      )}
    </Pressable>
  );
}

function OptionRow({
  theme,
  title,
  subtitle,
  selected,
  onPress,
}: {
  theme: PluginTheme;
  title: string;
  subtitle?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ hovered }: HoverState) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 7,
        backgroundColor: selected
          ? theme.colors.surface2
          : hovered
            ? theme.colors.surface1
            : "transparent",
      })}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text
          numberOfLines={1}
          style={{
            color: theme.colors.foreground,
            fontSize: 13,
            fontWeight: selected ? "600" : "400",
          }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text
            numberOfLines={1}
            style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {selected ? (
        <Icon name="Check" size={14} color={theme.colors.accent} />
      ) : null}
    </Pressable>
  );
}

function GroupLabel({ theme, text }: { theme: PluginTheme; text: string }) {
  return (
    <Text
      style={{
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "600",
        paddingHorizontal: 10,
        paddingTop: 8,
        paddingBottom: 2,
      }}
    >
      {text}
    </Text>
  );
}

/** One settings row per role: model picker + reasoning effort picker, aligned in fixed columns. */
function RoleModelRow({
  theme,
  compact,
  lang,
  title,
  hint,
  spec,
  allowNone,
  providers,
  onChange,
}: {
  theme: PluginTheme;
  compact: boolean;
  lang: UiLanguage;
  title: string;
  hint?: string;
  spec: RoleModelSpecDto | null;
  allowNone?: boolean;
  providers: ProviderCatalogItemDto[];
  onChange: (next: RoleModelSpecDto | null) => void;
}) {
  const t = UI_TEXT[lang];
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [query, setQuery] = useState("");

  const currentModel = spec === null ? NONE_MODEL : spec.model || "auto";
  const effortChoices = useMemo(
    () => effortChoicesFor(spec, providers),
    [spec, providers],
  );
  const currentEffort = spec?.thinking || AUTO_EFFORT;
  const effortLabel =
    effortChoices.length === 0
      ? t.effortDefault
      : currentEffort === AUTO_EFFORT
        ? t.effortDefault
        : (effortChoices.find((c) => c.id === currentEffort)?.label ??
          currentEffort);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return providers
      .map((prov) => ({
        provider: prov.provider,
        label: prov.label,
        ready: prov.ready,
        models: prov.models.filter(
          (m) =>
            !q ||
            m.fullId.toLowerCase().includes(q) ||
            m.label.toLowerCase().includes(q) ||
            prov.label.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.models.length > 0 || (!q && g.ready));
  }, [providers, query]);

  const selectModel = (nextModel: string) => {
    setModelOpen(false);
    setQuery("");
    if (nextModel === NONE_MODEL) {
      onChange(null);
      return;
    }
    const nextMeta = findModelMeta(nextModel, providers);
    const keepThinking =
      spec?.thinking &&
      (!nextMeta ||
        nextMeta.thinkingOptions.length === 0 ||
        nextMeta.thinkingOptions.some((opt) => opt.id === spec.thinking))
        ? spec.thinking
        : nextMeta?.defaultThinkingId;
    onChange({
      model: nextModel,
      ...(keepThinking ? { thinking: keepThinking } : {}),
    });
  };

  const selectEffort = (id: string) => {
    setEffortOpen(false);
    if (!spec) return;
    onChange({
      model: spec.model,
      ...(id === AUTO_EFFORT ? {} : { thinking: id }),
    });
  };

  return (
    <SettingsRow label={title} {...(hint ? { hint } : {})}>
      <View
        style={{
          flexDirection: "row",
          flexWrap: compact ? "wrap" : "nowrap",
          gap: 6,
        }}
      >
        <PickerButton
          theme={theme}
          width={compact ? 190 : MODEL_BUTTON_WIDTH}
          muted={currentModel === NONE_MODEL}
          label={formatModelButtonLabel(currentModel, providers, lang)}
          onPress={() => setModelOpen(true)}
        />
        <PickerButton
          theme={theme}
          width={EFFORT_BUTTON_WIDTH}
          muted={effortChoices.length === 0 || currentEffort === AUTO_EFFORT}
          disabled={effortChoices.length === 0}
          label={effortLabel}
          onPress={() => setEffortOpen(true)}
        />
      </View>

      <Modal
        title={`${t.selectModelTitle} · ${title}`}
        open={modelOpen}
        onOpenChange={setModelOpen}
      >
        <Modal.Content contentContainerStyle={{ gap: 4 }}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t.searchModelPlaceholder}
            placeholderTextColor={theme.colors.foregroundMuted}
            style={{
              color: theme.colors.foreground,
              fontSize: 13,
              paddingHorizontal: 10,
              paddingVertical: 8,
              marginBottom: 6,
              borderRadius: 7,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface0,
            }}
          />

          {!query.trim() ? (
            <>
              {allowNone ? (
                <OptionRow
                  theme={theme}
                  title={t.noneReviewerLabel}
                  subtitle={t.noneReviewerDesc}
                  selected={currentModel === NONE_MODEL}
                  onPress={() => selectModel(NONE_MODEL)}
                />
              ) : null}
            </>
          ) : null}

          {filteredGroups.length === 0 ? (
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 12,
                padding: 10,
              }}
            >
              {t.noMatchingModels}
            </Text>
          ) : (
            filteredGroups.map((group) => (
              <View key={group.provider}>
                <GroupLabel theme={theme} text={group.label} />
                {group.models.length === 0 ? (
                  <OptionRow
                    theme={theme}
                    title={t.providerDefaultModel}
                    subtitle={group.provider}
                    selected={currentModel === group.provider}
                    onPress={() => selectModel(group.provider)}
                  />
                ) : (
                  group.models.map((m) => (
                    <OptionRow
                      key={m.fullId}
                      theme={theme}
                      title={m.label}
                      subtitle={m.fullId}
                      selected={currentModel === m.fullId}
                      onPress={() => selectModel(m.fullId)}
                    />
                  ))
                )}
              </View>
            ))
          )}
        </Modal.Content>
      </Modal>

      <Modal
        title={`${t.effortLabel} · ${title}`}
        open={effortOpen}
        onOpenChange={setEffortOpen}
      >
        <Modal.Content contentContainerStyle={{ gap: 2 }}>
          {[{ id: AUTO_EFFORT, label: t.effortDefault }, ...effortChoices].map(
            (choice) => (
              <OptionRow
                key={choice.id}
                theme={theme}
                title={choice.label}
                selected={currentEffort === choice.id}
                onPress={() => selectEffort(choice.id)}
              />
            ),
          )}
        </Modal.Content>
      </Modal>
    </SettingsRow>
  );
}

function ActionButton({
  theme,
  label,
  icon,
  primary,
  onPress,
}: {
  theme: PluginTheme;
  label: string;
  icon?: string;
  primary?: boolean;
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
        backgroundColor: primary
          ? theme.colors.accent
          : hovered
            ? theme.colors.surface2
            : "transparent",
      })}
    >
      {icon ? (
        <Icon
          name={icon}
          size={13}
          color={
            primary ? theme.colors.accentForeground : theme.colors.foreground
          }
        />
      ) : null}
      <Text
        style={{
          color: primary
            ? theme.colors.accentForeground
            : theme.colors.foreground,
          fontSize: 12,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function TeamConfigView({
  theme,
  compact,
  cwd,
}: {
  theme: PluginTheme;
  compact: boolean;
  cwd?: string;
}) {
  const toast = useToast();
  const lang = useUiLanguage();
  const getBundle = useRpc(getConfigBundleRpc);
  const saveBundle = useRpc(saveConfigRpc);

  const [bundle, setBundle] = useState<ConfigBundleDto | null>(null);
  const [draft, setDraft] = useState<PaseoTeamConfigDto | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<string>("");
  const [newTeamName, setNewTeamName] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void getBundle(cwd ? { cwd } : {})
      .then((res) => {
        if (!active) return;
        setBundle(res);
        setDraft(res.config);
        setSelectedTeam(
          res.effectiveTeamName ??
            res.config.default ??
            Object.keys(res.config.teams)[0] ??
            "",
        );
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [cwd, getBundle, toast]);

  if (!bundle || !draft) {
    return <Loading />;
  }

  const t = UI_TEXT[lang];
  const teamNames = Object.keys(draft.teams);
  const activeName = draft.teams[selectedTeam]
    ? selectedTeam
    : (teamNames[0] ?? "");
  const activePreset: TeamPresetDto | undefined = activeName
    ? draft.teams[activeName]
    : undefined;
  const isDefault = draft.default === activeName;

  const persistNextConfig = async (nextConfig: PaseoTeamConfigDto) => {
    setDraft(nextConfig);
    setSaving(true);
    try {
      const updated = await saveBundle({
        config: nextConfig,
        ...(cwd ? { cwd } : {}),
      });
      setBundle(updated);
      setDraft(updated.config);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const updatePreset = (patch: Partial<TeamPresetDto>) => {
    if (!activeName || !activePreset) return;
    const merged: TeamPresetDto = { ...activePreset, ...patch };
    if (!merged.separatePlanReviewers) {
      merged.planReviewers = [...merged.codeReviewers];
    }
    void persistNextConfig({
      ...draft,
      teams: { ...draft.teams, [activeName]: merged },
    });
  };

  const handleCreatePreset = () => {
    const name = newTeamName.trim();
    if (!name) {
      toast.error(t.errEnterPresetName);
      return;
    }
    if (draft.teams[name]) {
      toast.error(t.errPresetExists(name));
      return;
    }
    const nextPreset: TeamPresetDto = activePreset
      ? {
          ...activePreset,
          codeReviewers: [...activePreset.codeReviewers],
          planReviewers: [...activePreset.planReviewers],
        }
      : {
          developer: { model: "auto" },
          codeReviewers: [{ model: "auto" }, { model: "auto" }],
          separatePlanReviewers: false,
          planReviewers: [{ model: "auto" }, { model: "auto" }],
          complexMode: "simple",
        };
    setSelectedTeam(name);
    setNewTeamName("");
    setCreateOpen(false);
    void persistNextConfig({
      ...draft,
      teams: { ...draft.teams, [name]: nextPreset },
    });
  };

  const handleDeletePreset = (name: string) => {
    setDeleteOpen(false);
    if (teamNames.length <= 1) {
      toast.error(t.errKeepOnePreset);
      return;
    }
    if (draft.default === name) {
      toast.error(t.errCannotDeleteDefault);
      return;
    }
    const nextTeams = { ...draft.teams };
    const nextProjects = { ...draft.projects };
    for (const [repo, presetName] of Object.entries(nextProjects)) {
      if (presetName === name) delete nextProjects[repo];
    }
    delete nextTeams[name];
    if (selectedTeam === name) {
      setSelectedTeam(draft.default ?? Object.keys(nextTeams)[0] ?? "");
    }
    void persistNextConfig({
      ...draft,
      teams: nextTeams,
      projects: nextProjects,
    });
  };

  const rev1 = activePreset?.codeReviewers[0] ?? { model: "auto" };
  const rev2 =
    activePreset && activePreset.codeReviewers.length >= 2
      ? activePreset.codeReviewers[1]
      : null;

  const sameModelBlindspot =
    activePreset &&
    activePreset.developer.model !== "auto" &&
    activePreset.codeReviewers.length > 0 &&
    activePreset.codeReviewers.every(
      (r) => r.model === activePreset.developer.model,
    );

  const deleteBlockedHint = isDefault
    ? t.presetDeleteHintDefault
    : teamNames.length <= 1
      ? t.presetDeleteHintLast
      : t.presetDeleteHint;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{
        paddingHorizontal: compact ? 12 : 24,
        paddingVertical: compact ? 14 : 22,
      }}
    >
      <View
        style={{
          width: "100%",
          maxWidth: 760,
          alignSelf: "center",
          gap: 22,
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
          <Text
            style={{
              flex: 1,
              color: theme.colors.foregroundMuted,
              fontSize: 13,
            }}
          >
            {t.setupIntro}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Icon
              name={saving ? "Loader" : "Check"}
              size={12}
              color={
                saving
                  ? theme.colors.foregroundMuted
                  : theme.colors.statusSuccess
              }
            />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {saving ? t.savingStatus : t.savedStatus}
            </Text>
          </View>
        </View>

        <SettingsSection
          title={t.sectionPresets}
          info={t.sectionPresetsInfo}
          trailing={
            <ActionButton
              theme={theme}
              icon="Plus"
              label={t.newPresetBtn}
              onPress={() => setCreateOpen(true)}
            />
          }
        >
          <SettingsCard>
            <SettingsSelect
              label={t.presetEditing}
              value={activeName}
              options={teamNames.map((name) => ({
                value: name,
                label:
                  draft.default === name ? `${name}${t.defaultSuffix}` : name,
              }))}
              onValueChange={(value) => setSelectedTeam(value)}
            />
            <SettingsAction
              label={t.presetDefaultRow}
              hint={
                isDefault
                  ? t.presetDefaultHintIs
                  : t.presetDefaultHintNot(draft.default ?? "")
              }
              actionLabel={isDefault ? t.isGlobalDefault : t.setGlobalDefault}
              disabled={isDefault}
              onPress={() =>
                void persistNextConfig({ ...draft, default: activeName })
              }
            />
            <SettingsAction
              label={t.presetDeleteRow}
              hint={deleteBlockedHint}
              actionLabel={t.deletePresetBtn}
              disabled={isDefault || teamNames.length <= 1}
              onPress={() => setDeleteOpen(true)}
            />
          </SettingsCard>
        </SettingsSection>

        {activePreset ? (
          <>
            <SettingsSection
              title={t.sectionDeveloper}
              info={t.sectionDeveloperInfo}
            >
              <SettingsCard>
                <RoleModelRow
                  theme={theme}
                  compact={compact}
                  lang={lang}
                  title="Developer"
                  spec={activePreset.developer}
                  providers={bundle.providers}
                  onChange={(next) => {
                    if (next) updatePreset({ developer: next });
                  }}
                />
              </SettingsCard>
            </SettingsSection>

            <SettingsSection title={t.sectionReview} info={t.sectionReviewInfo}>
              <SettingsCard>
                <RoleModelRow
                  theme={theme}
                  compact={compact}
                  lang={lang}
                  title={t.rev1RoleTitle}
                  hint={t.rev1RoleHint}
                  spec={rev1}
                  providers={bundle.providers}
                  onChange={(next) => {
                    if (!next) return;
                    updatePreset({
                      codeReviewers: rev2 ? [next, rev2] : [next],
                    });
                  }}
                />
                <RoleModelRow
                  theme={theme}
                  compact={compact}
                  lang={lang}
                  title={t.rev2RoleTitle}
                  hint={t.rev2RoleHint}
                  spec={rev2}
                  allowNone
                  providers={bundle.providers}
                  onChange={(next) => {
                    updatePreset({
                      codeReviewers: next ? [rev1, next] : [rev1],
                    });
                  }}
                />
              </SettingsCard>
              {sameModelBlindspot ? (
                <View
                  style={{
                    flexDirection: "row",
                    gap: 6,
                    alignItems: "flex-start",
                    paddingTop: 8,
                  }}
                >
                  <Icon
                    name="AlertTriangle"
                    size={13}
                    color={theme.colors.statusWarning}
                  />
                  <Text
                    style={{
                      flex: 1,
                      color: theme.colors.statusWarning,
                      fontSize: 12,
                    }}
                  >
                    {t.sameModelHint(activePreset.developer.model)}
                  </Text>
                </View>
              ) : null}
            </SettingsSection>

            <SettingsSection
              title={t.sectionComplex}
              info={t.sectionComplexInfo}
            >
              <SettingsCard>
                <SettingsSelect
                  label={t.planAuthorLabel}
                  value={activePreset.complexMode}
                  options={[
                    { value: "simple" as const, label: t.planAuthorSimple },
                    { value: "expert" as const, label: t.planAuthorExpert },
                  ]}
                  onValueChange={(value) =>
                    updatePreset({
                      complexMode: value,
                      ...(value === "expert" && !activePreset.expert
                        ? { expert: { model: "auto" } }
                        : {}),
                    })
                  }
                />
                {activePreset.complexMode === "expert" ? (
                  <RoleModelRow
                    theme={theme}
                    compact={compact}
                    lang={lang}
                    title={t.expertRoleTitle}
                    hint={t.expertRoleHint}
                    spec={activePreset.expert ?? { model: "auto" }}
                    providers={bundle.providers}
                    onChange={(next) => {
                      if (next) updatePreset({ expert: next });
                    }}
                  />
                ) : null}
                <SettingsSwitch
                  label={t.separatePlanRevTitle}
                  hint={t.separatePlanRevHint}
                  value={activePreset.separatePlanReviewers ?? false}
                  onValueChange={(value) =>
                    updatePreset({
                      separatePlanReviewers: value,
                      planReviewers: [...activePreset.codeReviewers],
                    })
                  }
                />
                {activePreset.separatePlanReviewers ? (
                  <>
                    <RoleModelRow
                      theme={theme}
                      compact={compact}
                      lang={lang}
                      title={t.planRevRoleTitle(0)}
                      hint={t.planRevRoleHint}
                      spec={activePreset.planReviewers[0] ?? { model: "auto" }}
                      providers={bundle.providers}
                      onChange={(next) => {
                        if (!next) return;
                        const p2 =
                          activePreset.planReviewers.length >= 2
                            ? activePreset.planReviewers[1]
                            : null;
                        updatePreset({
                          planReviewers: p2 ? [next, p2] : [next],
                        });
                      }}
                    />
                    <RoleModelRow
                      theme={theme}
                      compact={compact}
                      lang={lang}
                      title={t.planRevRoleTitle(1)}
                      hint={t.planRevRoleHint}
                      spec={
                        activePreset.planReviewers.length >= 2
                          ? activePreset.planReviewers[1]
                          : null
                      }
                      allowNone
                      providers={bundle.providers}
                      onChange={(next) => {
                        const p1 = activePreset.planReviewers[0] ?? {
                          model: "auto",
                        };
                        updatePreset({
                          planReviewers: next ? [p1, next] : [p1],
                        });
                      }}
                    />
                  </>
                ) : null}
              </SettingsCard>
            </SettingsSection>
          </>
        ) : null}
      </View>

      <Modal
        title={t.newPresetBtn}
        open={createOpen}
        onOpenChange={setCreateOpen}
      >
        <Modal.Content contentContainerStyle={{ gap: 10 }}>
          <TextInput
            value={newTeamName}
            onChangeText={setNewTeamName}
            onSubmitEditing={handleCreatePreset}
            autoFocus
            placeholder={t.newPresetPlaceholder}
            placeholderTextColor={theme.colors.foregroundMuted}
            style={{
              color: theme.colors.foreground,
              fontSize: 13,
              paddingHorizontal: 10,
              paddingVertical: 8,
              borderRadius: 7,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface0,
            }}
          />
          {activeName ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {t.newPresetHint(activeName)}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
            <ActionButton
              theme={theme}
              primary
              label={t.createBtn}
              onPress={handleCreatePreset}
            />
          </View>
        </Modal.Content>
      </Modal>

      <Modal
        title={`${t.presetDeleteRow} · ${activeName}`}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      >
        <Modal.Content contentContainerStyle={{ gap: 12 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
            {t.presetDeleteHint}
          </Text>
          <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
            <Pressable
              accessibilityRole="button"
              onPress={() => handleDeletePreset(activeName)}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 6,
                backgroundColor: theme.colors.statusDanger,
              }}
            >
              <Text
                style={{
                  color: theme.colors.accentForeground,
                  fontSize: 12,
                  fontWeight: "600",
                }}
              >
                {t.deletePresetBtn}
              </Text>
            </Pressable>
          </View>
        </Modal.Content>
      </Modal>
    </ScrollView>
  );
}

export function SettingsTeamConfigSurface({
  theme,
  layout,
}: PluginSurfaceProps) {
  return <TeamConfigView theme={theme} compact={layout.compact} />;
}
