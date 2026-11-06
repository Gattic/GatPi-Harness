"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { FileTraceStorage } = require("../src/trace-observability");
const { retainTraceFiles, traceProjectPrefix, headroomTarget } = require("../src/trace-retention");
const { openThread, recordAttempt } = require("../src/debug-ledger");
const { tmpFixture } = require("./helpers/tmp-fixture");
const root = tmpFixture("pi-trace-ownership-");
const shared = path.join(root, "shared");
const a = path.join(root, "project-a"), b = path.join(root, "project-b");
const now = Date.now(), old = new Date(now - 30 * 86400000);
const writers = [];
function closed(cwd, sessionId, rotate = false) {
  const writer = new FileTraceStorage({ root: shared, cwd, sessionId, ...(rotate ? { rotateBytes: 1 } : {}) });
  writers.push(writer);
  writer.write({ name: "session_shutdown" }); writer.close();
  return rotate ? path.join(shared, fs.readdirSync(shared).find(name => name.startsWith(`${path.basename(writer.path())}.`))) : writer.path();
}
try {
  fs.mkdirSync(a); fs.mkdirSync(b);
  const pinned = closed(a, "pinned");
  const rotated = closed(a, "rotated", true);
  const disposable = closed(a, "disposable");
  for (const file of [pinned, rotated, disposable]) fs.utimesSync(file, old, old);
  const thread = openThread(a, "Pinned shared trace evidence");
  recordAttempt(a, thread.threadId, { evidence: [pinned, rotated], verdict: "unverified" });
  const before = [pinned, rotated].map(file => fs.readFileSync(file));
  const preview = retainTraceFiles(shared, { cwd: a, now });
  assert.equal(preview.protectedFiles, 2);
  assert.deepEqual(preview.candidates.map(row => row.name), [path.basename(disposable)]);
  const foreign = new FileTraceStorage({ root: shared, cwd: b, sessionId: "b" }); writers.push(foreign);
  assert(fs.existsSync(pinned), "project B startup must preserve project A's debug-pinned trace");
  assert(fs.existsSync(rotated), "rotation must not lose owning-project protection");
  const limited = retainTraceFiles(shared, { cwd: b, maxTotalBytes: 1, maxFiles: 1, now, apply: true });
  assert.equal(limited.removedFiles, 0, "foreign files are not authorized for deletion by this project");
  assert.equal(limited.overBudget, true);
  assert(fs.existsSync(disposable), "only its owning project may decide that evidence is unpinned");
  const cleaned = retainTraceFiles(shared, { cwd: a, now, apply: true });
  assert.equal(cleaned.removedFiles, 1);
  assert(!fs.existsSync(disposable));
  const sameSession = new FileTraceStorage({ root: shared, cwd: b, sessionId: "pinned" }); writers.push(sameSession);
  sameSession.write({ name: "session_shutdown" });
  assert.notEqual(sameSession.path(), pinned, "logical session IDs cannot collide across projects");
  for (const [i, file] of [pinned, rotated].entries()) assert.deepEqual(fs.readFileSync(file), before[i]);
  const unknown = path.join(shared, "unowned.jsonl");
  fs.writeFileSync(unknown, '{"name":"session_shutdown"}\n'); fs.utimesSync(unknown, old, old);
  const unknownResult = retainTraceFiles(shared, { cwd: a, maxTotalBytes: 1, now, apply: true });
  assert(fs.existsSync(unknown), "unattributed historical traces require review, not an ownership guess");
  assert.equal(unknownResult.overBudget, true);
  const historical = fs.readFileSync(unknown);
  const replacement = new FileTraceStorage({ root: shared, cwd: a, sessionId: "unowned" }); writers.push(replacement);
  replacement.write({ name: "session_shutdown" });
  assert.notEqual(replacement.path(), unknown, "new writes must not claim a historical filename");
  assert.deepEqual(fs.readFileSync(unknown), historical);
  const alias = path.join(root, "project-a-alias"); fs.symlinkSync(a, alias, "dir");
  const aliased = new FileTraceStorage({ root: shared, cwd: alias, sessionId: "unowned" }); writers.push(aliased);
  assert.equal(aliased.path(), replacement.path(), "project aliases share canonical ownership");
  // Retention used to prune only down to the cap, so the next write crossed it
  // again immediately. Headroom makes each prune create room to grow into.
  const headroomRoot = path.join(root, "headroom");
  fs.mkdirSync(headroomRoot, { recursive: true });
  const headroomPrefix = traceProjectPrefix(headroomRoot);
  // 31 lines x 32 bytes = 992 bytes, ending in a settled session_shutdown row.
  const traceBody = Array.from({ length: 31 }, (_, n) => `{"name":"session_shutdown","n":${n % 10}}`).join("\n") + "\n";
  const headroomFiles = Array.from({ length: 4 }, (_, i) => path.join(headroomRoot, `${headroomPrefix}sess-${i}.jsonl`));
  // Ages stay clear of both boundaries this test exercises: above the 1 day grace
  // window so nothing is protected, and off the 2 day expiry boundary so a
  // sub-millisecond mtime rounding cannot flip an expiry decision.
  const headroomAges = [4, 3, 1.5, 1.25];
  const rewrite = () => headroomFiles.forEach((file, i) => {
    fs.writeFileSync(file, traceBody);
    fs.chmodSync(file, 0o600);
    const at = new Date(now - headroomAges[i] * 86400000);
    fs.utimesSync(file, at, at);
  });
  rewrite();
  assert.equal(headroomFiles.reduce((sum, file) => sum + fs.statSync(file).size, 0), 4216, "fixture sizing is exact");
  const exactCap = retainTraceFiles(headroomRoot, { cwd: headroomRoot, maxTotalBytes: 3600, headroomRatio: 0, now, apply: true });
  assert.equal(exactCap.targetBytes, 3600, "a zero headroom ratio keeps the historical prune-to-cap behaviour");
  assert.deepEqual({ removedFiles: exactCap.removedFiles, bytes: exactCap.bytes }, { removedFiles: 1, bytes: 3162 });
  assert.equal(exactCap.headroomRatio, 0);
  rewrite();
  const withHeadroom = retainTraceFiles(headroomRoot, { cwd: headroomRoot, maxTotalBytes: 3600, headroomRatio: 0.25, now, apply: true });
  assert.equal(withHeadroom.targetBytes, 2700, "the default target leaves a quarter of the cap free");
  assert.deepEqual({ removedFiles: withHeadroom.removedFiles, bytes: withHeadroom.bytes }, { removedFiles: 2, bytes: 2108 }, "pruning stops once the headroom target is met, not at the cap");
  assert.equal(withHeadroom.overBudget, false);
  assert.equal(fs.readdirSync(headroomRoot).length, 2, "the newest traces survive");
  assert.equal(retainTraceFiles(headroomRoot, { cwd: headroomRoot, now }).headroomRatio, 0.25, "headroom is the default so growth does not immediately re-cross the cap");
  assert.equal(headroomTarget(2000, 2), 1500, "an out-of-range ratio falls back to the default instead of pruning to zero");
  // A store under its cap keeps its history: headroom is a target for the prune
  // that the cap triggers, not a reason to trim a store that is already small.
  rewrite();
  const underCap = retainTraceFiles(headroomRoot, { cwd: headroomRoot, maxTotalBytes: 100000, headroomRatio: 0.25, now, apply: true });
  assert.deepEqual({ removedFiles: underCap.removedFiles, bytes: underCap.bytes, overBudget: underCap.overBudget }, { removedFiles: 0, bytes: 4216, overBudget: false });
  assert.equal(underCap.targetBytes, 75000);
  assert.equal(fs.readdirSync(headroomRoot).length, 4, "an under-cap store is not trimmed toward the headroom target");
  // An expired file is still removed on its own, without dragging the store down
  // to the headroom target.
  const aged = retainTraceFiles(headroomRoot, { cwd: headroomRoot, maxTotalBytes: 100000, headroomRatio: 0.25, maxAgeDays: 2, now, apply: true });
  assert.deepEqual({ removedFiles: aged.removedFiles, bytes: aged.bytes }, { removedFiles: 2, bytes: 2108 });
} finally {
  for (const writer of writers) writer.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("trace retention ownership tests passed");
