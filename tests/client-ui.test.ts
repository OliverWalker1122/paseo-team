import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import type {
  ConfigBundleDto,
  ConversationGraphPayloadDto,
  PipelineTaskSnapshotDto,
} from "../shared/contracts.ts";

process.env.SKIP_DOTENV = "true";
process.env.DOTENV_CONFIG_PATH = "/dev/null";

interface RenderedNode {
  type: string;
  props: Record<string, unknown>;
  children: Array<RenderedNode | string>;
}

interface HookSlot {
  kind: "state" | "memo" | "effect";
  value?: unknown;
  deps?: readonly unknown[];
  cleanup?: (() => void) | void;
}

class StatefulTreeRenderer {
  private states = new Map<string, HookSlot[]>();
  private pendingEffects: Array<{
    slot: HookSlot;
    effect: () => (() => void) | void;
  }> = [];
  private activeSlots: HookSlot[] | null = null;
  private activeIdx = 0;
  private lastElement: unknown = null;
  public root: RenderedNode | string | null = null;

  useState<T>(
    initial: T | (() => T),
  ): [T, (next: T | ((prev: T) => T)) => void] {
    const slots = this.activeSlots!;
    const idx = this.activeIdx++;
    if (!slots[idx]) {
      const initVal =
        typeof initial === "function" ? (initial as () => T)() : initial;
      slots[idx] = { kind: "state", value: initVal };
    }
    const slot = slots[idx];
    const setter = (next: T | ((prev: T) => T)) => {
      const prev = slot.value as T;
      const resolved =
        typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      if (!Object.is(prev, resolved)) {
        slot.value = resolved;
      }
    };
    return [slot.value as T, setter];
  }

  useMemo<T>(factory: () => T, deps?: readonly unknown[]): T {
    const slots = this.activeSlots!;
    const idx = this.activeIdx++;
    const prev = slots[idx];
    const unchanged =
      prev &&
      prev.deps &&
      deps &&
      prev.deps.length === deps.length &&
      prev.deps.every((d, i) => Object.is(d, deps[i]));
    if (unchanged) {
      return prev.value as T;
    }
    const value = factory();
    slots[idx] = { kind: "memo", value, deps };
    return value;
  }

  useEffect(
    effect: () => (() => void) | void,
    deps?: readonly unknown[],
  ): void {
    const slots = this.activeSlots!;
    const idx = this.activeIdx++;
    const prev = slots[idx];
    const unchanged =
      prev &&
      prev.deps &&
      deps &&
      prev.deps.length === deps.length &&
      prev.deps.every((d, i) => Object.is(d, deps[i]));
    if (unchanged) return;
    const slot: HookSlot = prev ?? { kind: "effect" };
    slot.deps = deps;
    slots[idx] = slot;
    this.pendingEffects.push({ slot, effect });
  }

  render(element: unknown): RenderedNode | string | null {
    this.lastElement = element;
    this.pendingEffects = [];
    this.root = this.evalNode(element, "root");
    const effects = [...this.pendingEffects];
    this.pendingEffects = [];
    for (const item of effects) {
      if (typeof item.slot.cleanup === "function") {
        item.slot.cleanup();
      }
      item.slot.cleanup = item.effect();
    }
    return this.root;
  }

  rerender(): RenderedNode | string | null {
    return this.render(this.lastElement);
  }

  unmount(): void {
    for (const slots of this.states.values()) {
      for (const slot of slots) {
        if (slot.kind === "effect" && typeof slot.cleanup === "function") {
          slot.cleanup();
          slot.cleanup = undefined;
        }
      }
    }
    this.states.clear();
    this.root = null;
  }

  private evalNode(
    node: unknown,
    pathKey: string,
  ): RenderedNode | string | null {
    if (node === null || node === undefined || typeof node === "boolean") {
      return null;
    }
    if (typeof node === "string" || typeof node === "number") {
      return String(node);
    }
    if (Array.isArray(node)) {
      const children = node
        .map((child, idx) => this.evalNode(child, `${pathKey}[${idx}]`))
        .filter((x): x is RenderedNode | string => x !== null);
      return { type: "Fragment", props: {}, children };
    }
    if (typeof node === "object" && node !== null && "__vnode" in node) {
      const vnode = node as unknown as {
        type: unknown;
        props: Record<string, unknown>;
        key?: string | null;
      };
      const instanceKey = `${pathKey}/${
        typeof vnode.type === "function"
          ? vnode.type.name || "Anon"
          : String(vnode.type)
      }${vnode.key != null ? `#${vnode.key}` : ""}`;

      if (typeof vnode.type === "function") {
        const prevSlots = this.activeSlots;
        const prevIdx = this.activeIdx;
        let slots = this.states.get(instanceKey);
        if (!slots) {
          slots = [];
          this.states.set(instanceKey, slots);
        }
        this.activeSlots = slots;
        this.activeIdx = 0;
        try {
          const out = (vnode.type as (p: Record<string, unknown>) => unknown)(
            vnode.props,
          );
          return this.evalNode(out, instanceKey);
        } finally {
          this.activeSlots = prevSlots;
          this.activeIdx = prevIdx;
        }
      }

      const resolvedProps = { ...vnode.props };
      if (typeof resolvedProps.style === "function") {
        resolvedProps.style = (
          resolvedProps.style as (s: Record<string, boolean>) => unknown
        )({ pressed: false, hovered: true });
      }
      const rawChildren = resolvedProps.children;
      const childList = Array.isArray(rawChildren)
        ? rawChildren
        : rawChildren !== undefined
          ? [rawChildren]
          : [];
      const children = childList
        .map((c, idx) => this.evalNode(c, `${instanceKey}.${idx}`))
        .filter((x): x is RenderedNode | string => x !== null);
      return {
        type: String(vnode.type),
        props: resolvedProps,
        children,
      };
    }
    return null;
  }
}

function collectText(node: RenderedNode | string | null): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  const ownLabel = [node.props.label, node.props.title, node.props.hint]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ");
  const childText = node.children.map((c) => collectText(c)).join(" ");
  return [ownLabel, childText].filter(Boolean).join(" ");
}

function findNodes(
  node: RenderedNode | string | null,
  pred: (n: RenderedNode) => boolean,
  out: RenderedNode[] = [],
): RenderedNode[] {
  if (!node || typeof node === "string") return out;
  if (pred(node)) out.push(node);
  for (const c of node.children) {
    findNodes(c, pred, out);
  }
  return out;
}

const uiSandbox = {
  renderer: new StatefulTreeRenderer(),
  locale: "zh-CN",
  workspaces: new Map<
    string,
    { id: string; directory: string; name: string }
  >(),
  rpcHandlers: new Map<string, (input: unknown) => Promise<unknown>>(),
  subListeners: new Map<
    string,
    Set<{ input: unknown; onEvent: (ev: unknown) => void }>
  >(),
  toasts: [] as Array<{ message: string; variant?: string }>,
  emitSubscription(name: string, event: unknown) {
    for (const sub of this.subListeners.get(name) ?? []) {
      sub.onEvent(event);
    }
  },
  reset() {
    this.renderer.unmount();
    this.renderer = new StatefulTreeRenderer();
    this.locale = "zh-CN";
    this.workspaces.clear();
    this.rpcHandlers.clear();
    this.subListeners.clear();
    this.toasts.length = 0;
  },
};

(globalThis as Record<string, unknown>).__paseoUiSandbox = uiSandbox;

const VIRTUAL_PREFIX = pathToFileURL("/__paseo_virtual__/").href;
const VIRTUAL_SPECIFIERS: Record<string, string> = {
  react: `${VIRTUAL_PREFIX}react.mjs`,
  "react/jsx-runtime": `${VIRTUAL_PREFIX}jsx-runtime.mjs`,
  "react-native": `${VIRTUAL_PREFIX}react-native.mjs`,
  "@getpaseo/plugin/client": `${VIRTUAL_PREFIX}paseo-client.mjs`,
  "@getpaseo/plugin/client/ui": `${VIRTUAL_PREFIX}paseo-client-ui.mjs`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (VIRTUAL_SPECIFIERS[specifier]) {
      return { url: VIRTUAL_SPECIFIERS[specifier], shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === VIRTUAL_SPECIFIERS.react) {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          const sb = () => globalThis.__paseoUiSandbox.renderer;
          export const Fragment = "Fragment";
          export function useState(init) { return sb().useState(init); }
          export function useMemo(fn, deps) { return sb().useMemo(fn, deps); }
          export function useEffect(fn, deps) { return sb().useEffect(fn, deps); }
          export function createElement(type, props, ...children) {
            return { __vnode: true, type, props: { ...(props || {}), children } };
          }
          export default { Fragment, useState, useMemo, useEffect, createElement };
        `,
      };
    }
    if (url === VIRTUAL_SPECIFIERS["react/jsx-runtime"]) {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const Fragment = "Fragment";
          export function jsx(type, props, key) {
            return { __vnode: true, type, props: props || {}, key };
          }
          export const jsxs = jsx;
        `,
      };
    }
    if (url === VIRTUAL_SPECIFIERS["react-native"]) {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const View = "View";
          export const Text = "Text";
          export const Pressable = "Pressable";
          export const ScrollView = "ScrollView";
          export const TextInput = "TextInput";
          export const Platform = { OS: "web" };
        `,
      };
    }
    if (url === VIRTUAL_SPECIFIERS["@getpaseo/plugin/client"]) {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          const sb = () => globalThis.__paseoUiSandbox;
          export function defineTranslations(config) {
            return {
              resources: config.resources,
              message(key) { return { __i18nKey: key, resources: config.resources }; },
            };
          }
          export function useTranslation() {
            return { locale: sb().locale };
          }
          export function useWorkspace(workspaceId, selector) {
            const ws = sb().workspaces.get(workspaceId) || { id: workspaceId, directory: "", name: workspaceId };
            return selector(ws);
          }
          export function useRpc(contract) {
            return sb().renderer.useMemo(() => async (input) => {
              const fn = sb().rpcHandlers.get(contract.name);
              if (!fn) throw new Error("Unhandled RPC in UI test: " + contract.name);
              return await fn(input);
            }, [contract.name]);
          }
          export function useSubscription(contract, input, onEvent) {
            sb().renderer.useEffect(() => {
              let set = sb().subListeners.get(contract.name);
              if (!set) {
                set = new Set();
                sb().subListeners.set(contract.name, set);
              }
              const entry = { input, onEvent };
              set.add(entry);
              return () => { set.delete(entry); };
            }, [contract.name, input]);
          }
        `,
      };
    }
    if (url === VIRTUAL_SPECIFIERS["@getpaseo/plugin/client/ui"]) {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          const sb = () => globalThis.__paseoUiSandbox;
          export const Icon = "Icon";
          export const Loading = "Loading";
          export const ScrollView = "ScrollView";
          export const SidebarRow = "SidebarRow";
          export const WorkspaceRowBadge = "WorkspaceRowBadge";
          export const SettingsCard = "SettingsCard";
          export const SettingsRow = "SettingsRow";
          export const SettingsSection = "SettingsSection";
          export const SettingsSelect = "SettingsSelect";
          export const SettingsSwitch = "SettingsSwitch";
          export const TextInput = "TextInput";
          export const Modal = Object.assign(
            function Modal(props) {
              if (!props.open) return null;
              return { __vnode: true, type: "Modal", props };
            },
            { Content: "ModalContent" }
          );
          export function useToast() {
            return sb().renderer.useMemo(() => ({
              show(message, opts) { sb().toasts.push({ message, variant: opts?.variant }); },
              error(message) { sb().toasts.push({ message, variant: "error" }); },
            }), []);
          }
        `,
      };
    }
    if (url.endsWith(".tsx")) {
      const filePath = fileURLToPath(url);
      const raw = readFileSync(filePath, "utf8");
      const out = ts.transpileModule(raw, {
        fileName: filePath,
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
        },
      });
      return {
        format: "module",
        shortCircuit: true,
        source: out.outputText,
      };
    }
    return nextLoad(url, context);
  },
});

const THEME = {
  appearance: "dark" as const,
  colors: {
    surface0: "#111",
    surface1: "#222",
    surface2: "#333",
    surface3: "#444",
    foreground: "#fff",
    foregroundMuted: "#999",
    border: "#444",
    accent: "#3b82f6",
    accentForeground: "#fff",
    statusSuccess: "#22c55e",
    statusWarning: "#f59e0b",
    statusDanger: "#ef4444",
  },
};

function sampleTaskSnapshot(
  overrides: Partial<PipelineTaskSnapshotDto> = {},
): PipelineTaskSnapshotDto {
  return {
    recordPath: "/tmp/state/todo/20261126-task-1/task.json",
    taskId: "20261126-task-1",
    sourceKind: "team_task",
    projectRoot: "/home/lcq/ai/test/todo",
    goal: "为 todo.mjs 新增 clear 子命令并补充测试",
    isComplex: false,
    teamName: "标准",
    complexMode: "simple",
    coordinatorAgentId: "todo-coord-1",
    planReview: "required",
    planReviewRound: 1,
    codeReview: "required",
    codeReviewRound: 0,
    ciStatus: "pending",
    circuitBroken: null,
    gateChecks: {
      deliveryRecorded: false,
      ciPassed: false,
      planReviewSatisfied: false,
      codeReviewSatisfied: false,
    },
    gateReady: false,
    gateMissing: ["Developer delivery has not been recorded yet."],
    lifecycleStatus: "active",
    runningCount: 1,
    attentionCount: 0,
    skippedStageCount: 0,
    stages: [
      {
        stepId: "coordinator",
        stageId: "coordinator",
        stepNumber: 1,
        title: "主控协调",
        subtitle: "目标拆解与证据裁决",
        stageStatus: "running",
        nodes: [
          {
            nodeId: "coordinator",
            stage: "coordinator",
            role: "coordinator",
            slotIndex: 0,
            label: "主控 Coordinator",
            profile: "claude/claude-opus-5-5",
            modelBadge: "claude/claude-opus-5-5 · high",
            agentId: "todo-coord-1",
            briefSummary: "目标拆解、派发协调与证据裁决",
            liveState: "running",
            visualStatus: "running",
            updatedAt: "2026-11-26T07:00:00.000Z",
          },
        ],
      },
      {
        stepId: "plan-review",
        stageId: "plan-review",
        round: 1,
        stepNumber: 2,
        title: "方案审查",
        subtitle: "第 1/2 轮 · 交叉审核",
        stageStatus: "blocked",
        nodes: [
          {
            nodeId: "plan-reviewer-0",
            stage: "plan-review",
            role: "plan-reviewer",
            slotIndex: 0,
            label: "方案审查 #1",
            profile: "codex/gpt-6.2-astra",
            modelBadge: "codex/gpt-6.2-astra · high",
            agentId: "todo-plan-rev-1",
            perspectiveLabel: "需求规格与真实边界场景",
            briefSummary: "审查方案边界",
            liveState: "idle",
            visualStatus: "changes_requested",
            round: 1,
            verdict: "REQUEST_CHANGES",
            summary: "需补齐空文件边界测试",
            rounds: [
              {
                round: 1,
                verdict: "REQUEST_CHANGES",
                summary: "需补齐空文件边界测试",
                findings: [
                  "blocking: todo.mjs:42 空列表退出码不一致",
                  "advice: 提示信息保持单行",
                ],
                recordedAt: "2026-11-26T07:05:00.000Z",
              },
            ],
            updatedAt: "2026-11-26T07:05:00.000Z",
          },
        ],
      },
      {
        stepId: "merge-gate",
        stageId: "merge-gate",
        stepNumber: 3,
        title: "验收门禁",
        subtitle: "CI、审查与轮次门禁",
        stageStatus: "pending",
        nodes: [
          {
            nodeId: "merge-gate",
            stage: "merge-gate",
            role: "gate",
            slotIndex: 0,
            label: "验收门禁",
            profile: "质量验收门禁",
            briefSummary: "核对最新一次测试/CI 与最新一轮审查批准",
            liveState: "not_started",
            visualStatus: "pending",
            updatedAt: "2026-11-26T07:00:00.000Z",
          },
        ],
      },
    ],
    createdAt: "2026-11-26T07:00:00.000Z",
    updatedAt: "2026-11-26T07:05:00.000Z",
    ...overrides,
  };
}

function createClientMock() {
  const workspacePanels: Array<Record<string, unknown>> = [];
  const agentPanels: Array<Record<string, unknown>> = [];
  const screens: Array<Record<string, unknown>> = [];
  const sidebarItems: Array<Record<string, unknown>> = [];
  const settingsScreens: Array<Record<string, unknown>> = [];
  const rowBadges: Array<Record<string, unknown>> = [];
  const commandItems: Array<Record<string, unknown>> = [];
  const slashCommands: Array<Record<string, unknown>> = [];
  const timelineTransformers: Array<Record<string, unknown>> = [];
  const timelineRenderers: Array<Record<string, unknown>> = [];
  const openedPanels: Array<{
    panelId: string;
    workspaceId: string;
    agentId?: string;
    source: string;
  }> = [];
  const openedScreens: Array<Record<string, unknown>> = [];

  const pills = new Map<
    string,
    {
      workspaceId: string;
      agentId: string;
      label: string;
      title: string;
      removed: boolean;
      onPress: () => void;
    }
  >();

  let agentSubCallbacks: {
    snapshot: (data: {
      entries: Array<{ agent: Record<string, unknown> }>;
    }) => void;
    update: (msg: {
      type: string;
      payload:
        | { kind: "upsert"; agent: Record<string, unknown> }
        | { kind: "remove"; agentId: string };
    }) => void;
  } | null = null;

  let tasksSubCallback:
    ((ev: { tasks: PipelineTaskSnapshotDto[] }) => void) | null = null;

  const client = {
    i18n: { locale: "zh-CN" },
    paseo: {
      agents: {
        async list() {
          return {
            subscription: {
              subscribe(cbs: NonNullable<typeof agentSubCallbacks>) {
                agentSubCallbacks = cbs;
              },
            },
          };
        },
      },
    },
    addScreen(c: Record<string, unknown>) {
      screens.push(c);
      return () => {
        const i = screens.indexOf(c);
        if (i >= 0) screens.splice(i, 1);
      };
    },
    addSidebarHeaderItem(c: Record<string, unknown>) {
      sidebarItems.push(c);
      return () => {
        const i = sidebarItems.indexOf(c);
        if (i >= 0) sidebarItems.splice(i, 1);
      };
    },
    addSettingsScreen(c: Record<string, unknown>) {
      settingsScreens.push(c);
      return () => {
        const i = settingsScreens.indexOf(c);
        if (i >= 0) settingsScreens.splice(i, 1);
      };
    },
    addWorkspacePanel(c: Record<string, unknown>) {
      workspacePanels.push(c);
      return () => {
        const i = workspacePanels.indexOf(c);
        if (i >= 0) workspacePanels.splice(i, 1);
      };
    },
    addAgentPanel(c: Record<string, unknown>) {
      agentPanels.push(c);
      return () => {};
    },
    addWorkspaceRowBadgeItem(c: Record<string, unknown>) {
      rowBadges.push(c);
      return () => {
        const i = rowBadges.indexOf(c);
        if (i >= 0) rowBadges.splice(i, 1);
      };
    },
    addComposerPill(c: {
      id: string;
      workspaceId: string;
      agentId: string;
      button: {
        title: string;
        label?: string;
        behavior: { kind: "action"; onPress: () => void };
      };
    }) {
      const record = {
        workspaceId: c.workspaceId,
        agentId: c.agentId,
        label: c.button.label ?? c.button.title,
        title: c.button.title,
        removed: false,
        onPress: c.button.behavior.onPress,
      };
      pills.set(c.agentId, record);
      return {
        update(patch: { label?: string; title?: string }) {
          if (record.removed) return;
          if (patch.label !== undefined) record.label = patch.label;
          if (patch.title !== undefined) record.title = patch.title;
        },
        remove() {
          record.removed = true;
          pills.delete(c.agentId);
        },
      };
    },
    addCommandCenterItem(c: Record<string, unknown>) {
      commandItems.push(c);
      return () => {
        const i = commandItems.indexOf(c);
        if (i >= 0) commandItems.splice(i, 1);
      };
    },
    addSlashCommand(c: Record<string, unknown>) {
      slashCommands.push(c);
      return () => {
        const i = slashCommands.indexOf(c);
        if (i >= 0) slashCommands.splice(i, 1);
      };
    },
    addTimelineTransformer(c: Record<string, unknown>) {
      timelineTransformers.push(c);
      return () => {
        const i = timelineTransformers.indexOf(c);
        if (i >= 0) timelineTransformers.splice(i, 1);
      };
    },
    addTimelineRenderer(c: Record<string, unknown>) {
      timelineRenderers.push(c);
      return () => {
        const i = timelineRenderers.indexOf(c);
        if (i >= 0) timelineRenderers.splice(i, 1);
      };
    },
    openPanel(
      panelId: string,
      options: { workspaceId: string; agentId?: string },
    ) {
      openedPanels.push({
        panelId,
        workspaceId: options.workspaceId,
        ...(options.agentId ? { agentId: options.agentId } : {}),
        source: "client.openPanel",
      });
    },
    subscribe(
      contract: { name: string },
      _input: unknown,
      onEvent: (ev: { tasks: PipelineTaskSnapshotDto[] }) => void,
    ) {
      if (contract.name === "paseo_team.tasks.watch") {
        tasksSubCallback = onEvent;
      }
      return {
        async release() {
          tasksSubCallback = null;
        },
      };
    },
  };

  return {
    client,
    workspacePanels,
    agentPanels,
    screens,
    sidebarItems,
    settingsScreens,
    rowBadges,
    commandItems,
    slashCommands,
    timelineTransformers,
    timelineRenderers,
    openedPanels,
    openedScreens,
    pills,
    pushAgentSnapshot(agents: Array<Record<string, unknown>>) {
      assert.ok(agentSubCallbacks, "expected agents.list subscription");
      agentSubCallbacks.snapshot({
        entries: agents.map((agent) => ({ agent })),
      });
    },
    pushAgentUpsert(agent: Record<string, unknown>) {
      assert.ok(agentSubCallbacks);
      agentSubCallbacks.update({
        type: "agent_update",
        payload: { kind: "upsert", agent },
      });
    },
    pushAgentRemove(agentId: string) {
      assert.ok(agentSubCallbacks);
      agentSubCallbacks.update({
        type: "agent_update",
        payload: { kind: "remove", agentId },
      });
    },
    pushTasks(tasks: PipelineTaskSnapshotDto[]) {
      assert.ok(tasksSubCallback, "expected watchTasksSubscription");
      tasksSubCallback({ tasks });
    },
  };
}

test("UI regression: registers one workspace-scoped team-graph panel (zero agent panels), hides pills on standalone test chats, and reuses the single tab across all triggers", async () => {
  uiSandbox.reset();
  const clientEntry = await import("../index.client.tsx");
  const mock = createClientMock();
  const cleanup = clientEntry.default(mock.client as never);
  await new Promise((r) => setTimeout(r, 10));

  // 1. Exactly ONE workspace-scoped panel ("team-graph"), ZERO per-agent panels!
  assert.equal(mock.agentPanels.length, 0);
  assert.equal(mock.workspacePanels.length, 1);
  assert.equal(mock.workspacePanels[0].id, "team-graph");
  assert.equal(mock.screens[0].id, "team-center");
  assert.equal(mock.sidebarItems[0].id, "team-center");
  assert.equal(mock.settingsScreens[0].id, "team-settings");
  assert.equal(mock.rowBadges[0].id, "team-badge");

  // 2. Standalone chats in `test` workspace have NO pills; subagent trees & team tasks get pills!
  mock.pushAgentSnapshot([
    {
      id: "test-standalone-1",
      workspaceId: "wks_test",
      parentAgentId: null,
      status: "idle",
      background: false,
    },
    {
      id: "test-standalone-2",
      workspaceId: "wks_test",
      parentAgentId: null,
      status: "closed",
      background: false,
    },
    {
      id: "bg-helper",
      workspaceId: "wks_todo",
      parentAgentId: null,
      status: "running",
      background: true,
    },
    {
      id: "todo-coord-1",
      workspaceId: "wks_todo",
      parentAgentId: null,
      status: "idle",
      background: false,
    },
    {
      id: "todo-plan-rev-1",
      workspaceId: "wks_todo",
      parentAgentId: "todo-coord-1",
      status: "running",
      background: false,
    },
  ]);

  assert.equal(
    mock.pills.has("test-standalone-1"),
    false,
    "standalone chat in test workspace must NOT mount a Team Graph pill",
  );
  assert.equal(mock.pills.has("test-standalone-2"), false);
  assert.equal(mock.pills.has("bg-helper"), false);
  assert.equal(mock.pills.get("todo-coord-1")?.label, "团队 · 1 运行中");
  assert.equal(mock.pills.get("todo-plan-rev-1")?.label, "团队 · 1 运行中");

  // Pushing both a completed task and an active task on the same coordinator prioritizes the active task.
  const completedTask = sampleTaskSnapshot({
    taskId: "20261125-done",
    lifecycleStatus: "completed",
    runningCount: 0,
  });
  const activeTask = sampleTaskSnapshot({
    taskId: "20261126-active",
    lifecycleStatus: "active",
    runningCount: 2,
  });
  mock.pushTasks([completedTask, activeTask]);
  assert.equal(mock.pills.get("todo-coord-1")?.label, "团队 · 2 运行中");
  assert.equal(
    mock.pills.get("todo-plan-rev-1")?.label,
    "方案审查 #1 · 团队状态图",
  );

  // If a standalone chat spawns a native subagent and later removes it, the pill mounts and cleans up.
  mock.pushAgentUpsert({
    id: "native-child",
    workspaceId: "wks_test",
    parentAgentId: "test-standalone-1",
    status: "idle",
    background: false,
  });
  assert.equal(mock.pills.get("test-standalone-1")?.label, "团队 · 1 个会话");
  mock.pushAgentRemove("native-child");
  assert.equal(mock.pills.has("test-standalone-1"), false);

  // 3. Clicking pills on coordinator & reviewer, running /paseo-team, and running Command Center
  //    all open the SAME workspace panel "team-graph" (without splitting tabs by agentId).
  mock.pills.get("todo-coord-1")!.onPress();
  mock.pills.get("todo-plan-rev-1")!.onPress();

  const slash = mock.slashCommands.find((c) => c.name === "paseo-team") as {
    onSubmit: (ctx: Record<string, unknown>) => Promise<void>;
  };
  const startRpcCalls: Array<Record<string, unknown>> = [];
  const makeActionCtx = (agentId: string) => ({
    workspace: { id: "wks_todo", directory: "/home/lcq/ai/test/todo" },
    agent: { id: agentId },
    async rpc(_contract: unknown, input: Record<string, unknown>) {
      startRpcCalls.push(input);
      return {
        taskId: "t1",
        recordPath: "/tmp/t1/task.json",
        coordinatorAgentId: agentId,
        teamName: "标准",
        message: "ok",
      };
    },
    openPanel(panelId: string) {
      mock.openedPanels.push({
        panelId,
        workspaceId: "wks_todo",
        source: "actionCtx.openPanel",
      });
    },
    openScreen(input: Record<string, unknown>) {
      mock.openedScreens.push(input);
    },
  });

  await slash.onSubmit({ ...makeActionCtx("todo-coord-1"), args: "setup" });
  assert.equal(mock.openedScreens.length, 1);
  assert.equal(mock.openedScreens[0].screenId, "team-center");

  await slash.onSubmit({ ...makeActionCtx("todo-coord-1"), args: "status" });
  const panelsBeforeStart = mock.openedPanels.length;
  await slash.onSubmit({
    ...makeActionCtx("todo-coord-1"),
    args: "新增 clear 子命令；需要审查",
  });
  assert.equal(startRpcCalls.length, 1);
  assert.equal(startRpcCalls[0].agentId, "todo-coord-1");
  assert.equal(
    mock.openedPanels.length,
    panelsBeforeStart,
    "starting a team task via /paseo-team <goal> must stay in the current chat without jumping to team-graph",
  );

  const openGraphCmd = mock.commandItems.find(
    (c) => c.id === "open-team-agent-graph",
  ) as { onSelect: (ctx: Record<string, unknown>) => void };
  openGraphCmd.onSelect(makeActionCtx("todo-plan-rev-1"));

  assert.equal(mock.openedPanels.length, 4);
  for (const opened of mock.openedPanels) {
    assert.equal(opened.panelId, "team-graph");
    assert.equal(opened.workspaceId, "wks_todo");
    assert.equal(
      opened.agentId,
      undefined,
      "workspace panel open must not pass per-agent tab target",
    );
  }

  // Workspace row badge renders running/halted states and hides when idle/completed.
  const BadgeComp = mock.rowBadges[0].Component as (
    p: Record<string, unknown>,
  ) => unknown;
  uiSandbox.renderer.render({
    __vnode: true,
    type: BadgeComp,
    props: {
      workspaceId: "wks_todo",
      theme: THEME,
      layout: { compact: false },
    },
  });
  assert.equal(uiSandbox.renderer.root, null);
  uiSandbox.emitSubscription("paseo_team.conversation.watch", {
    mode: "team_task",
    task: activeTask,
  });
  uiSandbox.renderer.rerender();
  assert.match(collectText(uiSandbox.renderer.root), /团队 · 2 运行中/);
  uiSandbox.emitSubscription("paseo_team.conversation.watch", {
    mode: "team_task",
    task: sampleTaskSnapshot({
      circuitBroken: {
        stage: "plan",
        round: 2,
        reason: "R2 failed",
        triggeredAt: "2026-11-26T07:10:00.000Z",
      },
    }),
  });
  uiSandbox.renderer.rerender();
  assert.match(collectText(uiSandbox.renderer.root), /团队已熔断/);

  cleanup();
  assert.equal(mock.workspacePanels.length, 0);
  assert.equal(mock.pills.size, 0);
});

test("UI components: WorkspaceConversationGraphPanel, GlobalTeamGraphScreen, and TeamConfigView render and handle user interactions", async () => {
  uiSandbox.reset();
  uiSandbox.workspaces.set("wks_todo", {
    id: "wks_todo",
    directory: "/home/lcq/ai/test/todo",
    name: "todo",
  });

  const {
    WorkspaceConversationGraphPanel,
    GlobalTeamGraphScreen,
    focusWorkspaceGraphAgent,
  } = await import("../client/TeamGraphPanel.tsx");

  const configBundle: ConfigBundleDto = {
    effectiveTeamName: "标准",
    config: {
      schemaVersion: 5,
      default: "标准",
      projects: {},
      teams: {
        标准: {
          developer: { model: "antigravity/gemini-4-neon", thinking: "xhigh" },
          codeReviewers: [
            { model: "claude/claude-opus-5-5", thinking: "high" },
            { model: "codex/gpt-6.2-astra", thinking: "high" },
          ],
          separatePlanReviewers: false,
          planReviewers: [
            { model: "claude/claude-opus-5-5", thinking: "high" },
            { model: "codex/gpt-6.2-astra", thinking: "high" },
          ],
          expert: { model: "claude/claude-opus-5-5", thinking: "high" },
          complexMode: "simple",
        },
        快审: {
          developer: { model: "codex/gpt-6.2-astra", thinking: "high" },
          codeReviewers: [{ model: "codex/gpt-6.2-astra", thinking: "high" }],
          separatePlanReviewers: false,
          planReviewers: [{ model: "codex/gpt-6.2-astra", thinking: "high" }],
          complexMode: "simple",
        },
      },
    },
    providers: [
      {
        provider: "claude",
        label: "Claude",
        ready: true,
        modes: ["auto"],
        models: [
          {
            id: "claude-opus-5-5",
            fullId: "claude/claude-opus-5-5",
            label: "Claude Opus 5.5",
            thinkingOptions: [{ id: "high", label: "high" }],
            defaultThinkingId: "high",
          },
        ],
      },
      {
        provider: "codex",
        label: "Codex",
        ready: true,
        modes: ["auto-review"],
        models: [
          {
            id: "gpt-6.2-astra",
            fullId: "codex/gpt-6.2-astra",
            label: "GPT-6.2 Astra",
            thinkingOptions: [{ id: "high", label: "high" }],
            defaultThinkingId: "high",
          },
        ],
      },
      {
        provider: "antigravity",
        label: "Antigravity",
        ready: true,
        modes: ["auto"],
        models: [
          {
            id: "gemini-4-neon",
            fullId: "antigravity/gemini-4-neon",
            label: "Gemini 4 Neon",
            thinkingOptions: [{ id: "xhigh", label: "xhigh" }],
            defaultThinkingId: "xhigh",
          },
        ],
      },
    ],
  };

  let graphPayload: ConversationGraphPayloadDto = {
    mode: "empty",
    viewerAgentId: "empty-chat",
    rootAgentId: "empty-chat",
    task: null,
  };
  const controlCalls: Array<Record<string, unknown>> = [];
  const openedAgents: Array<{ agentId: string; serverId?: string }> = [];

  uiSandbox.rpcHandlers.set(
    "paseo_team.conversation.get",
    async () => graphPayload,
  );
  uiSandbox.rpcHandlers.set("paseo_team.config.get", async () => configBundle);
  uiSandbox.rpcHandlers.set(
    "paseo_team.config.save",
    async (input: unknown) => ({
      ...configBundle,
      config: (input as { config: ConfigBundleDto["config"] }).config,
    }),
  );
  uiSandbox.rpcHandlers.set("paseo_team.tasks.list", async () => ({
    projectKey: "/home/lcq/ai/test/todo",
    tasks: [
      sampleTaskSnapshot(),
      sampleTaskSnapshot({
        taskId: "20261125-done",
        goal: "已完成历史任务",
        lifecycleStatus: "completed",
        runningCount: 0,
      }),
    ],
  }));
  uiSandbox.rpcHandlers.set(
    "paseo_team.tasks.control",
    async (input: unknown) => {
      const req = input as Record<string, unknown>;
      controlCalls.push(req);
      return {
        ok: true,
        message: "操作成功",
        task: sampleTaskSnapshot({
          lifecycleStatus: "abandoned",
          runningCount: 0,
        }),
      };
    },
  );

  const panelVnode = {
    __vnode: true,
    type: WorkspaceConversationGraphPanel,
    props: {
      theme: THEME,
      host: { id: "srv_local", label: "wsl" },
      layout: { compact: true, platform: "web" as const },
      workspaceId: "wks_todo",
      context: "workspace" as const,
      params: {},
      revision: 1,
      tab: {
        state: undefined,
        setModified() {},
        setState() {},
      },
      navigation: {
        supportsFocusHost: true,
        openAgent(input: { agentId: string; serverId?: string }) {
          openedAgents.push(input);
        },
        openWorkspace() {},
      },
    },
  };

  // 1. Empty state renders cleanly.
  uiSandbox.renderer.render(panelVnode);
  await new Promise((r) => setTimeout(r, 10));
  uiSandbox.renderer.rerender();
  assert.match(collectText(uiSandbox.renderer.root), /当前对话还没有子 Agent/);

  // 2. Focusing coordinator chat renders single team_task WITHOUT redundant "返回主对话" button!
  const singleTask = sampleTaskSnapshot();
  graphPayload = {
    mode: "team_task",
    viewerAgentId: "todo-coord-1",
    rootAgentId: "todo-coord-1",
    task: singleTask,
  };
  focusWorkspaceGraphAgent("wks_todo", "todo-coord-1");
  uiSandbox.renderer.rerender();
  await new Promise((r) => setTimeout(r, 10));
  uiSandbox.renderer.rerender();

  const singleText = collectText(uiSandbox.renderer.root);
  assert.match(singleText, /为 todo\.mjs 新增 clear 子命令并补充测试/);
  assert.match(singleText, /主控 Coordinator/);
  assert.match(singleText, /方案审查 #1/);
  assert.match(
    singleText,
    /返回主对话/,
    "Team Graph workspace tab should offer a one-click Back to main chat button",
  );

  // Click reviewer node tile to open NodeInspector and verify findings + Open chat action.
  const revTile = findNodes(
    uiSandbox.renderer.root,
    (n) =>
      n.type === "Pressable" &&
      String(n.props.accessibilityLabel ?? "").includes("方案审查 #1"),
  )[0];
  assert.ok(revTile, "expected reviewer workflow card");
  (revTile.props.onPress as () => void)();
  uiSandbox.renderer.rerender();
  const inspectorText = collectText(uiSandbox.renderer.root);
  assert.match(inspectorText, /空列表退出码不一致/);
  assert.match(inspectorText, /进入对话/);

  // Click gate node tile to inspect gate checklist and trigger recheck.
  const gateTile = findNodes(
    uiSandbox.renderer.root,
    (n) =>
      n.type === "Pressable" &&
      String(n.props.accessibilityLabel ?? "").includes("验收门禁"),
  )[0];
  (gateTile.props.onPress as () => void)();
  uiSandbox.renderer.rerender();
  assert.match(collectText(uiSandbox.renderer.root), /验收检查项/);

  // Switch to Setup inside the panel and back to Graph.
  const setupBtn = findNodes(
    uiSandbox.renderer.root,
    (n) => n.type === "Pressable" && n.props.accessibilityLabel === "配置",
  )[0];
  (setupBtn.props.onPress as () => void)();
  uiSandbox.renderer.rerender();
  await new Promise((r) => setTimeout(r, 10));
  uiSandbox.renderer.rerender();
  assert.match(collectText(uiSandbox.renderer.root), /为每个角色选择模型/);

  const backBtn = findNodes(
    uiSandbox.renderer.root,
    (n) => n.type === "Pressable" && collectText(n).includes("返回状态图"),
  )[0];
  (backBtn.props.onPress as () => void)();
  uiSandbox.renderer.rerender();
  assert.match(collectText(uiSandbox.renderer.root), /主控 Coordinator/);

  // 3. Multiple tasks on the same chat render as collapsible subtrees.
  uiSandbox.emitSubscription("paseo_team.conversation.watch", {
    mode: "launcher",
    viewerAgentId: "todo-coord-1",
    rootAgentId: "todo-coord-1",
    task: null,
    tasks: [
      singleTask,
      sampleTaskSnapshot({
        taskId: "20261125-done",
        goal: "早期已完成任务",
        lifecycleStatus: "completed",
        runningCount: 0,
      }),
    ],
  });
  uiSandbox.renderer.rerender();
  assert.match(collectText(uiSandbox.renderer.root), /本对话 · 2 个团队任务/);

  // 4. GlobalTeamGraphScreen renders Setup (including model modal & blindspot warning) and History tab.
  const screenVnode = {
    __vnode: true,
    type: GlobalTeamGraphScreen,
    props: {
      theme: THEME,
      host: { id: "srv_local", label: "wsl" },
      layout: { compact: false, platform: "web" as const },
      params: { tab: "config", cwd: "/home/lcq/ai/test/todo" },
      navigation: panelVnode.props.navigation,
    },
  };
  uiSandbox.renderer.render(screenVnode);
  await new Promise((r) => setTimeout(r, 10));
  uiSandbox.renderer.rerender();

  // Switch preset to "快审" to verify blindspot warning when developer and reviewer share one model.
  const presetSelect = findNodes(
    uiSandbox.renderer.root,
    (n) => n.type === "SettingsSelect",
  )[0];
  (presetSelect.props.onValueChange as (v: string) => void)("快审");
  uiSandbox.renderer.rerender();
  assert.match(collectText(uiSandbox.renderer.root), /都在用 Developer 的模型/);

  // Open model picker modal and switch to History tab.
  const modelBtn = findNodes(
    uiSandbox.renderer.root,
    (n) =>
      n.type === "Pressable" &&
      String(n.props.accessibilityLabel ?? "").includes("GPT-6.2 Astra"),
  )[0];
  (modelBtn.props.onPress as () => void)();
  uiSandbox.renderer.rerender();
  assert.match(collectText(uiSandbox.renderer.root), /选择模型/);

  const historyTabBtn = findNodes(
    uiSandbox.renderer.root,
    (n) => n.type === "Pressable" && collectText(n).includes("历史"),
  )[0];
  (historyTabBtn.props.onPress as () => void)();
  uiSandbox.renderer.rerender();
  await new Promise((r) => setTimeout(r, 10));
  uiSandbox.renderer.rerender();
  assert.match(collectText(uiSandbox.renderer.root), /已完成历史任务/);

  // 5. Route-first UI regression: before coordinator calls paseo_team(action="set_route"), render only Coordinator
  // with "评估复杂度中" (no premature CI or hidden-stages noise); after route is decided, render routeReason & expanded stages.
  uiSandbox.renderer.render(panelVnode);
  const pendingRouteTask = sampleTaskSnapshot({
    taskId: "20261126-routing",
    goal: "评估复杂架构改造",
    routeDecided: false,
    skippedStageCount: 0,
    stages: [
      {
        stepId: "coordinator",
        stageId: "coordinator",
        stepNumber: 1,
        title: "主控协调",
        subtitle: "评估需求复杂度与执行路径",
        stageStatus: "running",
        nodes: [
          {
            nodeId: "coordinator",
            stage: "coordinator",
            role: "coordinator",
            slotIndex: 0,
            label: "主控 Coordinator",
            profile: "claude/claude-opus-5-5",
            agentId: "todo-coord-1",
            briefSummary:
              "正在结合上下文评估需求复杂度，决定是否启用方案评审与代码审查",
            liveState: "running",
            visualStatus: "running",
            updatedAt: "2026-11-26T07:00:00.000Z",
          },
        ],
      },
    ],
  });
  uiSandbox.emitSubscription("paseo_team.conversation.watch", {
    mode: "team_task",
    viewerAgentId: "todo-coord-1",
    rootAgentId: "todo-coord-1",
    task: pendingRouteTask,
  });
  uiSandbox.renderer.rerender();
  const routingText = collectText(uiSandbox.renderer.root);
  assert.match(routingText, /评估复杂度中/);
  assert.match(routingText, /主控 Coordinator/);
  assert.doesNotMatch(routingText, /方案审查 #1/);
  assert.doesNotMatch(routingText, /验收门禁/);
  assert.doesNotMatch(routingText, /CI 待执行/);

  // After coordinator calls paseo_team(action="set_route"), the confirmed stages and routeReason render together.
  uiSandbox.emitSubscription("paseo_team.conversation.watch", {
    mode: "team_task",
    viewerAgentId: "todo-coord-1",
    rootAgentId: "todo-coord-1",
    task: sampleTaskSnapshot({
      taskId: "20261126-routing",
      goal: "评估复杂架构改造",
      routeDecided: true,
      routeReason: "涉及跨模块存储迁移，启用方案评审与代码审查",
    }),
  });
  uiSandbox.renderer.rerender();
  const decidedText = collectText(uiSandbox.renderer.root);
  assert.match(decidedText, /涉及跨模块存储迁移，启用方案评审与代码审查/);
  assert.match(decidedText, /方案审查 #1/);
  assert.match(decidedText, /验收门禁/);
  assert.doesNotMatch(decidedText, /评估复杂度中/);

  // 6. "返回主对话" button appears in the Team Graph header even when main chat IS coordinator
  // (no legacy launcherAgentId) and navigates straight back to the coordinator conversation.
  const backToMainBtn = findNodes(
    uiSandbox.renderer.root,
    (n) =>
      n.type === "Pressable" &&
      String(n.props.accessibilityLabel ?? "") === "返回主对话",
  )[0];
  assert.ok(backToMainBtn, 'header must render "返回主对话" button');
  const openCountBefore = openedAgents.length;
  (backToMainBtn.props.onPress as () => void)();
  assert.equal(openedAgents.length, openCountBefore + 1);
  assert.equal(openedAgents.at(-1)?.agentId, "todo-coord-1");

  // Also works in empty state when viewerAgentId is known.
  uiSandbox.emitSubscription("paseo_team.conversation.watch", {
    mode: "empty",
    viewerAgentId: "todo-coord-1",
    rootAgentId: "todo-coord-1",
    task: null,
  });
  uiSandbox.renderer.rerender();
  const emptyBackBtn = findNodes(
    uiSandbox.renderer.root,
    (n) =>
      n.type === "Pressable" &&
      String(n.props.accessibilityLabel ?? "") === "返回主对话",
  )[0];
  assert.ok(emptyBackBtn, 'empty state must render "返回主对话" button');
  (emptyBackBtn.props.onPress as () => void)();
  assert.equal(openedAgents.at(-1)?.agentId, "todo-coord-1");
});

test("UI timeline renderer: collapses /paseo-team kickoff prompts into compact goal bubbles with expand toggle while leaving normal messages untouched", async () => {
  uiSandbox.reset();
  const { default: contribute } = await import("../index.client.tsx");
  const { buildKickoffPrompt } = await import("../server/prompts.ts");

  const mock = createClientMock();
  const cleanup = contribute(mock.client as never);

  assert.equal(mock.timelineTransformers.length, 1);
  assert.equal(mock.timelineRenderers.length, 1);

  const transformer = mock.timelineTransformers[0] as {
    id: string;
    query: { itemType: string };
    transform: (input: {
      item: { type: "user_message"; text: string };
      phase: "streaming" | "complete";
    }) =>
      | {
          items: Array<{
            type: "plugin";
            kind: string;
            version: number;
            data: Record<string, unknown>;
          }>;
        }
      | undefined;
  };
  const renderer = mock.timelineRenderers[0] as {
    kind: string;
    version: number;
    schema: { parse: (val: unknown) => Record<string, unknown> };
    Component: (props: Record<string, unknown>) => unknown;
  };

  assert.equal(transformer.query.itemType, "user_message");
  assert.equal(renderer.kind, "team-kickoff");
  assert.equal(renderer.version, 1);

  // 1. Ordinary user messages must pass through untouched.
  assert.equal(
    transformer.transform({
      item: { type: "user_message", text: "帮我查一下 todo.mjs 的 bug" },
      phase: "complete",
    }),
    undefined,
  );
  assert.equal(
    transformer.transform({
      item: { type: "user_message", text: "[Team 任务启动] malformed" },
      phase: "complete",
    }),
    undefined,
  );

  // 2. Chinese kickoff message (including multiline goal) transforms & renders compactly by default.
  const zhPrompt = buildKickoffPrompt({
    taskId: "20261126-1243",
    goal: "整体项目，清理，开始1243\n保留现有测试",
    teamName: "标准",
    complexMode: "simple",
    taskDir: "/tmp/evidence/20261126-1243",
    rosterLines: [
      '- Developer: provider="antigravity/gemini-4-neon" settings={"modeId":"auto"} labels={"task":"20261126-1243","role":"developer"}',
    ],
    lang: "zh",
  });
  const zhTransformed = transformer.transform({
    item: { type: "user_message", text: zhPrompt },
    phase: "complete",
  });
  assert.ok(zhTransformed, "zh kickoff should be transformed");
  assert.equal(zhTransformed.items.length, 1);
  assert.equal(zhTransformed.items[0].kind, "team-kickoff");
  const zhData = renderer.schema.parse(zhTransformed.items[0].data);
  assert.equal(zhData.goal, "整体项目，清理，开始1243\n保留现有测试");
  assert.equal(zhData.teamName, "标准");

  uiSandbox.locale = "zh-CN";
  const zhVnode = {
    __vnode: true,
    type: renderer.Component,
    props: {
      agentId: "coord-1",
      theme: THEME,
      host: "web",
      layout: "desktop",
      timestamp: new Date("2026-11-26T14:15:00.000Z"),
      item: {
        type: "plugin",
        kind: "team-kickoff",
        version: 1,
        data: zhData,
      },
    },
  };
  uiSandbox.renderer.render(zhVnode);
  const collapsedZh = collectText(uiSandbox.renderer.root);
  assert.match(collapsedZh, /\/paseo-team/);
  assert.match(collapsedZh, /标准/);
  assert.match(collapsedZh, /整体项目，清理，开始1243/);
  assert.match(collapsedZh, /展开参数/);
  assert.doesNotMatch(collapsedZh, /成员派发参数/);
  assert.doesNotMatch(collapsedZh, /antigravity\/gemini-4-neon/);

  // Clicking "展开参数" reveals the raw kickoff prompt and flips label to "收起".
  const toggleBtn = findNodes(
    uiSandbox.renderer.root,
    (n) => n.type === "Pressable" && collectText(n).includes("展开参数"),
  )[0];
  assert.ok(toggleBtn);
  (toggleBtn.props.onPress as () => void)();
  uiSandbox.renderer.rerender();
  const expandedZh = collectText(uiSandbox.renderer.root);
  assert.match(expandedZh, /收起/);
  assert.match(expandedZh, /成员派发参数/);
  assert.match(expandedZh, /antigravity\/gemini-4-neon/);

  // Clicking "收起" collapses it again.
  const hideBtn = findNodes(
    uiSandbox.renderer.root,
    (n) => n.type === "Pressable" && collectText(n).includes("收起"),
  )[0];
  (hideBtn.props.onPress as () => void)();
  uiSandbox.renderer.rerender();
  assert.doesNotMatch(collectText(uiSandbox.renderer.root), /成员派发参数/);

  // 3. English kickoff message transforms & renders cleanly in English locale.
  const enPrompt = buildKickoffPrompt({
    taskId: "20261126-en",
    goal: "Refactor store persistence layer",
    teamName: "Standard",
    complexMode: "expert",
    rosterLines: ['- Developer: provider="codex/gpt-6.2-astra"'],
    lang: "en",
  });
  const enTransformed = transformer.transform({
    item: { type: "user_message", text: enPrompt },
    phase: "complete",
  });
  assert.ok(enTransformed, "en kickoff should be transformed");
  const enData = renderer.schema.parse(enTransformed.items[0].data);
  assert.equal(enData.goal, "Refactor store persistence layer");

  uiSandbox.locale = "en-US";
  uiSandbox.renderer.render({
    __vnode: true,
    type: renderer.Component,
    props: {
      agentId: "coord-en",
      theme: THEME,
      host: "web",
      layout: "desktop",
      timestamp: new Date("2026-11-26T14:20:00.000Z"),
      item: {
        type: "plugin",
        kind: "team-kickoff",
        version: 1,
        data: enData,
      },
    },
  });
  const collapsedEn = collectText(uiSandbox.renderer.root);
  assert.match(collapsedEn, /\/paseo-team/);
  assert.match(collapsedEn, /Standard/);
  assert.match(collapsedEn, /Refactor store persistence layer/);
  assert.match(collapsedEn, /Details/);
  assert.doesNotMatch(collapsedEn, /Member Routing/);

  cleanup();
  assert.equal(mock.timelineTransformers.length, 0);
  assert.equal(mock.timelineRenderers.length, 0);
});
