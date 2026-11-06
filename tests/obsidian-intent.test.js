#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { eventText, classifyObsidianIntent, obsidianAutomaticContextPolicy } = require("../src/obsidian-intent.js");
const corpus = [
  ["Search my Obsidian vault for the prior architecture decision", true],
  ["Prepare a literature review and citation list", true],
  ["Store this as a durable research note", true],
  ["Curate my research notes into durable context", true],
  ["Remember this research decision", true],
  ["Fix the memory leak in the worker", false],
  ["Research why this test flakes", false],
  ["Update the token vault authentication code", false],
  ["Write a unit test for notes.js", false],
  ["Continue implementing the adapter", false],
  ["Summarize this log", false],
  ["Plan the database migration", false]
];
let tp=0, fp=0, fn=0;
for(const [text, expected] of corpus){const actual=classifyObsidianIntent(text); if(actual.eligible&&expected)tp++; else if(actual.eligible)fp++; else if(expected)fn++;}
assert.equal(fp,0); assert.equal(fn,0); assert.equal(tp,5);
assert.equal(classifyObsidianIntent("memory leak").category,"none");
assert.equal(eventText({ messages:[{role:"assistant",content:"x"},{role:"user",content:[{type:"thinking",text:"obsidian"},{type:"text",text:"literature review"}]}] }),"literature review");

const eligible = classifyObsidianIntent("Search my Obsidian vault");
assert.deepEqual(obsidianAutomaticContextPolicy(eligible, { autoAware: false, autoStatus: true, statusInjected: false }), {
  eligible: true,
  injectAwareness: false,
  probeStatus: true,
}, "auto-status remains active when generic awareness injection is disabled");
assert.equal(obsidianAutomaticContextPolicy(eligible, { autoAware: false, autoStatus: true, statusInjected: true }).probeStatus, false, "automatic status probes only once per session");
assert.deepEqual(obsidianAutomaticContextPolicy(classifyObsidianIntent("Fix the worker"), { autoAware: true, autoStatus: true, statusInjected: false }), {
  eligible: false,
  injectAwareness: false,
  probeStatus: false,
}, "automatic Obsidian context remains intent-gated");
console.log("obsidian intent checks passed");
