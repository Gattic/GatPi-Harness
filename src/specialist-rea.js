"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { runContained, confinedFile, executable } = require("./specialist-primitives");
const { runtimeBinding, systemBinding } = require("./specialist-runtime");
const { digest, inZone } = require("./specialist-contracts");
const OPERATIONS = Object.freeze({ file_headers: "-f", section_headers: "-h", symbols: "-t", relocations: "-r" });
const fail = stderr => ({ ok: false, exitCode: 1, stderr });
function reaBinding(configuration, cwd) {
  const binding = runtimeBinding(configuration.runtime, { cwd });
  const command = systemBinding(configuration.node);
  const provider = systemBinding(configuration.objdump);
  systemBinding(configuration.readelf);
  // REA's provider selection is fixed by the cleared sandbox PATH. Never use a
  // caller-controlled executable flag, environment, debug-link traversal or mode.
  if (executable("objdump", { PATH: "/usr/bin:/bin" }) !== provider || executable("readelf", { PATH: "/usr/bin:/bin" }) !== configuration.readelf.path) throw new Error("SPECIALIST_REA_PROVIDER_MISMATCH");
  if (!fs.statSync(path.join(binding.runtimeRoot, "node_modules/rea-agents/scripts/rea.mjs")).isFile()) throw new Error("SPECIALIST_REA_ENTRYPOINT_MISSING");
  return { ...binding, command };
}
function targetBytes(cwd, config) {
  const file = confinedFile(cwd, config.target);
  if (fs.statSync(file).size > 16777216) throw new Error("SPECIALIST_INPUT_TOO_LARGE");
  const bytes = fs.readFileSync(file);
  if (digest(bytes) !== `sha256:${config.sha256}` || !bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) throw new Error("SPECIALIST_TARGET_NOT_AUTHORIZED");
  return bytes;
}
async function inspectRea({ cwd, configuration, signal }) {
  const binding = reaBinding(configuration, cwd);
  targetBytes(cwd, configuration);
  const checked = await runContained({ cwd, ...binding, args: ["/runtime/node_modules/rea-agents/scripts/rea.mjs", "inspect-with-objdump", `/workspace/${configuration.target}`, configuration.operation, "--format", "json", "--full-output"], readZones: [configuration.target], writable: false, timeoutMs: 30000, maxOutputBytes: 262144, signal });
  reaBinding(configuration, cwd); targetBytes(cwd, configuration);
  if (!checked.ok) return checked;
  let packet;
  try { packet = JSON.parse(checked.stdout); } catch { return fail("invalid REA JSON envelope"); }
  const data = packet?.data, raw = data?.raw_result, normalized = data?.normalized_result;
  if (packet.ok !== true || data?.subject?.digest?.sha256 !== configuration.sha256 || data?.subject?.local_path !== `/workspace/${configuration.target}` || data?.provider?.id !== "gnu.objdump" || data?.operation !== "inspect_with_objdump" || data?.parameters?.operation !== configuration.operation || data?.parameters?.follow_debug_links !== false || !raw || raw.exit_code !== 0 || raw.signal !== null || raw.output_truncated !== false || raw.completion_status !== "complete" || raw.artifact_changed !== false || raw.artifact_sha256_after !== configuration.sha256 || typeof raw.stdout !== "string" || typeof raw.stderr !== "string" || Buffer.byteLength(raw.stdout + raw.stderr) > 65536 || digest(raw) !== digest(normalized)) return fail("REA evidence binding or completion mismatch");
  return { ...checked, observation: raw.stdout, provider: { id: data.provider.id, version: data.provider.version ?? null }, evidenceId: data.evidence_id };
}
function reaVerifier(definition) {
  const { runtime, node, objdump, readelf, target, sha256, authorization, operation, roundTripSection } = definition;
  if (!Object.hasOwn(OPERATIONS, operation) || !/^[a-f0-9]{64}$/.test(sha256 || "") || typeof authorization !== "string" || !authorization.trim() || authorization.length > 2000 || typeof target !== "string") throw new Error("REA_POLICY_INVALID");
  const configuration = JSON.parse(JSON.stringify({ runtime, node, objdump, readelf, target, sha256, authorization, operation, roundTripSection: roundTripSection ?? null }));
  const binding = reaBinding(configuration);
  const roundTrip = require("./specialist-verifiers").staticElfVerifier({ target, sha256, roundTripSection: configuration.roundTripSection });
  return { kind: "integration", capability: "rea-static", command: binding.command, configuration, run: async ({ cwd, dossier, signal }) => {
    const structure = require("./specialist-verifiers").verifyDossier({ dossier });
    if (!structure.ok) return structure;
    const observed = await inspectRea({ cwd, configuration, signal });
    if (!observed.ok) return observed;
    const direct = await runContained({ cwd, command: configuration.objdump.path, args: [OPERATIONS[operation], "--", `/workspace/${target}`], readZones: [target], writable: false, timeoutMs: 30000, maxOutputBytes: 65536, signal });
    if (!direct.ok) return direct;
    if (observed.observation !== direct.stdout) return fail("REA output differs from independent pinned objdump observation");
    const lines = direct.stdout.split("\n");
    if (!dossier.evidenceRefs.length || dossier.evidenceRefs.some(evidence => {
      const locator = /^rea:objdump:([a-z_]+):line:([1-9][0-9]{0,5})$/.exec(evidence.locator);
      return evidence.source !== target || !locator || locator[1] !== operation || !evidence.observation.trim() || lines[Number(locator[2]) - 1]?.trim() !== evidence.observation.trim();
    })) return fail("unsupported REA observation or locator");
    // Reuse the independent ELF parser/section round-trip oracle rather than
    // treating the CLI's JSON envelope as evidence of target correctness.
    const elf = await roundTrip.run({ cwd, signal, dossier: { ...dossier, evidenceRefs: [{ id: "elf", source: target, locator: "readelf:line:1", observation: "ELF Header:" }], claims: [{ ...dossier.claims[0], evidenceIds: ["elf"] }] } });
    if (!elf.ok) return elf;
    reaBinding(configuration, cwd); targetBytes(cwd, configuration);
    const domainEvidence = { kind: "rea-static-observation", targetDigest: `sha256:${sha256}`, operation, provider: observed.provider, providerFingerprint: configuration.objdump.sha256, runtimeDigest: configuration.runtime.sha256, observationDigest: digest(direct.stdout), roundTrip: elf.roundTrip || null, targetExecuted: false, network: false };
    return { ...observed, stdout: JSON.stringify(domainEvidence), domainEvidence };
  } };
}
async function runReaDomain({ cwd, contract, operation, file, signal }) {
  const config = contract.settings?.reaConfiguration, input = contract.settings?.domainInput, policy = contract.settings?.taskPolicy;
  if (operation !== "rea-inspect" || !contract.settings?.domainOperations?.includes(operation) || !config || file !== config.target || input?.target !== config.target || input.sha256 !== config.sha256 || input.authorization !== config.authorization || input.technique !== "static" || input.reaOperation !== config.operation || !policy?.readZones?.some(zone => inZone(file, zone))) throw new Error("SPECIALIST_OPERATION_DENIED");
  const result = await inspectRea({ cwd, configuration: config, signal });
  if (!result.ok) return result;
  return { ...result, stdout: JSON.stringify({ target: file, targetDigest: `sha256:${config.sha256}`, operation: config.operation, locatorPrefix: `rea:objdump:${config.operation}:line:`, lines: result.observation.split("\n") }) };
}
module.exports = { OPERATIONS, reaBinding, reaVerifier, runReaDomain };
