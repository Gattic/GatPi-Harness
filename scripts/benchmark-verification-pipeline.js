#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Verifier, VerificationCache, EvidenceStore, VerificationMetrics, VerifiedExecutionPipeline } = require("../src/verification-pipeline");

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-verification-bench-"));
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src/a.js"), "module.exports = { a }; function a(){ return 1; }\n");

  const started = [];
  const verifier = (id, kind, extra = {}) => new Verifier({
    id, kind, files: ["src/**/*.js"], cacheable: true,
    run: async () => { started.push(id); return { ok: true, benchmarks: kind === "benchmark" ? { verifyOverheadMs: 1 } : undefined }; },
    ...extra,
  });
  const pipeline = new VerifiedExecutionPipeline({
    verifiers: [
      verifier("compile", "compile"), verifier("lint", "lint", { dependsOn: ["compile"] }), verifier("unit", "unit", { dependsOn: ["compile"] }),
      verifier("integration", "integration", { dependsOn: ["unit"] }), verifier("static", "static-analysis"), verifier("security", "security"),
      verifier("benchmark", "benchmark", { dependsOn: ["unit"] }), verifier("format", "format"),
    ],
    cache: new VerificationCache(path.join(tmp, "cache.json")),
    evidenceStore: new EvidenceStore(path.join(tmp, "evidence")),
    metrics: new VerificationMetrics(path.join(tmp, "metrics.json")),
    concurrency: 8,
  });

  const runs = Number(process.argv[2] || 100);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < runs; i++) {
    await pipeline.verify({
      cwd: tmp,
      baseline: { benchmarks: { verifyOverheadMs: 1 } },
      patchSet: { id: "bench", files: ["src/a.js"] },
      changeSet: { changedFiles: ["src/a.js"], before: { "src/a.js": "module.exports = { a }; function a(){ return 1; }\n" }, after: { "src/a.js": "module.exports = { a }; function a(){ return 2; }\n" } },
    });
  }
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(JSON.stringify({ runs, elapsedMs, averageMs: elapsedMs / runs, actualVerifierExecutions: started.length, cacheHitAvoidedExecutions: runs * 8 - started.length }, null, 2));
})().catch((err) => { console.error(err); process.exit(1); });
