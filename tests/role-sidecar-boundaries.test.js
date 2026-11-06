"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const { DEFAULT_ROLE_CONTRACTS } = require("../src/role-contracts");
const { validateRoleSubmission } = require("../src/role-result-schemas");
const { validateRpcCompletion } = require("../src/subagent-result-validator");

const piRoot = fs.realpathSync(path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent"));
const jitiModule = require(require.resolve("jiti", { paths: [piRoot] }));
const { tmpFixture } = require("./helpers/tmp-fixture");
const extensionFile = path.resolve(__dirname, "../extensions/role-sidecar/index.ts");
const jiti = (jitiModule.createJiti || jitiModule)(extensionFile, {
  interopDefault: true,
  alias: { typebox: require.resolve("typebox", { paths: [piRoot] }) },
});
const extension = jiti.import(extensionFile);

async function sidecar(roleId, settings = {}) {
  const role = structuredClone(DEFAULT_ROLE_CONTRACTS.find(role => role.roleId === roleId));
  role.settings = { ...role.settings, ...settings };
  const mod = await extension;
  const environment = {
    PI_ROLE_SIDECAR: "1", PI_SUBAGENT_PARENT_ID: "boundary-fixture",
    PI_ROLE_EXPECTED_MODEL: "fixture/parent", PI_ROLE_EXPECTED_THINKING_LEVEL: "high",
    PI_ROLE_CONTRACT_B64: Buffer.from(JSON.stringify(role)).toString("base64url"),
  };
  const saved = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  const tools = new Map(), hooks = new Map();
  try {
    Object.assign(process.env, environment);
    (mod.default || mod)({ registerTool: tool => tools.set(tool.name, tool), on: (event, handler) => hooks.set(event, handler) });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  return { role, tools, hooks };
}

test("task reads check lexical and canonical ownership, including private targets", async t => {
  const temporary = tmpFixture("pi-sidecar-paths-");
  try {
    const cwd = path.join(temporary, "project");
    for (const dir of ["docs", "other", ".pi", ".git"]) fs.mkdirSync(path.join(cwd, dir), { recursive: true });
    for (const file of ["docs/owned.txt", "docs/credentials.json", "other/outside.txt", ".pi/private.txt", ".git/config"]) fs.writeFileSync(path.join(cwd, file), "synthetic boundary fixture\n");
    fs.writeFileSync(path.join(temporary, "external.txt"), "synthetic external fixture\n");
    for (const [name, target] of Object.entries({ owned: "owned.txt", unowned: "../other/outside.txt", private: "../.pi/private.txt", git: "../.git/config", sensitive: "credentials.json", external: "../../external.txt", dangling: "../other/missing.txt", loop: "loop" })) fs.symlinkSync(target, path.join(cwd, "docs", name));
    fs.symlinkSync("../other", path.join(cwd, "docs", "unowned-dir"));
    fs.symlinkSync("docs", path.join(cwd, "unowned-alias"));
    fs.symlinkSync(cwd, path.join(temporary, "project-alias"));
    const { hooks } = await sidecar("security-reviewer", { taskPolicy: { readZones: ["docs/"], writeZones: [] } });
    let id = 0;
    const check = (toolName, input, root = cwd) => hooks.get("tool_call")({ toolName, toolCallId: `path-${++id}`, input }, { cwd: root });
    for (const name of ["unowned", "private", "git", "sensitive", "external", "dangling", "loop", "unowned-dir/outside.txt", "unowned-dir/new/deep.txt"]) {
      await t.test(`reject docs/${name}`, async () => assert.equal((await check("read", { path: `docs/${name}` }))?.block, true));
    }
    for (const tool of ["grep", "find", "ls"]) await t.test(`reject aliased directory for ${tool}`, async () => assert.equal((await check(tool, { path: "docs/unowned-dir" }))?.block, true));
    assert.equal((await check("read", { path: "unowned-alias/owned.txt" }))?.block, true, "canonical ownership does not grant an undeclared lexical alias");
    for (const file of ["docs/owned.txt", "docs/owned", "@docs/owned.txt", path.join(cwd, "docs/owned.txt")]) assert.equal(await check("read", { path: file }), undefined, `allow owned file ${file}`);
    assert.equal(await check("read", { path: "docs/owned" }, path.join(temporary, "project-alias")), undefined, "a symlinked cwd is resolved consistently");
    assert.equal(await check("ls", { path: "docs" }), undefined);
    assert.equal((await check("ls", {}))?.block, true, "omitting a path does not grant repository-wide access");
    const exact = await sidecar("security-reviewer", { taskPolicy: { readZones: ["docs/owned"], writeZones: [] } });
    assert.equal((await exact.hooks.get("tool_call")({ toolName: "read", toolCallId: "exact", input: { path: "docs/owned" } }, { cwd }))?.block, true, "a symlink-only grant does not authorize its undeclared target");

    const intake = await sidecar("worker", { allowedPrivateReadPaths: [".pi/private.txt"], restrictReadPaths: true });
    assert.equal(await intake.hooks.get("tool_call")({ toolName: "read", toolCallId: "private", input: { path: ".pi/private.txt" } }, { cwd }), undefined, "exact parent-approved private reads still work");
    fs.unlinkSync(path.join(cwd, ".pi/private.txt"));
    fs.symlinkSync("../other/outside.txt", path.join(cwd, ".pi/private.txt"));
    assert.equal((await intake.hooks.get("tool_call")({ toolName: "read", toolCallId: "retargeted", input: { path: ".pi/private.txt" } }, { cwd }))?.block, true, "retargeting an exact private grant cannot widen it");
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test("SDK read normalization cannot substitute an unauthorized target after approval", async t => {
  const { createReadTool } = await import(path.join(piRoot, "dist/index.js"));
  const cwd = tmpFixture("pi-sidecar-sdk-paths-");
  try {
    fs.mkdirSync(path.join(cwd, "docs")); fs.mkdirSync(path.join(cwd, ".pi"));
    const privateText = "synthetic private normalization fixture";
    fs.writeFileSync(path.join(cwd, ".pi/private.txt"), privateText);
    const { hooks } = await sidecar("security-reviewer", { taskPolicy: { readZones: ["docs/"], writeZones: [] } });
    const read = createReadTool(cwd);
    for (const [requested, actual] of [["space\u00a0name", "space name"], ["café", "cafe\u0301"], ["capture 1 AM.png", "capture 1\u202fAM.png"], ["capture's", "capture’s"]]) {
      fs.symlinkSync("../.pi/private.txt", path.join(cwd, "docs", actual));
      if (requested.includes("\u00a0")) fs.writeFileSync(path.join(cwd, "docs", requested), "a different, owned literal file");
      await t.test(requested, async () => {
        const input = { path: `docs/${requested}` };
        const result = await read.execute("sdk-read", input);
        assert(result.content.some(item => item.text?.includes(privateText)), "actual SDK resolves the request to the synthetic private target");
        assert.equal((await hooks.get("tool_call")({ toolName: "read", toolCallId: requested, input }, { cwd }))?.block, true);
      });
    }
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("new owned files can be written without granting symlinked ancestors", async () => {
  const cwd = tmpFixture("pi-sidecar-new-path-");
  try {
    fs.mkdirSync(path.join(cwd, "docs")); fs.mkdirSync(path.join(cwd, "other"));
    const { hooks } = await sidecar("coder", { taskPolicy: { readZones: [], writeZones: ["docs/"], storageBytes: 65536 } });
    const check = file => hooks.get("tool_call")({ toolName: "write", toolCallId: file, input: { path: file, content: "fixture" } }, { cwd });
    assert.equal(await check("docs/new/deep/file.txt"), undefined);
    fs.symlinkSync("../other", path.join(cwd, "docs/alias"));
    assert.equal((await check("docs/alias/new/file.txt"))?.block, true);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("diagnostic sidecar preserves stderr findings and failed collection status", async t => {
  const { containmentProbe } = require("../src/specialist-tools");
  const { digest } = require("../src/subagent-task-contracts");
  if (!containmentProbe().available) return t.skip("usable bubblewrap required");
  const cwd = tmpFixture("pi-sidecar-diagnostics-");
  let passed = false;
  try {
    for (const name of ["true", "false"]) {
      fs.copyFileSync(`/usr/bin/${name}`, path.join(cwd, "target"));
      const { tools, hooks } = await sidecar("code-profiler", { domainInput: { execution: { authorization: "Run this synthetic fixture only.", target: "target", sha256: digest(fs.readFileSync(path.join(cwd, "target"))).slice(7), args: [], operations: ["time-profile"], timeoutMs: 5000 } }, taskPolicy: { readZones: ["target"], writeZones: [] } });
      const input = { operation: "time-profile", file: "target" };
      assert.equal(await hooks.get("tool_call")({ toolName: "role_domain", toolCallId: name, input }, { cwd }), undefined);
      const result = await tools.get("role_domain").execute(name, input, undefined, undefined, { cwd });
      assert.match(result.content[0].text, /Maximum resident set size/);
      assert.equal(result.isError, name === "false");
      assert.equal(result.details.exitCode, name === "false" ? 1 : 0);
      assert.equal(result.details.diagnosticEvidence.operation, "time-profile");
      assert.equal((await hooks.get("tool_call")({ toolName: "bash", toolCallId: "shell", input: { command: "true" } }, { cwd })).block, true);
      await assert.rejects(() => tools.get("role_domain").execute("denied", { operation: "gdb-backtrace", file: "target" }, undefined, undefined, { cwd }), /OPERATION_DENIED/);
    }
    passed = true;
  } finally {
    if (passed) fs.rmSync(cwd, { recursive: true, force: true });
    else console.error(`Diagnostic sidecar failure fixture retained: ${cwd}`);
  }
});

test("dossiers survive the actual sidecar tool and parent RPC validation", async t => {
  const dossier = {
    assumptions: [{ id: "a1", statement: "Fixture input is authoritative for this transport test." }],
    claims: [{ id: "c1", statement: "The fixture declares a proposition.", status: "observed", assumptionIds: ["a1"], evidenceIds: ["e1"], limitationIds: ["l1"], proofObligationIds: ["p1"] }],
    evidenceRefs: [{ id: "e1", source: "fixture.txt", locator: "line:1", observation: "A declared fixture proposition." }],
    limitations: [{ id: "l1", statement: "Transport validation does not prove this proposition." }],
    proofObligations: [{ id: "p1", statement: "Independent native checking is separate." }],
    certificate: { kind: "bezout-gcd", targetDigest: `sha256:${"1".repeat(64)}`, u: "-1", v: "3" },
    leanProof: { targetDigest: `sha256:${"2".repeat(64)}`, source: "theorem candidate : True := True.intro\n" },
  };
  for (const roleId of ["mathematical-researcher", "reverse-engineer", "reliability-investigator", "code-profiler", "security-reviewer"]) await t.test(roleId, async () => {
    const { tools, role } = await sidecar(roleId);
    const params = { summary: "A bounded specialist dossier with explicit sources and limitations.", findings: [], evidence: [{ summary: "Inspected the declared synthetic fixture." }], dossier };
    assert.equal(validateRoleSubmission(params, { schema: role.outputSchema, maxResultChars: 131072 }).ok, true);
    const tool = tools.get("submit_role_result");
    const ctx = { cwd: process.cwd(), sessionManager: { getSessionFile: () => null } };
    const { dossier: omitted, ...missing } = params;
    await assert.rejects(() => tool.execute("missing", missing, undefined, undefined, ctx), /missing required field: dossier/);
    const reply = await tool.execute("submit", params, undefined, undefined, ctx);
    assert.deepEqual(reply.details.result.dossier, dossier);
    assert.equal(reply.terminate, true);
    const messages = [
      { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "submit", name: "submit_role_result", arguments: params }] },
      { role: "toolResult", toolCallId: "submit", toolName: "submit_role_result", isError: false, ...reply },
    ];
    const validated = validateRpcCompletion({ agentEnd: { type: "agent_end", messages }, messages, budget: null, roleContract: role, requireRoleResultV2: true, subagentId: "boundary-fixture" });
    assert.equal(validated.ok, true, JSON.stringify(validated));
    assert.deepEqual(validated.submittedResult.dossier, dossier);
  });
});

test("vision critiques survive the actual sidecar and parent RPC validation", async () => {
  const { tools, role, hooks } = await sidecar("3d-critic", { taskPolicy: { readZones: [], writeZones: [] } });
  const visualCritique = {
    artifactDigest: `sha256:${"1".repeat(64)}`, previewDigest: `sha256:${"2".repeat(64)}`, verdict: "revise",
    observations: ["front", "rear", "top"].map(view => ({ view, observation: "The synthetic shape has a wide body." })),
    corrections: [{ view: "front", issue: "The body is too wide.", action: "Reduce its width to match the brief." }],
    limitations: ["Fixture response, not live visual judgment."],
  };
  const params = { summary: "Independent visual critique with concrete modeling corrections.", evidence: [{ summary: "Inspected synthetic contact-sheet views." }], visualCritique };
  const ctx = { cwd: process.cwd(), sessionManager: { getSessionFile: () => null } };
  for (const toolName of ["read", "write", "edit", "bash", "role_domain"]) assert.equal((await hooks.get("tool_call")({ toolName, toolCallId: toolName, input: { path: "README.md" } }, ctx)).block, true);
  const reply = await tools.get("submit_role_result").execute("submit", params, undefined, undefined, ctx);
  assert.deepEqual(reply.details.result.visualCritique, visualCritique);
  const messages = [
    { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "submit", name: "submit_role_result", arguments: params }] },
    { role: "toolResult", toolCallId: "submit", toolName: "submit_role_result", isError: false, ...reply },
  ];
  const validated = validateRpcCompletion({ agentEnd: { type: "agent_end", messages }, messages, budget: null, roleContract: role, requireRoleResultV2: true, subagentId: "boundary-fixture" });
  assert.equal(validated.ok, true, JSON.stringify(validated));
  assert.deepEqual(validated.submittedResult.visualCritique, visualCritique);
});
