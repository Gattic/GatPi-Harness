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

function stageFixture(stage) {
  const tmp = tmpFixture("pi-memory-shadow-proposal-");
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
  const rollout = stage === "M1"
    ? resolveProjectMemoryRollout(env)
    : resolveProjectMemoryRollout({ ...env, PI_PROJECT_MEMORY_STAGE: stage }, { kind: "rollout.evaluated", effectiveStage: stage, insufficient: [] });
  assert.equal(rollout.effectiveStage, stage);
  assert.equal(rollout.controls.shadowCandidates, true);
  assert.equal(rollout.controls.candidateCapture, false);

  let now = BASE;
  const clock = () => new Date(now);
  let sessionHash = sha256("shadow-proposal-session");
  const trace = new TraceRuntime({
    storage: new FileTraceStorage({ root: path.join(cwd, ".pi", "traces"), sessionId: "shadow-proposal-test", cwd }),
  });
  const telemetry = {
    emit: (event) => {
      trace.emit({
        category: event.category === "memory_curation" ? "memory_curation" : "memory_decision",
        name: event.name,
        subsystem: "project-memory",
        session_id: "shadow-proposal-test",
        payload: { ...event, sessionId: "shadow-proposal-test" },
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
  const entry = {
    id: "cog-proposal",
    type: "semantic",
    title: "Shadow proposal",
    content: "Durable candidate content for the ledger smoke check.",
    verification: "verified",
    tags: ["decision"],
    provenance: { source: "interactive" },
  };
  const readTrace = () => {
    const dir = path.join(cwd, ".pi", "traces");
    return fs.readdirSync(dir)
      .filter((file) => file.endsWith(".jsonl"))
      .flatMap((file) => fs.readFileSync(path.join(dir, file), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));
  };
  return { tmp, cwd, env, adapter, pipeline, entry, readTrace, setNow: (value) => { now = value; }, setSessionHash: (value) => { sessionHash = value; } };
}

function m2Fixture() { return stageFixture("M2"); }

test("M2 records a shadow proposal in the decision ledger", () => {
  const fixture = m2Fixture();
  const settle = fixture.pipeline.settle([fixture.entry]);
  assert.equal(settle.enabled, true);
  assert.equal(settle.decisions.length, 1);
  assert.equal(settle.decisions[0].outcome, "shadowed");

  // The proposal is persisted, not only returned to the caller.
  const proposals = fixture.adapter.decisions({ limit: Infinity }).filter((row) => row.action === "shadowed");
  assert.equal(proposals.length, 1, "exactly one proposal row is persisted");
  const proposal = proposals[0];
  assert.equal(proposal.decisionId, settle.decisions[0].decisionId, "the ledger row is the settle decision");
  assert.match(proposal.sessionIdHash, /^[a-f0-9]{16,64}$/, "the proposal carries its session attribution");
  assert.equal(proposal.verification, "verified");
  assert.equal(proposal.automatic, false, "M2 records the proposal without automatic capture");

  // The proposal event reaches the trace with the same hash and session.
  const proposed = fixture.readTrace().filter((event) => event.name === "shadow.proposed");
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0].payload.proposalHash, proposal.candidateHash);
  assert.equal(proposed[0].payload.sessionIdHash, proposal.sessionIdHash);
  assert.equal(proposed[0].payload.applied, false);

  fs.rmSync(fixture.tmp, { recursive: true, force: true });
});

test("the recorded proposal is consumed as a shadow outcome", () => {
  const fixture = m2Fixture();
  assert.equal(fixture.pipeline.settle([fixture.entry]).decisions[0].outcome, "shadowed");
  const proposal = fixture.adapter.decisions({ limit: Infinity }).find((row) => row.action === "shadowed");

  fixture.setNow(BASE + 60 * 60 * 1000);
  const saved = fixture.adapter.save(
    { kind: "decision", title: fixture.entry.title, content: fixture.entry.content, verification: "verified" },
    { apply: true, explicit: true },
  );
  assert.equal(saved.decision.action, "saved");

  const outcomes = fixture.readTrace().filter((event) => event.name === "shadow.outcome");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].payload.proposalHash, proposal.candidateHash);
  assert.equal(outcomes[0].payload.agreed, true);
  assert.equal(outcomes[0].payload.applied, false);
  assert.equal(outcomes[0].payload.sessionIdHash, proposal.sessionIdHash);

  // The evaluator consumes the recorded proposal: one agreed outcome replaces
  // the missing-outcome state, even though the sample thresholds still gate SD.
  const evaluation = evaluateProjectMemoryRollout({
    cwd: fixture.cwd,
    env: fixture.env,
    now: BASE + 7 * DAY,
    refresh: true,
    emit: false,
    privacy: null,
    baseline: null,
  });
  assert.equal(evaluation.predicates.SD.metrics.outcomes, 1);
  assert.equal(evaluation.predicates.SD.metrics.sessions, 1);
  assert.equal(evaluation.predicates.SD.metrics.days, 1);
  assert.ok(!evaluation.predicates.SD.reasons.includes("shadow-outcomes-missing"));
  assert.ok(evaluation.predicates.SD.reasons.includes("shadow-samples-below-minimum"));

  fs.rmSync(fixture.tmp, { recursive: true, force: true });
});

test("SD moves from below-minimum to pass as agreed outcomes accrue", () => {
  const fixture = m2Fixture();
  let now = BASE;
  for (let day = 0; day < 7; day++) {
    fixture.setSessionHash(sha256(`agreed-session-${day}`));
    for (let sample = 0; sample < 3; sample++) {
      now = BASE + day * DAY + (sample + 1) * 60000;
      fixture.setNow(now);
      const entry = {
        ...fixture.entry,
        id: `cog-agreed-${day}-${sample}`,
        title: `Agreed proposal ${day}-${sample}`,
        content: `Durable agreed content ${day}-${sample}.`,
      };
      assert.equal(fixture.pipeline.settle([entry]).decisions[0].outcome, "shadowed");
      const saved = fixture.adapter.save(
        { kind: "decision", title: entry.title, content: entry.content, verification: "verified" },
        { apply: true, explicit: true },
      );
      assert.equal(saved.decision.action, "saved");
    }
    if (day === 0) {
      const partial = evaluateProjectMemoryRollout({ cwd: fixture.cwd, env: fixture.env, now, refresh: true, emit: false, privacy: null, baseline: null });
      assert.equal(partial.predicates.SD.status, "insufficient");
      assert.ok(partial.predicates.SD.reasons.includes("shadow-samples-below-minimum"));
      assert.equal(partial.predicates.SD.metrics.outcomes, 3);
      assert.equal(partial.predicates.SD.metrics.sessions, 1);
      assert.equal(partial.predicates.SD.metrics.days, 1);
    }
  }

  const healthy = evaluateProjectMemoryRollout({ cwd: fixture.cwd, env: fixture.env, now, refresh: true, emit: false, privacy: null, baseline: null });
  assert.equal(healthy.predicates.SD.status, "pass");
  assert.equal(healthy.predicates.SD.metrics.outcomes, 21);
  assert.equal(healthy.predicates.SD.metrics.sessions, 7);
  assert.equal(healthy.predicates.SD.metrics.days, 7);
  assert.equal(healthy.predicates.SD.metrics.agreement, 1);

  fs.rmSync(fixture.tmp, { recursive: true, force: true });
});

test("agreed:false outcomes are recorded and consumed into the agreement bar", () => {
  const fixture = m2Fixture();
  // Seed the conflicting titles so the first real decision for those
  // candidates is a review-queued conflict rather than a save.
  for (let day = 0; day < 3; day++) {
    const existing = fixture.adapter.save(
      { kind: "decision", title: `Shared title ${day}`, content: `First durable fact ${day}.`, verification: "verified" },
      { apply: true, explicit: true },
    );
    assert.equal(existing.decision.action, "saved");
  }

  const disagreements = [];
  let now = BASE;
  for (let day = 0; day < 7; day++) {
    fixture.setSessionHash(sha256(`disagreement-session-${day}`));
    for (let sample = 0; sample < 3; sample++) {
      now = BASE + day * DAY + (sample + 1) * 60000;
      fixture.setNow(now);
      const conflict = day < 3 && sample === 0;
      const entry = {
        ...fixture.entry,
        id: `cog-disagreement-${day}-${sample}`,
        title: conflict ? `Shared title ${day}` : `Agreed proposal ${day}-${sample}`,
        content: conflict ? `Conflicting durable fact ${day}.` : `Durable agreed content ${day}-${sample}.`,
      };
      assert.equal(fixture.pipeline.settle([entry]).decisions[0].outcome, "shadowed");
      const saved = fixture.adapter.save(
        { kind: "decision", title: entry.title, content: entry.content, verification: "verified" },
        { apply: true, explicit: true },
      );
      if (conflict) {
        assert.equal(saved.decision.action, "review-queued");
        disagreements.push(saved.decision);
      } else {
        assert.equal(saved.decision.action, "saved");
      }
    }
  }
  assert.equal(disagreements.length, 3);

  // The disagreement decisions are persisted with the proposal's candidate hash.
  const ledger = fixture.adapter.decisions({ limit: Infinity });
  for (const decision of disagreements) {
    const row = ledger.find((entry) => entry.decisionId === decision.decisionId);
    assert.equal(row.action, "review-queued");
    assert.equal(row.candidateHash, decision.candidateHash);
  }

  // Each agreed:false outcome reaches the trace with its proposal hash.
  const outcomes = fixture.readTrace().filter((event) => event.name === "shadow.outcome");
  assert.equal(outcomes.length, 21);
  const rejected = outcomes.filter((event) => event.payload.agreed === false);
  assert.equal(rejected.length, 3);
  for (const decision of disagreements) {
    assert.ok(rejected.some((event) => event.payload.proposalHash === decision.candidateHash), "each disagreement is consumed");
  }

  const evaluation = evaluateProjectMemoryRollout({ cwd: fixture.cwd, env: fixture.env, now, refresh: true, emit: false, privacy: null, baseline: null });
  assert.equal(evaluation.predicates.SD.status, "fail");
  assert.ok(evaluation.predicates.SD.reasons.includes("shadow-agreement-below-bar"));
  assert.ok(!evaluation.predicates.SD.reasons.includes("shadow-samples-below-minimum"), "the sample gate is passed");
  assert.ok(Math.abs(evaluation.predicates.SD.metrics.agreement - 18 / 21) < 1e-9);

  fs.rmSync(fixture.tmp, { recursive: true, force: true });
});

test("M1 records a shadow proposal and resolves it into a shadow outcome", () => {
  const fixture = stageFixture("M1");
  assert.equal(fixture.pipeline.settle([fixture.entry]).decisions[0].outcome, "shadowed");
  const proposal = fixture.adapter.decisions({ limit: Infinity }).find((row) => row.action === "shadowed");
  const proposed = fixture.readTrace().filter((event) => event.name === "shadow.proposed");
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0].payload.proposalHash, proposal.candidateHash);

  fixture.setNow(BASE + 60 * 60 * 1000);
  const saved = fixture.adapter.save(
    { kind: "decision", title: fixture.entry.title, content: fixture.entry.content, verification: "verified" },
    { apply: true, explicit: true },
  );
  assert.equal(saved.decision.action, "saved");

  const outcomes = fixture.readTrace().filter((event) => event.name === "shadow.outcome");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].payload.agreed, true);
  assert.equal(outcomes[0].payload.applied, false);
  assert.equal(outcomes[0].payload.proposalHash, proposal.candidateHash);
  assert.equal(outcomes[0].payload.sessionIdHash, proposal.sessionIdHash);

  const evaluation = evaluateProjectMemoryRollout({
    cwd: fixture.cwd,
    env: fixture.env,
    now: BASE + 7 * DAY,
    refresh: true,
    emit: false,
    privacy: null,
    baseline: null,
  });
  assert.equal(evaluation.predicates.SD.metrics.outcomes, 1);
  assert.equal(evaluation.predicates.SD.metrics.sessions, 1);
  assert.equal(evaluation.predicates.SD.metrics.days, 1);
  assert.ok(!evaluation.predicates.SD.reasons.includes("shadow-outcomes-missing"));

  fs.rmSync(fixture.tmp, { recursive: true, force: true });
});
