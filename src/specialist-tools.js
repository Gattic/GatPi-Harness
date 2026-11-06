"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { confinedFile, runContained, blenderRuntimeBinding, executable, executableFingerprint, inSystemRuntime, sandboxCommand, assertWriteAllocation, guardMutation, containmentProbe } = require("./specialist-primitives");
const { capabilityStatus } = require("./specialist-capabilities");
const { safeRelative, pathForbidden } = require("./subagent-workspaces");

function domainCommand({ operation, file, contract, cwd }) {
  if (!contract.settings?.domainOperations?.includes(operation)) throw new Error("SPECIALIST_OPERATION_DENIED");
  const absolute = confinedFile(cwd, file);
  if (fs.statSync(absolute).size > 16 * 1024 * 1024) throw new Error("SPECIALIST_INPUT_TOO_LARGE");
  if (operation === "elf-inspect") {
    const input = contract.settings?.domainInput;
    const hash = crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
    if (!input?.authorization || input.technique !== "static" || input.target !== file || input.sha256 !== hash) throw new Error("SPECIALIST_TARGET_NOT_AUTHORIZED");
    return { command: "readelf", args: ["--wide", "--file-header", "--section-headers", "--symbols", "--", `/workspace/${file}`], writable: false };
  }
  throw new Error("SPECIALIST_OPERATION_DENIED");
}
async function runDomain(input) {
  const diagnostics = require("./specialist-diagnostics");
  if (Object.hasOwn(diagnostics.DIAGNOSTIC_OPERATIONS, input.operation)) return diagnostics.runDiagnostic(input);
  if (input.operation === "rea-inspect") return require("./specialist-rea").runReaDomain(input);
  if (!["blender-script", "blenderai-dispatch"].includes(input.operation)) return runContained({ ...input, ...input.contract?.settings?.taskPolicy, ...domainCommand(input) });
  const { contract, cwd, file, outputs } = input;
  const policy = contract.settings?.taskPolicy;
  const dispatch = input.operation === "blenderai-dispatch";
  if (!contract.settings?.domainOperations?.includes(input.operation) || !policy || !file.endsWith(dispatch ? ".json" : ".py")) throw new Error("SPECIALIST_OPERATION_DENIED");
  if (fs.statSync(confinedFile(cwd, file)).size > 1048576) throw new Error("SPECIALIST_INPUT_TOO_LARGE");
  const addon = dispatch ? require("./specialist-blenderai").blenderAiBinding(contract.settings.blenderAi, cwd) : {};
  if (!Array.isArray(outputs) || !outputs.length || outputs.length > 4 || new Set(outputs).size !== outputs.length || outputs.some(name => safeRelative(name) !== name || pathForbidden(name) || !/\.(blend|glb|png|json)$/.test(name) || !policy.writeZones.some(zone => name === zone || (zone.endsWith("/") && name.startsWith(zone))))) throw new Error("SPECIALIST_OUTPUT_PATH_DENIED");
  const quota = Math.min(contract.settings.domainInput.maxBytes, policy.storageBytes, 16777216);
  const script = [
    "import runpy, os, json, base64, pathlib",
    "os.environ['PI_ASSET_OUTPUT_DIR'] = '/output'",
    dispatch ? require("./specialist-blenderai").blenderAiScript(file, outputs) : `runpy.run_path(${JSON.stringify(`/workspace/${file}`)}, run_name='__main__')`,
    `names = json.loads(${JSON.stringify(JSON.stringify(outputs))})`,
    "packet = {}",
    "for name in names:",
    " p = pathlib.Path('/output', name)",
    " assert p.is_file() and not p.is_symlink() and str(p.resolve()).startswith('/output/')",
    " packet[name] = base64.b64encode(p.read_bytes()).decode('ascii')",
    "print('PI_ASSET_EXPORT:' + json.dumps(packet, separators=(',', ':')))",
  ].join("\n");
  const binding = blenderRuntimeBinding(contract.settings.blenderRuntime, { cwd });
  const result = await runContained({ ...input, ...policy, ...binding, ...addon, args: ["--background", "--factory-startup", "--disable-autoexec", "--threads", "1", "--python-exit-code", "1", "--python-expr", script], writable: false, outputBytes: quota, maxOutputBytes: Math.min(33554432, Math.ceil(quota * 4 / 3) + 65536) });
  blenderRuntimeBinding(contract.settings.blenderRuntime, { cwd });
  if (dispatch) require("./specialist-blenderai").blenderAiBinding(contract.settings.blenderAi, cwd);
  if (!result.ok) return result;
  const line = result.stdout.split("\n").filter(line => line.startsWith("PI_ASSET_EXPORT:")).at(-1);
  if (!line) throw new Error("SPECIALIST_OUTPUT_MANIFEST_MISSING");
  const packet = JSON.parse(line.slice("PI_ASSET_EXPORT:".length));
  if (!packet || typeof packet !== "object" || Array.isArray(packet) || Object.keys(packet).sort().join("\0") !== [...outputs].sort().join("\0")) throw new Error("SPECIALIST_OUTPUT_MANIFEST_INVALID");
  let bytes = 0;
  const root = fs.realpathSync(cwd);
  const files = outputs.map(name => {
    if (typeof packet[name] !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(packet[name])) throw new Error("SPECIALIST_OUTPUT_ENCODING_INVALID");
    const data = Buffer.from(packet[name], "base64"); bytes += data.length;
    if (data.toString("base64") !== packet[name] || bytes > quota) throw new Error("SPECIALIST_OUTPUT_QUOTA_EXCEEDED");
    const target = path.join(root, name), parent = fs.realpathSync(path.dirname(target));
    if (!parent.startsWith(`${root}${path.sep}`) && parent !== root) throw new Error("SPECIALIST_OUTPUT_PATH_DENIED");
    if (fs.existsSync(target) && !fs.lstatSync(target).isFile()) throw new Error("SPECIALIST_OUTPUT_PATH_DENIED");
    return { name, target, data };
  });
  assertWriteAllocation(cwd, policy, files.map(entry => ({ name: entry.name, size: entry.data.length })));
  for (const entry of files) {
    const fd = fs.openSync(entry.target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { fs.writeFileSync(fd, entry.data); } finally { fs.closeSync(fd); }
  }
  return { ...result, stdout: JSON.stringify({ outputs: files.map(({ name, data }) => ({ path: name, bytes: data.length })), bytes }), outputBytes: bytes };
}
module.exports = { executable, executableFingerprint, blenderRuntimeBinding, inSystemRuntime, capabilityStatus, confinedFile, sandboxCommand, runContained, domainCommand, runDomain, guardMutation, containmentProbe };
