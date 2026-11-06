import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const focusModel = require(resolve(LIB_ROOT, "src", "chat-focus.js"));

function envInt(name: string, fallback: number, minimum: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback;
}

const POLL_MS = envInt("PI_CHAT_FOCUS_POLL_MS", 750, 250);
const SESSION_SCAN_MS = envInt("PI_CHAT_FOCUS_SESSION_SCAN_MS", 5000, POLL_MS);
const MAX_WIDGET_ROWS = envInt("PI_CHAT_FOCUS_WIDGET_ROWS", 3, 2);
const MAX_RECENT_FINAL_SUBAGENTS = envInt("PI_CHAT_FOCUS_RECENT_FINAL_SUBAGENTS", focusModel.DEFAULT_MAX_FINAL_SUBAGENTS, 0);

type FocusTarget = {
  key: string;
  kind: "main" | "fork" | "branch" | "subagent";
  label: string;
  detail?: string;
  sessionPath?: string | null;
  sessionId?: string;
  leafId?: string | null;
  sessionVersion?: string;
  resultVersion?: string;
  current?: boolean;
  status?: string;
  final?: boolean;
};

type FocusState = {
  api: ExtensionAPI;
  targets: FocusTarget[];
  sessions: any[];
  lastSessionScan: number;
  timer?: ReturnType<typeof setInterval>;
  editorInstallTimer?: ReturnType<typeof setTimeout>;
  panelCleanups: Set<() => void>;
  stripFocused: boolean;
  stripIndex: number;
  widgetInstalled: boolean;
  widget?: any;
  editor?: any;
  tui?: any;
  stopped: boolean;
  revision: number;
  statusInitialized: boolean;
  statusText?: string;
  refreshPromise?: Promise<FocusTarget[]>;
};

let state: FocusState | undefined;

function selectedIndex(targets: FocusTarget[]) {
  const index = targets.findIndex((target) => target.current);
  return index >= 0 ? index : 0;
}

function targetByArg(targets: FocusTarget[], raw: string) {
  const value = String(raw || "").trim();
  if (!value || value === "current") return targets.find((target) => target.current) || targets[0];
  if (value === "main" || value === "back") return targets.find((target) => target.kind === "main");
  if (/^\d+$/.test(value)) {
    const index = Number(value);
    return index >= 1 ? targets[index - 1] : undefined;
  }
  return targets.find((target) => target.key === value || target.key.endsWith(`:${value}`));
}

function styleWidgetRow(theme: any, row: string) {
  let styled = row.replace(/^Chats(?: · working)?/, (text) => theme.fg("accent", theme.bold(text)));
  styled = styled.replace(/◉/g, theme.fg("warning", "◉"));
  styled = styled.replace(/●/g, theme.fg("accent", "●"));
  styled = styled.replace(/▶/g, theme.fg("accent", theme.bold("▶")));
  styled = styled.replace(/✓/g, theme.fg("success", "✓"));
  styled = styled.replace(/!/g, theme.fg("error", "!"));
  styled = styled.replace(/(F6 (?:focus|inspect).*?$)/, (text) => theme.fg("dim", text));
  return styled;
}

function returnStripFocusToEditor(snapshot: FocusState, tui: any) {
  snapshot.stripFocused = false;
  if (snapshot.editor) tui?.setFocus?.(snapshot.editor);
  tui?.requestRender?.();
}

function installWidget(ctx: any, requestRender = true) {
  if (!state || !ctx?.ui?.setWidget) return;
  const snapshot = state;
  // Reasoning Runtime keeps a fallback widget for standalone installations;
  // Chat Focus owns the richer shared strip when both extensions are loaded.
  // Removing an already-absent widget rebuilds every widget container, so only
  // reconcile it when visible focus state changes.
  if (requestRender || !snapshot.widgetInstalled) ctx.ui.setWidget("subagents", undefined);
  if (snapshot.targets.length <= 1) {
    if (snapshot.stripFocused) returnStripFocusToEditor(snapshot, snapshot.tui);
    if (snapshot.widgetInstalled) ctx.ui.setWidget("chat-focus", undefined);
    snapshot.widgetInstalled = false;
    snapshot.widget = undefined;
    return;
  }
  snapshot.stripIndex = Math.max(0, Math.min(snapshot.stripIndex, snapshot.targets.length - 1));
  if (snapshot.widgetInstalled) {
    if (requestRender) snapshot.tui?.requestRender?.();
    return;
  }
  snapshot.widgetInstalled = true;
  ctx.ui.setWidget("chat-focus", (tui: any, theme: any) => {
    const component: any = {
      focused: false,
      invalidate() {},
      render(width: number) {
        const targets = state === snapshot ? snapshot.targets : [];
        const rows = focusModel.packTabRows(targets, width, {
          busy: !ctx.isIdle(),
          maxRows: MAX_WIDGET_ROWS,
          focused: snapshot.stripFocused,
          selectedIndex: snapshot.stripIndex,
        });
        return rows.map((row: string) => truncateToWidth(styleWidgetRow(theme, row), width, ""));
      },
      handleInput(data: string) {
        if (state !== snapshot || snapshot.stopped) return;
        const targets = snapshot.targets;
        if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
          const direction = matchesKey(data, Key.down) ? "down" : "up";
          const next = focusModel.stepStripNavigation({ focused: true, direction, index: snapshot.stripIndex, targetCount: targets.length });
          snapshot.stripFocused = next.focused;
          snapshot.stripIndex = next.index;
          if (!next.focused) return returnStripFocusToEditor(snapshot, tui);
        } else if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
          const direction = matchesKey(data, Key.tab) ? "down" : "up";
          const next = focusModel.stepStripNavigation({ focused: true, direction, index: snapshot.stripIndex, targetCount: targets.length });
          snapshot.stripFocused = next.focused;
          snapshot.stripIndex = next.index;
          if (!next.focused) return returnStripFocusToEditor(snapshot, tui);
        } else if (matchesKey(data, Key.enter)) {
          const target = targets[snapshot.stripIndex];
          returnStripFocusToEditor(snapshot, tui);
          if (target) void openPanel(snapshot.api, ctx, false, target.key);
          return;
        } else if (matchesKey(data, Key.escape)) {
          return returnStripFocusToEditor(snapshot, tui);
        } else {
          returnStripFocusToEditor(snapshot, tui);
          snapshot.editor?.handleInput?.(data);
          return;
        }
        tui.requestRender();
      },
    };
    snapshot.widget = component;
    snapshot.tui = tui;
    return component;
  }, { placement: "belowEditor" });
}

async function refresh(ctx: any, forceSessionScan = false) {
  if (!state || state.stopped) return [];
  if (state.refreshPromise) return state.refreshPromise;
  const snapshot = state;
  state.refreshPromise = Promise.resolve().then(async () => {
    const now = Date.now();
    const currentSessionFile = ctx.sessionManager?.getSessionFile?.();
    if (forceSessionScan || !snapshot.sessions.length || now - snapshot.lastSessionScan >= SESSION_SCAN_MS) {
      try { snapshot.sessions = focusModel.listSessionMetadata({ cwd: ctx.cwd, currentSessionFile }); } catch { snapshot.sessions = snapshot.sessions || []; }
      snapshot.lastSessionScan = now;
    }
    if (snapshot.stopped || state !== snapshot) return snapshot.targets;
    const nextTargets = focusModel.buildFocusTargets({
      cwd: ctx.cwd,
      sessions: snapshot.sessions,
      currentSessionFile,
      currentSessionId: ctx.sessionManager?.getSessionId?.(),
      currentLeafId: ctx.sessionManager?.getLeafId?.(),
      currentSessionEntries: ctx.sessionManager?.getEntries?.(),
      maxFinalSubagents: MAX_RECENT_FINAL_SUBAGENTS,
    });
    const targetsChanged = !focusModel.sameFocusTargets(snapshot.targets, nextTargets);
    snapshot.targets = nextTargets;
    if (targetsChanged) snapshot.revision += 1;
    installWidget(ctx, targetsChanged);
    // A later-loaded extension may replace the editor factory after our
    // session_start handler. Re-check on each bounded refresh so Chat Focus
    // composes with asynchronously installed custom editors as well.
    installEditorBridge(ctx);
    const active = snapshot.targets.filter((target: FocusTarget) => ["running", "queued"].includes(target.status || ""));
    const statusText = active.length ? `chats:${active.length} working` : undefined;
    if (!snapshot.statusInitialized || statusText !== snapshot.statusText) {
      snapshot.statusInitialized = true;
      snapshot.statusText = statusText;
      ctx.ui?.setStatus?.("chat-focus", statusText);
    }
    return snapshot.targets;
  }).finally(() => { if (state === snapshot) snapshot.refreshPromise = undefined; });
  return state.refreshPromise;
}

function panelHeight(tui: any) {
  const rows = Number(tui?.terminal?.rows || process.stdout?.rows || process.env.LINES || 24);
  return Math.max(10, Math.floor((Number.isFinite(rows) ? rows : 24) * 0.72));
}

function pad(text: string, width: number) {
  const clipped = truncateToWidth(text, Math.max(0, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function border(theme: any, width: number, title: string, bottom = false) {
  const safeWidth = Math.max(4, width);
  const inner = safeWidth - 2;
  const label = truncateToWidth(` ${title} `, inner, "");
  const fill = "─".repeat(Math.max(0, inner - visibleWidth(label)));
  return theme.fg("accent", `${bottom ? "╰" : "╭"}${label}${fill}${bottom ? "╯" : "╮"}`);
}

function framedRow(theme: any, width: number, text: string) {
  const inner = Math.max(0, Math.max(4, width) - 2);
  return `${theme.fg("accent", "│")}${pad(text, inner)}${theme.fg("accent", "│")}`;
}

function panelTranscript(target: FocusTarget, width: number) {
  const contentWidth = Math.max(1, width - 4);
  const blocks: string[] = focusModel.transcriptForTarget(target);
  const lines: string[] = [];
  for (const block of blocks) {
    const parts = String(block || "").split("\n");
    for (const line of parts) lines.push(...wrapTextWithAnsi(line, contentWidth));
    lines.push("");
  }
  if (lines.at(-1) === "") lines.pop();
  return lines.length ? lines : ["No visible messages."];
}

function canActivate(ctx: any, target: FocusTarget) {
  if (!ctx.isIdle()) return { ok: false, reason: "Parent chat is working; this is a live read-only focus view." };
  if (target.kind === "subagent" && ["created", "queued", "running"].includes(target.status || "")) return { ok: false, reason: "Subagent is still working; keep this view open or press Esc to return." };
  if (target.kind === "subagent" && target.status === "cancelled") return { ok: false, reason: "Cancelled subagent sessions stay read-only because runner ownership cannot be confirmed." };
  if (!target.sessionPath) return { ok: false, reason: "No Pi session file is available for this chat." };
  return { ok: true, reason: "Enter opens this chat as the main editable session." };
}

async function activateTarget(ctx: any, target: FocusTarget) {
  const allowed = canActivate(ctx, target);
  if (!allowed.ok) return ctx.ui.notify(allowed.reason, "warning");
  const currentPath = ctx.sessionManager?.getSessionFile?.();
  const currentLeaf = ctx.sessionManager?.getLeafId?.();
  if (target.sessionPath === currentPath) {
    if (target.leafId && target.leafId !== currentLeaf) {
      const result = await ctx.navigateTree(target.leafId, { summarize: false });
      if (!result.cancelled) ctx.ui.notify(`Focused ${target.label}`, "info");
    }
    return;
  }
  const leafId = target.leafId;
  const label = target.label;
  await ctx.switchSession(target.sessionPath, {
    withSession: async (freshCtx: any) => {
      if (leafId && freshCtx.sessionManager?.getLeafId?.() !== leafId) await freshCtx.navigateTree(leafId, { summarize: false });
      freshCtx.ui?.notify?.(`Focused ${label} · use /chat-back to return to Main`, "info");
    },
  });
}

async function openPanel(pi: ExtensionAPI, ctx: ExtensionContext, allowSwitch: boolean, initialKey?: string) {
  const initial = await refresh(ctx, true);
  if (!initial.length) return ctx.ui.notify("No persisted chat is available to focus.", "warning");
  const requestedIndex = initialKey ? initial.findIndex((target: FocusTarget) => target.key === initialKey) : -1;
  let index = requestedIndex >= 0 ? requestedIndex : selectedIndex(initial);
  let scroll = 0;
  let lastMaxScroll = 0;
  let followTail = true;
  let notice = "";

  const panelState = state;
  if (!panelState || panelState.stopped) return;
  let cleanup: (() => void) | undefined;
  let result: any;
  try {
    result = await ctx.ui.custom<any>((tui: any, theme: any, _keybindings: any, done: any) => {
      // eslint-disable-next-line prefer-const -- assigned after the finish closure is defined
      let timer: ReturnType<typeof setInterval> | undefined;
      let finished = false;
      const finish = (value: any) => {
        if (finished) return;
        finished = true;
        if (timer) clearInterval(timer);
        if (cleanup) panelState?.panelCleanups.delete(cleanup);
        done(value);
      };
      cleanup = () => finish({ action: "close" });
      panelState?.panelCleanups.add(cleanup);
      let renderedRevision = panelState?.revision || 0;
      timer = setInterval(() => {
        void refresh(ctx).then(() => {
          if (panelState && renderedRevision !== panelState.revision) tui.requestRender();
        });
      }, POLL_MS);
      timer.unref?.();

    return {
      invalidate() {},
      render(width: number) {
        if (panelState) renderedRevision = panelState.revision;
        const targets = state?.targets || initial;
        if (index >= targets.length) index = Math.max(0, targets.length - 1);
        const target = targets[index];
        const height = panelHeight(tui);
        const bodyHeight = Math.max(3, height - 4);
        const transcript = panelTranscript(target, width);
        const maxScroll = Math.max(0, transcript.length - bodyHeight);
        lastMaxScroll = maxScroll;
        scroll = followTail ? maxScroll : Math.max(0, Math.min(scroll, maxScroll));
        const visible = transcript.slice(scroll, scroll + bodyHeight);
        while (visible.length < bodyHeight) visible.push("");
        const activity = ctx.isIdle() ? "idle" : "parent working";
        const title = `${index + 1}/${targets.length} · ${target.label} · ${target.kind} · ${target.status || "saved"} · ${activity}`;
        const permission = canActivate(ctx, target);
        const help = notice || (allowSwitch ? permission.reason : permission.ok ? "Enter requests this chat; Tab changes focus; Esc returns to Main." : permission.reason);
        return [
          border(theme, width, title),
          framedRow(theme, width, theme.fg("dim", ` ↑/↓ scroll · boundary cycles chats · Tab/Shift+Tab jump · m Main · r refresh · q/Esc back `)),
          ...visible.map((line) => framedRow(theme, width, ` ${line}`)),
          border(theme, width, truncateToWidth(`${help} · scroll ${scroll}/${maxScroll}`, Math.max(1, width - 4), ""), true),
        ];
      },
      handleInput(data: string) {
        const targets = state?.targets || initial;
        notice = "";
        if (matchesKey(data, Key.escape) || data === "q") return finish({ action: "close" });
        if (matchesKey(data, Key.tab)) { index = (index + 1) % targets.length; scroll = 0; followTail = true; }
        else if (matchesKey(data, Key.shift("tab"))) { index = (index - 1 + targets.length) % targets.length; scroll = 0; followTail = true; }
        else if (data === "m") { const main = targets.findIndex((target) => target.kind === "main"); if (main >= 0) { index = main; scroll = 0; followTail = true; } }
        else if (data === "r") void refresh(ctx, true);
        else if (matchesKey(data, Key.up) || data === "k" || matchesKey(data, Key.down) || data === "j") {
          const direction = matchesKey(data, Key.down) || data === "j" ? "down" : "up";
          const next = focusModel.stepFocusNavigation({ direction, index, scroll, maxScroll: lastMaxScroll, targetCount: targets.length });
          index = next.index;
          scroll = next.scroll;
          followTail = next.followTail;
        }
        else if (matchesKey(data, Key.pageUp)) { scroll -= Math.max(3, panelHeight(tui) - 6); followTail = false; }
        else if (matchesKey(data, Key.pageDown)) { scroll += Math.max(3, panelHeight(tui) - 6); followTail = false; }
        else if (matchesKey(data, Key.end)) followTail = true;
        else if (matchesKey(data, Key.enter)) {
          const target = targets[index];
          const permission = canActivate(ctx, target);
          if (!permission.ok) notice = permission.reason;
          else return finish({ action: allowSwitch ? "switch" : "request-switch", key: target.key });
        }
        scroll = Math.max(0, scroll);
        tui.requestRender();
      },
    };
    }, {
      overlay: true,
      overlayOptions: { anchor: "top-center", width: "100%", maxHeight: "82%", margin: { top: 0, right: 0, bottom: 3, left: 0 } },
    });
  } finally {
    cleanup?.();
  }

  if (!result || result.action === "close") return;
  const targets = await refresh(ctx);
  const target = targets.find((item: FocusTarget) => item.key === result.key);
  if (!target) return ctx.ui.notify("That chat is no longer available.", "warning");
  if (result.action === "switch") return activateTarget(ctx, target);
  const command = `/chat-focus ${target.key}`;
  pi.sendUserMessage(command, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
}

function installEditorBridge(ctx: any) {
  if (!state || state.stopped || !ctx?.ui?.setEditorComponent) return;
  const snapshot = state;
  const activeFactory: any = ctx.ui.getEditorComponent?.();
  if (activeFactory?.__chatFocusBridgeState === snapshot) return;
  // Session replacement leaves the previous editor factory installed briefly.
  // Unwrap an older Chat Focus bridge so the new session never captures stale
  // focus state or recursively stacks wrappers.
  const previousFactory: any = activeFactory?.__chatFocusBridge
    ? activeFactory.__chatFocusBaseFactory
    : activeFactory;
  const factory: any = (tui: any, theme: any, keybindings: any) => {
    const editor: any = previousFactory
      ? previousFactory(tui, theme, keybindings)
      : new CustomEditor(tui, theme, keybindings);
    const handleInput = editor.handleInput.bind(editor);
    editor.handleInput = (data: string) => {
      if (state !== snapshot || snapshot.stopped) return handleInput(data);
      if (snapshot.stripFocused) {
        if (snapshot.widget) tui.setFocus(snapshot.widget);
        return;
      }
      const isDown = keybindings?.matches?.(data, "tui.editor.cursorDown") || matchesKey(data, Key.down);
      if (!isDown || editor.isShowingAutocomplete?.()) return handleInput(data);
      const beforeCursor = editor.getCursor?.();
      const beforeText = editor.getText?.();
      handleInput(data);
      const afterCursor = editor.getCursor?.();
      const afterText = editor.getText?.();
      const stayedAtBottom = beforeCursor && afterCursor
        && beforeCursor.line === afterCursor.line
        && beforeCursor.col === afterCursor.col
        && beforeText === afterText;
      if (!stayedAtBottom || snapshot.targets.length <= 1) return;
      const next = focusModel.stepStripNavigation({ focused: false, direction: "down", index: snapshot.stripIndex, targetCount: snapshot.targets.length });
      snapshot.stripFocused = next.focused;
      snapshot.stripIndex = next.index;
      installWidget(ctx);
      if (snapshot.widget) tui.setFocus(snapshot.widget);
      else snapshot.stripFocused = false;
      tui.requestRender();
    };
    snapshot.editor = editor;
    snapshot.tui = tui;
    return editor;
  };
  factory.__chatFocusBridge = true;
  factory.__chatFocusBridgeState = snapshot;
  factory.__chatFocusBaseFactory = previousFactory;
  ctx.ui.setEditorComponent(factory);
}

export default function chatFocusExtension(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  pi.on("session_start", async (_event, ctx: any) => {
    if (ctx.mode !== "tui") return;
    if (state?.timer) clearInterval(state.timer);
    state = {
      api: pi,
      targets: [],
      sessions: [],
      lastSessionScan: 0,
      panelCleanups: new Set(),
      stripFocused: false,
      stripIndex: 0,
      widgetInstalled: false,
      stopped: false,
      revision: 0,
      statusInitialized: false,
    };
    await refresh(ctx, true);
    const snapshot = state;
    snapshot.timer = setInterval(() => { void refresh(ctx); }, POLL_MS);
    snapshot.timer.unref?.();
    // Other extensions may install their own CustomEditor during session_start.
    // Wrap the final factory on the next macrotask so prompt suggestions and
    // other editor behavior remain intact.
    snapshot.editorInstallTimer = setTimeout(() => {
      if (state !== snapshot || snapshot.stopped) return;
      // Reconcile once after all session_start handlers so a later-loaded
      // Reasoning Runtime fallback cannot duplicate the shared chat strip.
      ctx.ui?.setWidget?.("subagents", undefined);
      installEditorBridge(ctx);
    }, 0);
    snapshot.editorInstallTimer.unref?.();
  });

  for (const event of ["agent_start", "agent_end", "agent_settled", "session_tree", "session_info_changed"] as const) {
    pi.on(event as any, async (_event: any, ctx: any) => {
      if (state) void refresh(ctx, event === "session_tree" || event === "session_info_changed");
    });
  }

  pi.on("session_shutdown", async (_event, ctx: any) => {
    if (!state) return;
    if (state.stripFocused) returnStripFocusToEditor(state, state.tui);
    state.stopped = true;
    if (state.timer) clearInterval(state.timer);
    if (state.editorInstallTimer) clearTimeout(state.editorInstallTimer);
    for (const cleanup of [...state.panelCleanups]) cleanup();
    state.panelCleanups.clear();
    ctx.ui?.setWidget?.("chat-focus", undefined);
    ctx.ui?.setStatus?.("chat-focus", undefined);
    state = undefined;
  });

  pi.registerShortcut("f6", { description: "Focus a main, subagent, fork, or branch chat", handler: async (ctx: any) => openPanel(pi, ctx, false) });

  pi.registerCommand("chat-focus", {
    description: "Focus a main, subagent, forked, or branched chat: /chat-focus [number|main|target-id]",
    handler: async (args, ctx: any) => {
      const targets = await refresh(ctx, true);
      const raw = String(args || "").trim();
      if (!raw) return openPanel(pi, ctx, true);
      const target = targetByArg(targets, raw);
      if (!target) return ctx.ui.notify(`Unknown chat target: ${raw}. Run /chat-list.`, "warning");
      return activateTarget(ctx, target);
    },
  });

  pi.registerCommand("chat-back", {
    description: "Return focus to the root Main chat",
    handler: async (_args, ctx: any) => {
      const targets = await refresh(ctx, true);
      const main = targets.find((target: FocusTarget) => target.kind === "main");
      if (!main) return ctx.ui.notify("Main chat was not found.", "warning");
      return activateTarget(ctx, main);
    },
  });

  pi.registerCommand("chat-list", {
    description: "List focusable main, subagent, forked, and branched chats",
    handler: async (_args, ctx: any) => {
      const targets = await refresh(ctx, true);
      const busy = !ctx.isIdle();
      const rows = targets.map((target: FocusTarget, index: number) => `${index + 1}. ${focusModel.statusIcon(target, busy)} ${target.label}\t${target.kind}\t${target.status || "saved"}${target.current ? "\tcurrent" : ""}\t${target.key}`);
      ctx.ui.notify(rows.join("\n") || "No focusable chats.", "info");
    },
  });
}
