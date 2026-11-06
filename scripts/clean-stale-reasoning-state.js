#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();
const stateDir = path.join(root, ".pi", "cognitive-automation");
const stale = /runtime\\*\.arch\.coordinate|Role architecture output|Current cognitive route|role[- ]architecture/i;
const dryRun = process.argv.includes("--dry-run");

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, value) { if (dryRun) return; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function includesStale(value) { const text = typeof value === "string" ? value : JSON.stringify(value || {}); return stale.test(text) || stale.test(text.replace(/\\/g, "")); }

const contextFile = path.join(stateDir, "layered-context.json");
const memoryFile = path.join(stateDir, "cognitive-memory.json");
let contextRemoved = [];
let memoryRemoved = [];

const context = readJson(contextFile, null);
if (context?.blocks) {
  const kept = [];
  for (const block of context.blocks) {
    if (includesStale(`${block.title || ""}\n${block.content || ""}`)) contextRemoved.push({ id: block.id, title: block.title });
    else kept.push(block);
  }
  if (!kept.some((b) => b.title === "Reasoning runtime architecture")) kept.push({
    layer: "L1",
    title: "Reasoning runtime architecture",
    content: "Model-side reasoning via src/reasoning-runtime.js is canonical. The harness stores public scaffold artifacts and verifier evidence without exposing private reasoning.",
    kind: "memory",
    tags: ["architecture", "reasoning-runtime"],
    verification: "verified",
    protected: true,
    id: "ctx_reasoning_runtime_architecture",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  context.blocks = kept;
  writeJson(contextFile, context);
}

const memory = readJson(memoryFile, null);
if (memory?.entries) {
  const kept = [];
  for (const entry of memory.entries) {
    if (includesStale(`${entry.title || ""}\n${entry.content || ""}`)) memoryRemoved.push({ id: entry.id, title: entry.title, type: entry.type });
    else kept.push(entry);
  }
  if (!kept.some((e) => e.title === "Reasoning runtime architecture")) kept.push({
    id: "mem_reasoning_runtime_architecture",
    type: "semantic",
    title: "Reasoning runtime architecture",
    content: "Model-side reasoning via src/reasoning-runtime.js is canonical. Obsolete internal role-orchestration error records should not be used as context.",
    tags: ["architecture", "reasoning-runtime"],
    confidence: 0.95,
    verification: "verified",
    provenance: { source: "clean-stale-reasoning-state" },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastAccessedAt: Date.now(),
    accessCount: 0,
    links: {},
    contradicts: [],
    supersedes: [],
  });
  memory.entries = kept;
  writeJson(memoryFile, memory);
}

console.log(JSON.stringify({ dryRun, contextRemoved, memoryRemoved }, null, 2));
