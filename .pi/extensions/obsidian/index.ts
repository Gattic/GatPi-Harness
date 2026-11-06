import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const {
  createObsidianAdapter,
  parseCliArgs,
  formatSize,
} = require(join(LIB_ROOT, "src", "obsidian-adapter.js"));
const { createContextInjector } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));
const { eventText, classifyObsidianIntent, judgedObsidianIntent, obsidianAutomaticContextPolicy } = require(join(LIB_ROOT, "src", "obsidian-intent.js"));
const { turnJudgmentModes } = require(join(LIB_ROOT, "src", "typesafe-turn-judgment.js"));
const JEV_INTENT_ON = turnJudgmentModes(process.env).modes.intent === "on";
const { createExtensionTelemetry } = require(join(LIB_ROOT, "src", "extension-telemetry.js"));
const { createPiIntegrationBoundary, projectMemoryRuntimeConfig, HermesAdvisoryAdapter } = require(join(LIB_ROOT, "src", "integration-boundary.js"));

// Obsidian configuration is parsed in src/obsidian-adapter.js. Hermes uses only the shared PI_HERMES_* advisory settings.
const hermesAdapters = new Map<string, any>();
function hermesFor(cwd: string) { let value = hermesAdapters.get(cwd); if (!value) { value = new HermesAdvisoryAdapter({ cwd, authority: { canonicalPromotionAllowed: false, automaticMutationAllowed: false } }); hermesAdapters.set(cwd, value); } return value; }
const adapter = createObsidianAdapter({ hermesAdapterFactory: (ctx: any) => hermesFor(ctx.cwd), projectMemoryFactory: (ctx: any, input: any) => projectMemoryFor(ctx.cwd, input) });
const ENABLED = adapter.config.enabled;
const OUTPUT_MAX_LINES = adapter.config.outputMaxLines;
const OUTPUT_MAX_BYTES = adapter.config.outputMaxBytes;
const AUTO_AWARE = process.env.PI_OBSIDIAN_AUTO_AWARE !== "0";
const AUTO_STATUS = process.env.PI_OBSIDIAN_AUTO_STATUS !== "0";

type ToolContext = { cwd: string; ui?: any; hasUI?: boolean };

const VaultField = Type.Optional(Type.String({ description: "Obsidian vault path. Defaults to PI_OBSIDIAN_VAULT, an existing detected vault, or ~/Obsidian/Pi Research." }));
const FolderField = Type.Optional(Type.String({ description: "Vault folder for written notes, e.g. Inbox or Research/<project>." }));
const TagsField = Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Obsidian tags to add. Strings may be comma-separated." }));
const SourcesField = Type.Optional(Type.Array(Type.String(), { description: "Research/docs source directories or files to import. Defaults to PI_OBSIDIAN_RESEARCH_ROOTS or local research/ and docs/." }));
const TimeoutField = Type.Optional(Type.Number({ description: "Strict Hermes probe/curation timeout in milliseconds." }));

function explicitHermesCurationIntent(value: unknown): boolean { return /\bhermes\b/i.test(String(value || "")) && /\b(obsidian|curat(?:e|ion)|memory|note|vault|review|doctor|probe)\b/i.test(String(value || "")); }

function outputText(result: any): string {
  return result?.content?.[0]?.text || JSON.stringify(result?.details ?? result, null, 2);
}

function projectMemoryFor(cwd: string, input: any = {}) { const runtime = projectMemoryRuntimeConfig(cwd, process.env, { vault: input?.vault }); const boundary = createPiIntegrationBoundary({ enabled: true, projectMemory: runtime.adapter, memoryState: { enabled: false }, memory: { enabled: false }, context: { enabled: false } }); return { adapter: boundary.projectMemory, rollout: runtime.rollout, selection: runtime.selection, readiness: runtime.readiness }; }
async function unifiedStatus(ctx: any, params: any = {}, doctor = false, signal?: AbortSignal) {
  const result = doctor ? await adapter.doctor(ctx, params, signal) : await adapter.status(ctx, params);
  const runtime = projectMemoryRuntimeConfig(ctx.cwd, process.env, { vault: params?.vault });
  result.details.selection = runtime.selection;
  result.details.projectMemoryRollout = runtime.rollout;
  const hermesStatus = hermesFor(ctx.cwd).status();
  result.details.authority = { providerReady: hermesStatus.providerReady, advisoryDraftAllowed: hermesStatus.advisoryDraftAllowed, reviewQueueSubmissionAllowed: Boolean(runtime.rollout.controls.hermesCuration), canonicalPromotionAllowed: false, automaticMutationAllowed: false };
  result.details.readiness = { ...(result.details.readiness || {}), ...runtime.readiness, hermesCuration: { ready: Boolean(result.details.curationReady && runtime.rollout.controls.hermesCuration), status: runtime.rollout.controls.hermesCuration ? (result.details.curationReady ? "ready" : "provider-proof-required") : "rollout-disabled" } };
  return result;
}

async function show(ctx: any, key: string, promise: Promise<any>) {
  try {
    const result = await promise;
    const text = outputText(result);
    if (ctx.hasUI) {
      ctx.ui.setWidget(key, text.split("\n"));
      ctx.ui.notify(`${key} complete`, "info");
    } else {
      console.log(text);
    }
  } catch (e: any) {
    const message = String(e?.message || e);
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    else console.error(message);
  }
}

function parseNoteArgs(args: string) {
  const idx = args.indexOf("::");
  if (idx < 0) return null;
  const title = args.slice(0, idx).trim();
  const body = args.slice(idx + 2).trim();
  if (!title || !body) return null;
  return { title, body };
}

const OBSIDIAN_AWARENESS_PROMPT = [
  "Obsidian research-memory tools are available when the Obsidian extension is loaded: obsidian_status, obsidian_search, obsidian_note, obsidian_import, obsidian_hermes, and obsidian_doctor.",
  "Automatically consider Obsidian for research, notes, memory, vault, durable context, or literature/research-management requests; call obsidian_status if vault readiness is unclear.",
  "Prefer obsidian_search before broad filesystem reads when relevant research/memory notes may already be in the vault; obsidian_hermes only drafts unverified candidates and never owns canonical memory.",
  "Never store secrets, credentials, full transcripts, or large raw logs in Obsidian notes.",
].join("\n");

export default function obsidianExtension(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  if (!ENABLED) return;

  let awarenessStatusInjected = false;
  let currentHermesIntent = false;
  const awarenessInjection = createContextInjector({ customType: "obsidian-awareness", maxChars: process.env.PI_OBSIDIAN_AWARENESS_INJECT_MAX_CHARS });

  pi.on("session_start" as any, () => { awarenessStatusInjected = false; currentHermesIntent = false; awarenessInjection.reset(); });
  // Published by reasoning-runtime, which starts one TypeSafe request per turn
  // at input; results are keyed by the full prompt text.
  let typesafe: any = null;
  pi.events.on("typesafe:service", (service: any) => { typesafe = service; });
  const judgedResearchMemory = async (text: string) => {
    const pending = typesafe?.turnFor?.(text);
    const result = pending ? await pending : null;
    return result?.ok ? result.decision.intent.researchMemory : null;
  };
  pi.on("before_agent_start" as any, async (event: any, ctx: any) => {
    const inputText = eventText(event);
    currentHermesIntent = explicitHermesCurationIntent(inputText);
    if (!AUTO_AWARE && !AUTO_STATUS) return;
    const intent = JEV_INTENT_ON ? judgedObsidianIntent(await judgedResearchMemory(String(event.prompt || ""))) : classifyObsidianIntent(inputText);
    createExtensionTelemetry({ cwd: ctx.cwd, extension: "obsidian", version: JEV_INTENT_ON ? "obsidian-intent-typesafe-v1" : "obsidian-intent-v1" }).opportunity("research-vault-intent", intent.eligible ? "eligible" : "ineligible", intent.eligible, "unknown", "not-applicable", ctx.hasUI ? "interactive" : "headless-smoke");
    const policy = obsidianAutomaticContextPolicy(intent, { autoAware: AUTO_AWARE, autoStatus: AUTO_STATUS, statusInjected: awarenessStatusInjected });
    if (!policy.eligible) return;
    const promptUpdate = policy.injectAwareness ? { systemPrompt: `${event.systemPrompt}\n\n${OBSIDIAN_AWARENESS_PROMPT}` } : {};
    if (!policy.probeStatus) return policy.injectAwareness ? promptUpdate : undefined;
    awarenessStatusInjected = true;
    try {
      const status = await adapter.status(ctx, {});
      return {
        ...promptUpdate,
        ...awarenessInjection.inject(`Automatic Obsidian research-memory status probe:\nIntent category: ${intent.category}; confidence=${intent.confidence}\n\n${outputText(status)}`, { details: { ...status.details, intentCategory: intent.category, intentConfidence: intent.confidence } }),
      };
    } catch (e: any) {
      return {
        ...promptUpdate,
        ...awarenessInjection.inject(`Automatic Obsidian research-memory status probe failed: ${String(e?.message || e)}\n\nThe model should still know the obsidian_* tools exist and may call obsidian_doctor for diagnostics.`),
      };
    }
  });

  pi.on("agent_end" as any, () => { currentHermesIntent = false; });

  pi.registerCommand("obsidian-status", {
    description: "Show Obsidian vault/binary/Hermes advisory readiness",
    handler: async (args: string, ctx: any) => {
      const parsed = parseCliArgs(args);
      await show(ctx, "obsidian-status", unifiedStatus(ctx, { ...parsed.opts, vault: parsed.opts.vault || parsed.positional[0] }));
    },
  });

  pi.registerCommand("obsidian-doctor", {
    description: "Diagnose layered vault/desktop/Hermes readiness; optionally --probe-auth or --probe-curation",
    handler: async (args: string, ctx: any) => {
      const parsed = parseCliArgs(args);
      await show(ctx, "obsidian-doctor", unifiedStatus(ctx, { ...parsed.opts, vault: parsed.opts.vault || parsed.positional[0] }, true));
    },
  });

  pi.registerCommand("obsidian-search", {
    description: "Search Markdown notes in the managed Obsidian vault: /obsidian-search <query>",
    handler: async (args: string, ctx: any) => {
      const parsed = parseCliArgs(args);
      const query = parsed.positional.join(" ");
      if (!query) return ctx.hasUI ? ctx.ui.notify("Usage: /obsidian-search <query>", "warning") : console.error("Usage: /obsidian-search <query>");
      await show(ctx, "obsidian-search", adapter.search(ctx, { ...parsed.opts, query }));
    },
  });

  pi.registerCommand("obsidian-note", {
    description: "Write/append a note: /obsidian-note <title> :: <markdown body>",
    handler: async (args: string, ctx: any) => {
      const parsed = parseCliArgs(args);
      const note = parseNoteArgs(parsed.positional.join(" "));
      if (!note) return ctx.hasUI ? ctx.ui.notify("Usage: /obsidian-note <title> :: <markdown body>", "warning") : console.error("Usage: /obsidian-note <title> :: <markdown body>");
      await show(ctx, "obsidian-note", adapter.note(ctx, { ...parsed.opts, ...note }));
    },
  });

  pi.registerCommand("obsidian-import", {
    description: "Preview/apply research docs import into Obsidian: /obsidian-import [--apply] [--include-code] [paths...]",
    handler: async (args: string, ctx: any) => {
      const parsed = parseCliArgs(args);
      await show(ctx, "obsidian-import", adapter.importResearch(ctx, { ...parsed.opts, sources: parsed.positional, dryRun: parsed.opts.dryRun ?? true }));
    },
  });

  pi.registerCommand("obsidian-hermes", {
    description: "Dry-run or explicitly submit Hermes project-memory candidates: /obsidian-hermes [--apply] <topic>",
    handler: async (args: string, ctx: any) => {
      const parsed = parseCliArgs(args);
      const topic = parsed.opts.topic || parsed.positional.join(" ") || "research memory";
      const dryRun = parsed.opts.dryRun ?? true;
      await show(ctx, "obsidian-hermes", adapter.hermes(ctx, { ...parsed.opts, topic, dryRun, userAuthorized: dryRun === false }));
    },
  });

  pi.registerCommand("obsidian-hermes-review", {
    description: "Record a receipt-bound governed curation outcome without promoting memory: /obsidian-hermes-review <receipt-id> <accept|reject|correct>",
    handler: async (args: string, ctx: any) => {
      const [receiptId, decision, ...extra] = String(args || "").trim().split(/\s+/).filter(Boolean);
      if (!receiptId || !decision || extra.length || !["accept", "reject", "correct"].includes(decision.toLowerCase())) return ctx.hasUI ? ctx.ui.notify("Usage: /obsidian-hermes-review <receipt-id> <accept|reject|correct>", "warning") : console.error("Usage: /obsidian-hermes-review <receipt-id> <accept|reject|correct>");
      await show(ctx, "obsidian-hermes-review", adapter.reviewHermesCuration(ctx, { receiptId, decision, userAuthorized: true, sessionHash: ctx.sessionManager?.getSessionId?.() }));
    },
  });

  pi.registerCommand("obsidian-project-memory-status", { description: "Show canonical Obsidian project-memory schema, revisions, and rollout state", handler: async (_args: string, ctx: any) => { const service = projectMemoryFor(ctx.cwd); await show(ctx, "obsidian-project-memory-status", Promise.resolve({ details: { status: service.adapter.status(), rollout: service.rollout }, content: [{ type: "text", text: JSON.stringify({ status: service.adapter.status(), rollout: service.rollout }, null, 2) }] })); } });

  pi.registerCommand("obsidian-project-memory-recall", { description: "Recall ranked canonical project memory locally: /obsidian-project-memory-recall <query>", handler: async (args: string, ctx: any) => { const service = projectMemoryFor(ctx.cwd); const result = service.adapter.recall(String(args || "").trim(), { limit: 5 }); await show(ctx, "obsidian-project-memory-recall", Promise.resolve({ details: result, content: [{ type: "text", text: JSON.stringify(result, null, 2) }] })); } });

  pi.registerCommand("obsidian-project-memory-compile", { description: "Preview or apply a rebuildable canonical recall cache: /obsidian-project-memory-compile [--apply]", handler: async (args: string, ctx: any) => { const service = projectMemoryFor(ctx.cwd); const apply = /--apply|--yes/.test(args || ""); const result = service.adapter.compile({ apply }); await show(ctx, "obsidian-project-memory-compile", Promise.resolve({ details: result, content: [{ type: "text", text: JSON.stringify(result, null, 2) }] })); } });

  pi.registerCommand("obsidian-open", {
    description: "Open Obsidian to the managed vault or note: /obsidian-open [note.md]",
    handler: async (args: string, ctx: any) => {
      const parsed = parseCliArgs(args);
      await show(ctx, "obsidian-open", adapter.open(ctx, { ...parsed.opts, file: parsed.positional.join(" ") || undefined }));
    },
  });

  pi.registerTool({
    name: "obsidian_status",
    label: "Obsidian status",
    description: "Show layered vault filesystem, Obsidian desktop, Hermes executable, and local curation-readiness status without an authenticated network probe.",
    promptSnippet: "Show Obsidian research-memory adapter status",
    promptGuidelines: ["Use obsidian_status before relying on Obsidian vault notes or Hermes-backed vault curation."],
    parameters: Type.Object({ vault: VaultField }),
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _update: any, ctx: ToolContext) { return unifiedStatus(ctx, params || {}); },
  });

  pi.registerTool({
    name: "obsidian_search",
    label: "Obsidian search",
    description: `Search Markdown notes in the managed Obsidian vault. Output is truncated to ${OUTPUT_MAX_LINES} lines or ${formatSize(OUTPUT_MAX_BYTES)}.`,
    promptSnippet: "Search local Obsidian research and memory notes",
    promptGuidelines: ["Use obsidian_search for research-note recall before broad filesystem reads when an Obsidian vault is available."],
    parameters: Type.Object({ query: Type.String({ description: "Search query." }), vault: VaultField, folder: FolderField, limit: Type.Optional(Type.Number({ description: "Maximum matching notes to return; default 20." })), maxFiles: Type.Optional(Type.Number({ description: "Maximum Markdown notes to scan; default PI_OBSIDIAN_MAX_FILES or 200." })) }),
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _update: any, ctx: ToolContext) { return adapter.search(ctx, params || {}); },
  });

  pi.registerTool({
    name: "obsidian_note",
    label: "Obsidian note",
    description: "Create, append, or overwrite a Markdown note in the managed Obsidian vault.",
    promptSnippet: "Write concise durable research or memory notes into Obsidian",
    promptGuidelines: ["Use obsidian_note only for concise durable notes: decisions, TODOs, stable research summaries, and memory candidates.", "Do not store secrets, credentials, full transcripts, or large raw logs in obsidian_note."],
    parameters: Type.Object({ title: Type.String({ description: "Note title." }), body: Type.String({ description: "Markdown note body." }), vault: VaultField, folder: FolderField, file: Type.Optional(Type.String({ description: "Optional explicit note path relative to the vault." })), tags: TagsField, mode: Type.Optional(StringEnum(["append", "overwrite", "create"] as const, { description: "Write mode. append is default; create adds a timestamp if the note already exists." })) }),
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _update: any, ctx: ToolContext) { return adapter.note(ctx, params || {}); },
  });

  pi.registerTool({
    name: "obsidian_import",
    label: "Obsidian import",
    description: `Preview or copy research/docs Markdown into the managed Obsidian vault. Defaults to dryRun=true. Output is truncated to ${OUTPUT_MAX_LINES} lines or ${formatSize(OUTPUT_MAX_BYTES)}.`,
    promptSnippet: "Import project research/docs artifacts into Obsidian with an index note",
    promptGuidelines: ["Use obsidian_import with dryRun=true first for large or unfamiliar research folders.", "Set obsidian_import dryRun=false only when the user explicitly wants files written into the Obsidian vault."],
    parameters: Type.Object({ sources: SourcesField, vault: VaultField, folder: FolderField, project: Type.Optional(Type.String({ description: "Research project name for the vault index/folder." })), dryRun: Type.Optional(Type.Boolean({ description: "Preview only by default. Set false to write files." })), includeCode: Type.Optional(Type.Boolean({ description: "Also import supported source/config code files as fenced Markdown notes." })), extensions: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "File extensions to include, e.g. md,txt,rst." })), maxFiles: Type.Optional(Type.Number({ description: "Maximum files to import/preview." })), maxImportFileBytes: Type.Optional(Type.Number({ description: "Skip source files larger than this byte size." })) }),
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _update: any, ctx: ToolContext) { return adapter.importResearch(ctx, params || {}); },
  });

  pi.registerTool({
    name: "obsidian_hermes",
    label: "Obsidian Hermes curation",
    description: "Ask Hermes for typed unverified project-memory candidates from scanner-approved Obsidian extracts. This model tool is always dry-run and cannot write canonical memory.",
    promptSnippet: "Preview Hermes project-memory candidates from Obsidian research notes",
    promptGuidelines: ["Use obsidian_hermes only when the user explicitly asks Hermes to curate Obsidian research/memory notes.", "Treat all candidates as unverified; only the explicit /obsidian-hermes --apply command may submit them to the governed review queue when rollout permits."],
    parameters: Type.Object({ topic: Type.Optional(Type.String({ description: "Research topic or memory focus. Defaults to research memory." })), vault: VaultField, maxFiles: Type.Optional(Type.Number({ description: "Maximum vault notes to scan for safe bounded extracts." })), timeoutMs: TimeoutField }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: ToolContext) { if (!currentHermesIntent) throw new Error("Obsidian Hermes curation requires explicit current-user Hermes intent"); return adapter.hermes(ctx, { ...(params || {}), dryRun: true, userAuthorized: false }, signal); },
  });

  pi.registerTool({
    name: "obsidian_doctor",
    label: "Obsidian doctor",
    description: "Diagnose vault filesystem, Obsidian desktop/open state, Hermes executable, authentication, provider/model, and curation readiness without exposing credentials.",
    promptSnippet: "Diagnose Obsidian/Hermes research-memory integration health",
    parameters: Type.Object({ vault: VaultField, probeAuth: Type.Optional(Type.Boolean({ description: "Run a bounded metadata-only authenticated model probe." })), probeCuration: Type.Optional(Type.Boolean({ description: "Run a bounded synthetic-input dry-run curation smoke after authentication succeeds; never reads vault bodies or writes a note." })), timeoutMs: TimeoutField }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: ToolContext) { if ((params?.probeAuth === true || params?.probeCuration === true) && !currentHermesIntent) throw new Error("Active Hermes probes require explicit current-user Hermes intent"); return unifiedStatus(ctx, params || {}, true, signal); },
  });
}
