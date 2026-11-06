"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runContained, confinedFile, executable } = require("./specialist-tools");
const { runtimeBinding, systemBinding } = require("./specialist-runtime");
const { digest } = require("./subagent-task-contracts");
const { validateJsonSchema } = require("./role-result-schemas");
const { LEAN_TARGET_SCHEMA } = require("./specialist-roles");
const checkerPath = path.join(__dirname, "specialist-lean-checker.lean");
const fail = stderr => ({ ok: false, exitCode: 1, stderr });

function leanBinding(configuration, cwd) {
  const binding = runtimeBinding(configuration.runtime, { cwd });
  const command = path.join(binding.runtimeRoot, "bin/lean");
  if (executable(command) !== command) throw new Error("SPECIALIST_LEAN_EXECUTABLE_INVALID");
  systemBinding(configuration.python);
  for (const module of configuration.target.imports) {
    if (!fs.statSync(path.join(binding.runtimeRoot, "lib/lean", `${module.replaceAll(".", "/")}.olean`)).isFile()) throw new Error("SPECIALIST_LEAN_IMPORT_UNAVAILABLE");
  }
  if (digest(fs.readFileSync(checkerPath)) !== configuration.checkerDigest) throw new Error("SPECIALIST_LEAN_CHECKER_STALE");
  return { ...binding, command };
}
async function compile({ cwd, module, configuration, signal }) {
  const binding = leanBinding(configuration, cwd);
  // Candidate compiler output is untrusted. Transport only bounded .olean parts
  // to a separate read-only checker process after the compiler namespace exits.
  const script = `import subprocess, pathlib, base64, json, sys
p=subprocess.run(['/runtime/bin/lean','-o','/output/${module}.olean','/workspace/${module}.lean'],cwd='/workspace')
if p.returncode: sys.exit(p.returncode)
packet={}
for suffix in ['', '.server', '.private']:
 p=pathlib.Path('/output/${module}.olean'+suffix)
 if p.exists():
  assert p.is_file() and not p.is_symlink()
  data=p.read_bytes()
  assert len(data)<=1048576
  packet[suffix]=base64.b64encode(data).decode('ascii')
assert '' in packet
print('PI_LEAN_OBJECT:'+json.dumps(packet,separators=(',',':')))
`;
  const result = await runContained({ cwd, ...binding, command: configuration.python.path, args: ["-c", script], readZones: [`${module}.lean`], writable: false, outputBytes: 4194304, timeoutMs: 30000, maxOutputBytes: 4194304, signal });
  leanBinding(configuration, cwd);
  if (!result.ok) return { result };
  const markers = result.stdout.split("\n").filter(line => line.startsWith("PI_LEAN_OBJECT:"));
  if (markers.length !== 1) return { result: fail("missing or ambiguous compiled Lean object") };
  let objects;
  try { objects = JSON.parse(markers[0].slice("PI_LEAN_OBJECT:".length)); } catch { return { result: fail("invalid compiled Lean object") }; }
  if (!objects || Array.isArray(objects) || !Object.hasOwn(objects, "") || Object.keys(objects).some(key => !["", ".server", ".private"].includes(key))) return { result: fail("invalid compiled Lean parts") };
  const files = [];
  for (const [suffix, encoded] of Object.entries(objects)) {
    if (typeof encoded !== "string") return { result: fail("invalid compiled Lean encoding") };
    const data = Buffer.from(encoded, "base64");
    if (!data.length || data.length > 1048576 || data.toString("base64") !== encoded) return { result: fail("invalid compiled Lean size or encoding") };
    const name = `${module}.olean${suffix}`;
    fs.writeFileSync(path.join(cwd, name), data, { flag: "wx", mode: 0o600 });
    files.push({ path: name, digest: digest(data), bytes: data.length });
  }
  return { result, files };
}
function leanVerifier({ runtime, python, target }) {
  if (validateJsonSchema(LEAN_TARGET_SCHEMA, target).length) throw new Error("LEAN_TARGET_INVALID");
  const configuration = JSON.parse(JSON.stringify({ runtime, python, target, targetDigest: digest(target), checkerDigest: digest(fs.readFileSync(checkerPath)) }));
  target = configuration.target;
  runtime = configuration.runtime;
  const binding = leanBinding(configuration);
  return { kind: "integration", capability: "lean-proof", command: binding.command, configuration,
    protectedFiles: [{ path: target.path, digest: `sha256:${target.sha256}` }],
    run: async ({ cwd, dossier, signal }) => {
      leanBinding(configuration, cwd);
      const structure = require("./specialist-verifiers").verifyDossier({ dossier });
      if (!structure.ok) return structure;
      const proof = dossier.leanProof;
      if (!proof || proof.targetDigest !== configuration.targetDigest || typeof proof.source !== "string" || Buffer.byteLength(proof.source) > 32768) return fail("missing, oversized or wrong-target Lean source");
      const file = confinedFile(cwd, target.path);
      if (fs.statSync(file).size > 65536) return fail("Lean target source too large");
      const source = fs.readFileSync(file);
      if (digest(source) !== `sha256:${target.sha256}`) return fail("Lean target source drift");
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lean-check-"));
      try {
        fs.writeFileSync(path.join(temporary, "Expected.lean"), source, { mode: 0o600 });
        fs.writeFileSync(path.join(temporary, "Candidate.lean"), proof.source, { mode: 0o600 });
        const reference = await compile({ cwd: temporary, module: "Expected", configuration, signal });
        if (!reference.result.ok) return reference.result;
        const candidate = await compile({ cwd: temporary, module: "Candidate", configuration, signal });
        if (!candidate.result.ok) return candidate.result;
        fs.copyFileSync(checkerPath, path.join(temporary, "Check.lean"));
        const checked = await runContained({ cwd: temporary, ...leanBinding(configuration, temporary), args: ["--run", "/workspace/Check.lean", target.declaration, target.candidateDeclaration, target.imports.join(","), target.allowedAxioms.join(",")], readZones: ["Check.lean", ...reference.files.map(f => f.path), ...candidate.files.map(f => f.path)], writable: false, timeoutMs: 30000, maxOutputBytes: 65536, signal });
        leanBinding(configuration, cwd);
        if (digest(fs.readFileSync(file)) !== `sha256:${target.sha256}`) return fail("Lean target changed during checking");
        if (!checked.ok) return checked;
        if (checked.stdout.trim() !== "PI_LEAN_KERNEL_ACCEPTED") return fail("independent Lean kernel receipt missing");
        const domainEvidence = { kind: "lean-kernel-replay", targetDigest: configuration.targetDigest, sourceDigest: digest(proof.source), objects: candidate.files, referenceObjects: reference.files, declaration: target.candidateDeclaration, allowedAxioms: target.allowedAxioms, imports: target.imports, runtimeDigest: runtime.sha256, checkerDigest: configuration.checkerDigest };
        return { ...checked, stdout: JSON.stringify(domainEvidence), domainEvidence };
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    } };
}
module.exports = { leanBinding, leanVerifier };
