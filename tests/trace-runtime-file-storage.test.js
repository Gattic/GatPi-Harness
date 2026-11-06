"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { TraceRuntime, FileTraceStorage, ReplayIndex } = require("../src/trace-observability");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-trace-runtime-");
const storage = new FileTraceStorage({ root: tmp, sessionId: "s", rotateBytes: 1_000_000, compressPayloadBytes: 20, capturePayloads: true });
const trace = new TraceRuntime({ storage, sessionId: "s" });
const corr = trace.setCorrelation("corr-1");
trace.emit({ category: "session", name: "start", subsystem: "test", payload: { small: true } });
trace.emit({ category: "model_request", name: "large", subsystem: "test", payload: { text: "x".repeat(100) } });
assert.equal(corr, "corr-1");
assert(fs.existsSync(storage.path()));
const events = ReplayIndex.readEvents(storage.path());
assert.equal(events.length, 2);
assert(events[1].payload_ref, "large payloads are compressed into refs");
assert.equal(trace.export("corr").length, 2);
assert.equal(trace.replaySummary().steps, 2);
// Disposable metadata traces are pruned oldest-first; active files and
// payload-bearing evidence remain protected.
const retTmp = tmpFixture("pi-trace-retention-");
const retention = new FileTraceStorage({ root: retTmp, sessionId: "r", rotateBytes: 2_000, maxTotalBytes: 6_000, compressPayloadBytes: 1_000_000, capturePayloads: false });
for (let i = 0; i < 40; i++) {
  retention.write({ category: "session", name: `evt-${i}`, subsystem: "test", diagnosticPadding: "y".repeat(400) });
}
retention.write({ category: "session", name: "final", subsystem: "test", payload: { small: true } });
const files = fs.readdirSync(retTmp);
assert(files.includes(path.basename(retention.path())), "active trace file is kept");
const totalBytes = files.reduce((sum, f) => sum + fs.statSync(path.join(retTmp, f)).size, 0);
assert(totalBytes <= 6_000 + 2_000, `total trace bytes stay near the cap, got ${totalBytes}`);
assert(files.length < 10, `old rotated files are pruned, got ${files.length}: ${files.join(", ")}`);

const privateDefaultRoot = tmpFixture("pi-trace-private-default-");
const privateDefault = new FileTraceStorage({ root: privateDefaultRoot, sessionId: "private-default" });
privateDefault.write({ category: "session", name: "private", subsystem: "test", payload: { secret: "PRIVATE_TRACE_PAYLOAD" } });
const privateDefaultText = fs.readFileSync(privateDefault.path(), "utf8");
assert(!privateDefaultText.includes("PRIVATE_TRACE_PAYLOAD"), "new trace storage omits payloads by default");
assert.equal(ReplayIndex.readEvents(privateDefault.path())[0].payload, undefined);
let disabledPayloadReads = 0;
const lazyPayload = {};
Object.defineProperty(lazyPayload, "expensive", {
  enumerable: true,
  get() {
    disabledPayloadReads += 1;
    return { nested: "must not be materialized" };
  },
});
privateDefault.write({ category: "session", name: "lazy-private", subsystem: "test", payload: lazyPayload });
assert.equal(disabledPayloadReads, 0, "disabled payload capture must not sanitize or clone payload data");

// Captured traces preserve diagnostic shape while sanitizing lexical secrets
// and provider-private fields before inline or compressed persistence.
const privacyRoot = tmpFixture("pi-trace-private-payloads-");
const privacy = new FileTraceStorage({ root: privacyRoot, sessionId: "privacy", compressPayloadBytes: 80, capturePayloads: true });
const providerShaped = `sk-${"Q".repeat(24)}`;
privacy.write({ category: "model_response", name: "inline", subsystem: "test", payload: { thinkingSignature: providerShaped, status: "useful" } });
privacy.write({ category: "model_response", name: "compressed", subsystem: "test", payload: { note: `token=${"R".repeat(24)}`, filler: "z".repeat(300) } });
const privateEvents = ReplayIndex.readEvents(privacy.path());
assert.equal(privateEvents[0].payload.thinkingSignature, "[REDACTED:sensitive-field]");
assert.equal(privateEvents[0].payload.status, "useful");
assert(privateEvents[1].payload_ref, "sanitized large payload remains compressed");
const compressedPayload = JSON.parse(require("node:zlib").gunzipSync(Buffer.from(privateEvents[1].payload_ref.data, "base64")).toString("utf8"));
assert(!compressedPayload.note.includes("R".repeat(24)));
assert.equal(compressedPayload.filler.length, 300);
const privacyText = fs.readFileSync(privacy.path(), "utf8");
assert(!privacyText.includes(providerShaped));
assert(!privacyText.includes("R".repeat(24)));

const diagnosticRoot = tmpFixture("pi-trace-diagnostic-metadata-");
const diagnostic = new FileTraceStorage({ root: diagnosticRoot, sessionId: "diagnostic", compressPayloadBytes: 10_000, capturePayloads: true });
const responseText = "private response body";
const toolResultText = "private tool result";
diagnostic.write({ category: "model_response", name: "message_update", subsystem: "test", payload: { role: "assistant", content: responseText, usage: { input: 12, output: 4 }, input: { path: "docs/private.md" }, result: { text: toolResultText } } });
const diagnosticEvent = ReplayIndex.readEvents(diagnostic.path())[0];
assert.equal(diagnosticEvent.payload.role, "assistant");
assert.deepEqual(diagnosticEvent.payload.usage, { input: 12, output: 4 });
assert.equal(diagnosticEvent.payload.content, undefined);
assert.equal(diagnosticEvent.payload.contentSummary.chars, responseText.length);
assert.equal(diagnosticEvent.payload.inputSummary.type, "object");
assert.equal(diagnosticEvent.payload.resultSummary.type, "object");
const diagnosticText = fs.readFileSync(diagnostic.path(), "utf8");
assert(!diagnosticText.includes(responseText));
assert(!diagnosticText.includes(toolResultText));
assert(!/\b(role|assistant|user|tool)\b.{0,120}\b(content|transcript|messages)\b/i.test(diagnosticText));

for (const item of [storage, retention, privateDefault, privacy, diagnostic]) item.close();
for (const dir of [tmp, retTmp, privateDefaultRoot, privacyRoot, diagnosticRoot]) fs.rmSync(dir, { recursive: true, force: true });
console.log("trace-runtime-file-storage tests passed");
