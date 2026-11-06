"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { digest } = require("../src/subagent-task-contracts");
const { blenderRuntimeBinding, capabilityStatus, sandboxCommand, containmentProbe, runDomain } = require("../src/specialist-tools");
const { blenderVerifier, domainCapabilities } = require("../src/specialist-verifiers");
const { SubagentTasksAdapter, MemoryJsonStorage, MemoryEvidenceStore, MultiAgentTopologyAdapter } = require("../src/integration-boundary");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  const cwd = tmpFixture("pi-blender-binding-");
  try {
    const root = path.join(cwd, "runtime"), workspace = path.join(cwd, "workspace");
    fs.mkdirSync(root); fs.mkdirSync(workspace); fs.mkdirSync(path.join(workspace, "assets"));
    // This is only a transport/authority fixture, not native Blender evidence.
    const binary = path.join(root, "blender");
    fs.writeFileSync(binary, '#!/usr/bin/node\nconsole.log(\'PI_ASSET_EXPORT:{"assets/out.json":"e30="}\');\n', { mode: 0o700 });
    const runtime = { root, executable: "blender", sha256: digest(fs.readFileSync(binary)).slice(7) };
    const role = { settings: { prerequisites: ["blender"], domainOperations: ["blender-script"], blenderRuntime: runtime, domainInput: { maxBytes: 16384 }, taskPolicy: { readZones: ["create.py"], writeZones: ["assets/"], storageBytes: 32768 } } };
    const asset = { units: "meters", axes: "Z-up", maxVertices: 128, maxTriangles: 24, maxMaterials: 4, maxTexturePixels: 0, maxBones: 0, maxBytes: 16384 };
    const definition = { id: "native", type: "blender", runtime, glb: "assets/cube.glb", native: "assets/cube.blend", budget: asset };
    const checker = blenderVerifier(definition);
    assert.equal(capabilityStatus(role, { env: { PATH: "" } }).available, true, "absolute approved binding needs no Blender on PATH");
    assert.equal(capabilityStatus({ settings: { prerequisites: ["blender"] } }, { env: { PATH: root } }).available, false, "PATH presence is not runtime approval");
    assert.equal(domainCapabilities().modeling.available, false);
    assert.equal(checker.command, binary);
    assert.deepEqual(checker.configuration.runtime, runtime);
    assert(Object.isFrozen(checker.configuration.runtime));
    for (const [value, pattern] of [
      [null, /RUNTIME_REQUIRED/],
      [{ ...runtime, sha256: "unreviewed" }, /RUNTIME_INVALID/],
      [{ ...runtime, root: "relative" }, /RUNTIME_INVALID/],
      [{ ...runtime, executable: "../blender" }, /RUNTIME_INVALID/],
      [{ ...runtime, root: path.join(cwd, "absent") }, /RUNTIME_UNAVAILABLE/],
      [{ ...runtime, sha256: "0".repeat(64) }, /EXECUTABLE_STALE/],
    ]) assert.throws(() => blenderRuntimeBinding(value), pattern);
    assert.throws(() => blenderRuntimeBinding(runtime, { cwd: root }), /ROOT_INVALID/);
    fs.symlinkSync(root, path.join(cwd, "alias"));
    assert.throws(() => blenderRuntimeBinding({ ...runtime, root: path.join(cwd, "alias") }), /RUNTIME_UNAVAILABLE/);
    fs.symlinkSync(binary, path.join(root, "alias"));
    assert.throws(() => blenderRuntimeBinding({ ...runtime, executable: "alias" }), /RUNTIME_UNAVAILABLE/);
    fs.chmodSync(binary, 0o600);
    assert.throws(() => blenderRuntimeBinding(runtime), /EXECUTABLE_UNAVAILABLE/);
    fs.chmodSync(binary, 0o700);
    fs.writeFileSync(path.join(workspace, "create.py"), "# transport only\n");
    const input = { cwd: workspace, contract: role, operation: "blender-script", file: "create.py", outputs: ["assets/out.json"] };
    await assert.rejects(() => runDomain({ ...input, contract: { settings: { ...role.settings, blenderRuntime: null } }, runtimeRoot: root, env: { PATH: root } }), /RUNTIME_REQUIRED/, "caller hints cannot bypass policy");
    await assert.rejects(() => blenderVerifier({ ...definition, runtime: null }).run({ cwd: workspace }), /RUNTIME_REQUIRED/);
    if (containmentProbe().available) {
      const launch = sandboxCommand({ cwd: workspace, ...blenderRuntimeBinding(runtime), args: [] });
      assert(launch.args.includes("/runtime/blender"));
      assert(launch.args.some((arg, index) => arg === "--ro-bind" && launch.args[index + 1] === root && launch.args[index + 2] === "/runtime"));
      const result = await runDomain({ ...input, runtimeRoot: "/unapproved", command: "/unapproved/blender", env: { PATH: "/usr/bin:/bin" } });
      assert.equal(result.ok, true, result.stderr);
      assert.equal(fs.readFileSync(path.join(workspace, "assets/out.json"), "utf8"), "{}");
    }
    const policy = { schemaVersion: 2, verifiers: [definition] };
    fs.mkdirSync(path.join(workspace, ".pi"));
    const policyFile = path.join(workspace, ".pi/specialist-task-policy.json");
    fs.writeFileSync(policyFile, JSON.stringify(policy));
    const storage = new MemoryJsonStorage(), topologies = new MultiAgentTopologyAdapter({ storage, options: { cwd: workspace } });
    const options = { cwd: workspace, enabled: true, policyFile, storage, topologies, subagents: {}, evidenceStore: new MemoryEvidenceStore(storage) };
    const adapter = new SubagentTasksAdapter(options);
    assert.equal(adapter.enabled, true);
    const capabilities = adapter.capabilities();
    assert.equal(capabilities.automaticRoutingChanged, false);
    assert.equal(capabilities.domains.modeling.verifiers[0].id, "native");
    fs.appendFileSync(binary, "// changed after policy load\n");
    assert.equal(capabilityStatus(role).available, false);
    assert.equal(adapter.capabilities().domains.modeling.available, false);
    await assert.rejects(() => runDomain(input), /EXECUTABLE_STALE/);
    await assert.rejects(() => checker.run({ cwd: workspace }), /EXECUTABLE_STALE/);
    assert.equal(new SubagentTasksAdapter(options).enabled, false, "stale policy fails closed at the integration boundary");
    console.log("✓ pinned runtime authority, missing/invalid/stale/nonexecutable/aliased bindings, containment transport and reviewed policy boundary");
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
