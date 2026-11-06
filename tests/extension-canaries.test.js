"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { operationCanaryPlan, recordOperationCanary } = require("../src/extension-canaries.js");
const { readExtensionTelemetry } = require("../src/extension-telemetry.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("extension-canaries-");
const source = path.join(tmp, ".pi", "extensions", "sample", "index.ts");
fs.mkdirSync(path.dirname(source), { recursive: true });
fs.writeFileSync(source, "export default function sample() {}\n");
const report = {
  extensions: [{ name: "sample", sha256: "0123456789abcdeffedcba98765432100123456789abcdeffedcba9876543210" }],
  portfolio: { records: [{ extensionId: "sample", mutationClass: "read-only" }] },
};
const runtime = {
  activeTools: ["sample_tool"],
  tools: [{
    name: "sample_tool",
    sourceInfo: { source: source, path: source },
    parameters: { properties: { operation: { anyOf: [{ const: "status" }, { const: "run" }] } } },
  }],
};
const plan = operationCanaryPlan(report, runtime);
assert.equal(plan.rows.length, 2);
assert.deepEqual(plan.rows.map((row) => row.operation), ["run", "status"]);
assert(plan.rows.every((row) => row.sourceFingerprint === "source_0123456789abcdef"));
assert(plan.rows.every((row) => row.executable === false), "canary planning never executes owning operations");
assert.equal(plan.privacy.arguments, false);

const template = plan.rows[0];
assert.throws(() => recordOperationCanary({ cwd: tmp, plan, record: { canaryId: "stale", stage: "passed" } }), /Unknown operation canaryId/);
assert.throws(() => recordOperationCanary({ cwd: tmp, plan, record: { canaryId: template.canaryId, stage: "planned" } }), /must be passed, failed, or not-applicable/);
const recorded = recordOperationCanary({ cwd: tmp, plan, record: { canaryId: template.canaryId, stage: "passed", durationMs: 12 }, sessionKind: "deterministic-fixture" });
assert.equal(recorded.ok, true);
const telemetry = readExtensionTelemetry({ cwd: tmp });
assert.equal(telemetry.canaries.count, 1);
assert.equal(telemetry.canaries.rows[0].tool, "sample_tool");
assert.equal(telemetry.canaries.rows[0].operation, "run");
assert.equal(telemetry.canaries.rows[0].sourceFingerprint, "source_0123456789abcdef");
const raw = fs.readFileSync(path.join(tmp, ".pi", "extension-telemetry", "events.jsonl"), "utf8");
assert(!raw.includes(source), "canary telemetry does not persist source paths");
console.log("extension canary tests passed");
