"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { verifyDossier, verifyGlbBuffer, staticElfVerifier, domainCapabilities } = require("../src/specialist-verifiers");
const { acquireManagedWorker } = require("../src/resource-guard");
const { digest } = require("../src/subagent-task-contracts");
const { validateRoleSubmission } = require("../src/role-result-schemas");
const { DEFAULT_ROLE_CONTRACTS } = require("../src/role-contracts");
const { runContained, runDomain, domainCommand, executable, guardMutation } = require("../src/specialist-tools");
const { tmpFixture } = require("./helpers/tmp-fixture");
function glb({ nonfinite = false, external = false, asset = { version: "2.0", extras: { sourceUnits: "meters", sourceAxes: "Z-up" } } } = {}) {
  const vertices = Buffer.alloc(36); if (nonfinite) vertices.writeFloatLE(NaN, 0); else { vertices.writeFloatLE(1, 12); vertices.writeFloatLE(1, 28); }
  const json = JSON.stringify({ asset, buffers: [{ byteLength: 36, ...(external ? { uri: "https://invalid.example/asset.bin" } : {}) }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }], accessors: [{ bufferView: 0, componentType: 5126, type: "VEC3", count: 3 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }] });
  const body = Buffer.from(json.padEnd(Math.ceil(Buffer.byteLength(json) / 4) * 4));
  const header = Buffer.alloc(20); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + body.length + vertices.length, 8); header.writeUInt32LE(body.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const bin = Buffer.alloc(8); bin.writeUInt32LE(vertices.length, 0); bin.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, body, bin, vertices]);
}
(async () => {
  const dossier = { assumptions: [], limitations: [{ id: "scope", statement: "This is a structural consistency check, not proof." }], proofObligations: [], claims: [{ id: "c1", statement: "A fixture observation.", status: "observed", assumptionIds: [], evidenceIds: ["e1"], limitationIds: ["scope"], proofObligationIds: [] }], evidenceRefs: [{ id: "e1", source: "fixture.txt", locator: "line 1", observation: "Read a fixture value." }] };
  assert.equal(verifyDossier({ dossier }).ok, true);
  assert.equal(verifyDossier({ dossier: { ...dossier, claims: [{ ...dossier.claims[0], evidenceIds: [] }] } }).ok, false);
  assert.equal(verifyDossier({ dossier: { ...dossier, claims: [{ ...dossier.claims[0], status: "machine-checked" }] } }).ok, false);
  assert.equal(verifyDossier({ dossier: { ...dossier, claims: [{ ...dossier.claims[0], status: "conjecture" }] } }).ok, false);
  const dangling = { ...dossier, claims: [{ ...dossier.claims[0], assumptionIds: ["missing"] }] };
  assert.equal(verifyDossier({ dossier: dangling }).ok, false);
  const rejected = validateRoleSubmission({ summary: "A dossier cannot omit the evidence behind its assumptions.", dossier: dangling }, { schema: DEFAULT_ROLE_CONTRACTS.find(role => role.roleId === "mathematical-researcher").outputSchema });
  assert(rejected.errors.some(error => error.includes("dangling-assumptionIds")), "bad links are rejected at submission, even without a separate dossier criterion");
  const linked = { ...dossier, assumptions: [{ id: "A1", statement: "The fixture value is fixed." }], proofObligations: [{ id: "P1", statement: "Prove the proposed extension." }], claims: [{ ...dossier.claims[0], status: "conjecture", assumptionIds: ["A1"], proofObligationIds: ["P1"] }] };
  assert.equal(verifyDossier({ dossier: linked }).ok, true);
  assert.equal(verifyDossier({ dossier: { ...linked, limitations: [] } }).ok, false);
  const budget = { maxBytes: 4096, maxVertices: 3, maxTriangles: 1, maxMaterials: 0, maxTexturePixels: 0, maxBones: 0, units: "meters", axes: "Z-up" };
  assert.equal(verifyGlbBuffer(glb(), budget).ok, true);
  const producerPrompt = DEFAULT_ROLE_CONTRACTS.find(role => role.roleId === "3d-modeler").systemPrompt;
  assert.match(producerPrompt, /asset\.extras\.sourceUnits equal to domainInput\.units/);
  assert.match(producerPrompt, /asset\.extras\.sourceAxes equal to domainInput\.axes/);
  assert.match(producerPrompt, /GLB coordinates standard meters\/Y-up/, "source metadata must not change the GLB coordinate convention");
  for (const units of ["meters", "centimeters", "millimeters"]) for (const axes of ["Z-up", "Y-up"]) {
    const asset = { version: "2.0", extras: { sourceUnits: units, sourceAxes: axes } };
    assert.equal(verifyGlbBuffer(glb({ asset }), { ...budget, units, axes }).ok, true, `${units}/${axes} source declarations match the requested budget`);
  }
  // Blender's normal export omits asset.extras; scene/node custom properties or
  // declarations elsewhere cannot satisfy this exact producer/checker contract.
  for (const [label, asset] of [
    ["missing extras", { version: "2.0" }],
    ["empty extras", { version: "2.0", extras: {} }],
    ["missing sourceUnits", { version: "2.0", extras: { sourceAxes: "Z-up" } }],
    ["missing sourceAxes", { version: "2.0", extras: { sourceUnits: "meters" } }],
    ["wrong sourceUnits", { version: "2.0", extras: { sourceUnits: "centimeters", sourceAxes: "Z-up" } }],
    ["export axes instead of source axes", { version: "2.0", extras: { sourceUnits: "meters", sourceAxes: "Y-up" } }],
    ["wrong metadata location", { version: "2.0", sourceUnits: "meters", sourceAxes: "Z-up" }],
  ]) assert.deepEqual(verifyGlbBuffer(glb({ asset }), budget), { ok: false, exitCode: 1, stderr: "asset-convention-mismatch" }, label);
  for (const value of [glb({ nonfinite: true }), glb({ external: true }), glb().subarray(0, 22), Buffer.from("not an asset")]) assert.equal(verifyGlbBuffer(value, budget).ok, false);
  assert.equal(verifyGlbBuffer(glb(), { ...budget, maxVertices: 2 }).ok, false);
  assert.equal(verifyGlbBuffer(glb(), { ...budget, axes: "Y-up" }).ok, false);
  assert.equal(domainCapabilities().formalProof.available, false, "a registered research role is not a formal-proof checker");
  const cwd = tmpFixture("pi-domain-verifier-");
  try {
    const bounded = { settings: { taskPolicy: { writeZones: ["assets/"], storageBytes: 8192 } } };
    assert.throws(() => guardMutation({ cwd, contract: bounded, tool: "write", input: { path: "assets/a/b/c/d/file.txt", content: "x" } }), /STORAGE_BUDGET/, "directory allocation must fit before a write starts");
    const cumulative = { settings: { domainOperations: ["blender-script"], domainInput: { maxBytes: 16384 }, taskPolicy: { readZones: ["script.py"], writeZones: ["assets/"], storageBytes: 12288 } } };
    guardMutation({ cwd, contract: cumulative, tool: "write", input: { path: "assets/first.glb", content: "x" } });
    fs.mkdirSync(path.join(cwd, "assets")); fs.writeFileSync(path.join(cwd, "assets/first.glb"), "x");
    assert.throws(() => guardMutation({ cwd, contract: cumulative, tool: "write", input: { path: "assets/second.glb", content: "x" } }), /STORAGE_BUDGET/);
    if (executable("bwrap")) {
      const runtime = tmpFixture("pi-domain-transport-");
      try {
        fs.mkdirSync(path.join(runtime, "bin"));
        fs.writeFileSync(path.join(runtime, "bin/blender"), '#!/usr/bin/node\nconsole.log(\'PI_ASSET_EXPORT:{"assets/second.glb":"eA=="}\');\n', { mode: 0o700 });
        fs.writeFileSync(path.join(cwd, "script.py"), "# Transport fixture only, not Blender capability evidence.\n");
        const pinnedContract = { settings: { ...cumulative.settings, blenderRuntime: { root: runtime, executable: "bin/blender", sha256: digest(fs.readFileSync(path.join(runtime, "bin/blender"))).slice(7) } } };
        await assert.rejects(() => runDomain({ cwd, contract: pinnedContract, operation: "blender-script", file: "script.py", outputs: ["assets/second.glb"] }), /STORAGE_BUDGET/);
        assert.equal(fs.existsSync(path.join(cwd, "assets/second.glb")), false, "aggregate DCC output admission occurs before importing any files");
      } finally { fs.rmSync(runtime, { recursive: true, force: true }); }
    }
    const lockRoot = path.join(cwd, "workers");
    const first = await acquireManagedWorker({ root: lockRoot }), second = await acquireManagedWorker({ root: lockRoot });
    await assert.rejects(() => acquireManagedWorker({ root: lockRoot }), /capacity exhausted/);
    await first.release(); const third = await acquireManagedWorker({ root: lockRoot }); await second.release(); await third.release();
    if (executable("bwrap") && executable("readelf")) {
      fs.copyFileSync("/usr/bin/true", path.join(cwd, "target.elf"));
      const sha256 = digest(fs.readFileSync(path.join(cwd, "target.elf"))).slice(7);
      const check = staticElfVerifier({ target: "target.elf", sha256, roundTripSection: ".interp" });
      const staticDossier = { ...dossier, evidenceRefs: [{ ...dossier.evidenceRefs[0], source: "target.elf", locator: "readelf:line:1", observation: "ELF Header:" }] };
      const roundTrip = await check.run({ cwd, dossier: staticDossier });
      assert.equal(roundTrip.ok, true, roundTrip.stderr);
      assert.equal(roundTrip.roundTrip.targetDigest, `sha256:${sha256}`);
      assert.equal(roundTrip.roundTrip.digest, digest(fs.readFileSync(path.join(cwd, "target.elf")).subarray(roundTrip.roundTrip.offset, roundTrip.roundTrip.offset + roundTrip.roundTrip.bytes)));
      assert.equal((await check.run({ cwd, dossier: { ...staticDossier, evidenceRefs: [{ ...staticDossier.evidenceRefs[0], locator: "readelf:line:999" }] } })).ok, false);
      assert.equal((await staticElfVerifier({ target: "target.elf", sha256, roundTripSection: ".absent-fixture-section" }).run({ cwd, dossier: staticDossier })).ok, false);
      assert.equal((await staticElfVerifier({ target: "target.elf", sha256: "0".repeat(64) }).run({ cwd })).ok, false);
      assert.throws(() => domainCommand({ cwd, file: "target.elf", operation: "elf-inspect", contract: { settings: { domainOperations: ["elf-inspect"], domainInput: { target: "target.elf", sha256, technique: "static" } } } }), /NOT_AUTHORIZED/);
      const isolated = await runContained({ cwd, command: "bash", args: ["-c", `! mkdir /escape && ! touch /dev/escape && test ! -e ${JSON.stringify(path.join(os.homedir(), ".pi"))} && ! echo bad > target.elf`], timeoutMs: 3000 });
      assert.equal(isolated.ok, true, isolated.stderr);
      const overOutput = await runContained({ cwd, command: "bash", args: ["-c", "printf 123456789"], maxOutputBytes: 4, timeoutMs: 3000 });
      assert.equal(overOutput.ok, false); assert.equal(overOutput.termination, "output-limit");
    }
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  console.log("specialist verifier, capability, containment and shared admission tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
