"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { isDiagnosticTextMetadata, sanitizeManagedDiagnosticState, sanitizeManagedState } = require("../src/managed-state-sanitizer");
const { CognitiveMemory } = require("../src/cognitive-memory");
const { MemoryJsonStorage, EntropyPersistenceAdapter } = require("../src/integration-boundary");
const { MetricsPersistence } = require("../src/entropy-monitor");
const { tmpFixture } = require("./helpers/tmp-fixture");

const providerShaped = `sk-${"A".repeat(24)}`;
const githubShaped = `ghp_${"B".repeat(24)}`;
const assignmentValue = "C".repeat(24);
const privateKey = [
  "-----BEGIN PRIVATE KEY-----",
  "fixture-material-not-a-real-key",
  "-----END PRIVATE KEY-----",
].join("\n");

const input = {
  ordinary: "Keep useful diagnostic context and counters.",
  nested: [
    `provider marker ${providerShaped}`,
    `github marker ${githubShaped}`,
    `api_key=${assignmentValue}`,
    privateKey,
  ],
  thinkingSignature: providerShaped,
  usage: { tokens: 42, token: 7 },
};
const result = sanitizeManagedState(input);
const rendered = JSON.stringify(result.value);
assert.equal(result.changed, true);
assert.equal(result.value.ordinary, input.ordinary);
assert.equal(result.value.usage.tokens, 42, "ordinary token counters remain intact");
assert.equal(result.value.usage.token, 7, "numeric singular token counters remain intact");
assert.equal(result.value.thinkingSignature, "[REDACTED:sensitive-field]");
assert(!rendered.includes(providerShaped));
assert(!rendered.includes(githubShaped));
assert(!rendered.includes(assignmentValue));
assert(!rendered.includes("fixture-material-not-a-real-key"));
assert(result.redactions["sensitive-field"] >= 1);
assert(result.redactions["openai-key"] >= 1);
assert(result.redactions["github-token"] >= 1);
assert(result.redactions["credential-assignment"] >= 1);
assert(result.redactions["private-key"] >= 1);
const repeated = sanitizeManagedState(result.value);
assert.equal(repeated.changed, false, "sanitation is idempotent");

const rawDiagnostic = {
  role: "assistant",
  content: `private response ${providerShaped}`,
  usage: { input: 12, output: 7 },
  toolName: "read",
  input: { path: "docs/example.md", offset: 1 },
  result: { text: "private tool result" },
  payload: { messages: [{ role: "user", content: "private provider request" }] },
  toolCall: { name: "debug_ledger", arguments: { observation: "private tool argument" } },
};
const diagnostic = sanitizeManagedDiagnosticState(rawDiagnostic);
const diagnosticText = JSON.stringify(diagnostic.value);
assert.equal(diagnostic.value.role, "assistant");
assert.deepEqual(diagnostic.value.usage, rawDiagnostic.usage);
assert.equal(diagnostic.value.toolName, "read");
assert.equal(diagnostic.value.content, undefined);
assert(diagnostic.value.contentSummary.chars > 0 && diagnostic.value.contentSummary.chars <= rawDiagnostic.content.length, "content metadata remains bounded after secret redaction");
assert.equal(diagnostic.value.inputSummary.type, "object");
assert.equal(diagnostic.value.resultSummary.type, "object");
assert.equal(diagnostic.value.payloadSummary.type, "object");
assert.equal(diagnostic.value.toolCall.arguments, undefined);
assert.equal(diagnostic.value.toolCall.argumentsSummary.type, "object");
assert(!diagnosticText.includes(providerShaped));
assert(!diagnosticText.includes("private tool result"));
assert.equal(sanitizeManagedDiagnosticState(diagnostic.value).changed, false, "diagnostic sanitation is idempotent");

const memory = new CognitiveMemory();
const remembered = memory.remember({
  type: "episodic",
  title: "Assistant turn",
  content: `Useful result; token=${assignmentValue}`,
  metadata: { thinkingSignature: providerShaped, retainedCounter: 3 },
  provenance: { source: "pi-message" },
});
assert.equal(remembered.accepted, true);
assert(isDiagnosticTextMetadata(remembered.entry.content));
assert(!remembered.entry.content.includes(assignmentValue));
assert.equal(remembered.entry.metadata.thinkingSignature, "[REDACTED:sensitive-field]");
assert.equal(remembered.entry.metadata.retainedCounter, 3);

const storage = new MemoryJsonStorage();
const entropy = new EntropyPersistenceAdapter(storage);
entropy.recordEvent({ type: "event", text: `Observed api_key=${assignmentValue}`, tokens: 9 });
entropy.recordSnapshot({ metrics: { entropyScore: 0.2 }, note: providerShaped });
const storedEvent = storage.readJsonl("entropy/events")[0];
const storedSnapshot = storage.readJsonl("entropy/snapshots")[0];
assert.equal(storedEvent.text, undefined);
assert.equal(storedEvent.textSummary.type, "string");
assert(storedEvent.textSummary.chars > 0 && storedEvent.textSummary.chars <= `Observed api_key=${assignmentValue}`.length);
assert.equal(storedEvent.tokens, 9);
assert(!storedSnapshot.note.includes(providerShaped));
assert.equal(storedSnapshot.metrics.entropyScore, 0.2);

// Snapshots are recorded on every observation; recording must not re-read the
// unbounded snapshot history.
class CountingStorage extends MemoryJsonStorage { readJsonl(key) { this.historyReads = (this.historyReads || 0) + 1; return super.readJsonl(key); } }
const countingStorage = new CountingStorage();
const countingEntropy = new EntropyPersistenceAdapter(countingStorage);
for (let i = 0; i < 5; i++) countingEntropy.recordSnapshot({ metrics: { entropyScore: i / 10 } });
assert.equal(countingStorage.historyReads || 0, 0, "recordSnapshot never reads the snapshot history");
assert.equal(countingEntropy.loadStats().count, 5);
assert.equal(countingEntropy.loadSnapshots(2).length, 2);

const entropyDir = tmpFixture("pi-entropy-private-");
const metrics = new MetricsPersistence({ dir: entropyDir });
metrics.recordEvent({ type: "event", text: `token=${assignmentValue}`, tokens: 7 });
metrics.recordSnapshot({ metrics: { entropyScore: 0.3 }, note: githubShaped });
const diskText = [
  fs.readFileSync(path.join(entropyDir, "events.jsonl"), "utf8"),
  fs.readFileSync(path.join(entropyDir, "snapshots.jsonl"), "utf8"),
].join("\n");
assert(!diskText.includes(assignmentValue));
assert(!diskText.includes(githubShaped));
assert(diskText.includes("textSummary"));
assert(diskText.includes("entropyScore"));

console.log("managed-state sanitizer tests passed");
