#!/usr/bin/env node
"use strict";
const { applyHarnessEnvironmentDefaults } = require("../src/harness-environment");
const { configureProjectMemoryServices, MemoryStateAdapter } = require("../src/integration-boundary");
if (process.argv.length > 2) throw new Error("usage: node scripts/collect-memory-diagnostics.js");
const env = { ...process.env };
applyHarnessEnvironmentDefaults({ env });
const cwd = process.cwd(); const boundary = {};
const runtime = configureProjectMemoryServices(boundary, { cwd, env });
if (!runtime.rollout.controls.diagnosticCapture) throw new Error("project-memory diagnostics are disabled");
// This command records diagnostics only, even if the caller has a higher stage.
const pipeline = boundary.projectMemoryCandidates;
pipeline.rollout = { ...runtime.rollout, controls: { ...runtime.rollout.controls, candidateCapture: false } };
const entries = new MemoryStateAdapter({ cwd }).records();
pipeline.settle(entries);
process.stdout.write(`${JSON.stringify({ diagnosticCapture: true, effectiveStage: runtime.rollout.effectiveStage, inspectedRecords: Math.min(2000, entries.length), canonicalWrites: false, automaticPromotion: false, output: ".pi/project-memory/diagnostics.jsonl" }, null, 2)}\n`);
