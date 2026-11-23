#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { tmpFixture } = require("./helpers/tmp-fixture");
const { projectMemoryRuntimeConfig } = require("../src/project-memory-runtime");
const { ProjectMemoryAdapter } = require("../src/integration-boundary/memory");
const { ProjectMemoryCandidatePipeline } = require("../src/project-memory-candidates");
const { resolveProjectMemoryRollout } = require("../src/project-memory-rollout");
const { evaluateProjectMemoryRollout } = require("../src/memory-rollout-telemetry");
const { TraceRuntime, FileTraceStorage } = require("../src/trace-observability");
const { sha256 } = require("../src/project-memory-schema");

const DAY = 864e5;
const BASE = Date.parse("2026-11-10T09:00:00Z");

test("the real pipeline emits verified explicit saves and shadow outcomes", () => {
  const tmp = tmpFixture("pi-memory-shadow-outcome-");
  const cwd = path.join(tmp, "repo");
  const vault = path.join(tmp, "vault");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".pi", "traces"), { recursive: true });

  const env = {
    ...process.env,
    PI_PROJECT_MEMORY_POSTURE: "env",
    PI_OBSIDIAN_VAULT: vault,
    PI_OBSIDIAN_ALLOW_OUTSIDE: "1",
    PI_PROJECT_MEMORY_STAGE: "M1",
    PI_PROJECT_MEMORY_WRITES: "1",
    PI_PROJECT_MEMORY_READS: "1",
    PI_PROJECT_MEMORY_DIAGNOSTICS: "1",
    PI_PROJECT_MEMORY_AUTOMATIC: "0",
  };
  const runtime = projectMemoryRuntimeConfig(cwd, env, { vault });
  assert.equal(runtime.adapter.writeEnabled, true, "the fixture must authorize explicit writes");

  // M2 controls: explicit writes plus shadow candidate measurement. Candidate
  // capture (M3) stays off, so proposals must be recorded without applying or
  // queueing a review.
  const rollout = resolveProjectMemoryRollout(
    { ...env, PI_PROJECT_MEMORY_STAGE: "M2" },
    { kind: "rollout.evaluated", effectiveStage: "M2", insufficient: [] },
  );
  assert.equal(rollout.effectiveStage, "M2");
  assert.equal(rollout.controls.explicitWrites, true);
  assert.equal(rollout.controls.candidateCapture, false, "M2 does not grant M3 candidate capture");
  assert.equal(rollout.controls.shadowCandidates, true, "M2 measures shadow proposals");

  let now = BASE;
  const clock = () => new Date(now);
  const trace = new TraceRuntime({
    storage: new FileTraceStorage({ root: path.join(cwd, ".pi", "traces"), sessionId: "shadow-outcome-test", cwd }),
  });
  let sessionHash = sha256("shadow-session-0");
  const telemetry = {
    emit: (event) => {
      trace.emit({
        category: event.category === "memory_curation" ? "memory_curation" : "memory_decision",
        name: event.name,
        subsystem: "project-memory",
        session_id: "shadow-outcome-test",
        payload: { ...event, sessionId: "shadow-outcome-test" },
        timestamp: clock().toISOString(),
      });
    },
  };
  const adapter = new ProjectMemoryAdapter({
    ...runtime.adapter,
    clock,
    sessionIdHash: () => sessionHash,
    telemetry,
  });
  const pipeline = new ProjectMemoryCandidatePipeline({ cwd, projectMemory: adapter, rollout, clock });

  for (let day = 0; day < 7; day++) {
    sessionHash = sha256(`shadow-session-${day}`);
    for (let sample = 0; sample < 3; sample++) {
      now = BASE + day * DAY + (sample + 1) * 60000;

      const explicit = adapter.save(
        { kind: "decision", title: `Verified explicit save ${day}-${sample}`, content: `Durable explicit fact recorded on day ${day} sample ${sample}.`, verification: "verified" },
        { apply: true, explicit: true },
      );
      assert.equal(explicit.decision.action, "saved");
      assert.equal(explicit.decision.verification, "verified");
      assert.equal(explicit.decision.automatic, false);

      // The candidate pipeline records the shadow proposal, then the explicit
      // save of the same candidate resolves it and emits shadow.outcome.
      const entry = {
        id: `cog-${day}-${sample}`,
        type: "semantic",
        title: `Shadow proposal ${day}-${sample}`,
        content: `Durable candidate content recorded on day ${day} sample ${sample}.`,
        verification: "verified",
        tags: ["decision"],
        provenance: { source: "interactive" },
      };
      const settle = pipeline.settle([entry]);
      assert.equal(settle.enabled, true);
      assert.equal(settle.decisions[0].outcome, "shadowed", "M2 records a proposal without applying it");
      const resolved = adapter.save(
        { kind: "decision", title: entry.title, content: entry.content, verification: "verified" },
        { apply: true, explicit: true },
      );
      assert.equal(resolved.decision.action, "saved");
    }
  }

  now = BASE + 7 * DAY;
  const evaluation = evaluateProjectMemoryRollout({ cwd, env, now, refresh: true, emit: false, privacy: null, baseline: null });
  assert.equal(evaluation.predicates.S1.status, "pass", JSON.stringify(evaluation.predicates.S1));
  assert.equal(evaluation.predicates.SD.status, "pass", JSON.stringify(evaluation.predicates.SD));
  assert.equal(evaluation.predicates.S1.metrics.saves, 42);
  assert.equal(evaluation.predicates.S1.metrics.days, 7);
  assert.equal(evaluation.predicates.SD.metrics.outcomes, 21);
  assert.equal(evaluation.predicates.SD.metrics.sessions, 7);
  assert.equal(evaluation.predicates.SD.metrics.days, 7);
  assert.equal(evaluation.predicates.SD.metrics.agreement, 1);

  fs.rmSync(tmp, { recursive: true, force: true });
});
