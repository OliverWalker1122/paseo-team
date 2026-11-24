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

export const STAGE_LABELS: Record<
  UiLanguage,
  Record<
    | "coordinator"
    | "expert"
    | "plan-review"
    | "development"
    | "code-review"
    | "merge-gate",
    { title: string; subtitle: string }
  >
> = {
  en: {
    coordinator: {
      title: "Coordinator",
      subtitle: "Scope, dispatch & evidence ruling",
    },
    expert: {
      title: "Expert Plan",
      subtitle: "Architecture & root-cause analysis",
    },
    "plan-review": {
      title: "Plan Review",
      subtitle: "Cross review before coding",
    },
    development: {
      title: "Development",
      subtitle: "Implements & runs full CI",
    },
    "code-review": {
      title: "Code Review",
      subtitle: "Adversarial cross review",
    },
    "merge-gate": {
      title: "Quality Gate",
      subtitle: "CI, review & round limit",
    },
  },
  zh: {
    coordinator: {
      title: "主控协调",
      subtitle: "目标拆解与证据裁决",
    },
    expert: {
      title: "专家方案",
      subtitle: "架构设计与根因分析",
    },
    "plan-review": {
      title: "方案审查",
      subtitle: "实现前交叉审核",
    },
    development: {
      title: "开发实现",
      subtitle: "实现代码与运行完整测试",
    },
    "code-review": {
      title: "代码审查",
      subtitle: "对抗性交叉审核",
    },
    "merge-gate": {
      title: "验收门禁",
      subtitle: "CI、审查与轮次门禁",
    },
  },
};

export const GATE_CHECK_LABELS: Record<UiLanguage, Record<string, string>> = {
  en: {
    deliveryRecorded: "Developer delivery recorded",
    ciPassed: "Latest CI run passed",
    planReviewSatisfied: "Plan review satisfied",
    codeReviewSatisfied: "Code review approved (latest round)",
  },
  zh: {
    deliveryRecorded: "已登记开发交付摘要",
    ciPassed: "最近一次完整测试/CI 通过",
    planReviewSatisfied: "方案审查已通过或无需开启",
    codeReviewSatisfied: "代码审查最新一轮已批准",
  },
};

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

export function localizeNodeRoleLabel(
  lang: UiLanguage,
  role:
    | "coordinator"
    | "expert"
    | "plan-reviewer"
    | "developer"
    | "code-reviewer"
    | "gate",
  slotIndex: number,
  fallbackLabel: string,
  isNativeTree?: boolean,
  totalSameRole?: number,
  round?: number,
  multiRound?: boolean,
): string {
  if (isNativeTree) {
    if (role === "coordinator") {
      return lang === "en" ? "Main Chat" : "主对话";
    }
    return fallbackLabel;
  }
  const showRound = Boolean(round && (multiRound || round > 1));
  const roundSuffix = showRound
    ? lang === "en"
      ? ` · Round ${round}`
      : role === "developer" || role === "expert"
        ? round! > 1
          ? ` · 第 ${round} 轮修订`
          : ` · 第 1 轮`
        : ` · 第 ${round} 轮`
    : "";

  switch (role) {
    case "coordinator":
      return lang === "en" ? "Coordinator" : "主控 Coordinator";
    case "expert":
      return (lang === "en" ? "Expert" : "专家 Expert") + roundSuffix;
    case "developer": {
      const base =
        (totalSameRole ?? 1) > 1 ? `Developer #${slotIndex + 1}` : "Developer";
      return base + roundSuffix;
    }
    case "plan-reviewer":
      return (
        (lang === "en"
          ? `Plan Reviewer #${slotIndex + 1}`
          : `方案审查 #${slotIndex + 1}`) + roundSuffix
      );
    case "code-reviewer":
      return (
        (lang === "en"
          ? `Code Reviewer #${slotIndex + 1}`
          : `代码审查 #${slotIndex + 1}`) + roundSuffix
      );
    case "gate":
      return lang === "en" ? "Quality Gate" : "验收门禁";
  }
}

export function localizeStepTitle(
  lang: UiLanguage,
  stageId:
    | "coordinator"
    | "expert"
    | "plan-review"
    | "development"
    | "code-review"
    | "merge-gate",
  round?: number,
  multiRound?: boolean,
): string {
  const base = STAGE_LABELS[lang][stageId].title;
  if (!round || (!multiRound && round <= 1)) {
    return base;
  }
  if (lang === "en") {
    if (stageId === "development" && round > 1) {
      return `Development · Round ${round}`;
    }
    if (stageId === "expert" && round > 1) {
      return `Plan Revision · Round ${round}`;
    }
    return `${base} · Round ${round}`;
  }
  if (stageId === "development") {
    return round > 1 ? `开发修订 · 第 ${round} 轮` : `开发实现 · 第 1 轮`;
  }
  if (stageId === "expert") {
    return round > 1 ? `方案修订 · 第 ${round} 轮` : `专家方案 · 第 1 轮`;
  }
  return `${base} · 第 ${round} 轮`;
}

export const UI_TEXT = {
  en: {
    // Navigation
    tabConfig: "Setup",
    tabHistory: "History",
    backToGraph: "Back to graph",
    configureTeam: "Setup",

    // Setup page
    setupIntro: "Pick a model for each role. Changes save automatically.",
    savedStatus: "Saved",
    savingStatus: "Saving…",
    sectionPresets: "Preset",
    sectionPresetsInfo:
      "A preset is a saved set of role models. New tasks use the default preset.",
    presetEditing: "Editing",
    defaultSuffix: " (default)",
    presetDefaultRow: "Default for new tasks",
    presetDefaultHintIs: "New tasks use this preset.",
    presetDefaultHintNot: (name: string) =>
      `New tasks currently use "${name}".`,
    setGlobalDefault: "Set as default",
    isGlobalDefault: "Default",
    presetDeleteRow: "Delete preset",
    presetDeleteHintDefault: "Pick another default before deleting this one.",
    presetDeleteHintLast: "At least one preset must remain.",
    presetDeleteHint: "Removes this preset and its project bindings.",
    deletePresetBtn: "Delete",
    newPresetBtn: "New preset",
    newPresetPlaceholder: "Preset name",
    newPresetHint: (from: string) => `Starts as a copy of "${from}".`,
    createBtn: "Create",
    sectionDeveloper: "Developer",
    sectionDeveloperInfo:
      "The only role that edits files. Works directly in this workspace and runs the full test suite.",
    effortLabel: "Reasoning effort",
    effortDefault: "Model default",
    sectionReview: "Code review",
    sectionReviewInfo:
      "Cross review: two reviewers examine each change independently from opposing angles and never see each other's verdict.",
    rev1RoleTitle: "Code Reviewer #1",
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
    autoModelLabel: "Auto",
    autoModelDesc:
      "Picks a ready model and gives the two reviewers different providers",
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
    errCannotDeleteDefault: "Pick another default before deleting this preset.",
    errNoWorkspaceCwd: "Can't detect the current workspace directory.",
    errEnterTaskGoal: "Enter a task goal.",
    toastTaskStarted: "Team started in this chat",

    // History
    filterAll: "All",
    filterActive: "Active",
    filterDone: "Done",
    noHistoryYet: "No team tasks yet. Run /paseo-team in a chat to start one.",
    noHistoryForFilter: "No tasks match this filter.",
    pickNodeHint: "Select an agent above to see its details.",
    statusRunningCount: (n: number) => `${n} running`,
    statusMerged: "Done",
    statusActive: "Active",
    statusHalted: "Halted",
    reviewRoundsTitle: "Review rounds",
    verdictApprove: "Approved",
    verdictChanges: "Changes requested",
    verdictBlocked: "Blocked",
    findingBlocking: "Must fix",
    findingAdvice: "Advice",
    findingsDigest: (blocking: number, advice: number) =>
      [
        blocking > 0 ? `${blocking} must-fix` : "",
        advice > 0 ? `${advice} advice` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    roundsCount: (n: number) => `${n} rounds`,

    // Graph
    nativeTreeBadge: "Subagents of this chat",
    presetBadge: (name: string, mode: string) =>
      `${name} · ${mode === "expert" ? "Expert plan" : "Chat plan"}`,
    ciLabel: "CI",
    ciPass: "passed",
    ciWaived: "waived",
    ciPending: "pending",
    circuitBrokenTitle: (stage: string) =>
      `Stopped after 2 review rounds (${stage === "plan" ? "plan review" : "code review"})`,
    authorizeNextRound: "Allow one more round",
    hiddenStagesHint: (n: number) =>
      `${n} unused stage${n > 1 ? "s" : ""} hidden`,
    parallelTag: (n: number) => `×${n}`,
    focusPrefix: "Focus:",
    currentChatTag: "● This chat",
    gateCompleted: "Verified",
    gateReady: "Ready",
    gateCheck: "Not checked",
    coordinatorIdle: "Coordinator",
    waitingPrev: "Waiting",
    openSubagentBtn: "Open chat",
    recheckGateBtn: "Recheck",
    completeTaskBtn: "Mark complete",
    responsibilityTitle: "Assignment",
    outcomeTitle: "Result",
    gateChecklistTitle: "Quality checks",
    emptyTitle: "No subagents in this chat yet",
    emptyDesc:
      "Each chat has its own workflow graph. Run /paseo-team or spawn subagents here and every step grows downward as work progresses.",
    startPlaceholder: (team: string) =>
      `Describe a task for the team (preset: ${team}; add "with review" to force code review)`,
    startingBtn: "Starting…",
    startBtn: "Start in this chat",
    blueprintPreviewTitle: (team: string) => `How preset "${team}" runs`,
    blueprintCoord: "Coordinator",
    blueprintThisChat: "This chat",
    blueprintExpert: "Expert plan",
    blueprintDev: "Developer",
    blueprintReview: "Code review",
    blueprintGate: "Quality gate",
    blueprintAutoCheck: "CI + review",
    visRunning: "Running",
    visAuth: "Needs approval",
    visApproved: "Approved",
    visCompleted: "Done",
    visChanges: "Changes requested",
    visBlocked: "Blocked",
    visSkipped: "Skipped",
    visPending: "Pending",
    liveRunning: "Running",
    liveInit: "Starting",
    livePerm: "Awaiting permission",
    liveError: "Error",
    liveClosed: "Closed",
    liveIdleApproved: "Approved",
    liveIdleChanges: "Requested changes",
    liveIdleDone: "Turn finished",
    liveDone: "Done",
    liveSkipped: "Skipped",
    liveWaiting: "Waiting for upstream",
    pillDefault: "Team graph",
    pillSubagents: (n: number) => `Team · ${n} agents`,
    pillRunning: (n: number) => `Team · ${n} running`,
    pillAttention: (n: number) => `Team · ${n} need you`,
    pillBreaker: "Team · Halted",
    pillDone: "Team · Done",
    badgeHalted: "Team halted",
    badgeRunning: (n: number) => `Team · ${n} running`,
  },
  zh: {
    // Navigation
    tabConfig: "配置",
    tabHistory: "历史",
    backToGraph: "返回状态图",
    configureTeam: "配置",

    // Setup page
    setupIntro: "为每个角色选择模型，修改自动保存。",
    savedStatus: "已保存",
    savingStatus: "保存中…",
    sectionPresets: "预设",
    sectionPresetsInfo: "预设是一组角色模型配置，新任务默认使用「默认预设」。",
    presetEditing: "当前编辑",
    defaultSuffix: "（默认）",
    presetDefaultRow: "新任务默认使用",
    presetDefaultHintIs: "新任务会使用这个预设。",
    presetDefaultHintNot: (name: string) => `新任务当前使用「${name}」。`,
    setGlobalDefault: "设为默认",
    isGlobalDefault: "已是默认",
    presetDeleteRow: "删除预设",
    presetDeleteHintDefault: "请先把其他预设设为默认，再删除这个。",
    presetDeleteHintLast: "至少需要保留一个预设。",
    presetDeleteHint: "删除这个预设及其项目绑定。",
    deletePresetBtn: "删除",
    newPresetBtn: "新建预设",
    newPresetPlaceholder: "预设名称",
    newPresetHint: (from: string) => `以「${from}」为副本创建。`,
    createBtn: "创建",
    sectionDeveloper: "开发",
    sectionDeveloperInfo:
      "唯一可以修改文件的角色，直接在当前工作区改代码并运行完整测试。",
    effortLabel: "推理强度",
    effortDefault: "模型默认",
    sectionReview: "代码审查",
    sectionReviewInfo:
      "交叉审核：两位审查员从对立视角独立审查每次改动，彼此看不到对方结论。",
    rev1RoleTitle: "代码审查 #1",
    rev1RoleHint: "需求符合度与真实边界场景",
    rev2RoleTitle: "代码审查 #2",
    rev2RoleHint: "架构一致性与更简单的方案",
    sameModelHint: (model: string) =>
      `两位审查员都在用 Developer 的模型（${model}）。换成其他模型家族，更容易发现它的盲点。`,
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
    autoModelLabel: "自动",
    autoModelDesc: "自动选用本机可用模型，并让两位审查员使用不同 Provider",
    noneReviewerLabel: "关闭（单人审查）",
    noneReviewerDesc: "只派 1 位代码审查，不开第 2 位",
    selectModelTitle: "选择模型",
    searchModelPlaceholder: "按 Provider 或模型名筛选",
    noMatchingModels: "没有匹配的模型。",
    providerDefaultModel: "Provider 默认模型",

    // Errors and toasts
    errEnterPresetName: "请输入预设名称。",
    errPresetExists: (n: string) => `已存在名为「${n}」的预设。`,
    errKeepOnePreset: "至少需要保留一个预设。",
    errCannotDeleteDefault: "请先把其他预设设为默认，再删除这个。",
    errNoWorkspaceCwd: "无法识别当前工作区目录。",
    errEnterTaskGoal: "请输入任务目标。",
    toastTaskStarted: "已在当前对话启动团队协作",

    // History
    filterAll: "全部",
    filterActive: "进行中",
    filterDone: "已完成",
    noHistoryYet: "还没有团队任务。在对话里运行 /paseo-team 即可开始。",
    noHistoryForFilter: "没有符合条件的任务。",
    pickNodeHint: "点击上方节点查看详情。",
    statusRunningCount: (n: number) => `${n} 运行中`,
    statusMerged: "已完成",
    statusActive: "进行中",
    statusHalted: "已熔断",
    reviewRoundsTitle: "审查记录",
    verdictApprove: "通过",
    verdictChanges: "需修改",
    verdictBlocked: "阻断",
    findingBlocking: "必改",
    findingAdvice: "建议",
    findingsDigest: (blocking: number, advice: number) =>
      [
        blocking > 0 ? `${blocking} 条必改` : "",
        advice > 0 ? `${advice} 条建议` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    roundsCount: (n: number) => `${n} 轮`,

    // Graph
    nativeTreeBadge: "当前对话的子 Agent",
    presetBadge: (name: string, mode: string) =>
      `${name} · ${mode === "expert" ? "专家起草方案" : "主控起草方案"}`,
    ciLabel: "CI",
    ciPass: "已通过",
    ciWaived: "已豁免",
    ciPending: "待执行",
    circuitBrokenTitle: (stage: string) =>
      `两轮审查未通过，已暂停（${stage === "plan" ? "方案审查" : "代码审查"}）`,
    authorizeNextRound: "允许再审一轮",
    hiddenStagesHint: (n: number) => `已隐藏 ${n} 个未启用阶段`,
    parallelTag: (n: number) => `×${n}`,
    focusPrefix: "侧重：",
    currentChatTag: "● 当前对话",
    gateCompleted: "已验收",
    gateReady: "可验收",
    gateCheck: "未核验",
    coordinatorIdle: "主控会话",
    waitingPrev: "等待前置阶段",
    openSubagentBtn: "进入对话",
    recheckGateBtn: "重新核验",
    completeTaskBtn: "确认完成",
    responsibilityTitle: "分配任务",
    outcomeTitle: "产出结论",
    gateChecklistTitle: "验收检查项",
    emptyTitle: "当前对话还没有子 Agent",
    emptyDesc:
      "每个对话有自己的工作流状态图。在这里运行 /paseo-team 或派生子 Agent，各执行与审查轮次会按工作流节点向下动态展开。",
    startPlaceholder: (team: string) =>
      `描述要交给团队的任务（预设：${team}；写“需要审查”可强制代码审查）`,
    startingBtn: "启动中…",
    startBtn: "在此对话启动",
    blueprintPreviewTitle: (team: string) => `预设「${team}」的执行流程`,
    blueprintCoord: "主控协调",
    blueprintThisChat: "当前对话",
    blueprintExpert: "专家方案",
    blueprintDev: "Developer",
    blueprintReview: "代码审查",
    blueprintGate: "验收门禁",
    blueprintAutoCheck: "CI + 审查",
    visRunning: "运行中",
    visAuth: "待授权",
    visApproved: "已通过",
    visCompleted: "已完成",
    visChanges: "需修改",
    visBlocked: "已阻断",
    visSkipped: "跳过",
    visPending: "待启动",
    liveRunning: "正在执行",
    liveInit: "正在启动",
    livePerm: "等待权限确认",
    liveError: "执行异常",
    liveClosed: "会话已关闭",
    liveIdleApproved: "已审查通过",
    liveIdleChanges: "已提修改意见",
    liveIdleDone: "本轮已完成",
    liveDone: "已完成",
    liveSkipped: "未启用",
    liveWaiting: "等待前置阶段",
    pillDefault: "团队状态图",
    pillSubagents: (n: number) => `团队 · ${n} 个会话`,
    pillRunning: (n: number) => `团队 · ${n} 运行中`,
    pillAttention: (n: number) => `团队 · ${n} 待处理`,
    pillBreaker: "团队 · 已熔断",
    pillDone: "团队 · 已完成",
    badgeHalted: "团队已熔断",
    badgeRunning: (n: number) => `团队 · ${n} 运行中`,
  },
} as const;
