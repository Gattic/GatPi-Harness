"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Verifier, VerifiedExecutionPipeline } = require("../src/verification-pipeline");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-proof-example-"));
fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
fs.writeFileSync(path.join(tmp, "src/app.js"), "module.exports = { answer };\nfunction answer() { return 41; }\n");

function gate(id, kind, extra = {}) {
  return new Verifier({
    id,
    kind,
    files: ["src/**/*.js"],
    run: async () => ({ ok: true, output: `${kind} passed`, artifacts: [`proof/${id}.txt`] }),
    ...extra,
  });
}

const pipeline = new VerifiedExecutionPipeline({
  verifiers: [
    gate("compile", "compile"),
    gate("lint", "lint", { dependsOn: ["compile"] }),
    gate("unit", "unit", { dependsOn: ["compile"], run: async () => ({ ok: true, coverage: { lines: 0.94 } }) }),
    gate("integration", "integration", { dependsOn: ["unit"] }),
    gate("static", "static-analysis", { dependsOn: ["lint"] }),
    gate("security", "security", { impacts: ["security", "dependency"] }),
    gate("benchmark", "benchmark", { dependsOn: ["unit"], impacts: ["semantic", "performance"], run: async () => ({ ok: true, benchmarks: { latencyMs: 8.7 } }) }),
    gate("format", "format"),
  ],
  feedbackSinks: [(evidence) => {
    // Planner/coder/memory agents can consume this compact proof summary.
    fs.writeFileSync(path.join(tmp, "last-feedback.json"), JSON.stringify({ ok: evidence.ok, confidence: evidence.confidence, impact: evidence.impact.categories }, null, 2));
  }],
});

(async () => {
  const evidence = await pipeline.execute({
    cwd: tmp,
    baseline: { benchmarks: { latencyMs: 9.0 }, coverage: { lines: 0.92 } },
    patchSet: { id: "raise-answer", files: ["src/app.js"] },
    apply: async () => {
      fs.writeFileSync(path.join(tmp, "src/app.js"), "module.exports = { answer };\nfunction answer() { return 42; }\n");
      return { changedFiles: ["src/app.js"] };
    },
  });

  console.log(JSON.stringify({ ok: evidence.ok, confidence: evidence.confidence, evidenceFile: evidence.evidenceFile, benchmarkDeltas: evidence.benchmarkDeltas }, null, 2));
})().catch((err) => { console.error(err); process.exit(1); });
