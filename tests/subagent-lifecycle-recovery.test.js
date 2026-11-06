"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { processIdentity } = require("../src/resource-guard");
const { SubagentService } = require("../src/subagents");
const { tmpFixture } = require("./helpers/tmp-fixture");

const root = path.join(__dirname, "..");
const tmp = tmpFixture("pi-subagent-recovery-");
const recordsDir = path.join(tmp, ".pi", "subagents", "records");

// Reproduce the observed orphan: a supervising process admits and starts a
// child run, then the supervisor closes before the run reaches a terminal
// state. The record on disk is left as "running" with no timestamps.
const supervisorScript = `
const fs = require("node:fs");
const { SubagentService } = require(process.env.PI_SUBAGENTS_LIB);
const service = new SubagentService({ cwd: process.env.PI_SUBAGENTS_CWD, runner: { run: () => new Promise(() => {}), steer: () => false, interrupt: () => false } });
const created = service.createSubagent({ parentSessionId: "session-orphan", role: "worker", task: "Fixture run abandoned by a closing supervisor" });
service.launchSubagent({ subagentId: created.id });
const file = service.store.recordFile(created.id);
const deadline = Date.now() + 10000;
while (Date.now() < deadline) {
  try { if (JSON.parse(fs.readFileSync(file, "utf8")).status === "running") { process.stdout.write(created.id); process.exit(0); } } catch {}
}
process.exit(2);
`;
const supervisor = spawnSync(process.execPath, ["-e", supervisorScript], {
  encoding: "utf8",
  timeout: 20000,
  env: { ...process.env, PI_SUBAGENTS_LIB: path.join(root, "src", "subagents.js"), PI_SUBAGENTS_CWD: tmp },
});
assert.equal(supervisor.status, 0, `supervisor fixture failed: ${supervisor.stderr}`);
const orphanId = String(supervisor.stdout).trim();
assert.match(orphanId, /^sub_[a-f0-9]+$/);

const service = new SubagentService({ cwd: tmp });
const orphan = service.getSubagent({ subagentId: orphanId });
assert.equal(orphan.status, "running", "fixture precondition: supervisor closed mid-run");
assert(!orphan.processClosedAt, "no processClosedAt after supervisor close");
assert(!orphan.finishedAt, "no finishedAt after supervisor close");
assert(!orphan.termination);
assert.equal(service.status({ parentSessionId: "session-orphan" }).active, 1, "orphan still counts as active");

// A legacy record written before owner identity was persisted has no owner at
// all; it cannot be live because every current run records its supervisor.
const at = new Date().toISOString();
const legacy = { schemaVersion: 3, id: "sub_legacy00000000", parentSessionId: "session-legacy", role: "worker", status: "running", createdAt: at, startedAt: at, updatedAt: at, budget: {}, workspacePolicy: "shared-readonly", diagnostics: {} };
fs.writeFileSync(path.join(recordsDir, `${legacy.id}.json`), JSON.stringify(legacy));

// A record owned by a live supervising process must never be reconciled from
// another session in the same checkout.
const identity = processIdentity(process.pid);
const live = { schemaVersion: 3, id: "sub_live000000000", parentSessionId: "session-live", role: "worker", status: "running", createdAt: at, startedAt: at, updatedAt: at, budget: {}, workspacePolicy: "shared-readonly", owner: { pid: process.pid, startTime: identity?.startTime ?? null }, diagnostics: {} };
fs.writeFileSync(path.join(recordsDir, `${live.id}.json`), JSON.stringify(live));

(async () => {
  // A created record is pending, not orphaned: reconciliation must never finalize it.
  const pending = service.createSubagent({ parentSessionId: "session-pending", role: "worker", task: "Pending task that was never launched" });
  assert.equal(pending.status, "created");

  // Launching a dead-owner record must reconcile it instead of reporting
  // "already running" forever.
  const launch = service.launchSubagent({ subagentId: orphanId });
  assert.equal(launch.launched, false);
  assert.equal(launch.alreadyTerminal, true);
  assert.equal(launch.recovered, true);

  const settled = service.getSubagent({ subagentId: orphanId });
  assert.equal(settled.status, "failed");
  assert.ok(settled.processClosedAt, "processClosedAt recorded");
  assert.ok(settled.finishedAt, "finishedAt recorded");
  assert.equal(settled.termination.code, "supervisor_lost");
  assert.equal(settled.resumable, true);
  assert.match(settled.receiptId, /^receipt_[a-f0-9]{20}$/);
  const result = service.store.getResult(orphanId);
  assert(result, "terminal result persisted");
  assert.equal(result.status, "failed");
  assert.equal(result.receiptId, settled.receiptId);
  assert.equal(service.status({ parentSessionId: "session-orphan" }).active, 0, "orphan no longer active");
  assert(service.events({ subagentId: orphanId }).some((event) => event.type === "subagent.process_closed"), "process_closed event emitted");
  assert(service.events({ subagentId: orphanId }).some((event) => event.type === "subagent.failed" && event.reasonCode === "supervisor-lost"), "failure event carries the reason");

  // Scoped reconciliation heals only the requested session's legacy record.
  const recovered = service.recoverInterruptedRuns({ parentSessionId: "session-legacy" });
  assert.deepEqual(recovered.map((record) => record.id), [legacy.id]);
  assert.equal(service.getSubagent({ subagentId: legacy.id }).status, "failed");
  assert.ok(service.getSubagent({ subagentId: legacy.id }).finishedAt);
  assert.equal(service.getSubagent({ subagentId: live.id }).status, "running");
  assert(!service.getSubagent({ subagentId: live.id }).finishedAt);
  assert.equal(service.getSubagent({ subagentId: pending.id }).status, "created", "pending record untouched");

  // A queued record whose supervisor closed before it started is also terminal.
  const queued = { schemaVersion: 3, id: "sub_queued0000000", parentSessionId: "session-queued", role: "worker", status: "queued", createdAt: at, queuedAt: at, updatedAt: at, budget: {}, workspacePolicy: "shared-readonly", diagnostics: {} };
  fs.writeFileSync(path.join(recordsDir, `${queued.id}.json`), JSON.stringify(queued));
  assert.deepEqual(service.recoverInterruptedRuns({ parentSessionId: "session-queued" }).map((record) => record.id), [queued.id]);
  assert.equal(service.getSubagent({ subagentId: queued.id }).status, "failed");
  assert.equal(service.recoverInterruptedRuns({ parentSessionId: "session-orphan" }).length, 0, "terminal records are not re-finalized");

  // The close time is bounded by the supervisor's wall-clock budget, not by the
  // idle time since it died; malformed persisted diagnostics cannot abort the sweep.
  const staleStartedAt = new Date(Date.now() - 48 * 3600_000).toISOString();
  const stale = { schemaVersion: 3, id: "sub_stale00000000", parentSessionId: "session-stale", role: "worker", status: "running", createdAt: staleStartedAt, startedAt: staleStartedAt, updatedAt: staleStartedAt, budget: { wallClockMs: 60_000 }, workspacePolicy: "shared-readonly", diagnostics: { errors: {} } };
  fs.writeFileSync(path.join(recordsDir, `${stale.id}.json`), JSON.stringify(stale));
  const [staleHealed] = service.recoverInterruptedRuns({ parentSessionId: "session-stale" });
  assert.equal(staleHealed.status, "failed");
  assert.equal(staleHealed.diagnostics.totalDurationMs, 60_000, "duration bounded by wall-clock budget");
  assert.equal(Date.parse(staleHealed.finishedAt) - Date.parse(staleStartedAt), 60_000);
  assert.equal(staleHealed.updatedAt, staleHealed.finishedAt, "retention age reflects close time");
  assert(Array.isArray(staleHealed.diagnostics.errors), "malformed error list normalized");
  assert(staleHealed.diagnostics.errors.some((error) => error.code === "supervisor-lost"));

  // A settled record is never rewritten by a direct or repeated reconciliation.
  assert.equal(service.finalizeInterruptedRun(service.store.get(orphanId)), null);
  assert.equal(service.recoverInterruptedRuns().length, 0, "reconciliation is idempotent");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("subagent lifecycle recovery tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
