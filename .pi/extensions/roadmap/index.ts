import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Key, matchesKey, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
const { statSync } = require("node:fs");

const {
  addItem,
  addItems,
  addSubtaskRoadmap,
  adoptRoadmap,
  archiveRoadmapPacket,
  ROADMAP_ERROR_CODES,
  RoadmapError,
  clearRoadmap,
  createPlanRoadmap,
  createRoadmap,
  findItem,
  finalReportSummary,
  formatRoadmapText,
  formatWidgetLines,
  roadmapPage,
  roadmapSnapshot,
  roadmapStoreCandidates,
  getProgress,
  importFromReasoning,
  linkItem,
  linkItems,
  loadRoadmap,
  parseStartArgs,
  roadmapMutationEnvelope,
  roadmapStateMetrics,
  saveRoadmap,
  setActive,
  setRoadmapLifecycle,
  setRoadmapSessionScope,
  setStatus,
  setStatusMany,
  startRoadmap,
  shouldClearCompletedRoadmapOnInput,
  stateFile,
  summaryLine,
} = require("./roadmap-state.js");
const { EvidenceStore } = require("../../../src/evidence-binder.js");
const {
  ROADMAP_COHORT_VERSION,
  createRoadmapFieldReport,
  createRoadmapSessionToken,
  roadmapCohortVersion,
  roadmapOpportunityEligible,
  readRoadmapTelemetry,
  recordRoadmapTelemetry,
} = require("../../../src/roadmap-telemetry.js");

const ENABLED = process.env.PI_ROADMAP !== "0";
const ROADMAP_USAGE_GUIDELINE = "Use roadmap_update proactively for substantive multi-step work (investigation, implementation, and verification), even when topology routing is off; do not wait for an explicit tracking request. Simple answers and one-step tasks do not need a roadmap.";
const ROADMAP_PROGRESS_GUIDELINE = "Keep roadmap_update current within the current task's scope at material transitions and before the final response: mark completed work done; leave unstarted work pending and mark blocked/paused only for actual blockers or pauses. Use verified only with current evidenceId. Do not infer completion from a plan or a delegated result alone. Continue the canonical parent after passing increments; report root required outcomes separately from recursive workflow counts.";
const ROADMAP_BATCH_GUIDELINE = "Settle several items in one call instead of one call per item: set_status accepts itemIds, and cascade=true also marks pending/active nested descendants deepest-first, so a finished milestone and its goals complete together.";
const rawWidgetMaxItems = Number(process.env.PI_ROADMAP_WIDGET_ITEMS || 6);
const WIDGET_MAX_ITEMS = Number.isFinite(rawWidgetMaxItems) ? Math.max(1, rawWidgetMaxItems) : 6;
const STATUS_VALUES = ["pending", "active", "done", "verified", "verified-unsubstantiated", "blocked", "paused", "shelved", "skipped", "archived"] as const;
const ACTION_VALUES = ["show", "export", "report", "start", "replace", "add_subtask", "add", "set_status", "active", "link", "adopt", "import_reasoning", "close", "shelve", "resume", "archive", "clear"] as const;
const PROVENANCE_VALUES = ["manual", "work-backed", "batch", "backfill", "override"] as const;
const MILESTONE_SCHEMA = Type.Object({
  title: Type.String({ minLength: 1, description: "Phase or milestone title" }),
  goals: Type.Array(Type.String({ minLength: 1, description: "Goal that becomes an item in the milestone's nested roadmap" }), { minItems: 1, maxItems: 20 }),
});

type RoadmapState = any;

function short(text: string, n = 160) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > n ? `${value.slice(0, n - 1)}…` : value;
}

function notify(ctx: any, message: string, level: "info" | "warning" | "error" = "info") {
  if (ctx?.hasUI) ctx.ui.notify(message, level);
  else console.log(message);
}

function parseFlag(text: string, name: string) {
  const input = String(text || "");
  const marker = `--${name}=`;
  let index = input.indexOf(marker);
  while (index > 0 && !/\s/.test(input[index - 1])) index = input.indexOf(marker, index + marker.length);
  if (index < 0) return undefined;
  const rest = input.slice(index + marker.length);
  const quote = rest[0] === '"' || rest[0] === "'" ? rest[0] : "";
  if (quote) {
    const end = rest.indexOf(quote, 1);
    return end < 0 ? rest.slice(1) : rest.slice(1, end);
  }
  return rest.split(/\s/, 1)[0] || undefined;
}

function stripKnownFlags(text: string) {
  return String(text || "")
    .replace(/(?:^|\s)--artifact=\S+/g, " ")
    .replace(/(?:^|\s)--evidence=\S+/g, " ")
    .replace(/(?:^|\s)--roadmap=\S+/g, " ")
    .replace(/(?:^|\s)--parent=\S+/g, " ")
    .replace(/(?:^|\s)--note=("[^"]*"|'[^']*'|\S+)/g, " ")
    .replace(/(?:^|\s)--focus=\S+/g, " ")
    .replace(/(?:^|\s)--offset=\S+/g, " ")
    .replace(/(?:^|\s)--limit=\S+/g, " ")
    .replace(/(?:^|\s)--provenance=\S+/g, " ")
    .replace(/(?:^|\s)--unsubstantiated\b/g, " ")
    .replace(/(?:^|\s)--cascade\b/g, " ")
    .trim();
}

function parseNote(text: string) {
  const raw = parseFlag(text, "note");
  return raw ? raw.replace(/^['"]|['"]$/g, "") : undefined;
}

function colorLine(line: string, theme: any) {
  const content = line.trimStart();
  if (content.startsWith("🧭")) return theme.fg("accent", line);
  if (content.startsWith("✓") || content.startsWith("◆")) return theme.fg("success", line);
  if (content.startsWith("▶")) return theme.fg("accent", line);
  if (content.startsWith("⚠")) return theme.fg("warning", line);
  if (content.startsWith("↷") || content.startsWith("↳") || content.startsWith("…")) return theme.fg("dim", line);
  return line;
}

function renderRoadmapWidget(ctx: any, state: RoadmapState | null) {
  if (!ctx?.hasUI || !ctx.ui?.setWidget) return;
  if (!state) {
    ctx.ui.setWidget("roadmap", undefined);
    ctx.ui.setStatus?.("roadmap", undefined);
    return;
  }
  const progress = getProgress(state);
  const active = progress.active ? ` · ${short(progress.active.title, 40)}` : "";
  ctx.ui.setStatus?.("roadmap", `🧭 ${progress.complete}/${progress.total}${progress.blocked ? ` !${progress.blocked}` : ""}${active}`);
  ctx.ui.setWidget("roadmap", (_tui: any, theme: any) => ({
    invalidate() {},
    render(width: number) {
      return formatWidgetLines(state, { maxItems: WIDGET_MAX_ITEMS }).map((line: string) => truncateToWidth(colorLine(line, theme), width));
    },
  }), { placement: "aboveEditor" });
}

function panelHeight(tui: any) {
  const rows = Number(tui?.terminal?.rows || process.stdout?.rows || 24);
  return Math.max(8, Math.min(28, Math.floor((Number.isFinite(rows) ? rows : 24) * 0.65)));
}

function panelLines(state: RoadmapState | null, theme: any, width: number) {
  const contentWidth = Math.max(10, width - 4);
  const raw = formatRoadmapText(state).split("\n");
  const colored = raw.map((line: string) => colorLine(line, theme));
  return colored.flatMap((line: string) => wrapTextWithAnsi(line, contentWidth));
}

async function openRoadmapPanel(ctx: ExtensionContext, getState: () => RoadmapState | null) {
  const state = getState();
  if (!ctx.hasUI) return notify(ctx, formatRoadmapText(state));
  await ctx.ui.custom<void>((tui: any, theme: any, _kb: any, done: any) => {
    let scroll = 0;
    return {
      invalidate() {},
      render(width: number) {
        const safeWidth = Math.max(20, width);
        const height = panelHeight(tui);
        const bodyHeight = Math.max(1, height - 4);
        const all = panelLines(getState(), theme, safeWidth);
        const maxScroll = Math.max(0, all.length - bodyHeight);
        scroll = Math.max(0, Math.min(scroll, maxScroll));
        const body = all.slice(scroll, scroll + bodyHeight);
        while (body.length < bodyHeight) body.push("");
        const title = truncateToWidth(theme.fg("accent", "╭─ Roadmap ─" + "─".repeat(Math.max(0, safeWidth - 13)) + "╮"), safeWidth);
        const footerText = `scroll ${scroll}/${maxScroll} · ↑/↓ PgUp/PgDn · q/Esc close`;
        const footer = truncateToWidth(theme.fg("accent", "╰─ " + footerText + " " + "─".repeat(Math.max(0, safeWidth - footerText.length - 5)) + "╯"), safeWidth);
        return [title, ...body.map((line: string) => truncateToWidth(`│ ${line}`, safeWidth)), footer];
      },
      handleInput(data: string) {
        const page = Math.max(4, panelHeight(tui) - 5);
        if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) return done();
        if (matchesKey(data, Key.down) || data === "j") scroll += 1;
        else if (matchesKey(data, Key.up) || data === "k") scroll -= 1;
        else if (matchesKey(data, Key.pageDown)) scroll += page;
        else if (matchesKey(data, Key.pageUp)) scroll -= page;
        scroll = Math.max(0, scroll);
        tui.requestRender();
      },
    };
  }, { overlay: true, overlayOptions: { anchor: "right-center", width: "60%", minWidth: 50, maxHeight: "80%", margin: 1 } });
}

export default function roadmapExtension(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  if (ENABLED) require("../../../src/pi-extension-kit.js").observeFixedOpportunity(pi, { extension: "roadmap", version: "opportunity-pilot-v1", triggerId: "workflow-plan-intent", sourceFile: __filename, tools: ["roadmap_update"], matches: (text: string) => /\b(?:plan|roadmap|multi-step|milestones?)\b/i.test(text) });
  if (!ENABLED) return;

  let state: RoadmapState | null = null;
  let loadedCwd = "";
  let loadedScope: string | null = null;
  let loadedStateRevision = "missing";
  let sessionToken = createRoadmapSessionToken();
  let cohortVersion = ROADMAP_COHORT_VERSION;
  let previousToolError = false;

  function sessionKind(ctx: any) { return ctx?.hasUI === true ? "interactive" : ctx?.hasUI === false ? "headless-smoke" : "unknown"; }
  function sessionScope(ctx: any) {
    const id = ctx?.sessionManager?.getSessionId?.();
    return id ? String(id) : null;
  }
  function validateEvidenceId(ctx: any) {
    const store = new EvidenceStore({ cwd: ctx.cwd });
    return (evidenceId: string) => store.validateEvidenceId(evidenceId, { requireOk: true });
  }
  function emitRoadmapTelemetry(ctx: any, operation: string, outcome: string, resultText = "", deltaChars = 0, errorCode?: string) {
    const metrics = roadmapStateMetrics(state);
    const result = recordRoadmapTelemetry(ctx.cwd, {
      cohortVersion,
      sessionToken,
      sessionKind: sessionKind(ctx),
      operation,
      outcome,
      requestValidity: operation === "add_subtask" ? (outcome === "domain-negative" ? "invalid" : outcome === "not-applicable" ? "not-applicable" : "valid") : "not-applicable",
      resultChars: String(resultText || "").length,
      deltaChars,
      ...metrics,
      eligible: false,
      adopted: Boolean(state),
      correction: previousToolError && outcome === "succeeded",
      errorCode,
    });
    previousToolError = outcome !== "succeeded" && outcome !== "not-applicable";
    return result;
  }

  function stateRevision(cwd: string) {
    try {
      const stat = statSync(stateFile(cwd), { bigint: true });
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
    } catch { return "missing"; }
  }

  // Every state change is rendered locally and published for status
  // consumers on the extension bus (e.g. the pi-dash session dashboard).
  function present(ctx: any, current: RoadmapState | null) {
    renderRoadmapWidget(ctx, current);
    pi.events.emit("roadmap:changed", roadmapSnapshot(current));
  }

  function syncScope(ctx: any) {
    const scope = sessionScope(ctx);
    if (scope !== loadedScope) {
      // Concurrent sessions in one directory keep independent roadmaps; the
      // scope switch also invalidates the cached state.
      loadedScope = scope;
      setRoadmapSessionScope(scope);
      loadedCwd = "";
    }
    return scope;
  }

  function ensureLoaded(ctx: any) {
    syncScope(ctx);
    const revision = stateRevision(ctx.cwd);
    if (loadedCwd !== ctx.cwd || loadedStateRevision !== revision) {
      loadedCwd = ctx.cwd;
      cohortVersion = roadmapCohortVersion(ctx.cwd);
      state = loadRoadmap(ctx.cwd);
      loadedStateRevision = stateRevision(ctx.cwd);
      present(ctx, state);
    }
    return state;
  }

  function commit(ctx: any, next: RoadmapState | null, options: any = {}) {
    syncScope(ctx);
    loadedCwd = ctx.cwd;
    state = next ? saveRoadmap(ctx.cwd, next) : clearRoadmap(ctx.cwd, options);
    loadedStateRevision = stateRevision(ctx.cwd);
    present(ctx, state);
    return state;
  }

  function requireState(ctx: any) {
    const current = ensureLoaded(ctx);
    if (!current) throw new RoadmapError(ROADMAP_ERROR_CODES.MISSING_PARENT, "No roadmap active. Use /roadmap-start <title> or /roadmap-import-reasoning.");
    return current;
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    loadedScope = sessionScope(ctx);
    setRoadmapSessionScope(loadedScope);
    loadedCwd = ctx.cwd;
    loadedStateRevision = stateRevision(ctx.cwd);
    sessionToken = createRoadmapSessionToken();
    cohortVersion = roadmapCohortVersion(ctx.cwd);
    previousToolError = false;
    state = loadRoadmap(ctx.cwd);
    present(ctx, state);
  });

  pi.on("tool_result" as any, async (_event: any, ctx: any) => { ensureLoaded(ctx); });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    // Roadmap owns parent planning guidance independently of routing/reasoning.
    // Restricted child roles and explicitly disabled tools must remain exempt.
    if (!pi.getActiveTools().includes("roadmap_update")) return;
    const current = ensureLoaded(ctx);
    const candidates = current ? [] : roadmapStoreCandidates(ctx.cwd).filter((entry: any) => !entry.settled).slice(0, 3);
    const context = current ? [
      "Persisted roadmap state (may belong to earlier work):",
      roadmapPage(current, { focusId: getProgress(current).active?.id, limit: 6, maxChars: 1600 }).text,
      "For continuing work, use this existing roadmap; do not start a duplicate. Use roadmap_update action=show for more detail and resume shelved scope only when continuing it.",
      "If no actionable parent exists, choose an explicit parentId or close/shelve the old scope before starting unrelated work; never guess a parent or replace without explicit authorization.",
    ].join("\n") : [
      "No roadmap active for this session. For multi-step work, call roadmap_update action=start with milestones before implementation; each milestone is a task and its goals are nested items.",
      candidates.length ? `Earlier roadmaps in this directory: ${candidates.map((entry: any) => `${entry.roadmapId} "${short(entry.title, 48)}" (${entry.complete}/${entry.total} complete, ${entry.actionable} actionable)`).join("; ")}. Continue one with roadmap_update action=adopt roadmapId=<id> instead of starting a duplicate.` : "",
    ].filter(Boolean).join("\n");
    // Read-only, bounded turn context: the model still authors the plan and
    // performs status transitions. Do not import a generic reasoning scaffold.
    return { systemPrompt: `${event.systemPrompt}\n\n## Roadmap workflow\n${ROADMAP_USAGE_GUIDELINE}\n${context}\n${ROADMAP_PROGRESS_GUIDELINE}\n${ROADMAP_BATCH_GUIDELINE}` };
  });

  pi.on("input", async (event: any, ctx: any) => {
    // Headless one-off turns (pi -p) must not mutate roadmap state persisted
    // by earlier interactive sessions; dogfooding saw a completed roadmap
    // silently deleted by an unrelated headless battery.
    if (!ctx?.hasUI) return { action: "continue" };
    const current = ensureLoaded(ctx);
    recordRoadmapTelemetry(ctx.cwd, { cohortVersion, sessionToken, sessionKind: sessionKind(ctx), operation: "input_opportunity", outcome: "not-applicable", eligible: roadmapOpportunityEligible(event?.text), adopted: Boolean(current), settled: Boolean(current && roadmapStateMetrics(current).settled), ...roadmapStateMetrics(current) });
    if (shouldClearCompletedRoadmapOnInput(current, event)) commit(ctx, null, { reason: "completed-on-next-input" });
    return { action: "continue" };
  });

  pi.registerCommand("roadmap", {
    description: "Show the active hybrid roadmap checklist",
    handler: async (_args: string, ctx: any) => {
      const current = ensureLoaded(ctx);
      renderRoadmapWidget(ctx, current);
      notify(ctx, formatRoadmapText(current), current ? "info" : "warning");
    },
  });

  pi.registerCommand("roadmap-panel", {
    description: "Open the scrollable roadmap panel",
    handler: async (_args: string, ctx: any) => openRoadmapPanel(ctx, () => ensureLoaded(ctx)),
  });

  pi.registerCommand("roadmap-start", {
    description: "Start a root roadmap, or nest under the active item without overwriting it: /roadmap-start <title> [:: step one | step two] [--parent=item]",
    handler: async (args: string, ctx: any) => {
      try {
        const parsed = parseStartArgs(stripKnownFlags(args || ""));
        const current = ensureLoaded(ctx);
        const next = startRoadmap(current, parsed.title, parsed.items, { source: "manual", parentId: parseFlag(args, "parent") });
        const nested = Boolean(current && current.id === next.id);
        commit(ctx, next);
        notify(ctx, `${nested ? "Nested subtask roadmap" : "Started root roadmap"} at ${stateFile(ctx.cwd)}\n${summaryLine(next)}`, "info");
      } catch (error: any) { notify(ctx, error?.message || String(error), "warning"); }
    },
  });

  pi.registerCommand("roadmap-subtask", {
    description: "Nest a subtask roadmap under the active or selected item: /roadmap-subtask <title> [:: step one | step two] [--parent=item]",
    handler: async (args: string, ctx: any) => {
      try {
        const parsed = parseStartArgs(stripKnownFlags(args || ""));
        const next = addSubtaskRoadmap(requireState(ctx), parsed.title, parsed.items, { source: "manual", parentId: parseFlag(args, "parent") });
        commit(ctx, next);
        notify(ctx, `Nested subtask roadmap.\n${summaryLine(next)}`, "info");
      } catch (error: any) { notify(ctx, error?.message || String(error), "warning"); }
    },
  });

  pi.registerCommand("roadmap-replace", {
    description: "Explicitly replace the entire roadmap: /roadmap-replace <title> [:: step one | step two]",
    handler: async (args: string, ctx: any) => {
      const parsed = parseStartArgs(args || "");
      const next = createRoadmap(parsed.title, parsed.items, { source: "manual" });
      commit(ctx, next);
      notify(ctx, `Replaced root roadmap at ${stateFile(ctx.cwd)}\n${summaryLine(next)}`, "warning");
    },
  });

  pi.registerCommand("roadmap-add", {
    description: "Add an item to the active nested roadmap: /roadmap-add <step> [--roadmap=id] [--artifact=id] [--evidence=id]",
    handler: async (args: string, ctx: any) => {
      try {
        const title = stripKnownFlags(args || "");
        if (!title) return notify(ctx, "Usage: /roadmap-add <step> [--roadmap=id] [--artifact=id] [--evidence=id]", "warning");
        const next = addItem(requireState(ctx), title, {
          activeRoadmap: true,
          roadmapId: parseFlag(args, "roadmap"),
          artifactId: parseFlag(args, "artifact"),
          evidenceIds: parseFlag(args, "evidence") ? [parseFlag(args, "evidence")] : [],
          validateEvidenceId: validateEvidenceId(ctx),
        });
        commit(ctx, next);
        notify(ctx, summaryLine(next), "info");
      } catch (error: any) { notify(ctx, error?.message || String(error), "warning"); }
    },
  });

  pi.registerCommand("roadmap-active", {
    description: "Mark a roadmap item active: /roadmap-active <item-id|numeric-path>",
    handler: async (args: string, ctx: any) => {
      try {
        const ref = String(args || "").trim();
        if (!ref) return notify(ctx, "Usage: /roadmap-active <item-id|numeric-path>", "warning");
        const next = setActive(requireState(ctx), ref);
        commit(ctx, next);
        notify(ctx, summaryLine(next), "info");
      } catch (error: any) { notify(ctx, error?.message || String(error), "warning"); }
    },
  });

  pi.registerCommand("roadmap-done", {
    description: "Mark roadmap items done and advance: /roadmap-done <item> [<item>...] [--evidence=id] [--cascade]",
    handler: async (args: string, ctx: any) => {
      try {
        const refs = stripKnownFlags(args || "").split(/\s+/).filter(Boolean);
        if (!refs.length) return notify(ctx, "Usage: /roadmap-done <item> [<item>...] [--evidence=id] [--cascade]", "warning");
        const next = setStatusMany(requireState(ctx), refs, "done", { evidenceId: parseFlag(args, "evidence"), validateEvidenceId: validateEvidenceId(ctx), cascade: /(?:^|\s)--cascade(?:\s|$)/.test(args || ""), autoAdvance: true });
        commit(ctx, next);
        notify(ctx, summaryLine(next), "info");
      } catch (error: any) { notify(ctx, error?.message || String(error), "warning"); }
    },
  });

  pi.registerCommand("roadmap-adopt", {
    description: "Bind an earlier roadmap from this directory to the current session: /roadmap-adopt <roadmap-id>",
    handler: async (args: string, ctx: any) => {
      try {
        const ref = String(args || "").trim();
        if (!ref) return notify(ctx, "Usage: /roadmap-adopt <roadmap-id>", "warning");
        ensureLoaded(ctx);
        const next = adoptRoadmap(ctx.cwd, ref);
        commit(ctx, next);
        notify(ctx, `Adopted roadmap ${ref}.\n${summaryLine(next)}`, "info");
      } catch (error: any) { notify(ctx, error?.message || String(error), "warning"); }
    },
  });

  pi.registerCommand("roadmap-verify", {
    description: "Mark an item verified with current evidence, or explicitly override: /roadmap-verify <item> <evidence-id> [--unsubstantiated]",
    handler: async (args: string, ctx: any) => {
      try {
        const parts = stripKnownFlags(args || "").split(/\s+/).filter(Boolean);
        const ref = parts[0];
        const evidenceId = parseFlag(args, "evidence") || parts[1];
        const allowUnsubstantiated = /(?:^|\s)--unsubstantiated(?:\s|$)/.test(args || "");
        if (!ref || (!evidenceId && !allowUnsubstantiated)) return notify(ctx, "Usage: /roadmap-verify <item> <evidence-id|--evidence=id> [--unsubstantiated]", "warning");
        const next = setStatus(requireState(ctx), ref, "verified", { evidenceId, validateEvidenceId: validateEvidenceId(ctx), allowUnsubstantiated, note: allowUnsubstantiated ? "Explicit unsubstantiated verification override" : undefined, autoAdvance: true });
        commit(ctx, next);
        notify(ctx, summaryLine(next), allowUnsubstantiated ? "warning" : "info");
      } catch (error: any) { notify(ctx, error?.message || String(error), "warning"); }
    },
  });

  pi.registerCommand("roadmap-block", {
    description: "Block a roadmap item: /roadmap-block <item> <reason>",
    handler: async (args: string, ctx: any) => {
      try {
        const [ref, ...rest] = String(args || "").trim().split(/\s+/).filter(Boolean);
        if (!ref || !rest.length) return notify(ctx, "Usage: /roadmap-block <item> <reason>", "warning");
        const next = setStatus(requireState(ctx), ref, "blocked", { note: rest.join(" "), autoAdvance: true });
        commit(ctx, next);
        notify(ctx, summaryLine(next), "warning");
      } catch (error: any) { notify(ctx, error?.message || String(error), "warning"); }
    },
  });

  pi.registerCommand("roadmap-skip", {
    description: "Skip a roadmap item: /roadmap-skip <item> [reason]",
    handler: async (args: string, ctx: any) => {
      try {
        const [ref, ...rest] = String(args || "").trim().split(/\s+/).filter(Boolean);
        if (!ref) return notify(ctx, "Usage: /roadmap-skip <item> [reason]", "warning");
        const next = setStatus(requireState(ctx), ref, "skipped", { note: rest.join(" "), autoAdvance: true });
        commit(ctx, next);
        notify(ctx, summaryLine(next), "info");
      } catch (error: any) { notify(ctx, error?.message || String(error), "warning"); }
    },
  });

  pi.registerCommand("roadmap-close", {
    description: "Close a roadmap that has no actionable work without deleting unresolved history",
    handler: async (args: string, ctx: any) => {
      try { const next = setRoadmapLifecycle(requireState(ctx), "closed", { reason: String(args || "").trim() || undefined }); commit(ctx, next); notify(ctx, summaryLine(next), "info"); }
      catch (error: any) { notify(ctx, error?.message || String(error), "warning"); }
    },
  });

  pi.registerCommand("roadmap-shelve", {
    description: "Shelve the current roadmap without deleting it",
    handler: async (args: string, ctx: any) => {
      try { const next = setRoadmapLifecycle(requireState(ctx), "shelved", { reason: String(args || "").trim() || undefined }); commit(ctx, next); notify(ctx, summaryLine(next), "warning"); }
      catch (error: any) { notify(ctx, error?.message || String(error), "warning"); }
    },
  });

  pi.registerCommand("roadmap-resume", {
    description: "Resume a closed or shelved roadmap",
    handler: async (_args: string, ctx: any) => {
      try { const next = setRoadmapLifecycle(requireState(ctx), "active"); commit(ctx, next); notify(ctx, summaryLine(next), "info"); }
      catch (error: any) { notify(ctx, error?.message || String(error), "warning"); }
    },
  });

  pi.registerCommand("roadmap-archive", {
    description: "Archive and detach the current roadmap without deleting its history",
    handler: async (args: string, ctx: any) => {
      try { const current = requireState(ctx); const archived = archiveRoadmapPacket(ctx.cwd, current, String(args || "").trim() || "manual-archive"); commit(ctx, null, { archive: false }); notify(ctx, `Archived roadmap ${archived.roadmapId}.`, "info"); }
      catch (error: any) { notify(ctx, error?.message || String(error), "warning"); }
    },
  });

  pi.registerCommand("roadmap-link", {
    description: "Link a roadmap item to reasoning artifacts/evidence: /roadmap-link <item> [artifact-id] [--evidence=id] [--artifact=id]",
    handler: async (args: string, ctx: any) => {
      try {
        const parts = stripKnownFlags(args || "").split(/\s+/).filter(Boolean);
        const ref = parts[0];
        const artifactId = parseFlag(args, "artifact") || parts[1];
        const evidenceId = parseFlag(args, "evidence") || parts[2];
        if (!ref || (!artifactId && !evidenceId)) return notify(ctx, "Usage: /roadmap-link <item> [artifact-id] [--evidence=id]", "warning");
        const next = linkItem(requireState(ctx), ref, { artifactId, evidenceId, note: parseNote(args), validateEvidenceId: validateEvidenceId(ctx) });
        commit(ctx, next);
        notify(ctx, `Linked ${ref}.\n${summaryLine(next)}`, "info");
      } catch (error: any) { notify(ctx, error?.message || String(error), "warning"); }
    },
  });

  pi.registerCommand("roadmap-next", {
    description: "Show the active/next roadmap item",
    handler: async (_args: string, ctx: any) => {
      const current = ensureLoaded(ctx);
      const progress = getProgress(current);
      if (!current || !progress.active) return notify(ctx, "No active roadmap item.", "warning");
      const item = findItem(current, progress.active.id);
      const activePath = progress.activePath?.at(-1)?.path?.join(".");
      notify(ctx, item ? `Next: ${item.title}\nID: ${item.id}${activePath ? `\nPath: #${activePath}` : ""}\nStatus: ${item.status}` : "No active roadmap item.", "info");
    },
  });

  function importReasoningRoadmap(ctx: any) {
    const result = importFromReasoning(ctx.cwd);
    if (!result.imported) {
      notify(ctx, `${result.reason}\nLooked in: ${result.file}`, "warning");
      return;
    }
    const current = ensureLoaded(ctx);
    const next = startRoadmap(current, result.roadmap.title, result.roadmap.items, {
      source: result.roadmap.source,
      sourceArtifactId: result.roadmap.sourceArtifactId,
    });
    const nested = Boolean(current && current.id === next.id);
    commit(ctx, next);
    notify(ctx, `${nested ? "Nested" : "Imported"} ${result.artifactType} ${result.artifactId}\n${summaryLine(next)}`, "info");
  }

  pi.registerCommand("roadmap-import-reasoning", {
    description: "Seed a root or nested subtask roadmap from the latest reasoning plan/decomposition artifact",
    handler: async (_args: string, ctx: any) => importReasoningRoadmap(ctx),
  });

  pi.registerCommand("roadmap-from-reasoning", {
    description: "Alias for /roadmap-import-reasoning",
    handler: async (_args: string, ctx: any) => importReasoningRoadmap(ctx),
  });

  pi.registerCommand("roadmap-report", {
    description: "Show claim-consistency and exact-version aggregate roadmap evidence",
    handler: async (_args: string, ctx: any) => {
      const current = ensureLoaded(ctx);
      const report = createRoadmapFieldReport({ events: readRoadmapTelemetry(ctx.cwd), excludeSessionToken: sessionToken, cohortVersion });
      notify(ctx, JSON.stringify({ roadmap: finalReportSummary(current), field: report }, null, 2), report.decision === "ship" ? "info" : "warning");
    },
  });

  pi.registerCommand("roadmap-export", {
    description: "Show a bounded roadmap page and durable JSON path: --focus=id --offset=n --limit=n",
    handler: async (args: string, ctx: any) => {
      const current = ensureLoaded(ctx);
      if (!current) return notify(ctx, "No active roadmap to export.", "warning");
      const page = roadmapPage(current, { focusId: parseFlag(args, "focus"), offset: Number(parseFlag(args, "offset") || 0), limit: Number(parseFlag(args, "limit") || 100) });
      notify(ctx, `Roadmap JSON: ${stateFile(ctx.cwd)}\n\n${page.text}`, "info");
    },
  });

  pi.registerCommand("roadmap-clear", {
    description: "Clear the active roadmap JSON state and widget",
    handler: async (_args: string, ctx: any) => {
      commit(ctx, null);
      notify(ctx, "Cleared active roadmap.", "info");
    },
  });

  pi.registerTool({
    name: "roadmap_update",
    label: "Roadmap",
    description: "Proactively track substantive multi-step work in the visible recursive roadmap, independently of topology routing. Executable plans may provide milestones so each phase becomes a root task and its goals become a nested subtask roadmap. Resume the canonical root for continuations; only genuinely new helper work nests. Report root required outcomes separately from recursive workflow counts; use replace only for an explicitly new root plan.",
    promptSnippet: "Proactively track substantive multi-step work in the visible recursive roadmap; map executable plan milestones to tasks and milestone goals to nested subtask roadmaps.",
    promptGuidelines: [
      ROADMAP_USAGE_GUIDELINE,
      ROADMAP_PROGRESS_GUIDELINE,
      ROADMAP_BATCH_GUIDELINE,
      "Roadmaps are bound to the session that owns them, so concurrent sessions in one directory keep independent plans. When no roadmap is active, action=show lists earlier roadmaps in the directory and action=adopt roadmapId=<id> continues one instead of starting a duplicate.",
      "Before executing a genuinely new plan, call start or explicitly authorized replace with milestones; each phase/milestone must be a roadmap task and each milestone's goals must be items in its nested subtask roadmap. A continuation or compaction is not a new plan: show the canonical root and resume existing item IDs with active/resume. Keep permanent tracking at milestone/goal depth; ordinary inspect/build/test steps belong in notes and evidence, not another implementation wrapper.",
      "Report stable root required outcomes completed/total and blocked outcomes separately from recursive workflow counts. Only an explicit scope decision changes the outcome inventory. A passing phase is progress, not completion of the parent plan; continue dependency-ready authorized outcomes.",
      "Use roadmap_update action=add_subtask for temporary workflows such as committing or verification only when separately tracked, close the helper after reporting its evidence, and resume the parent item without completing it; provide parentId when active scope is absent or ambiguous, and never use action=replace unless the user explicitly wants the full roadmap discarded.",
      "Use verified only with current evidenceId; use allowUnsubstantiated only for an explicit override, which is reported separately and is not substantiated proof.",
      "Ordinary mutations return compact deltas. Use show/export with focusId, offset, and limit for bounded full rendering; use close/shelve/resume/archive for lifecycle decisions.",
    ],
    parameters: Type.Object({
      action: StringEnum(ACTION_VALUES),
      title: Type.Optional(Type.String({ description: "Roadmap title for start/replace/add_subtask, or item title for add" })),
      items: Type.Optional(Type.Array(Type.String({ description: "Initial flat roadmap items for action=start/replace/add_subtask" }))),
      milestones: Type.Optional(Type.Array(MILESTONE_SCHEMA, { minItems: 1, maxItems: 20, description: "Executable plan hierarchy: milestones become tasks and goals become nested roadmap items" })),
      itemId: Type.Optional(Type.String({ description: "Recursive item id or numeric path such as 2.1.3" })),
      itemIds: Type.Optional(Type.Array(Type.String({ description: "Item id or numeric path" }), { minItems: 1, maxItems: 50, description: "Several items to update in one call (set_status, link); combined with itemId when both are given" })),
      cascade: Type.Optional(Type.Boolean({ description: "With set_status: also mark pending/active nested descendants of each target in the same call, deepest first" })),
      parentId: Type.Optional(Type.String({ description: "Parent item id/path for a nested subtask roadmap; defaults to the active leaf item" })),
      roadmapId: Type.Optional(Type.String({ description: "Target roadmap id/path for add or lifecycle operations" })),
      status: Type.Optional(StringEnum(STATUS_VALUES)),
      note: Type.Optional(Type.String()),
      artifactId: Type.Optional(Type.String({ description: "Reasoning artifact id to link" })),
      evidenceId: Type.Optional(Type.String({ description: "Current verifier evidence id to bind to the item fingerprint" })),
      provenance: Type.Optional(StringEnum(PROVENANCE_VALUES)),
      allowUnsubstantiated: Type.Optional(Type.Boolean({ description: "Explicit override; records verified-unsubstantiated rather than proof" })),
      force: Type.Optional(Type.Boolean({ description: "Explicitly allow a lifecycle transition that otherwise requires settled scope" })),
      focusId: Type.Optional(Type.String({ description: "Item or subroadmap focus for show/export" })),
      offset: Type.Optional(Type.Number({ minimum: 0, description: "Entry offset for bounded show/export" })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200, description: "Maximum entries for bounded show/export" })),
      maxChars: Type.Optional(Type.Number({ minimum: 500, maximum: 20000, description: "Hard show/export character bound" })),
    }),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const action = params.action || "show";
      try {
        ensureLoaded(ctx);
        if (action === "show" || action === "export") {
          const page = roadmapPage(state, { focusId: params.focusId, offset: params.offset, limit: params.limit, maxChars: params.maxChars });
          const candidates = state ? [] : roadmapStoreCandidates(ctx.cwd, { limit: 0 }).slice(0, 8).map((entry: any) => ({ roadmapId: entry.roadmapId, title: entry.title, sessionId: entry.sessionId, lifecycle: entry.lifecycle, outcomes: entry.outcomes, complete: entry.complete, total: entry.total, actionable: entry.actionable, settled: entry.settled, updatedAt: entry.updatedAt }));
          const listing = candidates.length ? `\n\nRoadmaps in this directory (continue one with action=adopt roadmapId=<id>):\n${candidates.map((entry: any) => `- ${entry.roadmapId} "${short(entry.title, 60)}" · ${entry.complete}/${entry.total} complete · ${entry.settled ? "settled" : `${entry.actionable} actionable`}${entry.sessionId ? ` · session ${entry.sessionId.slice(0, 8)}` : " · directory"}`).join("\n")}` : "";
          const text = (action === "export" && state ? `Roadmap JSON: ${stateFile(ctx.cwd)}\n\n${page.text}` : page.text) + listing;
          const details = { ok: true, outcome: "succeeded", operation: action, summary: finalReportSummary(state), candidates, page: { ...page, text: undefined } };
          emitRoadmapTelemetry(ctx, action, "succeeded", text, 0);
          return { content: [{ type: "text", text }], details };
        }
        if (action === "report") {
          const report = createRoadmapFieldReport({ events: readRoadmapTelemetry(ctx.cwd), excludeSessionToken: sessionToken, cohortVersion });
          const details = { ok: true, outcome: "succeeded", operation: action, roadmap: finalReportSummary(state), field: report };
          const text = JSON.stringify(details);
          emitRoadmapTelemetry(ctx, action, "succeeded", text, 0);
          return { content: [{ type: "text", text }], details };
        }

        const previous = state;
        if (action === "start") {
          if (!params.title) throw new RoadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, "roadmap_update action=start requires title");
          commit(ctx, startRoadmap(state, params.title, params.items || [], { source: params.milestones ? "planner-plan" : "manual", parentId: params.parentId, milestones: params.milestones }));
        } else if (action === "replace") {
          if (!params.title) throw new RoadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, "roadmap_update action=replace requires title");
          commit(ctx, params.milestones ? createPlanRoadmap(params.title, params.milestones, { source: "planner-plan" }) : createRoadmap(params.title, params.items || [], { source: "manual" }));
        } else if (action === "add_subtask") {
          if (!params.title) throw new RoadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, "roadmap_update action=add_subtask requires title");
          commit(ctx, addSubtaskRoadmap(requireState(ctx), params.title, params.items || [], { source: params.milestones ? "planner-plan" : "manual", parentId: params.parentId, milestones: params.milestones }));
        } else if (action === "add") {
          const titles = [params.title, ...(params.items || [])].filter(Boolean);
          if (!titles.length) throw new RoadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, "roadmap_update action=add requires title or items");
          commit(ctx, addItems(requireState(ctx), titles, { activeRoadmap: true, roadmapId: params.roadmapId, artifactId: params.artifactId, evidenceIds: params.evidenceId ? [params.evidenceId] : [], validateEvidenceId: validateEvidenceId(ctx) }));
        } else if (action === "adopt") {
          if (!params.roadmapId) throw new RoadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, "roadmap_update action=adopt requires roadmapId");
          commit(ctx, adoptRoadmap(ctx.cwd, params.roadmapId));
        } else if (action === "set_status") {
          const refs = [params.itemId, ...(params.itemIds || [])].filter(Boolean);
          if (!refs.length || !params.status) throw new RoadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, "roadmap_update action=set_status requires itemId or itemIds and status");
          commit(ctx, setStatusMany(requireState(ctx), refs, params.status, { note: params.note, artifactId: params.artifactId, evidenceId: params.evidenceId, validateEvidenceId: validateEvidenceId(ctx), provenance: params.provenance, allowUnsubstantiated: params.allowUnsubstantiated, cascade: params.cascade === true, autoAdvance: true }));
        } else if (action === "active") {
          if (!params.itemId) throw new RoadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, "roadmap_update action=active requires itemId");
          commit(ctx, setActive(requireState(ctx), params.itemId));
        } else if (action === "link") {
          const refs = [params.itemId, ...(params.itemIds || [])].filter(Boolean);
          if (!refs.length) throw new RoadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, "roadmap_update action=link requires itemId or itemIds");
          commit(ctx, linkItems(requireState(ctx), refs, { artifactId: params.artifactId, evidenceId: params.evidenceId, validateEvidenceId: validateEvidenceId(ctx), note: params.note, provenance: params.provenance }));
        } else if (action === "import_reasoning") {
          const result = importFromReasoning(ctx.cwd);
          if (!result.imported) throw new RoadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, result.reason || "No reasoning roadmap could be imported");
          commit(ctx, startRoadmap(state, result.roadmap.title, result.roadmap.items, { source: result.roadmap.source, sourceArtifactId: result.roadmap.sourceArtifactId, parentId: params.parentId }));
        } else if (["close", "shelve", "resume"].includes(action)) {
          const lifecycle = action === "close" ? "closed" : action === "shelve" ? "shelved" : "active";
          commit(ctx, setRoadmapLifecycle(requireState(ctx), lifecycle, { roadmapId: params.roadmapId, reason: params.note, force: params.force }));
        } else if (action === "archive") {
          archiveRoadmapPacket(ctx.cwd, requireState(ctx), params.note || "tool-archive");
          commit(ctx, null, { archive: false });
        } else if (action === "clear") commit(ctx, null, { reason: params.note || "tool-clear" });
        else throw new RoadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, `Unsupported roadmap operation: ${action}`);

        const mutation = roadmapMutationEnvelope(previous, state, action);
        const details = { ok: true, outcome: "succeeded", operation: action, ...mutation.envelope };
        emitRoadmapTelemetry(ctx, action, "succeeded", mutation.text, mutation.deltaChars);
        return { content: [{ type: "text", text: mutation.text }], details };
      } catch (error: any) {
        const code = Object.values(ROADMAP_ERROR_CODES).includes(error?.code) ? error.code : ROADMAP_ERROR_CODES.PERSISTENCE_FAILED;
        const outcome = code === ROADMAP_ERROR_CODES.PERSISTENCE_FAILED ? "infrastructure-failed" : "domain-negative";
        const details = { ok: false, outcome, operation: action, error: { code, message: code === ROADMAP_ERROR_CODES.PERSISTENCE_FAILED ? "Roadmap persistence failed." : error?.message || "Roadmap operation failed." } };
        const text = `roadmap ${action} failed: ${details.error.code} ${details.error.message}`;
        emitRoadmapTelemetry(ctx, action, outcome, text, 0, code);
        return { content: [{ type: "text", text }], details };
      }
    },
    renderCall(args: any, theme: any) {
      const label = args?.action ? `roadmap ${args.action}` : "roadmap";
      return new Text(theme.fg("toolTitle", theme.bold(label)), 0, 0);
    },
    renderResult(result: any, _options: any, theme: any) {
      if (result.details?.ok === false) return new Text(theme.fg("warning", `${result.details.error?.code || "ROADMAP_ERROR"}: ${result.details.error?.message || "operation failed"}`), 0, 0);
      const progress = result.details?.progress || result.details?.summary;
      if (!progress) return new Text(theme.fg("dim", "Roadmap operation complete"), 0, 0);
      const outcomes = progress.outcomes;
      const complete = progress.complete ?? progress.counts?.complete ?? outcomes?.complete ?? 0;
      const total = progress.total ?? progress.counts?.total ?? outcomes?.total ?? 0;
      const blocked = progress.blocked ?? progress.counts?.blocked ?? 0;
      const actionable = progress.actionable ?? progress.counts?.unresolvedActionable;
      // Root required outcomes are the decision denominator; workflow counts
      // include temporary helper descendants.
      const scope = outcomes && outcomes.total && outcomes.total !== total ? `${outcomes.complete}/${outcomes.total} outcomes · ${complete}/${total} workflow` : `${complete}/${total}`;
      return new Text(theme.fg("accent", `🧭 ${scope}${blocked ? ` · ${blocked} blocked` : ""}${actionable != null ? ` · ${actionable} actionable` : ""}`), 0, 0);
    },
  });
}
