"use strict";

const { inferOutcome, isNegativeOutcome } = require("./outcome-schema");

const CODEMODE_LIMITS = Object.freeze({ timeoutMs: 60000, maxCalls: 32, concurrency: 4, maxOutputTokens: 2000, maxSourceChars: 131072 });
const CODEMODE_OPERATIONS = Object.freeze({
  read: null, grep: null, find: null, ls: null,
  code_context: ["repoMap", "search", "symbolGet", "symbolRelations", "buildQuery", "changeImpact", "diagnostics"],
  docs_lookup: ["status", "search", "read", "package"],
  test_runner: ["status", "listProfiles", "infer"],
});
const GUIDANCE = "Harness CodeMode: only read/grep/find/ls, code_context, docs_lookup and test_runner status/listProfiles/infer are callable when eligible. ALL_TOOLS, searchTools and describeTool cover only those CodeMode-callable tools, not the session's declared tool surface; optional harness tools stay direct and activate through activate_tools or an explicit request. Shell, mutations, verification execution, approvals, delegation and supervision stay direct. models and persistent store writes are disabled. Limits: 60s, 32 calls, 4 in flight, 2000 output tokens. Nested outcomes remain authoritative even if caught or omitted from output; script completion is not verification.";

const OUTPUT_CONTRACT = "When using CodeMode, finish deterministic selection and aggregation inside the script. Return only the requested result and source paths; do not emit intermediate tool outputs or collections when the requested answer is small.";

function callableTool(tool) { return Object.hasOwn(CODEMODE_OPERATIONS, tool.name); }
function scriptTool(tool) {
  const operations = CODEMODE_OPERATIONS[tool.name];
  if (!operations) return tool;
  return { ...tool, description: `${tool.description}\nCodeMode operations: ${operations.join(", ")}.`, parameters: { ...tool.parameters, properties: { ...tool.parameters.properties, operation: { type: "string", enum: operations } } } };
}
function operationFor(name, args = {}) {
  if (name === "test_runner") return require("./test-runner").normalizeTestRunnerParams(args).operation;
  const input = { ...(args.input || {}), ...args };
  return input.operation || (name === "code_context" ? "repoMap" : name === "docs_lookup" ? "search" : "default");
}
function boundedScript(source, limits = CODEMODE_LIMITS) {
  if (typeof source !== "string" || !source.trim() || source.length > limits.maxSourceChars) throw new Error("CodeMode source is empty or exceeds its source limit");
  let code = source;
  let options = {};
  if (/^\/\/ @options:/.test(code)) {
    const end = code.indexOf("\n");
    if (end < 0) throw new Error("CodeMode options require a script");
    options = JSON.parse(code.slice("// @options:".length, end));
    if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["timeout_ms", "max_output_tokens"].includes(key))) throw new Error("Invalid CodeMode options");
    code = code.slice(end + 1);
  }
  const bounded = (key, cap) => {
    if (options[key] === undefined) return cap;
    if (!Number.isSafeInteger(options[key]) || options[key] < 1) throw new Error(`Invalid CodeMode ${key}`);
    return Math.min(options[key], cap);
  };
  const timeoutMs = bounded("timeout_ms", limits.timeoutMs);
  const maxOutputTokens = bounded("max_output_tokens", limits.maxOutputTokens);
  return { code: `// @options: ${JSON.stringify({ timeout_ms: timeoutMs, max_output_tokens: maxOutputTokens })}\n${code}`, timeoutMs };
}

function governedCodemode(definition, { enabled = true, limits = CODEMODE_LIMITS } = {}) {
  return {
    ...definition,
    defaultActive: enabled,
    exposure: enabled ? "model-only" : "hidden",
    promptGuidelines: [...(definition.promptGuidelines || []), GUIDANCE, OUTPUT_CONTRACT],
    prepareLoadout(loadout) {
      const changes = definition.prepareLoadout({ ...loadout, callable: loadout.callable.filter(callableTool).map(scriptTool) });
      changes.descriptions.codemode += `\n\n${GUIDANCE}`;
      return changes;
    },
    async execute(id, params, signal, update, ctx) {
      if (!enabled) throw new Error("CodeMode is disabled (PI_CODEMODE=0)");
      const outcomes = [];
      const controller = new AbortController();
      const runSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let requests = 0, active = 0;
      const waiting = [];
      const record = (name, operation, outcome) => outcomes.push({ tool: name, operation, outcome });
      const executeTool = async (name, args, options = {}) => {
        let operation;
        try { operation = operationFor(name, args); }
        catch { record(name, "invalid", "blocked"); controller.abort(); throw new Error("Invalid CodeMode operation"); }
        if (!Object.hasOwn(CODEMODE_OPERATIONS, name) || (CODEMODE_OPERATIONS[name] && !CODEMODE_OPERATIONS[name].includes(operation))) {
          record(name, operation, "blocked");
          controller.abort();
          throw new Error(`CodeMode operation is not allowed: ${name}.${operation}`);
        }
        if (++requests > limits.maxCalls) {
          if (!controller.signal.aborted) record(name, operation, "blocked");
          controller.abort();
          throw new Error("CodeMode nested-call limit exceeded");
        }
        if (active >= limits.concurrency) await new Promise(resolve => waiting.push(resolve));
        else active++;
        try {
          if (runSignal.aborted || options.signal?.aborted) throw new Error("CodeMode call cancelled");
          const result = await ctx.executeTool(name, args, options);
          const data = result.result.structuredContent ?? result.result.details;
          const policyBlocked = result.isError && (result.result.content || []).some(item => item.type === "text" && /^policy-enforcer (?:block|approval-required)\b/.test(item.text));
          const inferred = policyBlocked ? "blocked" : inferOutcome(data, { isError: result.isError, toolName: name, operation });
          // Structured data may survive a failed transport or a result hook.
          // It cannot override the native pipeline's error verdict.
          const outcome = result.isError && !isNegativeOutcome(inferred) ? "infrastructure-failed" : inferred;
          record(name, operation, outcome === "unknown" && !result.isError ? "succeeded" : outcome);
          return result;
        } catch (error) {
          record(name, operation, runSignal.aborted || options.signal?.aborted ? "cancelled" : "infrastructure-failed");
          throw error;
        } finally {
          const next = waiting.shift();
          if (next) next();
          else active--;
        }
      };
      const tools = ctx.tools.filter(callableTool).map(scriptTool);
      const sessionManager = new Proxy(ctx.sessionManager, { get(target, key) {
        if (key === "getBranch") return () => target.getBranch().filter(entry => entry.customType !== "codemode-store");
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      // Pi's executeTool is non-configurable. A neutral target permits the
      // facade while reads of original guarded context properties stay lazy.
      const context = new Proxy({}, { get(_target, key) {
        if (key === "tools") return tools;
        if (key === "executeTool") return executeTool;
        if (key === "sessionManager") return sessionManager;
        return Reflect.get(ctx, key, ctx);
      } });
      const bounded = boundedScript(params.code, limits);
      let expired = false;
      const deadline = setTimeout(() => { expired = true; controller.abort(); }, bounded.timeoutMs);
      let result;
      try { result = await definition.execute(id, { ...params, code: bounded.code }, runSignal, update, context); }
      finally { clearTimeout(deadline); }
      const negative = outcomes.find(row => isNegativeOutcome(row.outcome));
      const outcome = expired ? "timed-out" : negative?.outcome || (signal?.aborted ? "cancelled" : result.isError ? "infrastructure-failed" : outcomes.some(row => row.outcome === "not-applicable") ? "not-applicable" : "succeeded");
      return {
        ...result,
        isError: result.isError === true || Boolean(negative) || expired || signal?.aborted === true,
        content: [{ type: "text", text: `Harness CodeMode outcome: ${outcome}. Nested outcomes are not verification proof.` }, ...(result.content || [])],
        details: { ...result.details, outcome, nestedOutcomes: outcomes },
      };
    },
  };
}

module.exports = { CODEMODE_LIMITS, CODEMODE_OPERATIONS, GUIDANCE, OUTPUT_CONTRACT, callableTool, scriptTool, operationFor, boundedScript, governedCodemode };
