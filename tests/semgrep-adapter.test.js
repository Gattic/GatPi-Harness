#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Adapter behavior fixtures must not inherit the parent harness's production
// advisory-mode override; individual tests supply their own enablement cases.
process.env.PI_SEMGREP_ADVISORY = "1";

const {
  semgrepScan,
  semgrepCodegraphAdvisory,
  semgrepConfigReadiness,
  semgrepReliabilityReport,
  recordSemgrepReliability,
  configFromEnv,
  semgrepDoctor,
  createSemgrepAdapter,
  normalizeProjectFile,
  parseSemgrepOutput,
  parseCliArgs,
} = require("../src/semgrep-adapter.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-semgrep-test-");
fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
fs.writeFileSync(path.join(tmp, "src", "foo.js"), "const token = 'abc';\n");
fs.writeFileSync(path.join(tmp, "tests", "foo.test.js"), "require('../src/foo');\n");

assert.equal(normalizeProjectFile(tmp, "src/foo.js"), "src/foo.js");
assert.deepEqual(parseCliArgs('--verbose --budget-tokens 120 src/foo.js'), { opts: { verbose: true, budgetTokens: 120 }, positional: ["src/foo.js"] });
assert.throws(() => parseCliArgs('--text'), /Unknown Semgrep option.*--verbose/);
assert.throws(() => normalizeProjectFile(tmp, "../outside.js"), /Semgrep target must stay inside/);

const parsed = parseSemgrepOutput(JSON.stringify({ results: [{ check_id: "js.demo", path: "src/foo.js", start: { line: 1, col: 1 }, extra: { severity: "WARNING", message: "demo", metadata: { cwe: ["CWE-1"] } } }] }), tmp);
assert.equal(parsed.summary.findings, 1);
assert.equal(parsed.findings[0].severity, "WARNING");
assert.equal(parsed.diagnostics[0].provider, "semgrep");
assert.equal(parsed.diagnostics[0].path, "src/foo.js");
const limited = parseSemgrepOutput(JSON.stringify({ results: [
  { check_id: "low", path: "src/foo.js", extra: { severity: "INFO", message: "low" } },
  { check_id: "critical", path: "src/foo.js", extra: { severity: "ERROR", message: "critical" } },
] }), tmp, { maxFindings: 1 });
assert.equal(limited.findings[0].checkId, "critical", "severity ranking happens before the collection cap");
assert.equal(limited.summary.findings, 2);

const missing = semgrepDoctor(tmp, { bin: path.join(tmp, "missing-semgrep"), timeoutMs: 200 });
assert.equal(missing.binary.found, false);
assert.ok(missing.risks.some((r) => /not installed|not on PATH/.test(r)));

const fakeSemgrep = path.join(tmp, "fake-semgrep.js");
fs.writeFileSync(fakeSemgrep, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("fake-semgrep 1.0.0"); process.exit(0); }
if (args[0] === "scan") {
  if (!args.includes("--json")) { console.log("src/foo.js:1 ERROR demo finding"); process.exit(0); }
  console.log(JSON.stringify({ version: "fake", results: [{ check_id: "js.demo", path: "src/foo.js", start: { line: 1, col: 7 }, end: { line: 1, col: 12 }, extra: { severity: "ERROR", message: "demo finding", metadata: { confidence: "HIGH", category: "security" } } }], errors: [] }));
  process.exit(0);
}
console.error("unexpected semgrep args " + args.join(" "));
process.exit(2);
`);
fs.chmodSync(fakeSemgrep, 0o755);

const scan = semgrepScan(tmp, ["src/foo.js"], { bin: fakeSemgrep, timeoutMs: 1000, config: "p/default" });
assert.equal(scan.ok, true);
assert.equal(scan.scanStatus, "findings");
assert.equal(scan.infrastructureFailure, false);
assert.equal(scan.readiness.binary, true);
assert.equal(scan.readiness.config, true);
assert.equal(scan.readiness.scan, true);
assert.equal(scan.summary.findings, 1);
assert.deepEqual(scan.summary.filesWithFindings, ["src/foo.js"]);
assert.equal(scan.findings[0].checkId, "js.demo");
const healthy = semgrepDoctor(tmp, { bin: fakeSemgrep, timeoutMs: 1000 });
assert.equal(healthy.binary.found, true);
assert.equal(healthy.binaryReady, true);
assert.equal(healthy.configReady, true);
assert.equal(healthy.scanReady, true);
assert.equal(healthy.ready, true);

const autoBlocked = semgrepConfigReadiness(tmp, { bin: fakeSemgrep, config: "auto", metrics: "off", forceConfigProbe: true });
assert.equal(autoBlocked.ready, false);
assert.equal(autoBlocked.errorCode, "SEMGREP_AUTO_METRICS_CONFLICT");
assert.match(autoBlocked.guidance[0], /Use p\/default/);

const fakeCodegraph = path.join(tmp, "fake-codegraph.js");
fs.writeFileSync(fakeCodegraph, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "affected") console.log(JSON.stringify({ tests: ["tests/foo.test.js"], other: ["src/foo.js"] }));
else if (args[0] === "status") console.log("initialized");
else console.log("ok");
`);
fs.chmodSync(fakeCodegraph, 0o755);

const advisory = semgrepCodegraphAdvisory(tmp, ["src/foo.js"], { bin: fakeSemgrep, codegraphBin: fakeCodegraph, timeoutMs: 1000, codegraphTimeoutMs: 1000 });
assert.equal(advisory.semgrep.ok, true);
assert.deepEqual(advisory.semgrep.run.args.slice(0, 3), ["scan", "--config", "p/default"], "the privacy-safe default avoids Semgrep's auto/metrics=off incompatibility");
assert.equal(advisory.semgrep.summary.findings, 1);
assert.deepEqual(advisory.affectedTests, ["tests/foo.test.js"]);
assert.ok(advisory.recommendations.some((r) => /Semgrep/.test(r)));

const probeLog = path.join(tmp, "probe.log");
const unavailableSemgrep = path.join(tmp, "unavailable-semgrep.js");
fs.writeFileSync(unavailableSemgrep, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('fake-semgrep 2.0.0'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(probeLog)}, args.join(' ') + '\\n');
if (args.includes('--validate')) {
  if (args.includes('p/cpp')) { console.error('registry config not found'); process.exit(7); }
  process.exit(0);
}
console.log(JSON.stringify({ results: [], errors: [] }));
`);
fs.chmodSync(unavailableSemgrep, 0o755);
const unavailableFirst = semgrepScan(tmp, ["src/foo.js"], { bin: unavailableSemgrep, config: "p/cpp", metrics: "off", timeoutMs: 1000 });
const unavailableSecond = semgrepScan(tmp, ["src/foo.js"], { bin: unavailableSemgrep, config: "p/cpp", metrics: "off", timeoutMs: 1000 });
assert.equal(unavailableFirst.reason, "config-not-ready");
assert.equal(unavailableFirst.errorCode, "SEMGREP_CONFIG_UNAVAILABLE");
assert.equal(unavailableSecond.configReadiness.cached, true, "unavailable registry packs are not repeatedly retried inside the negative-cache window");
assert.equal(fs.readFileSync(probeLog, "utf8").trim().split(/\n+/).length, 1);
assert.match(fs.readFileSync(probeLog, "utf8"), /--validate/, "a failed preflight never spawns the doomed scan");
delete require.cache[require.resolve("../src/semgrep-adapter")];
const coldReload = require("../src/semgrep-adapter").semgrepScan(tmp, ["src/foo.js"], { bin: unavailableSemgrep, config: "p/cpp", metrics: "off", timeoutMs: 1000 });
assert.equal(coldReload.configReadiness.cached, true, "negative config readiness survives a cold module reload");
assert.equal(fs.readFileSync(probeLog, "utf8").trim().split(/\n+/).length, 1);
const readinessStateFile = path.join(tmp, ".pi", "semgrep", "config-readiness.json");
const readinessStateText = fs.readFileSync(readinessStateFile, "utf8");
assert.equal(fs.statSync(readinessStateFile).mode & 0o777, 0o600);
assert.doesNotMatch(readinessStateText, /p\/cpp|registry config not found|--config|\/tmp\//, "persistent config readiness stores only hashed config identity and bounded categories");
const degraded = semgrepCodegraphAdvisory(tmp, ["src/foo.js"], { bin: unavailableSemgrep, config: "p/cpp", codegraphBin: fakeCodegraph, timeoutMs: 1000, codegraphTimeoutMs: 1000 });
assert.equal(degraded.semgrep.ok, false);
assert.deepEqual(degraded.affectedTests, ["tests/foo.test.js"]);
assert.equal(degraded.semgrep.scanStatus, "not-run");
assert.equal(degraded.semgrep.infrastructureFailure, false, "config readiness is separate from scan infrastructure failure");
assert.ok(degraded.recommendations.some((row) => /Semgrep was not run/.test(row)));

const findingExitSemgrep = path.join(tmp, "finding-exit-semgrep.js");
fs.writeFileSync(findingExitSemgrep, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('fake-semgrep 4.0.0'); process.exit(0); }
if (args.includes('--validate')) process.exit(0);
console.log(JSON.stringify({ version: '4.0.0', results: [{ check_id: 'js.finding', path: 'src/foo.js', extra: { severity: 'ERROR', message: 'finding' } }], errors: [] }));
process.exit(1);
`);
fs.chmodSync(findingExitSemgrep, 0o755);
const findingExit = semgrepScan(tmp, ["src/foo.js"], { bin: findingExitSemgrep, config: "p/default", metrics: "off", errorOnFindings: true, timeoutMs: 1000, forceConfigProbe: true });
assert.equal(findingExit.ok, true, "--error exit 1 with parsed findings is a completed scan, not infrastructure failure");
assert.equal(findingExit.scanStatus, "findings");
assert.equal(findingExit.scan.findingExit, true);
assert.equal(findingExit.infrastructureFailure, false);

const infrastructureSemgrep = path.join(tmp, "infrastructure-semgrep.js");
fs.writeFileSync(infrastructureSemgrep, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('fake-semgrep 5.0.0'); process.exit(0); }
if (args.includes('--validate')) process.exit(0);
console.error('engine crashed');
process.exit(2);
`);
fs.chmodSync(infrastructureSemgrep, 0o755);
const infrastructure = semgrepScan(tmp, ["src/foo.js"], { bin: infrastructureSemgrep, config: "p/default", metrics: "off", timeoutMs: 1000, forceConfigProbe: true });
assert.equal(infrastructure.ok, false);
assert.equal(infrastructure.scanStatus, "infrastructure-failed");
assert.equal(infrastructure.infrastructureFailure, true);
assert.equal(infrastructure.summary.findings, 0);

const failingCodegraph = path.join(tmp, "failing-codegraph.js");
fs.writeFileSync(failingCodegraph, `#!/usr/bin/env node
if (process.argv[2] === 'status') { console.log('initialized'); process.exit(0); }
console.error('graph unavailable'); process.exit(2);
`);
fs.chmodSync(failingCodegraph, 0o755);
const supplementFailure = semgrepCodegraphAdvisory(tmp, ["src/foo.js"], { bin: fakeSemgrep, codegraphBin: failingCodegraph, timeoutMs: 1000, codegraphTimeoutMs: 1000 });
assert.equal(supplementFailure.semgrep.ok, true);
assert.equal(supplementFailure.semgrep.scanStatus, "findings");
assert.equal(supplementFailure.codegraph.status, "supplement-failed");
assert.equal(supplementFailure.supplementFailure, true);

const reliabilityConfig = configFromEnv(process.env, { bin: findingExitSemgrep, config: "p/default", metrics: "off" });
for (let day = 1; day <= 14; day++) recordSemgrepReliability(tmp, reliabilityConfig, { config: "p/default", metrics: "off" }, { status: "findings", infrastructureFailure: false, findingsPresent: true }, { at: `2026-01-${String(day).padStart(2, "0")}T12:00:00.000Z` });
const reliability = semgrepReliabilityReport(tmp, { configObject: reliabilityConfig, config: "p/default", metrics: "off" });
assert.ok(reliability.observedDays >= 14);
assert.equal(reliability.infrastructureErrorRate, 0);
assert.equal(reliability.verdict, "pass");
const reliabilityFile = path.join(tmp, ".pi", "semgrep", "reliability.json");
const reliabilityText = fs.readFileSync(reliabilityFile, "utf8");
assert.equal(fs.statSync(reliabilityFile).mode & 0o777, 0o600);
assert.doesNotMatch(reliabilityText, /p\/default|src\/foo|js\.finding|engine crashed|\/tmp\//, "reliability state stores aggregate categories and hashes only");

const missingLocal = semgrepConfigReadiness(tmp, { bin: unavailableSemgrep, config: "./missing-rules.yml", metrics: "off", forceConfigProbe: true });
assert.equal(missingLocal.errorCode, "SEMGREP_LOCAL_CONFIG_MISSING");
const timeoutSemgrep = path.join(tmp, "timeout-semgrep.js");
fs.writeFileSync(timeoutSemgrep, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('fake-semgrep 3.0.0'); process.exit(0); }
if (args.includes('--validate')) setInterval(() => {}, 1000);
`);
fs.chmodSync(timeoutSemgrep, 0o755);
const timedOutConfig = semgrepConfigReadiness(tmp, { bin: timeoutSemgrep, config: "p/default", metrics: "off", configProbeTimeoutMs: 1000, forceConfigProbe: true });
assert.equal(timedOutConfig.errorCode, "SEMGREP_CONFIG_PROBE_TIMEOUT");
assert.equal(timedOutConfig.status, "timed-out");

const adapter = createSemgrepAdapter({ bin: unavailableSemgrep, config: "p/cpp", metrics: "off", timeoutMs: 1000, codegraphAffectedTests: () => ({ ok: true, tests: ["tests/foo.test.js"] }) });
(async () => {
  const result = await adapter.codegraph({ cwd: tmp }, { files: ["src/foo.js"] });
  assert.equal(result.details.semgrep.ok, false, "tool adapter returns explicit config readiness instead of throwing");
  assert.equal(result.details.semgrep.scanStatus, "not-run");
  assert.equal(result.details.semgrep.infrastructureFailure, false);
  assert.equal(result.details.codegraph.status, "completed-advisory");
  assert.equal(result.details.codegraph.gatingSafe, false);
  assert.deepEqual(result.details.affectedTests, ["tests/foo.test.js"]);
  const failingAdapter = createSemgrepAdapter({ bin: infrastructureSemgrep, config: "p/default", metrics: "off", timeoutMs: 1000 });
  const failedScan = await failingAdapter.scan({ cwd: tmp }, { files: ["src/foo.js"], forceConfigProbe: true });
  assert.equal(failedScan.details.scanStatus, "infrastructure-failed");
  assert.equal(failedScan.details.infrastructureFailure, true);
  const completed = createSemgrepAdapter({ bin: fakeSemgrep, config: "p/default", timeoutMs: 1000, codegraphAffectedTests: () => ({ ok: true, tests: ["tests/foo.test.js"], freshness: "stale", degradation: { code: "stale_index", message: "source changed" } }) });
  const combined = await completed.codegraph({ cwd: tmp }, { files: ["src/foo.js"] });
  assert.match(combined.content[0].text, /js.demo/);
  assert.match(combined.content[0].text, /demo finding/, "diagnostic messages survive envelope re-rendering");
  assert.match(combined.content[0].text, /scan=findings findings=1/);
  assert.match(combined.content[0].text, /stale_index/);
  assert.equal(combined.details.items.length, 1);
  assert.match(combined.details.semgrep.raw, /demo finding/);
  const compact = await completed.scan({ cwd: tmp }, { files: ["src/foo.js"] });
  const verbose = await completed.scan({ cwd: tmp }, { files: ["src/foo.js"], verbose: true });
  assert.equal(verbose.content[0].text, verbose.details.raw);
  assert.equal(compact.details.rendering.modelChars, compact.content[0].text.length);
  assert.equal(compact.details.rendering.rawChars, compact.details.raw.length);
  const structured = await completed.scan({ cwd: tmp }, { files: ["src/foo.js"], json: false });
  assert.equal(structured.details.scanStatus, "findings", "a non-JSON format request must not turn real findings into a clean scan");
  assert.equal(structured.details.summary.findings, 1);
  assert.match(structured.content[0].text, /demo finding/);
  console.log("semgrep adapter checks passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
