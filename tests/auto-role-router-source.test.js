"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", ".pi", "extensions", "reasoning-runtime", "index.ts"), "utf8");
const routerSource = fs.readFileSync(path.join(__dirname, "..", "src", "role-router.js"), "utf8");
const containmentSource = fs.readFileSync(path.join(__dirname, "..", "src", "role-runtime-containment.js"), "utf8");
const workerCanaryTuiSmoke = fs.readFileSync(path.join(__dirname, "..", "scripts", "check-worker-shadow-canary-tui.sh"), "utf8");
const delegateTuiSmoke = fs.readFileSync(path.join(__dirname, "..", "scripts", "check-auto-role-delegate-tui.sh"), "utf8");

assert(source.includes("TOPOLOGY_AUTO_ROUTE_DEFAULT_MODE"), "auto-router has an environment-derived default mode");
assert(source.includes('process.env.PI_SUBAGENT_PARENT_ID ? "off"'), "auto-router disables itself inside subagent sidecars to avoid recursion");
assert(source.includes("resolveRoleRuntimeConfig"), "auto-router uses the tested rollout/rollback resolver");
assert(source.includes("parseAutoRouteMode(ROLE_RUNTIME_CONFIG.autoRouteMode)"), "PI_TOPOLOGY_AUTO_ROUTE is normalized by the rollout config before use");
assert(source.includes('process.env.PI_MULTI_AGENT_TOPOLOGIES_ENABLED === "1"'), "topology adapter is opt-in instead of globally enabled by default");
assert(source.includes("ROLE_RUNTIME_CONFIG"), "role runtime selection and compatibility are explicit");
assert(source.includes('const TOPOLOGY_AUTO_ROUTE_DEFAULT_TOPOLOGY'), "default auto-router topology is configurable");
assert(source.includes('src", "role-router.js'), "auto-router delegates pure classification to the tested library module");
assert(source.includes('const TOPOLOGY_AUTO_ROUTE_SUBAGENTS'), "auto-router can force topology nodes through subagents");
assert(source.includes('const TOPOLOGY_AUTO_ROUTE_COOLDOWN_MS'), "auto-router has a cooldown guard");
assert(source.includes('pi.registerCommand("auto-roles"'), "/auto-roles command is registered");
assert(source.includes('pi.registerTool({ name: "auto_role_router"'), "auto_role_router tool is registered");
assert(source.includes('const ROLE_RUNTIME_VERSION = 2'), "role runtime v2 availability is explicit");
assert(source.includes('const ROLE_CONTRACT_VERSION = "role-v2"'), "role contract v2 version is explicit");
assert(source.includes('const ROLE_RESULT_SCHEMA_VERSION = 2'), "role result schema v2 is explicit");
assert(source.includes('const ROLE_RUNTIME_V2_AVAILABLE = ROLE_RUNTIME_CONFIG.selectedVersion === 2'), "workspace-isolated role runtime availability follows the immediate version rollback switch");
assert(source.includes('inspectAutoRouteSafety'), "mutating auto-routes are inspected during containment");
assert(containmentSource.includes('AUTO_ROUTE_MUTATION_BLOCKED'), "mutating auto-routes fail closed during containment");
assert(source.includes('Use explicit /topology-run'), "containment warning points users to explicit topology execution");

for (const fn of [
  "classifyAutoRoute",
  "autoRouteTopologyForDecision",
  "autoRouteSafety",
  "startAutoRouteRun",
  "maybeHandleAutoRouteInput",
  "formatAutoRouteAdvisory",
  "workerShadowCanaryAuthorization",
  "appendWorkerShadowCanaryTelemetry",
  "cancelAutoRouteRuns",
]) assert(source.includes(`function ${fn}`), `${fn} helper exists`);

assert(source.includes('if (mode === "off") return null'), "auto-router is passive when off");
assert(source.includes('Legacy run mode maps to read-only shadow mode'), "legacy run warns and maps to shadow");
for (const mode of ["suggest", "shadow", "delegate"]) assert(source.includes(`mode === "${mode}"`) || source.includes(`"${mode}"`), `${mode} mode is implemented`);
assert(source.includes('const result = await started.promise') && source.includes('runtime.autoRouteTurnResult = compactAutoRouteTurnResult'), "delegate mode waits for automatic topology follow-through and retains its typed result");
assert(!source.includes('delegate-requires-explicit-invocation'), "ordinary delegate routing no longer stops at a prompt recommendation");
assert(source.includes('pi.on("input", async (event: any, ctx: any)'), "input hook receives ctx before using auto-router UI helpers");
assert(source.includes('shadow mode disabled in print/json mode'), "shadow mode does not spawn background work in print/json prompts");
assert(!source.includes('return { action: "handled" }'), "auto-router must not swallow typed prompts");
assert(source.includes('read-only shadow'), "shadow mode is explicitly constrained to read-only work");
assert(source.includes('normal assistant turn continues'), "read-only shadow work preserves the normal assistant turn");
assert(source.includes('executionMode: "subagent"'), "auto-router can create subagent-backed topology nodes");
assert(source.includes('handlerOnlyRoles'), "auto-router avoids forcing handler-only roles into subagent sidecars");
assert(source.includes('formatAutoRouteAdvisory(runtime, prompt)'), "router mode injects advisory context for the normal model turn");
assert(source.includes('[L2:auto-router] Role topology delegation') && source.includes('Automatic follow-through completed') && source.includes('<delegated_role_result>'), "delegate mode injects the completed typed topology result into the parent turn");
assert(source.includes('Mutating roles work only in isolated worktrees') && source.includes('parent patch application remains an explicit reviewed action'), "delegate guidance preserves isolated mutation and explicit parent application");
assert(source.includes('patchApplication: "explicit"') && source.includes('parentPatchApplied: false'), "typed delegation context cannot imply that an isolated patch reached the parent workspace");
assert(source.includes('AUTO_ROUTE_PARENT_RESULT_MAX_CHARS = 12000') && source.includes('boundedAutoRouteValue') && source.includes('omittedRoleResults'), "the typed parent result has a deterministic global size bound");
assert(source.includes("topologies?.roadmapHandoffs?.(result)") && source.includes("requiresParentFollowThrough"), "the compact delegated result preserves exact parent roadmap follow-through metadata through the integration boundary");
assert(source.includes("Do not start a duplicate roadmap") && source.includes("before the final response"), "delegated parent guidance requires updates to the existing roadmap binding");
assert(source.includes('safeWorkerRecommendations: ROLE_RUNTIME_CONFIG.effectiveStage === "R0"'), "worker recommendations are contained to R0");
assert(source.includes('rt.boundary.topologies.recommendRole(decision.recommendedRoleId)'), "worker inference recommendations resolve through the integration boundary");
assert(source.includes('[L2:auto-router] Safe worker recommendation'), "safe worker tasks receive a distinct recommendation");
assert(source.includes('ROLE_RUNTIME_CONFIG.workerShadowCanaryEnabled === true'), "worker shadow execution requires the resolved enabled-by-default harness flag");
assert(source.includes('authorizeWorkerShadowCanary(decision'), "worker shadow execution passes the pure authorization gate");
assert(source.includes('workerShadowTopology: buildWorkerShadowCanaryTopology()'), "worker shadow execution uses the tested runtime-only topology builder");
assert(source.includes('ROLE_RUNTIME_CONFIG.fieldPilotEnabled'), "worker shadow execution remains inside the read-only field pilot");
assert(source.includes('ROLE_MUTATION_MODE === "off"') && source.includes('mutationPolicy === "forbidden"'), "worker shadow execution remains mutation-forbidden");
assert(source.includes('workerShadowCanaryScopeSafe(decision?.task)'), "execution safety rechecks sensitive paths and positional extraction after authorization");
assert(routerSource.includes('metadata: { explicitOnly: true, autoRoutePolicy: "never", publishCapable: false, workerShadowCanary: true }'), "runtime-only worker topology cannot enter generic routing");
assert(source.includes('Worker shadow result (separate from parent answer)'), "worker result is displayed separately from the parent answer");
assert(source.includes('auto-router.worker-shadow'), "worker canary records compact dedicated telemetry");
for (const field of ["classified", "matched", "execute", "automaticExecutionAllowed", "workerShadowCanary"]) assert(routerSource.includes(`${field}:`), `compact router decisions preserve the ${field} execution fact`);
assert(source.includes('summary: workerShadowCanary ? null') && source.includes('resultHash: workerShadowCanary ? sha256(rendered)'), "worker canary result telemetry stores a hash rather than duplicating result text");
assert(workerCanaryTuiSmoke.includes("PI_ROLE_WORKER_SHADOW_CANARY=1") && workerCanaryTuiSmoke.includes("PI_SUBAGENT_EXECUTION_FIXTURE_RESULT"), "worker canary TUI smoke exercises the guarded automatic path without a live child provider");
assert(workerCanaryTuiSmoke.includes("PI_MULTI_AGENT_TOPOLOGIES_ENABLED=1"), "worker canary TUI smoke explicitly enables its topology adapter instead of inheriting the enclosing agent's opt-out");
assert(workerCanaryTuiSmoke.includes('action: "handled"') && workerCanaryTuiSmoke.includes("unexpectedly started the independent parent provider turn"), "worker canary TUI smoke suppresses the independent parent provider turn only after the router input hook runs");
assert(workerCanaryTuiSmoke.includes("topology=auto-worker-shadow-canary status=succeeded"), "worker canary TUI smoke requires an end-to-end successful automatic topology");
assert(delegateTuiSmoke.includes("PI_MULTI_AGENT_TOPOLOGIES_ENABLED=1") && delegateTuiSmoke.includes("PI_TOPOLOGY_AUTO_ROUTE=delegate") && delegateTuiSmoke.includes("PI_ROLE_ROLLOUT_STAGE=R5") && delegateTuiSmoke.includes("PI_ROLE_MUTATION=isolated"), "delegate TUI smoke explicitly enables the guarded automatic R5 path");
assert(delegateTuiSmoke.includes("<delegated_role_result>") && delegateTuiSmoke.includes('"parentPatchApplied":false') && delegateTuiSmoke.includes("ctx.abort()"), "delegate TUI smoke proves typed parent injection and stops before a real provider request");
assert(delegateTuiSmoke.includes("PI_CODING_AGENT_DIR='$state_root/agent'"), "delegate TUI smoke isolates credentials and user model configuration in its disposable state root");
assert(delegateTuiSmoke.includes("--model anthropic/claude-sonnet-4-5 --api-key pi-auto-role-delegate-fixture"), "delegate TUI smoke uses a pinned native serializer and non-persistent dummy key instead of resolving user OAuth before the sentinel");
assert(delegateTuiSmoke.includes("pi --offline --no-approve"), "delegate TUI smoke disables automatic networking and ignores project model overrides");
assert(delegateTuiSmoke.includes("PI_JEV_TURN_INTENT=off"), "delegate TUI smoke disables the independent input-hook classifier even when the parent has a live key and enabled mode");
assert(delegateTuiSmoke.includes("reviewer,verifier") && delegateTuiSmoke.includes("topology=auto-reviewer-verifier-gate status=succeeded"), "delegate TUI smoke requires successful reviewer and verifier follow-through");
assert(source.includes('/subagent-create --role ${decision.recommendedRoleId}'), "disabled canary guidance retains explicit manual fallback");
assert(source.includes('followUpCommand: next.recommendedRoleId ? "/subagent-run latest"'), "disabled canary guidance retains a separate explicit run action");
assert(source.includes('cancelAutoRouteRuns(runtime);'), "active auto routes are aborted on session shutdown");
assert(source.includes('auto_router.failed'), "auto-router failures are traced");
assert(source.includes("function autoRouteTerminalOutcome") && source.includes('return "domain-negative"') && source.includes("autoRouteTerminalOutcome(result)"), "terminal failed topology runs record a truthful canonical outcome instead of unknown");
assert(source.includes('code.startsWith("budget-")') && source.includes('return "timed-out"') && source.includes('return "infrastructure-failed"'), "failed topology telemetry distinguishes budget/timeout and provider infrastructure terminations from domain-negative results");
assert(source.includes("terminationForNode") && source.includes("e.termination?.message") && source.includes("termination=${short"), "topology warnings expose retained child termination codes and details");
assert(source.includes('auto-router.decision'), "auto-router persists compact matched and skipped decisions");
assert(source.includes('auto-router.result'), "auto-router persists compact result entries");
assert(!source.includes('sendUserMessage(`/topology-run'), "auto-router must not inject slash commands as chat follow-ups");

console.log("auto-role router source tests passed");
