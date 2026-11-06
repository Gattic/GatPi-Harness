"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_ROLE_CONTRACTS, roleRevisionHash, validateRoleContract } = require("../src/role-contracts");
const { publicRecord, resolveSubagentPreflight, roleRevision } = require("../src/subagent-lifecycle");
const { buildFocusTargets, readSubagentRecords } = require("../src/chat-focus");
const { tmpFixture } = require("./helpers/tmp-fixture");

const auditor = DEFAULT_ROLE_CONTRACTS.find((role) => role.roleId === "evidence-auditor");
const legacyContract = { ...auditor, completionPolicy: { requireSubmittedResult: true, allowEmptySummary: false } };
const legacyRecord = { id: "sub_legacy_auditor", parentSessionId: "historical-parent", role: auditor.roleId, roleContract: legacyContract, status: "succeeded" };
const before = JSON.stringify(legacyRecord);
const projected = publicRecord(legacyRecord);
assert.equal(projected.id, legacyRecord.id);
assert.equal(projected.status, "succeeded");
assert.equal(projected.typedRole, true);
assert.equal(projected.roleRevision, null, "history with an obsolete contract has no validated revision");
assert.equal(JSON.stringify(legacyRecord), before, "displaying history must not migrate or rewrite its policies");
assert.equal(projected.roleContract, undefined, "historical prompts and contracts stay private");

const storedRevision = `sha256:${"a".repeat(64)}`;
assert.equal(publicRecord({ ...legacyRecord, roleRevision: storedRevision }).roleRevision, storedRevision, "stored historical revisions are preserved");
assert.equal(publicRecord({ ...legacyRecord, roleContract: auditor }).roleRevision, roleRevisionHash(auditor), "current contracts retain the canonical revision");
assert.equal(publicRecord({ id: "untyped" }).roleRevision, null);
const obsoleteRouting = { ...auditor, autoRoutePolicy: "delegate-explicit" };
assert.equal(publicRecord({ ...legacyRecord, roleContract: obsoleteRouting }).roleRevision, null, "other obsolete policy fields also cannot crash history");
assert.equal(publicRecord({ ...legacyRecord, roleContract: {} }).roleRevision, null, "incomplete historical contracts cannot crash history");
assert.throws(() => validateRoleContract(legacyContract), /minimumSummaryChars/);
assert.throws(() => roleRevision(legacyContract), /minimumSummaryChars/, "launch-time revision validation remains strict");
assert.throws(() => roleRevisionHash(obsoleteRouting), /auto route policy/);
const preflight = resolveSubagentPreflight({ role: auditor.roleId, roleContract: legacyContract });
assert.equal(preflight.allowed, false, "display compatibility must not authorize launching an obsolete contract");
assert(preflight.reasons.includes("role-contract-invalid"));

const tmp = tmpFixture("pi-subagent-history-");
try {
  const recordsDir = path.join(tmp, ".pi", "subagents", "records");
  fs.mkdirSync(recordsDir, { recursive: true });
  const records = [legacyRecord, { ...legacyRecord, id: "sub_obsolete_routing", roleContract: obsoleteRouting }, { ...legacyRecord, id: "sub_current", roleContract: auditor }];
  for (const record of records) fs.writeFileSync(path.join(recordsDir, `${record.id}.json`), JSON.stringify(record));
  const history = readSubagentRecords(tmp);
  assert.equal(history.length, records.length, "old records stay visible alongside current records");
  assert.equal(history.find((record) => record.id === legacyRecord.id).roleRevision, null);
  const sessionFile = path.join(tmp, "main.jsonl");
  const targets = buildFocusTargets({ cwd: tmp, currentSessionFile: sessionFile, currentSessionId: legacyRecord.parentSessionId, sessions: [{ id: legacyRecord.parentSessionId, path: sessionFile }] });
  for (const record of records) assert(targets.some((target) => target.key === `subagent:${record.id}`), "startup builds focus targets for historical and current subagents");
  assert.equal(fs.readFileSync(path.join(recordsDir, `${legacyRecord.id}.json`), "utf8"), before, "startup leaves historical records untouched");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("subagent history compatibility tests passed");
