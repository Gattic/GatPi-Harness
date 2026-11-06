"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const {
  discoverManagedStateFiles,
  planManagedStateRemediation,
  applyManagedStateRemediation,
} = require("../src/managed-state-remediation");
const { isDiagnosticTextMetadata } = require("../src/managed-state-sanitizer");
const { tmpFixture } = require("./helpers/tmp-fixture");

function tmp() { return tmpFixture("pi-state-remediation-"); }
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
function jsonl(rows) { return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`; }
function compressedRef(payload) {
  const text = JSON.stringify(payload, null, 2);
  return {
    encoding: "gzip+base64",
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
    original_bytes: Buffer.byteLength(text),
    data: zlib.gzipSync(Buffer.from(text)).toString("base64"),
  };
}

{
  const cwd = tmp();
  const providerShaped = `sk-${"M".repeat(24)}`;
  const assignmentValue = "N".repeat(24);
  const cognitive = path.join(cwd, ".pi/cognitive-automation/cognitive-memory.json");
  const entropy = path.join(cwd, ".pi/cognitive-automation/entropy/events.jsonl");
  const debug = path.join(cwd, ".pi/debug-ledger/fixture.json");
  const trace = path.join(cwd, ".pi/traces/fixture.jsonl");
  write(cognitive, `${JSON.stringify({ entries: [{ id: "memory-1", type: "episodic", title: "Assistant turn", content: `api_key=${assignmentValue}`, confidence: 0.8, provenance: { source: "pi-message" } }] }, null, 2)}\n`);
  write(entropy, jsonl([{ type: "event", text: providerShaped, tokens: 8 }, { type: "event", text: "safe progress", tokens: 3 }]));
  write(debug, `${JSON.stringify({ threadId: "fixture", attempts: [{ observation: `token=${assignmentValue}`, verdict: "partial" }] }, null, 2)}\n`);
  write(trace, jsonl([
    { category: "model_response", payload: { role: "assistant", content: "private inline response", thinkingSignature: providerShaped, status: "useful" } },
    { category: "model_response", payload_ref: compressedRef({ role: "tool", content: "private compressed response", input: { path: "private.md" }, result: { text: "private result" }, note: `api_key=${assignmentValue}`, count: 4 }) },
  ]));
  const files = [cognitive, entropy, debug, trace];
  const discovered = discoverManagedStateFiles(cwd);
  assert(discovered.includes(debug), "default discovery includes debug ledger JSON");
  assert(discovered.includes(trace), "default discovery includes trace JSONL");
  const before = new Map(files.map((file) => [file, fs.readFileSync(file)]));

  const plan = planManagedStateRemediation({ cwd, files });
  assert.equal(plan.preview, true);
  assert.equal(plan.summary.candidateFiles, 4);
  assert.equal(plan.summary.blockedFiles, 0);
  assert.equal(plan.summary.changedRecords, 6);
  assert(plan.manifest && fs.existsSync(path.join(cwd, plan.manifest)));
  for (const file of files) assert.deepEqual(fs.readFileSync(file), before.get(file), "preview must not mutate state");
  const planText = JSON.stringify(plan);
  assert(!planText.includes(providerShaped));
  assert(!planText.includes(assignmentValue));

  const applied = applyManagedStateRemediation({ cwd, manifestId: plan.id, apply: true });
  assert.equal(applied.summary.sanitizedFiles, 4);
  assert.equal(applied.summary.blockedFiles, 0);
  assert.equal(applied.summary.changedRecords, 6);
  assert(fs.existsSync(applied.backupRoot));
  assert.equal(fs.statSync(applied.backupRoot).mode & 0o777, 0o700);
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    assert(!text.includes(providerShaped));
    assert(!text.includes(assignmentValue));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  const cognitiveAfter = JSON.parse(fs.readFileSync(cognitive, "utf8"));
  assert.equal(cognitiveAfter.entries[0].id, "memory-1");
  assert.equal(cognitiveAfter.entries[0].confidence, 0.8);
  assert(isDiagnosticTextMetadata(cognitiveAfter.entries[0].content));
  const entropyAfter = fs.readFileSync(entropy, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(entropyAfter.length, 2);
  assert.equal(entropyAfter[1].text, undefined);
  assert.equal(entropyAfter[1].textSummary.chars, "safe progress".length);
  const traceAfter = fs.readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(traceAfter[0].payload.status, "useful");
  assert.equal(traceAfter[0].payload.role, "assistant");
  assert.equal(traceAfter[0].payload.content, undefined);
  assert.equal(traceAfter[0].payload.contentSummary.chars, "private inline response".length);
  assert.equal(traceAfter[0].payload.thinkingSignature, "[REDACTED:sensitive-field]");
  const decompressed = JSON.parse(zlib.gunzipSync(Buffer.from(traceAfter[1].payload_ref.data, "base64")).toString("utf8"));
  assert.equal(decompressed.count, 4);
  assert.equal(decompressed.role, "tool");
  assert.equal(decompressed.content, undefined);
  assert.equal(decompressed.contentSummary.chars, "private compressed response".length);
  assert.equal(decompressed.inputSummary.type, "object");
  assert.equal(decompressed.resultSummary.type, "object");
  assert(!decompressed.note.includes(assignmentValue));
  const resultManifest = fs.readFileSync(path.join(cwd, applied.manifest), "utf8");
  assert(!resultManifest.includes(providerShaped));
  assert(!resultManifest.includes(assignmentValue));
  assert.equal(fs.statSync(path.join(cwd, applied.manifest)).mode & 0o777, 0o600);

  const repeated = planManagedStateRemediation({ cwd, files, writeManifest: false });
  assert.equal(repeated.summary.candidateFiles, 0, "remediation is idempotent");
}

{
  const cwd = tmp();
  const snapshot = path.join(cwd, ".pi/cognitive-automation/branches/snapshots/source.json");
  const debug = path.join(cwd, ".pi/debug-ledger/resolved.json");
  const experiment = path.join(cwd, ".pi/experiment-ledger/closed.json");
  write(snapshot, `${JSON.stringify({ filesystemState: { files: { "src/example.js": { content: "assistant role maps to content fields" } } } }, null, 2)}\n`);
  write(debug, `${JSON.stringify({ status: "resolved", attempts: [{ observation: "assistant diagnostics describe content shape without carrying messages" }] }, null, 2)}\n`);
  write(experiment, `${JSON.stringify({ status: "closed", gates: [{ note: "tool role coverage includes content metadata" }] }, null, 2)}\n`);
  const plan = planManagedStateRemediation({ cwd, files: [snapshot, debug, experiment], writeManifest: false });
  assert.equal(plan.summary.candidateFiles, 0, "audited source snapshots and bounded ledger notes remain unchanged");
}

{
  const cwd = tmp();
  const assignmentValue = "P".repeat(24);
  const entropy = path.join(cwd, ".pi/cognitive-automation/entropy/events.jsonl");
  write(entropy, jsonl([{ type: "event", text: `api_key=${assignmentValue}` }]));
  const plan = planManagedStateRemediation({ cwd, files: [entropy], writeManifest: false });
  const replacement = `${entropy}.replacement`;
  write(replacement, fs.readFileSync(entropy));
  fs.renameSync(replacement, entropy);
  const applied = applyManagedStateRemediation({ cwd, plan, apply: true });
  assert.equal(applied.summary.sanitizedFiles, 0);
  assert.equal(applied.summary.blockedFiles, 1);
  assert(fs.readFileSync(entropy, "utf8").includes(assignmentValue), "identity mismatch blocks mutation");
}

{
  const cwd = tmp();
  const malformed = path.join(cwd, ".pi/traces/malformed.jsonl");
  write(malformed, "{not-json}\n");
  const plan = planManagedStateRemediation({ cwd, files: [malformed], writeManifest: false });
  assert.equal(plan.summary.blockedFiles, 1);
  assert.throws(() => applyManagedStateRemediation({ cwd, plan, apply: true }), /blocked files/);
}

{
  const cwd = tmp();
  const assignmentValue = "V".repeat(24);
  const entropy = path.join(cwd, ".pi/cognitive-automation/entropy/events.jsonl");
  write(entropy, jsonl([{ type: "event", text: `api_key=${assignmentValue}`, tokens: 2 }]));
  const script = path.resolve(__dirname, "../scripts/remediate-managed-state-privacy.js");
  const preview = execFileSync(process.execPath, [script, `--file=${entropy}`], { cwd, encoding: "utf8" });
  assert.match(preview, /candidate files: 1/);
  assert(!preview.includes(assignmentValue));
  const manifestId = preview.match(/manifest: .*\/(privacy-remediation-[a-z0-9-]+)\.json/i)?.[1];
  assert(manifestId, "CLI preview returns an opaque manifest id");
  const applied = execFileSync(process.execPath, [script, "--apply", "--yes", `--manifest=${manifestId}`], { cwd, encoding: "utf8" });
  assert.match(applied, /"sanitizedFiles": 1/);
  assert(!applied.includes(assignmentValue));
  assert(!fs.readFileSync(entropy, "utf8").includes(assignmentValue));
}

console.log("managed-state remediation tests passed");
