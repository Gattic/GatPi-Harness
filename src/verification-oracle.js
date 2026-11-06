"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { inferCommands } = require("./test-runner");
const { captureTreeFingerprint, compareTreeFingerprint } = require("./tree-fingerprint");
const { hash } = require("./reviewed-evidence");

const commandHash = command => hash([command.command, command.args || []]);

// Freeze repository-defined checks before assignment/exposure, not from the
// model's later choice of convenient tests. No commands execute here.
function freezeVerificationOracle(cwd) {
  const inferred = inferCommands(cwd, { profile: "changed" });
  const commands = inferred.profiles.changed.filter(c => !c.reason.startsWith("fallback quick verifier"));
  const full = inferred.profiles.full;
  const selected = commands.length ? commands : full;
  const tree = captureTreeFingerprint(cwd);
  const contract = {
    treeFingerprint: tree.gatingSafe ? tree.fingerprint : null,
    commandHashes: selected.map(commandHash).sort(),
    fullCommandHashes: full.map(commandHash).sort(),
  };
  return { contract: { ...contract, hash: hash(contract) }, commands: selected, files: inferred.changedFiles,
    available: tree.gatingSafe && inferred.changedFiles.length > 0 && selected.length > 0 && selected.length <= 64 };
}

// Verdicts describe execution of the frozen checks, not overall correctness,
// subjective usefulness, or the truth of arbitrary natural-language claims.
function assessVerification(cwd, result, oracle, startedAt, now) {
  const inconclusive = reason => ({ status: "inconclusive", reason });
  if (!oracle.available) return inconclusive("no-executable-oracle");
  const proof = result?.evidence;
  if (!/^proof_[a-f0-9]{16}$/.test(proof?.id || "")) return inconclusive("no-verification-proof");
  const created = Date.parse(proof.createdAt);
  if (!Number.isFinite(created) || created < Date.parse(startedAt) || created > now) return inconclusive("outside-execution-window");
  const file = path.join(cwd, ".pi", "verification-center", "evidence", `${proof.id}.json`);
  if (!fs.existsSync(file) || fs.statSync(file).size > 16 * 1024 * 1024) return inconclusive("missing-or-oversized-proof");
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  if (hash(persisted) !== hash(proof)) return inconclusive("proof-content-mismatch");
  if (!compareTreeFingerprint(cwd, proof.tree).gatingSafe || proof.tree.fingerprint !== oracle.contract.treeFingerprint) return inconclusive("tree-changed-or-unproven");
  const commands = result.commands || [], verifiers = proof.verifiers || [];
  if (!Array.isArray(proof.executedCommands) || hash(proof.executedCommands) !== hash(commands.map(c => ({ id: c.id, command: c.command, args: c.args || [] })))) return inconclusive("command-provenance-mismatch");
  if (!commands.length || commands.length > 128 || commands.length !== verifiers.length || new Set(commands.map(c => c.id)).size !== commands.length || new Set(verifiers.map(v => v.id)).size !== verifiers.length) return inconclusive("incomplete-verifier-set");
  const observedHashes = new Set();
  for (const command of commands) {
    const verifier = verifiers.find(v => v.id === command.id);
    if (!verifier || !Number.isFinite(Date.parse(verifier.startedAt)) || Date.parse(verifier.startedAt) < Date.parse(startedAt) || Date.parse(verifier.startedAt) > created || verifier.cached || !Number.isInteger(verifier.metrics?.exitCode) || verifier.metrics.exitCode < 0 || verifier.metrics.signal || verifier.ok !== (verifier.metrics.exitCode === 0)) return inconclusive("unproven-command-execution");
    observedHashes.add(commandHash(command));
  }
  const coverage = oracle.contract.commandHashes.every(h => observedHashes.has(h)) || oracle.contract.fullCommandHashes.some(h => observedHashes.has(h));
  if (!coverage) return inconclusive("frozen-checks-not-covered");
  const passed = verifiers.every(v => v.ok);
  if (proof.ok !== passed || !["pass", "fail"].includes(proof.status) || proof.status !== (passed ? "pass" : "fail")) return inconclusive("inconsistent-verdict");
  if ((proof.policy?.violations || []).some(v => v.policy !== "rejectFailedVerifiers")) return { status: "policy-violation", reason: "verifier-policy-violation" };
  return { status: "resolved", reason: "frozen-checks-executed", verificationResult: passed ? "pass" : "fail", proofId: proof.id, proofHash: hash(persisted) };
}

module.exports = { freezeVerificationOracle, assessVerification, commandHash };
