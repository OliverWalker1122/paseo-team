import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import type {
  AgentTreeSnapshotDto,
  ConfigBundleDto,
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
      if (!Object.is(prev, resolved)) slot.value = resolved;
    };
    return [slot.value as T, setter];
  }

  useMemo<T>(factory: () => T, deps?: readonly unknown[]): T {
    const slots = this.activeSlots!;
    const idx = this.activeIdx++;
    const prev = slots[idx];
    const unchanged =
      prev?.deps &&
      deps &&
      prev.deps.length === deps.length &&
      prev.deps.every((d, i) => Object.is(d, deps[i]));
    if (unchanged) return prev.value as T;
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
      prev?.deps &&
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
      if (typeof item.slot.cleanup === "function") item.slot.cleanup();
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
        .map((c, idx) => this.evalNode(c, `${pathKey}[${idx}]`))
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
      return { type: String(vnode.type), props: resolvedProps, children };
    }
    return null;
  }
}

function collectText(node: RenderedNode | string | null): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  const own = [node.props.label, node.props.title, node.props.hint]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ");
  const kids = node.children.map((c) => collectText(c)).join(" ");
  return [own, kids].filter(Boolean).join(" ");
}

function findNodes(
  node: RenderedNode | string | null,
  pred: (n: RenderedNode) => boolean,
  out: RenderedNode[] = [],
): RenderedNode[] {
  if (!node || typeof node === "string") return out;
  if (pred(node)) out.push(node);
  for (const c of node.children) findNodes(c, pred, out);
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
  composer: null as Record<string, unknown> | null,
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
    this.composer = null;
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
          export function useComposer() {
            if (!sb().composer) throw new Error("Missing mock composer");
            return sb().composer;
          }
          export function useWorkspace(workspaceId, selector) {
            const ws = sb().workspaces.get(workspaceId) || { id: workspaceId, directory: "", name: workspaceId };
            return selector(ws);
          }
          export function useRpc(contract) {
            return sb().renderer.useMemo(() => async (input) => {
              const fn = sb().rpcHandlers.get(contract.name);
              if (!fn) throw new Error("Unhandled RPC: " + contract.name);
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
          export const Toggle = "Toggle";
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
      return { format: "module", shortCircuit: true, source: out.outputText };
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

function sampleTree(
  overrides: Partial<AgentTreeSnapshotDto> = {},
): AgentTreeSnapshotDto {
  return {
    rootAgentId: "coord-1",
    workspaceId: "wks_todo",
    title: "自定义组件透明度滑块",
    cwd: "/home/lcq/ai/test/todo",
    isTeamChat: true,
    totalAgents: 3,
    runningCount: 1,
    attentionCount: 0,
    createdAt: "2026-11-28T00:00:00.000Z",
    updatedAt: "2026-11-28T00:04:00.000Z",
    layers: [
      {
        layerId: "coordinator",
        title: "主控协调",
        status: "idle",
        nodes: [
          {
            agentId: "coord-1",
            parentAgentId: null,
            workspaceId: "wks_todo",
            role: "coordinator",
            label: "主控 Coordinator",
            title: "自定义组件透明度滑块",
            modelBadge: "claude/claude-opus-5-5 · high",
            status: "idle",
            createdAt: "2026-11-28T00:00:00.000Z",
            updatedAt: "2026-11-28T00:04:00.000Z",
          },
        ],
      },
      {
        layerId: "developer-1",
        title: "开发实现",
        status: "running",
        nodes: [
          {
            agentId: "dev-1",
            parentAgentId: "coord-1",
            workspaceId: "wks_todo",
            role: "developer",
            label: "Developer",
            title: "Developer: 透明度滑块实现",
            modelBadge: "antigravity/gemini-4-neon · xhigh",
            status: "running",
            createdAt: "2026-11-28T00:01:00.000Z",
            updatedAt: "2026-11-28T00:04:00.000Z",
          },
        ],
      },
      {
        layerId: "code-reviewer-1",
        title: "代码审查",
        status: "idle",
        nodes: [
          {
            agentId: "rev-1",
            parentAgentId: "coord-1",
            workspaceId: "wks_todo",
            role: "code-reviewer",
            label: "代码审查 #1",
            title: "Code Reviewer #1",
            modelBadge: "codex/gpt-6.2-astra · high",
            perspectiveLabel: "需求规格与真实边界场景",
            status: "idle",
            createdAt: "2026-11-28T00:03:00.000Z",
            updatedAt: "2026-11-28T00:03:30.000Z",
          },
        ],
      },
    ],
    ...overrides,
  };
}

function createClientMock() {
  const workspacePanels: Array<Record<string, unknown>> = [];
  const screens: Array<Record<string, unknown>> = [];
  const sidebarItems: Array<Record<string, unknown>> = [];
  const settingsScreens: Array<Record<string, unknown>> = [];
  const rowBadges: Array<Record<string, unknown>> = [];
  const commandItems: Array<Record<string, unknown>> = [];
  const slashCommands: Array<Record<string, unknown>> = [];
  const composerItems: Array<Record<string, unknown>> = [];
  const timelineTransformers: Array<Record<string, unknown>> = [];
  const timelineRenderers: Array<Record<string, unknown>> = [];
  const openedPanels: Array<{ panelId: string; workspaceId: string }> = [];
  const pills = new Map<
    string,
    { workspaceId: string; agentId: string; label: string; onPress: () => void }
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
    addScreen: (c: Record<string, unknown>) => {
      screens.push(c);
      return () => screens.splice(screens.indexOf(c), 1);
    },
    addSidebarHeaderItem: (c: Record<string, unknown>) => {
      sidebarItems.push(c);
      return () => sidebarItems.splice(sidebarItems.indexOf(c), 1);
    },
    addSettingsScreen: (c: Record<string, unknown>) => {
      settingsScreens.push(c);
      return () => settingsScreens.splice(settingsScreens.indexOf(c), 1);
    },
    addWorkspacePanel: (c: Record<string, unknown>) => {
      workspacePanels.push(c);
      return () => workspacePanels.splice(workspacePanels.indexOf(c), 1);
    },
    addWorkspaceRowBadgeItem: (c: Record<string, unknown>) => {
      rowBadges.push(c);
      return () => rowBadges.splice(rowBadges.indexOf(c), 1);
    },
    addComposerPill(c: {
      workspaceId: string;
      agentId: string;
      button: {
        title: string;
        label?: string;
        behavior: { onPress: () => void };
      };
    }) {
      const rec = {
        workspaceId: c.workspaceId,
        agentId: c.agentId,
        label: c.button.label ?? c.button.title,
        onPress: c.button.behavior.onPress,
      };
      pills.set(c.agentId, rec);
      return {
        update(patch: { label?: string; title?: string }) {
          if (patch.label) rec.label = patch.label;
        },
        remove() {
          pills.delete(c.agentId);
        },
      };
    },
    addComposerItem: (c: Record<string, unknown>) => {
      composerItems.push(c);
      return () => composerItems.splice(composerItems.indexOf(c), 1);
    },
    addCommandCenterItem: (c: Record<string, unknown>) => {
      commandItems.push(c);
      return () => commandItems.splice(commandItems.indexOf(c), 1);
    },
    addSlashCommand: (c: Record<string, unknown>) => {
      slashCommands.push(c);
      return () => slashCommands.splice(slashCommands.indexOf(c), 1);
    },
    addTimelineTransformer: (c: Record<string, unknown>) => {
      timelineTransformers.push(c);
      return () =>
        timelineTransformers.splice(timelineTransformers.indexOf(c), 1);
    },
    addTimelineRenderer: (c: Record<string, unknown>) => {
      timelineRenderers.push(c);
      return () => timelineRenderers.splice(timelineRenderers.indexOf(c), 1);
    },
    openPanel(panelId: string, opts: { workspaceId: string }) {
      openedPanels.push({ panelId, workspaceId: opts.workspaceId });
    },
  };

  return {
    client,
    workspacePanels,
    screens,
    sidebarItems,
    settingsScreens,
    rowBadges,
    commandItems,
    slashCommands,
    composerItems,
    timelineTransformers,
    timelineRenderers,
    openedPanels,
    pills,
    pushAgentSnapshot(agents: Array<Record<string, unknown>>) {
      agentSubCallbacks!.snapshot({
        entries: agents.map((agent) => ({ agent })),
      });
    },
    pushAgentUpsert(agent: Record<string, unknown>) {
      agentSubCallbacks!.update({
        type: "agent_update",
        payload: { kind: "upsert", agent },
      });
    },
    pushAgentRemove(agentId: string) {
      agentSubCallbacks!.update({
        type: "agent_update",
        payload: { kind: "remove", agentId },
      });
    },
  };
}

test("client registration, pure Paseo composer pills (labels + team toggle), and slash command routes", async () => {
  uiSandbox.reset();
  const clientEntry = await import("../index.client.tsx");
  const { TEAM_ENABLED_METADATA_KEY } = await import("../shared/contracts.ts");
  const mock = createClientMock();
  const cleanup = clientEntry.default(mock.client as never);
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(mock.workspacePanels[0].id, "team-graph");
  assert.equal(mock.screens[0].id, "team-center");
  assert.equal(mock.composerItems[0].id, "team-mode");

  // Pills derive purely from live Paseo agent stream:
  // - standalone chats get NO pill
  // - team-enabled root gets "团队" immediately before any child spawns
  // - child linked via labels["paseo.parent-agent-id"] lights up both parent & child pills!
  mock.pushAgentSnapshot([
    {
      id: "standalone-1",
      workspaceId: "wks_test",
      status: "idle",
      metadata: {},
    },
    {
      id: "team-root",
      workspaceId: "wks_todo",
      status: "running",
      metadata: { [TEAM_ENABLED_METADATA_KEY]: true },
    },
  ]);
  assert.equal(mock.pills.has("standalone-1"), false);
  assert.equal(mock.pills.get("team-root")?.label, "团队");

  mock.pushAgentUpsert({
    id: "team-dev",
    workspaceId: "wks_todo",
    labels: { "paseo.parent-agent-id": "team-root" },
    status: "running",
  });
  assert.equal(mock.pills.get("team-root")?.label, "团队 · 1 运行中");
  assert.equal(mock.pills.get("team-dev")?.label, "团队 · 1 运行中");

  mock.pills.get("team-root")!.onPress();
  assert.equal(mock.openedPanels[0].panelId, "team-graph");

  mock.pushAgentRemove("team-dev");
  assert.equal(mock.pills.get("team-root")?.label, "团队");

  // Slash command routes: setup, status, and task start
  const slash = mock.slashCommands[0] as {
    onSubmit: (ctx: Record<string, unknown>) => Promise<void>;
  };
  const openedScreens: unknown[] = [];
  const rpcCalls: unknown[] = [];
  const baseCtx = {
    workspace: { id: "wks_todo", directory: "/tmp/todo" },
    agent: { id: "team-root" },
    openScreen: (x: unknown) => openedScreens.push(x),
    openPanel: (id: string) =>
      mock.openedPanels.push({ panelId: id, workspaceId: "wks_todo" }),
    rpc: async (_c: unknown, input: unknown) => rpcCalls.push(input),
  };
  await slash.onSubmit({ ...baseCtx, args: "setup" });
  await slash.onSubmit({ ...baseCtx, args: "status" });
  await slash.onSubmit({ ...baseCtx, args: "新增暗色模式" });
  assert.equal(openedScreens.length, 1);
  assert.equal(rpcCalls.length, 1);

  // Workspace badge renders running & attention states cleanly
  const BadgeComp = mock.rowBadges[0].Component as (p: unknown) => unknown;
  uiSandbox.renderer.render({
    __vnode: true,
    type: BadgeComp,
    props: {
      workspaceId: "wks_todo",
      theme: THEME,
      layout: { compact: false },
    },
  });
  uiSandbox.emitSubscription("paseo_team.conversation.watch", {
    viewerAgentId: null,
    rootAgentId: "coord-1",
    tree: sampleTree({ runningCount: 2, attentionCount: 0 }),
  });
  uiSandbox.renderer.rerender();
  assert.match(collectText(uiSandbox.renderer.root), /团队 · 2 运行中/);

  uiSandbox.emitSubscription("paseo_team.conversation.watch", {
    viewerAgentId: null,
    rootAgentId: "coord-1",
    tree: sampleTree({ runningCount: 0, attentionCount: 1 }),
  });
  uiSandbox.renderer.rerender();
  assert.match(collectText(uiSandbox.renderer.root), /团队 · 1 待处理/);

  cleanup();
  assert.equal(mock.composerItems.length, 0);
});

test("TeamComposerToggle persists selected state across new-workspace, draft, and agent, and hides on subagents", async () => {
  uiSandbox.reset();
  const {
    addTeamSlashPrefix,
    hasTeamSlashPrefix,
    stripTeamSlashPrefix,
    TEAM_ENABLED_METADATA_KEY,
    TEAM_SUBAGENT_METADATA_KEY,
  } = await import("../shared/contracts.ts");
  const { TeamComposerToggle } = await import("../client/composer-item.tsx");

  assert.equal(hasTeamSlashPrefix("/paseo-team fix"), true);
  assert.equal(hasTeamSlashPrefix("/paseo-team-x"), false);
  assert.equal(addTeamSlashPrefix("fix"), "/paseo-team fix");
  assert.equal(addTeamSlashPrefix(""), "/paseo-team ");
  assert.equal(stripTeamSlashPrefix("/paseo-team fix"), "fix");

  const makeComposer = (opts: {
    context: "new-workspace" | "draft" | "agent";
    prompt?: string;
    metadata?: Record<string, unknown>;
  }) => {
    const state = {
      context: opts.context,
      prompt: opts.prompt ?? "",
      metadata: { ...(opts.metadata ?? {}) },
      focusCalls: [] as unknown[],
    };
    return {
      state,
      composer: {
        get context() {
          return state.context;
        },
        get prompt() {
          return state.prompt;
        },
        agent: {
          get metadata() {
            return state.metadata;
          },
        },
        setPrompt(t: string) {
          state.prompt = t;
        },
        async focus(o?: unknown) {
          state.focusCalls.push(o);
        },
        async setMetadata(patch: Record<string, unknown>) {
          for (const [k, v] of Object.entries(patch)) {
            if (v === null) delete state.metadata[k];
            else state.metadata[k] = v;
          }
        },
      },
    };
  };

  // New workspace: toggles metadata cleanly without touching prompt
  const nw = makeComposer({ context: "new-workspace", prompt: "透明度设置" });
  uiSandbox.composer = nw.composer;
  uiSandbox.renderer.render({
    __vnode: true,
    type: TeamComposerToggle,
    props: {},
  });
  let toggle = findNodes(
    uiSandbox.renderer.root,
    (n) => n.type === "Toggle",
  )[0];
  assert.equal(toggle.props.icon, "Users");
  assert.equal(toggle.props.value, false);
  await (
    toggle.props.onValueChange as (e: { value: boolean }) => Promise<void>
  )({
    value: true,
  });
  assert.equal(nw.state.metadata[TEAM_ENABLED_METADATA_KEY], true);
  assert.equal(nw.state.prompt, "透明度设置");

  // Transitioning to open agent keeps toggle SELECTED (`value=true`)
  nw.state.context = "agent";
  nw.state.prompt = "";
  uiSandbox.renderer.rerender();
  toggle = findNodes(uiSandbox.renderer.root, (n) => n.type === "Toggle")[0];
  assert.equal(toggle.props.value, true);

  // Turning OFF clears metadata
  await (
    toggle.props.onValueChange as (e: { value: boolean }) => Promise<void>
  )({
    value: false,
  });
  assert.equal(nw.state.metadata[TEAM_ENABLED_METADATA_KEY], undefined);

  // Existing plain agent turning ON prepends `/paseo-team `
  nw.state.prompt = "修复问题";
  uiSandbox.renderer.rerender();
  toggle = findNodes(uiSandbox.renderer.root, (n) => n.type === "Toggle")[0];
  await (
    toggle.props.onValueChange as (e: { value: boolean }) => Promise<void>
  )({
    value: true,
  });
  assert.equal(nw.state.prompt, "/paseo-team 修复问题");

  // Hidden on team subagents
  const sub = makeComposer({
    context: "agent",
    metadata: { [TEAM_SUBAGENT_METADATA_KEY]: true },
  });
  uiSandbox.composer = sub.composer;
  uiSandbox.renderer.render({
    __vnode: true,
    type: TeamComposerToggle,
    props: {},
  });
  assert.equal(uiSandbox.renderer.root, null);
});

test("WorkspaceConversationGraphPanel, GlobalTeamGraphScreen, TeamConfigView, and TeamKickoffBubble render & interact", async () => {
  uiSandbox.reset();
  const { GlobalTeamGraphScreen, WorkspaceConversationGraphPanel } =
    await import("../client/TeamGraphPanel.tsx");
  const { parseKickoffMessage, TeamKickoffBubble } =
    await import("../client/KickoffTimelineItem.tsx");
  const { buildKickoffPrompt } = await import("../server/prompts.ts");

  const bundle: ConfigBundleDto = {
    effectiveTeamName: "标准",
    config: {
      schemaVersion: 5,
      default: "标准",
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
          complexMode: "simple",
        },
      },
      projects: {},
    },
    providers: [
      {
        provider: "antigravity",
        label: "Antigravity",
        ready: true,
        modes: ["auto", "full-access"],
        modeOptions: [
          { id: "auto", label: "Auto", description: "Recommended mode" },
          {
            id: "full-access",
            label: "Full access",
            description: "Unrestricted execution",
          },
        ],
        models: [
          {
            id: "gemini-4-neon",
            fullId: "antigravity/gemini-4-neon",
            label: "Gemini 4 Neon",
            thinkingOptions: [{ id: "xhigh", label: "Extra" }],
            defaultThinkingId: "xhigh",
          },
        ],
      },
      {
        provider: "claude",
        label: "Claude",
        ready: true,
        modes: ["auto", "bypassPermissions"],
        modeOptions: [
          { id: "auto", label: "Auto mode" },
          { id: "bypassPermissions", label: "Bypass permissions" },
        ],
        models: [
          {
            id: "claude-opus-5-5",
            fullId: "claude/claude-opus-5-5",
            label: "Opus 5.5",
            thinkingOptions: [{ id: "high", label: "High" }],
            defaultThinkingId: "high",
          },
        ],
      },
    ],
  };
  const savedConfigs: ConfigBundleDto["config"][] = [];
  uiSandbox.rpcHandlers.set("paseo_team.config.get", async () => bundle);
  uiSandbox.rpcHandlers.set("paseo_team.config.save", async (input) => {
    const payload = input as { config: ConfigBundleDto["config"] };
    savedConfigs.push(payload.config);
    return { ...bundle, config: payload.config };
  });
  uiSandbox.workspaces.set("wks_todo", {
    id: "wks_todo",
    directory: "/home/lcq/ai/test/todo",
    name: "todo",
  });

  // 1. Workspace graph panel: renders live tree, node inspector, Back to main chat, and Config toggle
  const openedAgents: Array<{ agentId: string }> = [];
  uiSandbox.renderer.render({
    __vnode: true,
    type: WorkspaceConversationGraphPanel,
    props: {
      workspaceId: "wks_todo",
      theme: THEME,
      layout: { compact: false, platform: "web" },
      navigation: {
        openAgent: (x: { agentId: string }) => openedAgents.push(x),
      },
    },
  });
  uiSandbox.emitSubscription("paseo_team.conversation.watch", {
    viewerAgentId: "coord-1",
    rootAgentId: "coord-1",
    tree: sampleTree(),
  });
  uiSandbox.renderer.rerender();

  const graphText = collectText(uiSandbox.renderer.root);
  assert.match(graphText, /返回主对话/);
  assert.match(graphText, /Developer/);
  assert.match(graphText, /运行中/);

  // Click Developer node to inspect and open chat
  const devCard = findNodes(
    uiSandbox.renderer.root,
    (n) => n.type === "Pressable" && collectText(n).includes("Developer"),
  )[0];
  assert.ok(devCard);
  (devCard.props.onPress as () => void)();
  uiSandbox.renderer.rerender();
  assert.match(
    collectText(uiSandbox.renderer.root),
    /antigravity\/gemini-4-neon/,
  );

  const openBtn = findNodes(
    uiSandbox.renderer.root,
    (n) => n.type === "Pressable" && collectText(n).includes("进入对话"),
  )[0];
  (openBtn.props.onPress as () => void)();
  assert.equal(openedAgents[0].agentId, "dev-1");

  const backMainBtn = findNodes(
    uiSandbox.renderer.root,
    (n) => n.type === "Pressable" && collectText(n).includes("返回主对话"),
  )[0];
  (backMainBtn.props.onPress as () => void)();
  assert.equal(openedAgents[1].agentId, "coord-1");

  // Switch to Config view: verify renamed "返回团队", Complex tasks always expanded, and permission mode picker works
  const cfgBtn = findNodes(
    uiSandbox.renderer.root,
    (n) => n.type === "Pressable" && collectText(n).includes("配置"),
  )[0];
  (cfgBtn.props.onPress as () => void)();
  uiSandbox.renderer.rerender();
  await new Promise((r) => setTimeout(r, 10));
  uiSandbox.renderer.rerender();
  const cfgText = collectText(uiSandbox.renderer.root);
  assert.match(cfgText, /返回团队/);
  assert.match(cfgText, /由谁起草方案/);
  assert.match(cfgText, /单独设置方案审查/);
  assert.doesNotMatch(cfgText, /展开/);
  assert.match(cfgText, /默认权限/);

  // Open Developer permission mode picker and select "Full access"
  const modePickerBtn = findNodes(
    uiSandbox.renderer.root,
    (n) => n.type === "Pressable" && n.props.accessibilityLabel === "默认权限",
  )[0];
  assert.ok(modePickerBtn);
  (modePickerBtn.props.onPress as () => void)();
  uiSandbox.renderer.rerender();
  assert.match(collectText(uiSandbox.renderer.root), /Full access/);

  const fullAccessOption = findNodes(
    uiSandbox.renderer.root,
    (n) => n.type === "Pressable" && collectText(n).includes("Full access"),
  )[0];
  assert.ok(fullAccessOption);
  (fullAccessOption.props.onPress as () => void)();
  await new Promise((r) => setTimeout(r, 10));
  uiSandbox.renderer.rerender();
  assert.equal(
    savedConfigs.at(-1)?.teams["标准"].developer.mode,
    "full-access",
  );

  // 2. Global Team Screen: defaults to Running tab with header switcher; History tab is vertical list with click-to-expand DAG
  uiSandbox.renderer.unmount();
  uiSandbox.renderer.render({
    __vnode: true,
    type: GlobalTeamGraphScreen,
    props: {
      theme: THEME,
      layout: { compact: false, platform: "web" },
      params: {},
      navigation: {
        openAgent: (x: { agentId: string }) => openedAgents.push(x),
      },
    },
  });
  uiSandbox.emitSubscription("paseo_team.trees.watch", {
    trees: [
      sampleTree({
        rootAgentId: "coord-1",
        title: "自定义组件透明度滑块",
        runningCount: 1,
      }),
      sampleTree({
        rootAgentId: "coord-run-2",
        title: "第二个运行中任务",
        runningCount: 2,
      }),
      sampleTree({
        rootAgentId: "coord-hist-1",
        title: "已完成历史任务",
        runningCount: 0,
        attentionCount: 0,
      }),
    ],
  });
  uiSandbox.renderer.rerender();

  // Running tab shows both running sessions in top switcher, NOT the history session's DAG
  const runningViewText = collectText(uiSandbox.renderer.root);
  assert.match(runningViewText, /运行中 \(2\)/);
  assert.match(runningViewText, /历史 \(1\)/);
  assert.match(runningViewText, /自定义组件透明度滑块/);
  assert.match(runningViewText, /第二个运行中任务/);
  assert.doesNotMatch(runningViewText, /已完成历史任务/);

  // Click second running session in the top header switcher
  const run2Btn = findNodes(
    uiSandbox.renderer.root,
    (n) =>
      n.type === "Pressable" && collectText(n).includes("第二个运行中任务"),
  )[0];
  assert.ok(run2Btn);
  (run2Btn.props.onPress as () => void)();
  uiSandbox.renderer.rerender();

  // Switch to History tab: row is collapsed by default (no DAG nodes rendered yet)
  const historyTabBtn = findNodes(
    uiSandbox.renderer.root,
    (n) =>
      n.type === "Pressable" &&
      n.props.accessibilityRole === "tab" &&
      collectText(n).includes("历史"),
  )[0];
  assert.ok(historyTabBtn);
  (historyTabBtn.props.onPress as () => void)();
  uiSandbox.renderer.rerender();

  const collapsedHistoryText = collectText(uiSandbox.renderer.root);
  assert.match(collapsedHistoryText, /已完成历史任务/);
  assert.doesNotMatch(collapsedHistoryText, /点击上方任意角色卡片/);

  // Click history row to expand its inline DAG
  const historyRowBtn = findNodes(
    uiSandbox.renderer.root,
    (n) => n.type === "Pressable" && collectText(n).includes("已完成历史任务"),
  )[0];
  assert.ok(historyRowBtn);
  (historyRowBtn.props.onPress as () => void)();
  uiSandbox.renderer.rerender();
  assert.match(collectText(uiSandbox.renderer.root), /Developer/);
  assert.match(collectText(uiSandbox.renderer.root), /点击上方任意角色卡片/);

  // Click again to collapse
  (historyRowBtn.props.onPress as () => void)();
  uiSandbox.renderer.rerender();
  assert.doesNotMatch(
    collectText(uiSandbox.renderer.root),
    /点击上方任意角色卡片/,
  );

  // Empty running tab shows CTA button to jump straight to History
  const runningTabBtn = findNodes(
    uiSandbox.renderer.root,
    (n) =>
      n.type === "Pressable" &&
      n.props.accessibilityRole === "tab" &&
      collectText(n).includes("运行中"),
  )[0];
  (runningTabBtn.props.onPress as () => void)();
  uiSandbox.emitSubscription("paseo_team.trees.watch", {
    trees: [
      sampleTree({
        rootAgentId: "coord-hist-1",
        title: "已完成历史任务",
        runningCount: 0,
        attentionCount: 0,
      }),
    ],
  });
  uiSandbox.renderer.rerender();
  assert.match(
    collectText(uiSandbox.renderer.root),
    /当前没有运行中的团队协作/,
  );
  const viewHistBtn = findNodes(
    uiSandbox.renderer.root,
    (n) => n.type === "Pressable" && collectText(n).includes("查看历史记录"),
  )[0];
  assert.ok(viewHistBtn);
  (viewHistBtn.props.onPress as () => void)();
  uiSandbox.renderer.rerender();
  assert.match(collectText(uiSandbox.renderer.root), /已完成历史任务/);

  // 3. Kickoff timeline bubble parses both v7 (no task_id) and legacy v6 (with task_id) messages
  const v7Prompt = buildKickoffPrompt({
    goal: "实现透明滑块",
    teamName: "标准",
    complexMode: "simple",
    rosterLines: ['- Developer: provider="antigravity/gemini-4-neon"'],
    lang: "zh",
  });
  const parsedV7 = parseKickoffMessage(v7Prompt);
  assert.ok(parsedV7);
  assert.equal(parsedV7.goal, "实现透明滑块");
  assert.equal(parsedV7.teamName, "标准");

  const legacyV6 = parseKickoffMessage(
    "[Team Kickoff] task_id=`20261126-old`\nGoal: Old task\nActive Preset: `Standard` (mode: `simple`)\n\nbody",
  );
  assert.ok(legacyV6);
  assert.equal(legacyV6.goal, "Old task");

  uiSandbox.renderer.render({
    __vnode: true,
    type: TeamKickoffBubble,
    props: {
      agentId: "coord-1",
      theme: THEME,
      item: {
        type: "plugin",
        kind: "team-kickoff",
        version: 1,
        data: parsedV7,
      },
    },
  });
  assert.match(collectText(uiSandbox.renderer.root), /实现透明滑块/);
  assert.doesNotMatch(
    collectText(uiSandbox.renderer.root),
    /antigravity\/gemini-4-neon/,
  );
});
