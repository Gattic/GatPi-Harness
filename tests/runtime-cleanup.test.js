#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { inspectTracePrivacy, inspectRuntimeState, planCleanup, applyCleanup, formatCleanupPlan } = require("../src/runtime-cleanup");
const { FileIntegrationStorage } = require("../src/file-integration-storage");
const { tmpFixture } = require("./helpers/tmp-fixture");

function tmp() { return tmpFixture("pi-runtime-cleanup-"); }
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function lines(n, prefix = "row") { return Array.from({ length: n }, (_, i) => JSON.stringify({ i, message: `${prefix}-${i}`, content: "redacted" })).join("\n") + "\n"; }
function size(file) { try { return fs.statSync(file).size; } catch { return 0; } }

{
  const cwd = tmp();
  const traceRoot = path.join(cwd, "global-traces");
  write(path.join(cwd, ".pi/cognitive-automation/trace/events.jsonl"), lines(30));
  write(path.join(cwd, ".pi/cognitive-automation/entropy/events.jsonl"), lines(40, "entropy"));
  write(path.join(cwd, ".pi/cognitive-automation/entropy/snapshots.jsonl"), lines(50, "snap"));
  fs.mkdirSync(traceRoot, { recursive: true });
  for (let i = 0; i < 6; i++) {
    const file = path.join(traceRoot, `trace-${i}.jsonl`);
    write(file, lines(10, `trace-${i}`));
    fs.utimesSync(file, new Date(Date.now() - (10 + i) * 3600_000), new Date(Date.now() - (10 + i) * 3600_000));
  }
  const state = inspectRuntimeState({ cwd, traceRoot });
  assert.ok(state.sizes.projectTraceBytes > 0);
  assert.equal(state.files.globalTraceFiles.length, 6);

  const plan = planCleanup({ cwd, traceRoot, policy: { trace: { maxProjectTraceBytes: 100, keepProjectEvents: 5, maxGlobalTraceBytes: 100, keepGlobalTraceFiles: 2, minNewestGlobalTraceFiles: 2 }, entropy: { maxEventsBytes: 100, maxSnapshotsBytes: 100, keepEventsLines: 6, keepSnapshotsLines: 7 }, safety: { minAgeHours: 0 } } });
  assert.ok(plan.items.some((i) => i.category === "project-trace" && i.action === "truncate-jsonl"));
  assert.ok(plan.items.some((i) => i.category === "entropy" && i.action === "truncate-jsonl-gzip-archive"));
  assert.ok(plan.items.some((i) => i.category === "global-trace" && i.action === "delete"));
  assert.match(formatCleanupPlan(plan), /Runtime cleanup plan/);

  const beforeProjectTrace = size(path.join(cwd, ".pi/cognitive-automation/trace/events.jsonl"));
  const dry = applyCleanup(plan, { dryRun: true, cwd });
  assert.equal(size(path.join(cwd, ".pi/cognitive-automation/trace/events.jsonl")), beforeProjectTrace, "dry-run must not mutate trace");
  assert.equal(dry.summary.applied, 0);

  const result = applyCleanup(plan, { dryRun: false, cwd });
  assert.ok(result.manifestPath && fs.existsSync(result.manifestPath));
  assert.ok(result.summary.applied >= 3);
  const projectLines = fs.readFileSync(path.join(cwd, ".pi/cognitive-automation/trace/events.jsonl"), "utf8").trim().split(/\n/);
  assert.equal(projectLines.length, 5);
  const entropyLines = fs.readFileSync(path.join(cwd, ".pi/cognitive-automation/entropy/events.jsonl"), "utf8").trim().split(/\n/);
  assert.equal(entropyLines.length, 6);
  const archives = fs.readdirSync(path.join(cwd, ".pi/runtime-cleanup/archive")).filter((f) => f.endsWith(".gz"));
  assert.ok(archives.length >= 2, "entropy cleanup should gzip archives");
  const archived = zlib.gunzipSync(fs.readFileSync(path.join(cwd, ".pi/runtime-cleanup/archive", archives[0]))).toString("utf8");
  assert.ok(archived.includes("{"));
  assert.ok(fs.readdirSync(traceRoot).length <= 2, "global trace cleanup keeps newest files");
  const manifestText = fs.readFileSync(result.manifestPath, "utf8");
  assert.ok(!manifestText.includes("redacted-1"), "manifest must not include trace payload contents");
  assert.equal(fs.statSync(path.dirname(result.manifestPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(result.manifestPath).mode & 0o777, 0o600, "cleanup manifests are private");
}

{
  const cwd = tmp();
  const traceRoot = path.join(cwd, "legacy-traces");
  const legacy = path.join(traceRoot, "legacy.jsonl.1");
  write(legacy, [
    JSON.stringify({ category: "session", name: "legacy", payload: { text: "PRIVATE_LEGACY_TRACE_PAYLOAD" } }),
    JSON.stringify({ category: "model_request", name: "compressed", payload_ref: { encoding: "gzip+base64", data: "PRIVATE_COMPRESSED_PAYLOAD" } }),
  ].join("\n") + "\n");
  const inspected = inspectTracePrivacy(legacy);
  assert.equal(inspected.classification, "payload-bearing");
  assert.equal(inspected.payloadFields, 1);
  assert.equal(inspected.payloadRefs, 1);
  assert(!JSON.stringify(inspected).includes("PRIVATE_LEGACY_TRACE_PAYLOAD"), "trace privacy inspection returns metadata, not payload values");
  const before = fs.readFileSync(legacy);
  const plan = planCleanup({ cwd, traceRoot, policy: { trace: { maxGlobalTraceBytes: 1, keepGlobalTraceFiles: 0, minNewestGlobalTraceFiles: 0 }, safety: { minAgeHours: 0 } } });
  assert(plan.items.some((item) => item.path === legacy && item.category === "legacy-payload-trace" && item.action === "review-retention" && item.safe === false));
  assert(!plan.items.some((item) => item.path === legacy && item.action === "delete"), "payload-bearing legacy traces are never ordinary cleanup deletions");
  assert(!formatCleanupPlan(plan).includes("PRIVATE_COMPRESSED_PAYLOAD"));
  applyCleanup(plan, { dryRun: false, cwd });
  assert.deepEqual(fs.readFileSync(legacy), before, "ordinary cleanup apply leaves payload-bearing legacy traces unchanged");
}

{
  const cwd = tmp();
  const traceRoot = path.join(cwd, "global-traces");
  fs.mkdirSync(traceRoot, { recursive: true });
  const oldFile = path.join(traceRoot, "old.jsonl");
  const newFile = path.join(traceRoot, "new.jsonl");
  write(oldFile, lines(20)); write(newFile, lines(20));
  fs.utimesSync(oldFile, new Date(Date.now() - 10 * 3600_000), new Date(Date.now() - 10 * 3600_000));
  const plan = planCleanup({ cwd, traceRoot, policy: { trace: { maxGlobalTraceBytes: 10, keepGlobalTraceFiles: 0, minNewestGlobalTraceFiles: 0 }, safety: { minAgeHours: 6 } } });
  assert.ok(plan.items.some((i) => i.path === oldFile && i.action === "delete"));
  assert.ok(plan.items.some((i) => i.path === newFile && i.action === "skip"), "new traces are protected by min age");
}

{
  const cwd = tmp();
  const objects = path.join(cwd, ".pi", "code-context", "objects");
  const ledgers = path.join(cwd, ".pi", "code-context", "ledgers");
  const protectedObject = path.join(objects, "protected.json");
  const oldObject = path.join(objects, "old.json");
  write(protectedObject, JSON.stringify({ contentRef: "ctxref:protected", extract: "keep" }));
  write(oldObject, JSON.stringify({ contentRef: "ctxref:old", extract: "remove" }));
  write(path.join(ledgers, "session.json"), JSON.stringify({ entries: [{ contentRef: "ctxref:protected", stale: false }] }));
  const old = new Date(Date.now() - 2 * 86400000);
  fs.utimesSync(protectedObject, old, old); fs.utimesSync(oldObject, old, old);
  const state = inspectRuntimeState({ cwd });
  assert.equal(state.files.codeContextObjects.length, 2);
  const plan = planCleanup({ cwd, policy: { codeContext: { maxBytes: 1, maxAgeDays: 1 } } });
  assert.ok(plan.items.some((item) => item.category === "code-context-cache" && item.path === oldObject));
  assert.ok(!plan.items.some((item) => item.path === protectedObject), "live ledger refs protect cache objects");
  applyCleanup(plan, { dryRun: false, cwd });
  assert.equal(fs.existsSync(oldObject), false);
  assert.equal(fs.existsSync(protectedObject), true);
}

{
  const cwd = tmp();
  const workspaces = path.join(cwd, ".pi", "subagents", "workspaces");
  const retained = path.join(workspaces, "sub_retained");
  const active = path.join(workspaces, "sub_active");
  const debugReferenced = path.join(workspaces, "sub_debug");
  write(path.join(retained, "lease.json"), JSON.stringify({ subagentId: "sub_retained", state: "retained" }));
  write(path.join(retained, "changes.patch"), "bounded patch");
  write(path.join(active, "lease.json"), JSON.stringify({ subagentId: "sub_active", state: "active" }));
  write(path.join(debugReferenced, "lease.json"), JSON.stringify({ subagentId: "sub_debug", state: "retained" }));
  write(path.join(cwd, ".pi", "debug-ledger", "open.json"), JSON.stringify({ status: "open", evidence: ["sub_debug"] }));
  const old = new Date(Date.now() - 10 * 86400000);
  fs.utimesSync(retained, old, old); fs.utimesSync(active, old, old); fs.utimesSync(debugReferenced, old, old);
  const state = inspectRuntimeState({ cwd });
  assert.equal(state.files.subagentWorkspaces.length, 3);
  const plan = planCleanup({ cwd, policy: { subagentWorkspaces: { maxBytes: 1, maxAgeDays: 1 }, safety: { minAgeHours: 0 } } });
  assert(plan.items.some((item) => item.path === retained && item.action === "delete-directory"), "old retained recovery workspaces are cleanup candidates");
  assert(plan.items.some((item) => item.path === active && item.action === "skip"), "active workspace leases are protected");
  assert(plan.items.some((item) => item.path === debugReferenced && item.action === "skip"), "debug-referenced workspaces are protected");
  applyCleanup(plan, { dryRun: true, cwd });
  assert(fs.existsSync(retained), "workspace cleanup defaults to preview/dry-run");
  applyCleanup(plan, { dryRun: false, cwd });
  assert.equal(fs.existsSync(retained), false);
  assert.equal(fs.existsSync(active), true);
  assert.equal(fs.existsSync(debugReferenced), true);
}

{
  const cwd = tmp();
  const subagents = path.join(cwd, ".pi", "subagents");
  const topologyRuns = path.join(cwd, ".pi", "cognitive-automation", "topologies", "runs");
  const old = new Date(Date.now() - 10 * 86400000);
  const roleFiles = {
    succeededRecord: path.join(subagents, "records", "sub_succeeded.json"),
    succeededResult: path.join(subagents, "results", "sub_succeeded.json"),
    failedRecord: path.join(subagents, "records", "sub_failed.json"),
    failedResult: path.join(subagents, "results", "sub_failed.json"),
    debugRecord: path.join(subagents, "records", "sub_debug_record.json"),
    unknownRecord: path.join(subagents, "records", "sub_unknown.json"),
    rpcSucceeded: path.join(subagents, "rpc-sessions", "sub_succeeded", "session.jsonl"),
    rpcFailed: path.join(subagents, "rpc-sessions", "sub_failed", "session.jsonl"),
    patchApplied: path.join(subagents, "patches", "applied.json"),
    patchReady: path.join(subagents, "patches", "ready.json"),
    topologySucceeded: path.join(topologyRuns, "toprun_succeeded.json"),
    topologyFailed: path.join(topologyRuns, "toprun_failed.json"),
  };
  write(roleFiles.succeededRecord, JSON.stringify({ id: "sub_succeeded", status: "succeeded" }));
  write(roleFiles.succeededResult, JSON.stringify({ subagent_id: "sub_succeeded", status: "succeeded" }));
  write(roleFiles.failedRecord, JSON.stringify({ id: "sub_failed", status: "failed" }));
  write(roleFiles.failedResult, JSON.stringify({ subagent_id: "sub_failed", status: "failed" }));
  write(roleFiles.debugRecord, JSON.stringify({ id: "sub_debug_record", status: "succeeded" }));
  write(roleFiles.unknownRecord, JSON.stringify({ id: "sub_unknown" }));
  write(roleFiles.rpcSucceeded, lines(2, "rpc-success"));
  write(roleFiles.rpcFailed, lines(2, "rpc-failure"));
  write(roleFiles.patchApplied, JSON.stringify({ id: "applied", status: "applied", subagentId: "sub_succeeded" }));
  write(roleFiles.patchReady, JSON.stringify({ id: "ready", status: "ready", subagentId: "sub_failed" }));
  write(roleFiles.topologySucceeded, JSON.stringify({ runId: "toprun_succeeded", status: "succeeded" }));
  write(roleFiles.topologyFailed, JSON.stringify({ runId: "toprun_failed", status: "failed" }));
  write(path.join(cwd, ".pi", "debug-ledger", "open.json"), JSON.stringify({ status: "open", evidence: ["sub_debug_record", "toprun_failed"] }));
  for (const file of Object.values(roleFiles)) { fs.chmodSync(file, 0o644); fs.utimesSync(file, old, old); }

  const state = inspectRuntimeState({ cwd });
  for (const name of ["roleRecords", "roleResults", "rpcChildSessions", "retainedWorkspaces", "patches", "topologyRuns"]) {
    assert(state.roleState.inventories[name], `missing role-state inventory ${name}`);
    assert(Number.isFinite(state.roleState.inventories[name].bytes));
  }
  assert(state.roleState.summary.files >= Object.keys(roleFiles).length);
  assert(state.roleState.summary.permissionChanges > 0, "historical permissive role state is inventoried for hardening");

  const plan = planCleanup({ cwd, policy: { roleState: { maxAgeDays: 1, keepRecent: 0, maxBytes: 1 }, safety: { minAgeHours: 0 } } });
  assert(plan.items.some((item) => item.category === "role-record" && item.path === roleFiles.succeededRecord && item.action === "delete"));
  assert(plan.items.some((item) => item.path === roleFiles.failedRecord && item.action === "skip"), "failed role records are recovery evidence");
  assert(plan.items.some((item) => item.path === roleFiles.debugRecord && item.action === "skip"), "open debug-ledger references are retained");
  assert(plan.items.some((item) => item.path === roleFiles.unknownRecord && item.action === "skip"), "unclassified role evidence is retained");
  assert(plan.items.some((item) => item.path === roleFiles.rpcFailed && item.action === "skip"), "failed child RPC sessions are retained");
  assert(plan.items.some((item) => item.path === roleFiles.patchReady && item.action === "skip"), "unapplied patch recovery evidence is retained");
  assert(plan.items.some((item) => item.path === roleFiles.topologyFailed && item.action === "skip"), "failed topology evidence is retained");
  assert(plan.items.some((item) => item.category === "role-state-permission" && item.action === "chmod"));

  const dry = applyCleanup(plan, { dryRun: true, cwd });
  assert.equal(dry.summary.applied, 0);
  assert(fs.existsSync(roleFiles.succeededRecord));
  const applied = applyCleanup(plan, { dryRun: false, cwd });
  assert(applied.summary.applied > 0);
  assert.equal(fs.existsSync(roleFiles.succeededRecord), false);
  assert.equal(fs.existsSync(roleFiles.failedRecord), true);
  assert.equal(fs.existsSync(roleFiles.debugRecord), true);
  assert.equal(fs.existsSync(roleFiles.patchReady), true);
  assert.equal(fs.existsSync(roleFiles.topologyFailed), true);
  assert(!fs.readFileSync(applied.manifestPath, "utf8").includes("rpc-failure"), "role cleanup manifest contains metadata only");
}

{
  const cwd = tmp();
  const record = path.join(cwd, ".pi", "subagents", "records", "sub_swap.json");
  write(record, JSON.stringify({ id: "sub_swap", status: "succeeded" }));
  const old = new Date(Date.now() - 10 * 86400000);
  fs.utimesSync(record, old, old);
  const plan = planCleanup({ cwd, policy: { roleState: { maxAgeDays: 1, keepRecent: 0, maxBytes: 1 }, safety: { minAgeHours: 0 } } });
  const replacement = path.join(cwd, ".pi", "subagents", "records", "sub_swap_replacement.json");
  write(replacement, JSON.stringify({ id: "replacement", status: "succeeded" }));
  fs.renameSync(replacement, record);
  const result = applyCleanup(plan, { dryRun: false, cwd });
  assert(result.actions.some((action) => action.error && /changed since preview/.test(action.error)), "cleanup refuses path identity swaps");
  assert(fs.existsSync(record));
}

{
  const root = path.join(tmp(), "private-storage");
  const storage = new FileIntegrationStorage(root);
  const jsonFile = storage.writeJson("topologies/runs/private", { status: "succeeded" });
  const jsonlFile = storage.appendJsonl("topologies/runs", { runId: "private" });
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.dirname(jsonFile)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(jsonFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(jsonlFile).mode & 0o777, 0o600);
}

console.log("runtime-cleanup tests passed");
