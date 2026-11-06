#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { securityCheckpointPlan, runSecurityCheckpoint, securityCheckpointSummary } = require("../src/security-checkpoint");
const { tmpFixture } = require("./helpers/tmp-fixture");

const root = tmpFixture("pi-security-checkpoint-");
const put = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
try {
  put("docs/auth.md", "Documentation only");
  put("src/value.js", "module.exports = 42;");
  put("src/auth.js", "module.exports = () => true;");
  put("src/worker.js", "require('node:child_process').execFile('git', ['status']);");
  put("generated/auth.js", "eval(input)");
  let scans = 0;
  const scan = (_cwd, files, options) => { scans++; assert.equal(options.advisory, true); assert.equal(options.metrics, "off"); return { semgrep: { ok: true, findings: [], summary: { findings: 0 } }, affectedTests: ["tests/auth.test.js"] }; };
  assert.equal(runSecurityCheckpoint(root, ["docs/auth.md", "src/value.js", "src/deleted.js", "generated/auth.js"], { scan }).status, "not-applicable");
  assert.equal(scans, 0, "low-risk and deleted-only changes never start a scanner");
  const planned = securityCheckpointPlan(root, ["src/auth.js", "src/worker.js"]);
  assert.deepEqual(planned.files, ["src/auth.js", "src/worker.js"]);
  assert.equal(scans, 0, "planning does not scan");
  const checked = runSecurityCheckpoint(root, planned.files, { scan });
  assert.equal(checked.status, "clean");
  assert.equal(checked.gatingSafe, false);
  assert.match(securityCheckpointSummary(checked), /baseline tests remain required/);
  assert.equal(runSecurityCheckpoint(root, ["src/value.js"], { required: true, scan }).applicable, true);
  const broad = Array.from({ length: 10 }, (_, i) => `src/plain${i}.js`);
  broad.forEach(file => put(file, "module.exports = 1"));
  assert.equal(securityCheckpointPlan(root, broad).files.length, 10);
  assert.throws(() => securityCheckpointPlan(root, ["../outside.js"]), /inside repository/);
  fs.symlinkSync(os.tmpdir(), path.join(root, "outside"));
  const outsideFile = path.basename(root) + "-auth.js";
  fs.writeFileSync(path.join(os.tmpdir(), outsideFile), "module.exports = 1");
  try { assert.throws(() => securityCheckpointPlan(root, [`outside/${outsideFile}`]), /inside repository/); }
  finally { fs.unlinkSync(path.join(os.tmpdir(), outsideFile)); }

  const finding = runSecurityCheckpoint(root, ["src/auth.js"], { scan: () => ({ semgrep: { ok: true, findings: [{ path: "src/auth.js" }] }, affectedTests: [] }) });
  assert.equal(finding.status, "findings", "findings are not infrastructure failures");
  const failed = runSecurityCheckpoint(root, ["src/auth.js"], { scan: () => ({ semgrep: { ok: false, infrastructureFailure: true, reason: "scan-failed", findings: [] }, affectedTests: ["tests/auth.test.js"] }) });
  assert.equal(failed.status, "unavailable");
  assert.deepEqual(failed.affectedTests, ["tests/auth.test.js"], "graph hints survive scanner degradation");

  put(".semgrep.yml", "rules: []\n");
  put("fake-semgrep", `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
if (!args.includes('--validate')) console.log(JSON.stringify({ results: [], errors: [] }));
`);
  fs.chmodSync(path.join(root, "fake-semgrep"), 0o755);
  const prior = process.env.PI_SEMGREP_ADVISORY;
  process.env.PI_SEMGREP_ADVISORY = "0";
  try {
    const integrated = runSecurityCheckpoint(root, ["src/auth.js"], { bin: path.join(root, "fake-semgrep"), config: ".semgrep.yml", codegraph: false });
    assert.equal(integrated.status, "clean", "completion checkpoint uses the real adapter despite background enrichment being off");
    assert.equal(integrated.config, ".semgrep.yml");
    const calls = fs.readFileSync(path.join(root, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert(calls.some(args => args.includes("--validate")));
    assert(calls.some(args => args.includes("src/auth.js") && args.includes("--metrics=off")));
    fs.appendFileSync(path.join(root, ".semgrep.yml"), "# rule revision\n");
    runSecurityCheckpoint(root, ["src/auth.js"], { bin: path.join(root, "fake-semgrep"), config: ".semgrep.yml", codegraph: false });
    const updated = fs.readFileSync(path.join(root, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(updated.filter(args => args.includes("--validate")).length, 2, "local rule content changes invalidate config readiness");
  } finally { if (prior == null) delete process.env.PI_SEMGREP_ADVISORY; else process.env.PI_SEMGREP_ADVISORY = prior; }
  console.log("security checkpoint tests passed");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
