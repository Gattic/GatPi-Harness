"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { TestEvidenceIndex } = require("./test-evidence-index.js");
const { workingTreeRevision, revisionId, normalizeRepositoryPath } = require("./code-context-revision.js");
const { sourceKindForPath } = require("./code-context-contracts.js");
const { isTestPath } = require("./test-paths.js");

const MAX_FILES = 256;
const MAX_BYTES = 32 * 1024 * 1024;
function coverageEntities(root, directory) {
  const names = fs.readdirSync(directory);
  if (names.length > MAX_FILES) throw new Error("coverage-file-limit");
  let bytes = 0;
  const files = names.filter(name => name.endsWith(".json")).map(name => {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid-coverage-file");
    bytes += stat.size;
    if (bytes > MAX_BYTES) throw new Error("coverage-byte-limit");
    return file;
  });
  const entities = new Set();
  for (const file of files) {
    const packet = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(packet.result)) throw new Error("invalid-v8-coverage");
    for (const script of packet.result) {
      if (!String(script.url).startsWith("file:") || !script.functions?.some(fn => fn.ranges?.some(range => range.count > 0))) continue;
      let relative;
      try { relative = normalizeRepositoryPath(root, fs.realpathSync(fileURLToPath(script.url))); } catch { continue; }
      if (sourceKindForPath(relative) !== "first_party" || isTestPath(relative) || /(^|\/)\.pi\/(?!extensions\/)/.test(relative)) continue;
      entities.add(relative);
    }
  }
  return { entities: [...entities].sort(), files: files.length, bytes };
}

async function withNodeTestCoverage(cwd, command, execute, options = {}) {
  if (options.coverage !== true) return execute({});
  const args = command.args || [];
  if (path.basename(command.command) !== "node" || args.length !== 1 || !isTestPath(args[0]) || !/\.[cm]?js$/.test(args[0])) throw new Error("Coverage requires one inferred direct Node test command (node tests/name.test.js).");
  const root = fs.realpathSync(cwd);
  const test = normalizeRepositoryPath(root, args[0]);
  normalizeRepositoryPath(root, fs.realpathSync(path.join(root, test)));
  const space = fs.statfsSync(os.tmpdir());
  if (space.bavail * space.bsize < MAX_BYTES * 2) throw new Error("Insufficient temporary space for bounded Node coverage.");
  const configuration = options.configuration || "default";
  const before = workingTreeRevision(root, { configuration });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-node-coverage-"));
  try {
    const run = await execute({ NODE_V8_COVERAGE: directory });
    try {
      const captured = coverageEntities(root, directory);
      const after = workingTreeRevision(root, { configuration });
      const unchanged = before.available && after.available && revisionId(before) === revisionId(after);
      const index = new TestEvidenceIndex(root);
      const ingested = index.ingest(captured.entities.map(entity => ({ test, entity, relation: "covered", revision: revisionId(before), configuration, freshness: unchanged ? "fresh" : "stale", gatingSafe: unchanged && run.ok, evidenceRef: `test-output:${run.outputHash}` })));
      index.recordDuration(test, run.durationMs);
      index.persist();
      run.coverage = { status: captured.files ? "collected" : "unavailable", reason: captured.files ? null : "no-v8-coverage", files: captured.files, bytes: captured.bytes, accepted: ingested.accepted.length, rejected: ingested.rejected.length, revision: revisionId(before), configuration, gatingSafe: Boolean(unchanged && run.ok && captured.files) };
    } catch (error) {
      // Test outcome remains separate from optional evidence collection failure.
      run.coverage = { status: "unavailable", reason: String(error.message), gatingSafe: false };
    }
    return run;
  } finally {
    // Raw V8 packets are disposable; only bounded relationships and run diagnostics persist.
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
module.exports = { withNodeTestCoverage, coverageEntities, MAX_FILES, MAX_BYTES };
