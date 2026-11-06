import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const {
  createSemgrepAdapter,
  parseCliArgs,
} = require(join(LIB_ROOT, "src", "semgrep-adapter.js"));
const { notify } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

// Env knobs are parsed in src/semgrep-adapter.js: process.env.PI_SEMGREP process.env.PI_SEMGREP_BIN process.env.PI_SEMGREP_CONFIG process.env.PI_SEMGREP_TIMEOUT_MS process.env.PI_SEMGREP_MAX_BUFFER process.env.PI_SEMGREP_MAX_LINES process.env.PI_SEMGREP_MAX_BYTES process.env.PI_SEMGREP_ALLOW_OUTSIDE process.env.PI_SEMGREP_ADVISORY process.env.PI_SEMGREP_ADVISORY_TIMEOUT_MS process.env.PI_SEMGREP_METRICS process.env.PI_SEMGREP_CONFIG_PROBE_TIMEOUT_MS process.env.PI_SEMGREP_CONFIG_READY_TTL_MS process.env.PI_SEMGREP_CONFIG_FAILURE_TTL_MS process.env.PI_SEMGREP_MAX_FINDINGS
const adapter = createSemgrepAdapter();
const ENABLED = adapter.config.enabled;

type ToolContext = { cwd: string; ui?: any };

const PathField = Type.Optional(Type.String({ description: "Project path. Defaults to the current Pi working directory. By default this must stay inside cwd; set PI_SEMGREP_ALLOW_OUTSIDE=1 to override." }));
const TimeoutField = Type.Optional(Type.Number({ description: "Command timeout in milliseconds." }));
const ConfigField = Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Semgrep config(s), e.g. p/default, p/security-audit, or a local rules file. Defaults to PI_SEMGREP_CONFIG or p/default. Config auto is rejected while metrics are off." }));
const FilesField = Type.Optional(Type.Array(Type.String(), { description: "Files or directories to scan. For semgrep_codegraph, defaults to changed files; for semgrep_scan, defaults to the project root." }));
const SeverityField = Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Severity filter(s), e.g. ERROR, WARNING, INFO." }));
const GlobField = Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())]));
const VerboseField = Type.Optional(Type.Boolean({ description: "Return the raw scan payload instead of the bounded finding view." }));
const BudgetField = Type.Optional(Type.Number({ description: "Token budget for the model-facing finding view." }));

async function notifyResult(ctx: any, promise: Promise<any>) {
  try {
    const result = await promise;
    const text = result.content?.[0]?.text || JSON.stringify(result.details, null, 2);
    notify(ctx, text, "info");
  } catch (e: any) {
    notify(ctx, String(e?.message || e), "error");
  }
}

export default function semgrepExtension(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  if (!ENABLED) return;

  pi.registerCommand("semgrep-status", { description: "Show Semgrep availability and adapter status", handler: async (args: string, ctx: any) => notifyResult(ctx, adapter.status(ctx, { path: args.trim() || undefined })) });
  pi.registerCommand("semgrep-scan", { description: "Run Semgrep scan: /semgrep-scan [--config c] [--severity s] [files...]", handler: async (args: string, ctx: any) => { const parsed = parseCliArgs(args); await notifyResult(ctx, adapter.scan(ctx, { ...parsed.opts, files: parsed.positional })); } });
  pi.registerCommand("semgrep-changed", { description: "Scan changed files and enrich findings with CodeGraph affected-test hints", handler: async (args: string, ctx: any) => { const parsed = parseCliArgs(args); const files = parsed.positional.length ? parsed.positional : adapter.gitChangedFiles(ctx.cwd); await notifyResult(ctx, adapter.codegraph(ctx, { ...parsed.opts, files })); } });
  pi.registerCommand("semgrep-codegraph", { description: "Combine Semgrep findings with CodeGraph affected-test hints", handler: async (args: string, ctx: any) => { const parsed = parseCliArgs(args); await notifyResult(ctx, adapter.codegraph(ctx, { ...parsed.opts, files: parsed.positional })); } });
  pi.registerCommand("semgrep-doctor", { description: "Diagnose Semgrep binary, config, env knobs, and CodeGraph supplement path", handler: async (args: string, ctx: any) => { const parsed = parseCliArgs(args); await notifyResult(ctx, adapter.doctor(ctx, { ...parsed.opts, path: parsed.opts.path || parsed.positional[0] })); } });

  pi.registerTool({
    name: "semgrep_status",
    label: "Semgrep status",
    description: "Show Semgrep availability, version, env knobs, and adapter readiness.",
    promptSnippet: "Show Semgrep static-analysis adapter status",
    parameters: Type.Object({ path: PathField, timeoutMs: TimeoutField }),
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _update: any, ctx: ToolContext) { return adapter.status(ctx, params || {}); },
  });

  pi.registerTool({
    name: "semgrep_scan",
    label: "Semgrep scan",
    description: "Run Semgrep static analysis over selected files or the current project. Returns a bounded finding view with severity and rule counts plus readiness; verbose=true returns the raw payload.",
    promptSnippet: "Run Semgrep static analysis for security/correctness findings",
    promptGuidelines: ["Use a focused Semgrep scan at security-sensitive verification checkpoints, not after every edit. gitverify and Verification Center perform risk-triggered checks; inspect that result instead of duplicating the scan.", "For an explicit scan outside those checkpoints, pass focused files; use semgrep_codegraph if you also need affected-test hints."],
    parameters: Type.Object({ path: PathField, files: FilesField, config: ConfigField, configs: ConfigField, severity: SeverityField, include: GlobField, exclude: GlobField, errorOnFindings: Type.Optional(Type.Boolean({ description: "Pass --error so findings make Semgrep exit non-zero." })), scanTimeoutSec: Type.Optional(Type.Number({ description: "Semgrep per-file timeout in seconds." })), verbose: VerboseField, budgetTokens: BudgetField, timeoutMs: TimeoutField }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: ToolContext) { return adapter.scan(ctx, params || {}, signal); },
  });

  pi.registerTool({
    name: "semgrep_codegraph",
    label: "Semgrep + CodeGraph advisory",
    description: "Combine Semgrep findings with CodeGraph affected-test hints. Returns a bounded finding view plus advisory test hints; verbose=true returns the raw payload.",
    promptSnippet: "Scan changed files with Semgrep and map finding files to likely tests with CodeGraph",
    promptGuidelines: ["Use semgrep_codegraph for one combined security scan and impact lookup when a checkpoint has not already provided it; do not repeat codegraph_affected for the same files.", "Treat findings and graph test hints as advisory, not proof of safety or exhaustive coverage. Keep baseline verification; report missing providers explicitly."],
    parameters: Type.Object({ path: PathField, files: FilesField, scanAll: Type.Optional(Type.Boolean({ description: "Scan the whole project instead of defaulting to changed files." })), config: ConfigField, configs: ConfigField, severity: SeverityField, include: GlobField, exclude: GlobField, depth: Type.Optional(Type.Number({ description: "CodeGraph dependency traversal depth; default 5." })), codegraphTimeoutMs: Type.Optional(Type.Number({ description: "Timeout for the CodeGraph affected-test supplement." })), verbose: VerboseField, budgetTokens: BudgetField, timeoutMs: TimeoutField }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: ToolContext) { return adapter.codegraph(ctx, params || {}, signal); },
  });

  pi.registerTool({
    name: "semgrep_doctor",
    label: "Semgrep doctor",
    description: "Diagnose Semgrep binary and config readiness separately, including Docker-wrapper health, env knobs, and CodeGraph degradation guidance.",
    promptSnippet: "Diagnose Semgrep integration health",
    parameters: Type.Object({ path: PathField, timeoutMs: TimeoutField }),
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _update: any, ctx: ToolContext) { return adapter.doctor(ctx, params || {}); },
  });
}
