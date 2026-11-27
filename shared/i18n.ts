export type UiLanguage = "en" | "zh";

export function detectPromptLanguage(
  goalText: string,
  fallback: UiLanguage = "en",
): UiLanguage {
  if (/[\u4e00-\u9fff]/.test(goalText)) {
    return "zh";
  }
  if (/[a-zA-Z]{3,}/.test(goalText)) {
    return "en";
  }
  return fallback;
}

export const PERSPECTIVE_LABELS: Record<
  UiLanguage,
  Record<"spec-boundary" | "arch-simplicity" | "comprehensive", string>
> = {
  en: {
    "spec-boundary": "Spec & Real Edge Cases",
    "arch-simplicity": "Architecture & Simplicity",
    comprehensive: "Spec, Architecture & Edge Cases",
  },
  zh: {
    "spec-boundary": "需求规格与真实边界场景",
    "arch-simplicity": "架构一致性与复杂度删减",
    comprehensive: "需求、架构与边界综合审查",
  },
};

export const UI_TEXT = {
  en: {
    // Navigation
    tabRunning: "Running",
    tabHistory: "History",
    tabConfig: "Setup",
    backToGraph: "Back to team",
    backToMainChat: "Back to main chat",
    configureTeam: "Setup",

    // Setup page
    setupIntro: "Pick a model for each role. Changes save automatically.",
    savedStatus: "Saved",
    savingStatus: "Saving…",
    sectionPresets: "Preset",
    sectionPresetsInfo:
      "A preset is a saved set of role models. New team sessions use the default preset.",
    presetEditing: "Editing",
    defaultSuffix: " (default)",
    presetDefaultRow: "Default preset",
    presetDefaultHintIs: "New team sessions use this preset.",
    presetDefaultHintNot: (name: string) =>
      `New team sessions currently use "${name}".`,
    setGlobalDefault: "Set as default",
    isGlobalDefault: "Default",
    presetDeleteRow: (name: string) => `Delete "${name}"`,
    presetDeleteConfirm: (
      name: string,
      fallback: string,
      wasDefault: boolean,
    ) =>
      wasDefault
        ? `"${name}" is the default. After deleting it, new sessions and its projects use "${fallback}".`
        : `Projects bound to "${name}" go back to the default "${fallback}".`,
    deletePresetBtn: "Delete",
    newPresetBtn: "New preset",
    newPresetPlaceholder: "Preset name",
    newPresetHint: (from: string) => `Starts as a copy of "${from}".`,
    createBtn: "Create",
    cancelBtn: "Cancel",
    sectionDeveloper: "Developer",
    sectionDeveloperInfo:
      "The only role that edits files. Works directly in this workspace and runs the full test suite.",
    effortLabel: "Reasoning effort",
    effortDefault: "Model default",
    modeLabel: "Permission mode",
    modeDefault: "Default",
    modeDefaultOption: "Default (auto)",
    modeDefaultDesc:
      "Automatically pick the provider's recommended non-interactive mode (e.g. auto-review / auto).",
    sectionReview: "Code review",
    sectionReviewInfo:
      "Cross review: two reviewers examine each change independently from opposing angles and never see each other's verdict.",
    rev1RoleTitle: "Code Reviewer #1",
    devRoleTitle: "Developer",
    devRoleHint: "Writes the code and runs the checks",
    rev1RoleHint: "Requirements and real edge cases",
    rev2RoleTitle: "Code Reviewer #2",
    rev2RoleHint: "Architecture and simpler alternatives",
    sameModelHint: (model: string) =>
      `Both reviewers use the Developer's model (${model}). Reviewers from a different model family catch more of its blind spots.`,
    sectionComplex: "Complex tasks",
    sectionComplexInfo: "Only used for cross-module or architectural work.",
    planAuthorLabel: "Who writes the plan",
    planAuthorSimple: "This chat (lower cost)",
    planAuthorExpert: "Dedicated expert session",
    expertRoleTitle: "Expert model",
    expertRoleHint: "Drafts the design and root-cause analysis",
    separatePlanRevTitle: "Separate plan reviewers",
    separatePlanRevHint:
      "When off, plan review reuses the code reviewers above.",
    planRevRoleTitle: (idx: number) => `Plan Reviewer #${idx + 1}`,
    planRevRoleHint: "Independent cross review before implementation",

    // Model picker
    unsetModelLabel: "Not set — pick a model",
    noneReviewerLabel: "Off (single reviewer)",
    noneReviewerDesc: "Run one code reviewer instead of two",
    selectModelTitle: "Choose model",
    searchModelPlaceholder: "Filter by provider or model",
    noMatchingModels: "No models match this filter.",
    providerDefaultModel: "Provider default model",

    // Errors and toasts
    errEnterPresetName: "Enter a preset name.",
    errPresetExists: (n: string) => `A preset named "${n}" already exists.`,
    errKeepOnePreset: "At least one preset must remain.",

    // Sessions & Graph
    noRunningYet: "No team sessions are running right now.",
    viewHistoryBtn: "View history",
    noHistoryYet:
      "No historical team sessions yet. Turn on the Team toggle or run /paseo-team in a chat.",
    pickNodeHint:
      "Select an agent card to inspect details or jump into its chat.",
    statusRunningCount: (n: number) => `${n} running`,
    statusAttentionCount: (n: number) => `${n} need you`,
    statusIdle: "Idle",
    statusError: "Error",
    statusRunning: "Running",
    statusInit: "Starting",
    statusPerm: "Needs approval",
    statusClosed: "Closed",
    agentCountLabel: (n: number) => `${n} agent${n === 1 ? "" : "s"}`,
    focusPrefix: "Focus:",
    openSubagentBtn: "Open chat",
    responsibilityTitle: "Session",
    emptyTitle: "No team session or subagents in this chat yet",
    emptyDesc:
      "Turn on the Team icon in the composer or run /paseo-team to start. Every subagent dispatched by this chat appears live here.",
    pillDefault: "Team",
    pillSubagents: (n: number) => `Team · ${n} agents`,
    pillRunning: (n: number) => `Team · ${n} running`,
    pillAttention: (n: number) => `Team · ${n} need you`,
    badgeRunning: (n: number) => `Team · ${n} running`,
    badgeAttention: (n: number) => `Team · ${n} need you`,
    kickoffDetails: "Details",
    kickoffHide: "Hide",
    composerTeamToggle: "Team mode",
  },
  zh: {
    // Navigation
    tabRunning: "运行中",
    tabHistory: "历史",
    tabConfig: "配置",
    backToGraph: "返回团队",
    backToMainChat: "返回主对话",
    configureTeam: "配置",

    // Setup page
    setupIntro: "为每个角色选择模型，修改自动保存。",
    savedStatus: "已保存",
    savingStatus: "保存中…",
    sectionPresets: "预设",
    sectionPresetsInfo: "预设是一组角色模型配置，新任务默认使用「默认预设」。",
    presetEditing: "正在编辑",
    defaultSuffix: "（默认）",
    presetDefaultRow: "默认预设",
    presetDefaultHintIs: "新任务都用这个预设。",
    presetDefaultHintNot: (name: string) => `新任务现在用「${name}」。`,
    setGlobalDefault: "设为默认",
    isGlobalDefault: "当前默认",
    presetDeleteRow: (name: string) => `删除「${name}」`,
    presetDeleteConfirm: (
      name: string,
      fallback: string,
      wasDefault: boolean,
    ) =>
      wasDefault
        ? `「${name}」是默认预设，删除后新任务和绑定它的项目改用「${fallback}」。`
        : `绑定「${name}」的项目会改用默认预设「${fallback}」。`,
    deletePresetBtn: "删除",
    newPresetBtn: "新建预设",
    newPresetPlaceholder: "预设名称",
    newPresetHint: (from: string) => `以「${from}」为副本创建。`,
    createBtn: "创建",
    cancelBtn: "取消",
    sectionDeveloper: "开发",
    sectionDeveloperInfo:
      "唯一可以修改文件的角色，直接在当前工作区改代码并运行完整测试。",
    effortLabel: "推理强度",
    effortDefault: "模型默认",
    modeLabel: "权限模式",
    modeDefault: "默认权限",
    modeDefaultOption: "默认（自动推荐）",
    modeDefaultDesc: "自动选择该模型提供商推荐的权限模式。",
    sectionReview: "代码审查",
    sectionReviewInfo:
      "交叉审核：两位审查员从对立视角独立审查每次改动，彼此看不到对方结论。",
    rev1RoleTitle: "代码审查 #1",
    devRoleTitle: "开发者",
    devRoleHint: "写代码并跑检查",
    rev1RoleHint: "需求符合度与真实边界场景",
    rev2RoleTitle: "代码审查 #2",
    rev2RoleHint: "架构一致性与更简单的方案",
    sameModelHint: (model: string) =>
      `两位审查员都在用开发者的模型（${model}）。换成其他模型家族，更容易发现它的盲点。`,
    sectionComplex: "复杂任务",
    sectionComplexInfo: "仅在跨模块或架构级任务中使用。",
    planAuthorLabel: "由谁起草方案",
    planAuthorSimple: "当前对话（省成本）",
    planAuthorExpert: "独立专家会话",
    expertRoleTitle: "专家模型",
    expertRoleHint: "起草设计方案与根因分析",
    separatePlanRevTitle: "单独设置方案审查",
    separatePlanRevHint: "关闭时，方案审查复用上面的代码审查模型。",
    planRevRoleTitle: (idx: number) => `方案审查 #${idx + 1}`,
    planRevRoleHint: "实现前的独立交叉审核",

    // Model picker
    unsetModelLabel: "未设置，请选择模型",
    noneReviewerLabel: "关闭（单人审查）",
    noneReviewerDesc: "只派 1 位代码审查，不开第 2 位",
    selectModelTitle: "选择模型",
    searchModelPlaceholder: "按提供商或模型名筛选",
    noMatchingModels: "没有匹配的模型。",
    providerDefaultModel: "提供商默认模型",

    // Errors and toasts
    errEnterPresetName: "请输入预设名称。",
    errPresetExists: (n: string) => `已存在名为「${n}」的预设。`,
    errKeepOnePreset: "至少需要保留一个预设。",

    // Sessions & Graph
    noRunningYet: "当前没有运行中的团队协作。",
    viewHistoryBtn: "查看历史记录",
    noHistoryYet:
      "还没有历史团队协作记录。在输入框点亮双人团队图标，或输入 /paseo-team 即可开始。",
    pickNodeHint: "点击上方任意角色卡片查看详情或进入对应对话。",
    statusRunningCount: (n: number) => `${n} 运行中`,
    statusAttentionCount: (n: number) => `${n} 待你处理`,
    statusIdle: "已空闲",
    statusError: "异常",
    statusRunning: "运行中",
    statusInit: "启动中",
    statusPerm: "待授权",
    statusClosed: "已关闭",
    agentCountLabel: (n: number) => `${n} 个会话`,
    focusPrefix: "侧重：",
    openSubagentBtn: "进入对话",
    responsibilityTitle: "会话标题",
    emptyTitle: "当前对话还没有团队会话或子会话",
    emptyDesc:
      "点亮输入框底部的双人团队图标或运行 /paseo-team 启动协作；主控派出的所有子会话都会实时展示在这里。",
    pillDefault: "团队",
    pillSubagents: (n: number) => `团队 · ${n} 个会话`,
    pillRunning: (n: number) => `团队 · ${n} 运行中`,
    pillAttention: (n: number) => `团队 · ${n} 待处理`,
    badgeRunning: (n: number) => `团队 · ${n} 运行中`,
    badgeAttention: (n: number) => `团队 · ${n} 待处理`,
    kickoffDetails: "展开参数",
    kickoffHide: "收起",
    composerTeamToggle: "团队模式",
  },
} as const;
