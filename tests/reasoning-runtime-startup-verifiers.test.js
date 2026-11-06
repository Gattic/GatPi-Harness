"use strict";
const { tmpFixture } = require("./helpers/tmp-fixture");

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

async function checkStartup(mode) {
  const enabled = mode === "enabled";
  const normal = mode === "normal";
  process.env.PI_COGNITIVE_AUTO_VERIFY = enabled ? "1" : "0";
  process.env.PI_COGNITIVE_ORCHESTRATION_ENABLED = "0";
  const defaults = require("../src/harness-environment").readHarnessEnvironment().values;
  process.env.PI_MULTI_AGENT_TOPOLOGIES_ENABLED = normal ? defaults.PI_MULTI_AGENT_TOPOLOGIES_ENABLED : enabled ? "1" : "0";
  process.env.PI_SPECIALIST_TASKS_ENABLED = normal ? defaults.PI_SPECIALIST_TASKS_ENABLED : enabled ? "1" : "0";
  process.env.PI_TOPOLOGY_AUTO_ROUTE = defaults.PI_TOPOLOGY_AUTO_ROUTE;
  delete process.env.PI_SUBAGENT_PARENT_ID;

  const hooks = [], tools = new Map(), commands = new Map(), entries = [];
  const noop = () => {};
  const cwd = tmpFixture("pi-startup-verifiers-");
  execFileSync("git", ["init", "-q"], { cwd });
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".pi/\n");
  fs.writeFileSync(path.join(cwd, "README.md"), "Startup fixture\n");
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], { cwd });
  if (enabled) {
    fs.mkdirSync(path.join(cwd, ".pi"));
    fs.writeFileSync(path.join(cwd, ".pi", "specialist-task-policy.json"), JSON.stringify({ schemaVersion: 2, verifiers: [{ id: "elf-fixture", type: "static-elf", target: "target.elf", sha256: "0".repeat(64), roundTripSection: ".interp" }] }));
  }
  const ctx = {
    cwd, mode: "rpc", hasUI: true, isIdle: () => true,
    ui: { setStatus: noop, setWidget: noop, notify: noop, confirm: async () => false },
    sessionManager: { getBranch: () => [], getLeafId: () => "leaf", getSessionId: () => "fixture-session" },
  };
  const emit = async event => {
    for (const hook of hooks.filter(row => row.event === event)) await hook.handler({}, ctx);
  };
  let discoveryCalls = 0;
  let boundary;
  const load = Module._load;
  const previousVerifierModule = require("../src/verification-pipeline");
  const domainModules = ["specialist-runtime", "specialist-blenderai", "specialist-lean", "specialist-rea"].map(name => [name, require(`../src/${name}`)]);
  // Count discovery without making the regression depend on native providers,
  // network access or readiness caches. Keep the integration boundary real.
  Module._load = function(request, ...args) {
    const exports = load.call(this, request, ...args);
    if (request.endsWith("/src/project-intelligence.js")) {
      return { ...exports, createProjectIndex: () => {
        discoveryCalls++;
        return { verifierProfiles: [{ id: "startup-fixture", automatic: true, kind: "unit", command: "node", args: ["-e", "process.exit(0)"] }] };
      }};
    }
    if (request.endsWith("/src/integration-boundary.js")) {
      return { ...exports, createPiIntegrationBoundary: config => {
        boundary = exports.createPiIntegrationBoundary(config);
        return boundary;
      }};
    }
    return exports;
  };

  try {
    const piRoot = fs.realpathSync(path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works", "pi-coding-agent"));
    const runtimePackage = (name, workspace) => {
      const installed = path.join(piRoot, "node_modules", "@earendil-works", name);
      return fs.realpathSync(fs.existsSync(path.join(installed, "package.json")) ? installed : path.resolve(piRoot, "..", workspace));
    };
    const jitiModule = require(require.resolve("jiti", { paths: [piRoot] }));
    const extensionFile = path.resolve(".pi/extensions/reasoning-runtime/index.ts");
    const aiRoot = runtimePackage("pi-ai", "ai");
    const jiti = (jitiModule.createJiti || jitiModule)(extensionFile, {
      interopDefault: true,
      alias: {
        typebox: require.resolve("typebox", { paths: [piRoot] }),
        "@earendil-works/pi-coding-agent": piRoot,
        "@earendil-works/pi-ai/compat": path.join(aiRoot, "dist", "compat.js"),
        "@earendil-works/pi-ai": aiRoot,
        "@earendil-works/pi-tui": runtimePackage("pi-tui", "tui"),
        "@earendil-works/pi-agent-core": runtimePackage("pi-agent-core", "agent"),
      },
    });
    const mod = await jiti.import(extensionFile);
    (mod.default || mod)({
      on: (event, handler) => hooks.push({ event, handler }),
      registerCommand: (name, command) => commands.set(name, command), registerTool: tool => tools.set(tool.name, tool), registerShortcut: noop, registerMessageRenderer: noop,
      getCommands: () => [], getAllTools: () => [], getActiveTools: () => [], setActiveTools: noop,
      events: { on: noop, off: noop, emit: noop },
      appendEntry: (customType, data) => entries.push({ customType, data }), sendMessage: noop, sendUserMessage: noop, setSessionName: noop,
    });
    await emit("session_start");
    assert.notStrictEqual(require("../src/verification-pipeline"), previousVerifierModule, "boundary-owned reload refreshes executable verification implementation");
    for (const [name, previous] of domainModules) assert.notStrictEqual(require(`../src/${name}`), previous, `boundary-owned reload refreshes ${name}`);
    assert.equal(discoveryCalls, enabled ? 1 : 0, "automatic verifier discovery must match the enabled policy");
    assert.equal(boundary.verification.enabled, enabled);
    assert.deepEqual(boundary.verification.pipeline.graph.verifiers.map(row => row.id), enabled ? ["startup-fixture"] : []);
    assert.equal(boundary.tasks.enabled, enabled || normal, "missing optional checker configuration does not disable normal-session tasks");
    assert.equal(boundary.topologies.enabled, enabled || normal, "manual topology availability is separate from task policy readiness");
    const taskTool = tools.get("specialist_tasks");
    assert(taskTool, "task controls are boundary-backed and discoverable");
    if (enabled || normal) {
      const planning = (await taskTool.execute("fixture", { operation: "context" }, undefined, undefined, ctx)).details;
      assert.equal(planning.enabled, true);
      assert.equal(planning.topologiesEnabled, true);
      assert.match(planning.baseline.baseRevision, /^[a-f0-9]{40}$/);
      assert.match(planning.baseline.baselineFingerprint, /^sha256:[a-f0-9]{64}$/);
      assert.deepEqual(planning.execution, {
        taskBudgets: false, model: "inherit", thinkingLevel: "inherit", humanFeedback: "non-blocking",
        assetRefinement: { critic: "3d-critic", maxAttempts: 3, requiresImageInput: true },
        assetAcceptance: { modes: ["critic", "measured"], default: "critic", measured: { field: "acceptanceMode", requiresMeasuredChecker: true, reviewer: "independent-review" } },
      });
      assert.equal(planning.accounting, undefined);
      assert.match(planning.roles.find(role => role.roleId === "coder").revision, /^sha256:[a-f0-9]{64}$/);
      assert.equal(planning.verifiers[0].id, enabled ? "elf-fixture" : "dossier");
      assert.equal(planning.authorization, "preflight-required; application-is-a-separate-parent-action");
      if (normal) {
        const { validateToolArguments } = await jiti.import(path.join(aiRoot, "dist", "utils", "validation.js"));
        await checkSpecialistGraphArguments(taskTool, planning, ctx, validateToolArguments);
      }
      planning.execution.model = "tampered";
      const freshPlanning = (await taskTool.execute("fixture", { operation: "context" }, undefined, undefined, ctx)).details;
      assert.equal(freshPlanning.execution.model, "inherit", "returned context cannot mutate policy");
      fs.appendFileSync(path.join(cwd, "README.md"), "Changed fixture baseline\n");
      assert.notEqual((await taskTool.execute("fixture", { operation: "context" }, undefined, undefined, ctx)).details.baseline.baselineFingerprint, planning.baseline.baselineFingerprint, "context is current, not a cached launch identity");
      if (enabled) assert.equal(boundary.tasks.service.verifiers.get("elf-fixture").configuration.roundTripSection, ".interp", "pinned ELF configuration reaches the trusted checker");
      const request = { operation: "feedback", runId: "fixture-run", taskId: "fixture-task", artifactDigest: `sha256:${"0".repeat(64)}`, text: "Visual iteration feedback" };
      const received = [];
      boundary.tasks.service.feedback = async input => { received.push(input); return { recorded: true }; };
      boundary.tasks.service.apply = async input => { received.push(input); return { applied: true }; };
      ctx.hasUI = false;
      assert.equal((await taskTool.execute("fixture", request, undefined, undefined, ctx)).details.recorded, true);
      assert.equal((await taskTool.execute("fixture", { ...request, operation: "apply" }, undefined, undefined, ctx)).details.applied, true);
      assert.equal(received[1].explicit, true, "application is the explicit parent tool action, not a UI dialog");
      ctx.hasUI = true;
      assert.equal(boundary.tasks.metrics().runs, 0, "startup and planning never create task runs");
      assert.equal(boundary.tasks.metrics().providerReportedCost, null, "an unmeasured cohort is not a zero-cost result");
    } else {
      assert.equal((await taskTool.execute("fixture", { operation: "preflight", graph: {} }, undefined, undefined, ctx)).details.allowed, false);
      const planning = (await taskTool.execute("fixture", { operation: "context" }, undefined, undefined, ctx)).details;
      assert.equal(planning.enabled, false);
      assert.equal(planning.reason, "specialist-tasks-disabled");
      assert.equal((await taskTool.execute("fixture", { operation: "run", graph: {} }, undefined, undefined, ctx)).details.enabled, false, "explicit rollback never launches a task");
      assert.equal(fs.existsSync(path.join(cwd, ".pi", "specialist-task-policy.json")), false, "startup never installs an approved policy");
    }
    assert.equal(boundary.subagents.listSubagents({ parentSessionId: "fixture-session" }).length, 0, "startup and planning context never spawn workers");
    assert.equal((await tools.get("auto_role_router").execute("fixture", { operation: "status" }, undefined, undefined, ctx)).details.mode, "off");
    if (!enabled) await checkSdkCommands({ commands, tools, entries, ctx });
  } finally {
    try {
      await emit("session_shutdown");
    } finally {
      Module._load = load;
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
  console.log(`startup verifier policy ${mode} passed`);
}

async function checkSpecialistGraphArguments(tool, planning, ctx, validateToolArguments) {
  const role = planning.roles.find(item => item.roleId === "reliability-investigator");
  const graph = {
    schemaVersion: 2, graphId: "schema-regression", concurrency: 1,
    context: { id: "context", baselineFingerprint: planning.baseline.baselineFingerprint, requirementIds: ["R1"], sources: ["README.md"], assumptions: [], conventions: [], testEntryPoints: [], exclusions: [] },
    tasks: [{ taskId: "inspect", requirementIds: ["R1"], roleId: role.roleId, contractRevision: role.revision, objective: "Inspect the fixture without execution or mutation.", exclusions: [], taskKind: "analysis", dependsOn: [], readZones: ["README.md"], writeZones: [], resources: [], ...planning.baseline, contextPacketId: "context", domainInput: {}, acceptanceCriteria: [{ id: "structure", kind: "executable", verifierId: "dossier", expected: "passed", required: true }] }],
  };
  const request = { operation: "preflight", graph };
  const call = arguments_ => ({ type: "toolCall", id: "graph-schema", name: tool.name, arguments: arguments_ });
  // Exercise the SDK boundary, including the JSON schema actually shown to providers.
  for (const parameters of [tool.parameters, JSON.parse(JSON.stringify(tool.parameters))]) {
    const definition = { ...tool, parameters };
    for (const malformed of [JSON.stringify(graph), [], true, 42]) {
      assert.throws(() => validateToolArguments(definition, call({ ...request, graph: malformed })), /Validation failed[\s\S]*graph/, "serialized graphs and other non-objects must fail SDK validation, not reach TASK_GRAPH_INVALID");
    }
    assert.equal(parameters.properties.graph.type, "object", "providers must see an object argument, not unconstrained Type.Any");
    assert.equal(parameters.properties.graph.additionalProperties, true, "provider strict-schema conversion must not close the graph to an empty object");
    assert.deepEqual(validateToolArguments(definition, call(request)), request, "nested graph fields survive validation unchanged");
    assert.deepEqual(validateToolArguments(definition, call({ operation: "context" })), { operation: "context" }, "graph remains optional for discovery");
  }
  const validated = validateToolArguments(tool, call(request));
  const result = await tool.execute("graph-schema", validated, undefined, undefined, { ...ctx, model: { provider: "fixture", id: "parent" }, thinkingLevel: "low" });
  assert.match(result.details.graphDigest, /^sha256:[a-f0-9]{64}$/, "valid objects reach the real boundary-backed preflight; its public result exposes a digest, not the graph");
  const invalidVersion = validateToolArguments(tool, call({ ...request, graph: { ...graph, schemaVersion: 1 } }));
  await assert.rejects(tool.execute("graph-schema", invalidVersion, undefined, undefined, { ...ctx, model: { provider: "fixture", id: "parent" }, thinkingLevel: "low" }), /TASK_GRAPH_VERSION_INVALID/, "the object schema must not bypass semantic graph validation");
  console.log("Specialist graph SDK argument regression passed (no provider or worker launch)");
}

async function checkSdkCommands({ commands, tools, entries, ctx }) {
  const execute = (name, params) => tools.get(name).execute("fixture", params, undefined, undefined, ctx);
  const subagents = await execute("create_subagent", { operation: "list" });
  assert.deepEqual(subagents.content, [{ type: "text", text: JSON.stringify(subagents.details, null, 2) }]);
  assert.deepEqual(subagents.details.subagents, []);
  const blocked = await execute("skill_synthesis", { operation: "approve", skillId: "fixture" });
  assert.equal(blocked.details.reasonCode, "explicit-skill-governance-intent-required");
  assert.deepEqual(blocked.content, [{ type: "text", text: blocked.details.message }]);
  const skills = await execute("skill_synthesis", { operation: "list" });
  assert.equal(skills.content[0].type, "text");
  assert(Array.isArray(JSON.parse(skills.content[0].text)));
  assert(Object.hasOwn(skills, "details"), "content-only replies still satisfy the SDK-required details field");
  assert.equal(skills.details, undefined);
  assert.equal((await execute("auto_role_router", { operation: "status" })).details.mode, "off");
  assert.equal((await execute("auto_role_router", { operation: "setMode", mode: "off" })).details.mode, "off");
  assert.equal(entries.findLast(entry => entry.customType === "auto-router.state").data.mode, "off");

  const notices = [], calls = [];
  ctx.ui.notify = message => notices.push(message);
  ctx.model = { provider: "fixture", id: "ask-model" };
  const ask = async response => {
    const settled = Promise.withResolvers();
    ctx.ui.setStatus = (key, label) => { if (key === "ask" && label === undefined) settled.resolve(); };
    // Only the completion boundary is faked: no credentials, network, or provider spend.
    ctx.modelRegistry = { complete: async (...args) => {
      calls.push(args);
      if (response instanceof Error) throw response;
      return response;
    } };
    await commands.get("ask").handler("What changed?", ctx);
    await settled.promise;
    await commands.get("ask-status").handler("", ctx);
    return notices.at(-1).split("\n\n---\n\n")[0];
  };
  const success = await ask({ stopReason: "stop", content: [{ type: "text", text: "Fixture answer" }] });
  assert.match(success, /succeeded/);
  assert.match(success, /A: Fixture answer/);
  assert.equal(calls.length, 1, "ask uses the session model registry, not the removed standalone SDK export");
  assert.strictEqual(calls[0][0], ctx.model);
  assert.match(calls[0][1].systemPrompt, /read-only transcript snapshot/);
  assert.match(calls[0][1].messages[0].content[0].text, /What changed\?/);
  assert.equal(calls[0].length, 2, "request-time authentication belongs to the configured registry");
  assert.match(await ask({ stopReason: "error", errorMessage: "fixture auth unavailable", content: [] }), /failed[\s\S]*fixture auth unavailable/);
  assert.match(await ask(new Error("fixture transport unavailable")), /failed[\s\S]*fixture transport unavailable/);
  assert.match(await ask({ stopReason: "aborted", content: [] }), /failed/);

  let key = "q", panelCalls = 0;
  ctx.ui.custom = (factory, options) => new Promise(resolve => {
    panelCalls++;
    assert.equal(options.overlay, true);
    const component = factory({ requestRender() {} }, {}, {}, resolve);
    component.handleInput(key);
  });
  await commands.get("ask-panel").handler("", ctx);
  assert.equal(panelCalls, 1, "close resolves the custom UI interaction");
  key = "f";
  await commands.get("ask-panel").handler("", ctx);
  assert.match(notices.at(-1), /requires command context/, "shortcuts cannot replace the parent session");
  let forked = 0;
  ctx.newSession = async () => { forked++; };
  await commands.get("ask-panel").handler("", ctx);
  assert.equal(forked, 1, "command contexts retain the explicit fork action");
  key = "c";
  await commands.get("ask-panel").handler("", ctx);
  await commands.get("ask-status").handler("", ctx);
  assert.equal(notices.at(-1), "No ask runs yet.");
  assert.equal(panelCalls, 4, "clear closes rather than reopening the panel");
  assert.equal((await execute("auto_role_router", { operation: "status" })).details.mode, "off");
  console.log("SDK command regression cases passed (provider-free, routing off)");
}

if (process.argv[2] === "case") {
  checkStartup(process.argv[3]).catch(error => { console.error(error); process.exitCode = 1; });
} else {
  // AUTO_VERIFY is read when the extension is loaded, so each case needs a fresh process.
  for (const mode of ["disabled", "enabled", "normal"]) {
    const result = spawnSync(process.execPath, [__filename, "case", mode], { encoding: "utf8", timeout: 30000, maxBuffer: 128 * 1024 });
    assert.equal(result.status, 0, `${mode}: ${result.error || result.stderr || result.stdout}`);
    assert(result.stdout.includes(`startup verifier policy ${mode} passed`), `${mode}: async checks must reach completion`);
    process.stdout.write(result.stdout);
  }
}
