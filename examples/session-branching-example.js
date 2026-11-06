"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SessionBranchManager, SnapshotStore, BranchVisualizer } = require("../src/session-branches");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-branch-demo-"));
fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
fs.writeFileSync(path.join(cwd, "src/app.js"), "exports.answer = 41;\n");

const manager = new SessionBranchManager({ cwd, store: new SnapshotStore(path.join(cwd, ".pi/session-branches")) });

const main = manager.createBranch({
  type: "verification",
  name: "baseline",
  states: {
    memoryState: { decisions: ["answer module owns numeric answer"] },
    contextState: { tokens: 120, entropyScore: 0.05 },
    toolState: { lastTool: "write" },
    verifierState: { ok: true, successRate: 1, invariants: [{ ok: true, name: "exports answer" }] },
  },
});

fs.writeFileSync(path.join(cwd, "src/app.js"), "exports.answer = 42;\n");
const candidate = manager.createBranch({ fromBranchId: main.id, type: "experimental", name: "try 42", states: { contextState: { tokens: 160, entropyScore: 0.12 }, verifierState: { ok: true, benchmarkDeltas: { latencyMs: { delta: -1 } } } } });

manager.instantRollback(main.headSnapshotId);
fs.writeFileSync(path.join(cwd, "src/check.js"), "exports.check = () => true;\n");
const verifier = manager.createBranch({ fromBranchId: main.id, type: "verification", name: "add verifier helper", states: { verifierState: { ok: true, successRate: 1 } } });

const comparison = manager.compare(candidate.id, verifier.id);
const merged = manager.merge(candidate.id, verifier.id, { apply: true, targetName: "verified trajectory" });

console.log("Workspace:", cwd);
console.log("Merged:", merged.ok, merged.conflicts);
console.log("\nBranch tree:\n" + manager.visualizeTree());
console.log("\nDivergence:\n" + BranchVisualizer.divergence(comparison));
console.log("\nCurrent app.js:\n" + fs.readFileSync(path.join(cwd, "src/app.js"), "utf8"));
