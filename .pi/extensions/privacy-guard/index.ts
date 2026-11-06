import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { chmodSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ENABLED = process.env.PI_PRIVACY_GUARD !== "0";
const STATE_DIR = ".pi/privacy-guard";
const { PrivacyGuardScanAdapter } = require("../../../src/integration-boundary.js");
const privacyGuardScan = new PrivacyGuardScanAdapter();
const SECRET_PATTERNS: { name: string; severity: string; runtimeOnly?: boolean; description?: string }[] = privacyGuardScan.patterns();
const scan = (cwd: string, roots?: string[], options?: any) => privacyGuardScan.scan(cwd, roots, options);
const reviewCandidate = (handle: string) => privacyGuardScan.review(handle);

function policy() { return { durableMemory: "summaries only; no secrets or full transcripts", projectIsolation: "automatic scans are repo-local", hermesAuthority: "typed advisory only; no transcripts, durable conversation state, or canonical mutation", tracePayloads: process.env.PI_TRACE_CAPTURE_PAYLOADS ?? "default", falsePositiveHandling: "Source/docs matches for transcript vocabulary are ignored by default; use includeIgnored/includeSource for audits.", recommendations: ["Use PI_TRACE_CAPTURE_PAYLOADS=0 for metadata-only traces when sharing", "Run /privacy-scan before exports", "Never store .env, keys, full transcripts, or sensitive local paths in memory"] }; }
function writeJson(file: string, data: any) { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); try { chmodSync(dirname(file), 0o700); } catch {} writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 }); try { chmodSync(file, 0o600); } catch {} }
function purgePreview(cwd: string) { return { preview: true, candidates: [join(cwd, ".pi", "runtime-doctor"), join(cwd, ".pi", "ast-refactor"), join(cwd, ".pi", "verification-center")].filter(existsSync), note: "No deletion is performed by privacy-guard. Use repo cleanup scripts or manual rm after reviewing exports." }; }
function parseScanArgs(args = "") { return { includeIgnored: /--include-ignored/.test(args), includeSource: /--include-source/.test(args) }; }
function displayScan(result: any, cwd: string) {
  const compact = { ...result, roots: result.roots.map((r: string) => relative(cwd, r).startsWith("..") ? r : relative(cwd, r) || ".") };
  return JSON.stringify(compact, null, 2);
}

export default function privacyGuard(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi, { extension: "privacy-guard", outcomePolicies: { privacy_guard: { scan: "domain-negative" } } }) as ExtensionAPI;
  if (!ENABLED) return;
  pi.registerCommand("privacy-status", { description: "Show privacy guard policy/status", handler: async (_args: string, ctx: any) => ctx.ui.notify(JSON.stringify({ policy: policy(), last: existsSync(join(ctx.cwd, STATE_DIR, "latest-scan.json")) }, null, 2), "info") });
  pi.registerCommand("privacy-scan", { description: "Scan runtime state for likely secrets/transcripts; flags: --include-ignored --include-source", handler: async (args: string, ctx: any) => { const result = scan(ctx.cwd, undefined, parseScanArgs(args)); writeJson(join(ctx.cwd, STATE_DIR, "latest-scan.json"), result); ctx.ui.notify(displayScan(result, ctx.cwd), result.ok ? "info" : "warning"); } });
  pi.registerCommand("privacy-trace-audit", { description: "Audit trace privacy knobs", handler: async (_args: string, ctx: any) => ctx.ui.notify(JSON.stringify({ traceDir: process.env.PI_TRACE_DIR || join(ctx.cwd, ".pi", "traces"), capturePayloads: process.env.PI_TRACE_CAPTURE_PAYLOADS ?? "default", recommendation: "Set PI_TRACE_CAPTURE_PAYLOADS=0 before collecting shareable traces." }, null, 2), "info") });
  pi.registerCommand("privacy-memory-audit", { description: "Audit project-local cognitive memory paths", handler: async (args: string, ctx: any) => { const options = parseScanArgs(args); const roots = [join(ctx.cwd, ".pi", "cognitive-automation"), join(ctx.cwd, ".pi", "project-memory")]; ctx.ui.notify(displayScan(scan(ctx.cwd, roots, options), ctx.cwd), "info"); } });
  pi.registerCommand("privacy-redaction-test", { description: "Show built-in redaction pattern metadata", handler: async (_args: string, ctx: any) => ctx.ui.notify(JSON.stringify(SECRET_PATTERNS.map((p) => ({ name: p.name, severity: p.severity, runtimeOnly: Boolean(p.runtimeOnly), description: p.description })), null, 2), "info") });
  pi.registerCommand("privacy-review", { description: "Resolve an in-process redacted candidate handle to a local file/line without showing the matched value", handler: async (args: string, ctx: any) => { const handle = String(args || "").trim(); const row = reviewCandidate(handle); ctx.ui.notify(row ? `Local candidate ${handle}: ${row.file}${row.line ? `:${row.line}` : ""} (${row.pattern}). Inspect locally; no value was persisted or displayed.` : `Unknown or expired privacy review handle: ${handle}`, row ? "warning" : "info"); } });
  pi.registerCommand("privacy-policy", { description: "Show privacy policy", handler: async (_args: string, ctx: any) => ctx.ui.notify(JSON.stringify(policy(), null, 2), "info") });
  pi.registerCommand("privacy-purge", { description: "Preview purge candidates; does not delete", handler: async (_args: string, ctx: any) => ctx.ui.notify(JSON.stringify(purgePreview(ctx.cwd), null, 2), "warning") });
  pi.registerTool({ name: "privacy_guard", label: "Privacy guard", description: "Audit local runtime state for likely secrets, full-transcript hints, risky settings, and explicit scan coverage.", parameters: Type.Object({ operation: Type.Optional(Type.Union([Type.Literal("status"), Type.Literal("scan"), Type.Literal("policy"), Type.Literal("purgePreview")])), input: Type.Optional(Type.Any()) }), async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) { const op = params.operation || "status"; const options = params.input || {}; const details = op === "scan" ? scan(ctx.cwd, options.roots, { includeIgnored: Boolean(options.includeIgnored), includeSource: Boolean(options.includeSource), sessionRoot: options.sessionRoot, rawSessionPermissions: Boolean(options.rawSessionPermissions), maxFiles: options.maxFiles, maxBytes: options.maxBytes, deadlineMs: options.deadlineMs }) : op === "policy" ? policy() : op === "purgePreview" ? purgePreview(ctx.cwd) : { policy: policy() }; return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details }; } });
}
