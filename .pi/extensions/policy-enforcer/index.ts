import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { FileApprovalStore, enforceToolCall, evaluateToolCall, formatEnforcementDecision } = require(join(LIB_ROOT, "src", "policy-enforcement.js"));
const { DEFAULT_ALLOW_TOOLS, DEFAULT_DENY_PATH_PREFIXES, evaluatePolicy, serializablePolicy } = require(join(LIB_ROOT, "src", "runtime-policy.js"));
const { readJson, writeJson } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

// policy-gate was merged into this extension: gate surfaces are advisory
// policy checks over src/runtime-policy.js, enforcer surfaces actively gate
// tool calls through src/policy-enforcement.js. The env gates stay
// independent so existing configurations keep working.
const ENABLED = process.env.PI_POLICY_ENFORCER !== "0";
const GATE_ENABLED = process.env.PI_POLICY_GATE !== "0";
const GATE_STATE_DIR = ".pi/policy-gate";
let MODE = process.env.PI_POLICY_ENFORCER_MODE || "block"; // advisory | warn | block | approval

function gatePolicy(cwd: string) { return readJson(join(cwd, GATE_STATE_DIR, "policy.json"), {}); }
function gateCheck(cwd: string, input: any) { return evaluatePolicy(input, { cwd, policy: gatePolicy(cwd) }); }
function saveGateCheck(cwd: string, d: any) { const file = join(cwd, GATE_STATE_DIR, "checks.jsonl"); mkdirSync(dirname(file), { recursive: true }); require("node:fs").appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...d })}\n`); }
function formatGateCheck(d: any) { return `${String(d.severity).toUpperCase()} ok=${d.ok}\n${(d.reasons || []).map((r: string) => `- ${r}`).join("\n")}`; }
function updateGateList(cwd: string, kind: "allow" | "deny", value: string) { const file = join(cwd, GATE_STATE_DIR, "policy.json"); const current = readJson(file, {}); const key = kind === "allow" ? "allowTools" : "denyPathPrefixes"; const defaults = kind === "allow" ? DEFAULT_ALLOW_TOOLS : DEFAULT_DENY_PATH_PREFIXES; current[key] = [...new Set([...(current[key] || defaults || []), value].filter(Boolean))]; writeJson(file, current); return { file, policy: serializablePolicy(current) }; }
function ensureGatePolicy(cwd: string) { const file = join(cwd, GATE_STATE_DIR, "policy.json"); if (!existsSync(file)) writeJson(file, { allowTools: DEFAULT_ALLOW_TOOLS, denyPathPrefixes: DEFAULT_DENY_PATH_PREFIXES, requireApprovalFor: ["package-install", "outside-repo-write", "secret-bearing-trace", "unapproved-skill", "unsafe-topology"] }); return file; }

function registerPolicyGate(pi: ExtensionAPI) {
  if (!GATE_ENABLED) return;
  pi.registerCommand("policy-status", { description: "Show policy gate status", handler: async (_args: string, ctx: any) => ctx.ui.notify(JSON.stringify({ enabled: GATE_ENABLED, policy: serializablePolicy(gatePolicy(ctx.cwd)), stateDir: join(ctx.cwd, GATE_STATE_DIR) }, null, 2), "info") });
  pi.registerCommand("policy-check", { description: "Check a command/path/tool against local safety policy", handler: async (args: string, ctx: any) => { const d = gateCheck(ctx.cwd, args || ""); saveGateCheck(ctx.cwd, d); ctx.ui.notify(formatGateCheck(d), d.ok ? d.severity === "warn" ? "warning" : "info" : "warning"); } });
  pi.registerCommand("policy-denylist", { description: "Add denied path prefix: /policy-denylist <path>", handler: async (args: string, ctx: any) => ctx.ui.notify(JSON.stringify(updateGateList(ctx.cwd, "deny", String(args || "").trim()), null, 2), "warning") });
  pi.registerCommand("policy-allowlist", { description: "Add allowed tool: /policy-allowlist <tool>", handler: async (args: string, ctx: any) => ctx.ui.notify(JSON.stringify(updateGateList(ctx.cwd, "allow", String(args || "").trim()), null, 2), "info") });
  pi.registerCommand("policy-simulate", { description: "Simulate policy checks for common risky operations", handler: async (_args: string, ctx: any) => { const samples = ["rm -rf .", "npm install left-pad", { kind: "write", path: "../outside.txt" }, { tool: "unknown_tool" }].map((x) => gateCheck(ctx.cwd, x)); ctx.ui.notify(JSON.stringify(samples, null, 2), "warning"); } });
  pi.registerCommand("policy-enforce", { description: "Write default local policy file", handler: async (_args: string, ctx: any) => ctx.ui.notify(`Policy file ready: ${ensureGatePolicy(ctx.cwd)}`, "info") });
  pi.registerTool({ name: "policy_gate", label: "Policy gate", description: "Evaluate commands, paths, tools, and automation requests against a centralized local safety policy.", parameters: Type.Object({ operation: Type.Optional(Type.Union([Type.Literal("status"), Type.Literal("check"), Type.Literal("simulate"), Type.Literal("enforce"), Type.Literal("policy")])), input: Type.Optional(Type.Any()) }), async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) { const op = params.operation || "check"; let details: any; if (op === "status" || op === "policy") details = { enabled: GATE_ENABLED, policy: serializablePolicy(gatePolicy(ctx.cwd)) }; else if (op === "simulate") details = ["rm -rf .", "sudo make install", { kind: "write", path: "../x" }].map((x) => gateCheck(ctx.cwd, x)); else if (op === "enforce") details = { file: ensureGatePolicy(ctx.cwd) }; else { details = gateCheck(ctx.cwd, params.input); saveGateCheck(ctx.cwd, details); } return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details }; } });
}

function store(ctx: any) { return new FileApprovalStore({ cwd: ctx.cwd }); }
function activeToolPolicy(pi: ExtensionAPI, cwd: string) {
  const tools = (pi.getAllTools?.() || []).map((tool: any) => tool.name).filter(Boolean);
  return { ...gatePolicy(cwd), ...(tools.length ? { allowTools: [...new Set(tools)] } : {}) };
}
function parseTtl(args = "") {
  const m = String(args).match(/--ttl=(\d+)([smhd])?/);
  if (!m) return 24 * 60 * 60 * 1000;
  const n = Number(m[1]);
  const unit = m[2] || "h";
  return n * (unit === "s" ? 1000 : unit === "m" ? 60000 : unit === "d" ? 86400000 : 3600000);
}
function approveFromInput(input: any = {}, ctx: any, reason = "policy_enforcer tool", ttlMs?: number) {
  const key = input.key || input.approvalKey;
  const request = input.request || (input.toolName ? { tool: input.toolName, ...(input.input || {}) } : undefined);
  if (!key && !request) {
    return { ok: false, error: "approve requires input.request, input.toolName/input, or input.key/approvalKey" };
  }
  return store(ctx).approve(request || { approvedByKey: key }, { reason, ttlMs, ...(key ? { key } : {}) });
}

export default function policyEnforcer(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  registerPolicyGate(pi);
  if (!ENABLED) return;

  pi.on("tool_call" as any, async (event: any, ctx: any) => {
    const decision = enforceToolCall(event.toolName, event.input || {}, {
      cwd: ctx.cwd,
      mode: MODE,
      approvalStore: store(ctx),
      policy: activeToolPolicy(pi, ctx.cwd),
    });
    if (decision.action === "warn") ctx.ui.notify(formatEnforcementDecision(decision), "warning");
    if (decision.allow) return;
    if (ctx.hasUI && decision.action === "approval-required") {
      const ok = await ctx.ui.confirm("Policy approval required", `${formatEnforcementDecision(decision)}\n\nAllow once for 24h?`, { timeout: 15000 });
      if (ok) {
        for (const item of decision.missingApprovals || []) store(ctx).approve(item.request, { reason: "interactive approval" });
        return;
      }
    }
    return { block: true, reason: formatEnforcementDecision(decision) };
  });

  pi.registerCommand("policy-enforcer-status", {
    description: "Show active policy enforcement status",
    handler: async (_args: string, ctx: any) => ctx.ui.notify(JSON.stringify({
      enabled: ENABLED,
      mode: MODE,
      activeAllowTools: activeToolPolicy(pi, ctx.cwd).allowTools || [],
      approvals: store(ctx).list(),
      stateFile: store(ctx).file,
    }, null, 2), "info"),
  });

  pi.registerCommand("policy-mode", {
    description: "Set policy enforcer mode: advisory|warn|block|approval",
    handler: async (args: string, ctx: any) => {
      const next = String(args || "").trim();
      if (["advisory", "warn", "block", "approval"].includes(next)) MODE = next;
      ctx.ui.notify(`policy enforcer mode=${MODE}`, "info");
    },
  });

  pi.registerCommand("policy-approvals", {
    description: "List active policy approval grants",
    handler: async (_args: string, ctx: any) => ctx.ui.notify(JSON.stringify(store(ctx).list({ includeExpired: true }), null, 2), "info"),
  });

  pi.registerCommand("policy-approve", {
    description: "Approve a request for a tool call: /policy-approve <tool> <json-input> [--ttl=24h], or /policy-approve <approval_key>",
    handler: async (args: string, ctx: any) => {
      const raw = String(args || "").trim();
      const ttlMs = parseTtl(raw);
      const withoutTtl = raw.replace(/--ttl=\d+[smhd]?/, "").trim();
      const keyOnly = withoutTtl.match(/^(approval_[a-f0-9]+)$/i);
      if (keyOnly) {
        const approval = approveFromInput({ key: keyOnly[1] }, ctx, "manual /policy-approve", ttlMs);
        return ctx.ui.notify(JSON.stringify({ approval }, null, 2), "warning");
      }

      const [tool, ...rest] = withoutTtl.split(/\s+/);
      let input: any = {};
      try { input = JSON.parse(rest.join(" ") || "{}"); } catch { input = { command: rest.join(" ") }; }
      const evaluated = evaluateToolCall(tool, input, { cwd: ctx.cwd });
      const approvals = evaluated.evaluations.map((e: any) => store(ctx).approve(e.request, { reason: "manual /policy-approve", ttlMs }));
      ctx.ui.notify(JSON.stringify({ tool, input, approvals }, null, 2), "warning");
    },
  });

  pi.registerCommand("policy-approve-directory", {
    description: "Permanently allow recursive writes from this project: /policy-approve-directory <directory>",
    handler: async (args: string, ctx: any) => {
      const raw = String(args || "").trim();
      const directory = raw.startsWith('"') ? JSON.parse(raw)
        : raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
      const approval = store(ctx).approveDirectory(directory, {
        reason: "manual /policy-approve-directory",
        policy: activeToolPolicy(pi, ctx.cwd),
      });
      ctx.ui.notify(JSON.stringify({ approval, stateFile: store(ctx).file }, null, 2), "info");
    },
  });

  pi.registerCommand("policy-revoke", {
    description: "Revoke a policy approval by key",
    handler: async (args: string, ctx: any) => ctx.ui.notify(JSON.stringify(store(ctx).revoke(String(args || "").trim()), null, 2), "warning"),
  });

  pi.registerTool({
    name: "policy_enforcer",
    label: "Policy enforcer",
    description: "Inspect or manage active tool-call policy enforcement and approval grants.",
    parameters: Type.Object({
      operation: Type.Optional(Type.Union([
        Type.Literal("status"),
        Type.Literal("inspect"),
        Type.Literal("check"),
        Type.Literal("approve"),
        Type.Literal("grant"),
        Type.Literal("request"),
        Type.Literal("revoke"),
        Type.Literal("mode"),
      ])),
      input: Type.Optional(Type.Any()),
    }),
    async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
      const op = params.operation || "status";
      const normalizedOp = op === "inspect" ? "status" : (op === "grant" || op === "request") ? "approve" : op;
      let details: any;
      if (normalizedOp === "check") {
        details = enforceToolCall(params.input?.toolName, params.input?.input || {}, {
          cwd: ctx.cwd,
          mode: params.input?.mode || MODE,
          approvalStore: store(ctx),
          policy: activeToolPolicy(pi, ctx.cwd),
        });
      } else if (normalizedOp === "approve") {
        details = approveFromInput(params.input || {}, ctx);
      } else if (normalizedOp === "revoke") {
        details = store(ctx).revoke(params.input?.key);
      } else if (normalizedOp === "mode") {
        if (params.input?.mode) MODE = params.input.mode;
        details = { mode: MODE };
      } else {
        details = {
          enabled: ENABLED,
          mode: MODE,
          activeAllowTools: activeToolPolicy(pi, ctx.cwd).allowTools || [],
          approvals: store(ctx).list(),
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });
}
