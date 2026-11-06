#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { executableInfo, semgrepScan } = require("../src/semgrep-adapter");
const { tmpFixture } = require("./helpers/tmp-fixture");
const binary = executableInfo(process.env.PI_SEMGREP_BIN || "semgrep");
if (!binary.found) {
  console.log("Semgrep rule integration not-applicable: scanner not installed");
} else {
  const root = tmpFixture("pi-semgrep-rules-");
  try {
    fs.writeFileSync(path.join(root, "unsafe.js"), [
      'const agent = { rejectUnauthorized: false };',
      'console.log(process.env.API_TOKEN);',
      "require('node:child_process').execSync('echo ' + input);",
    ].join("\n"));
    fs.writeFileSync(path.join(root, "safe.js"), [
      'const agent = { rejectUnauthorized: true };',
      'console.log(Boolean(process.env.API_TOKEN));',
      "require('node:child_process').execFileSync('echo', [input]);",
    ].join("\n"));
    const scanned = semgrepScan(root, ["unsafe.js", "safe.js"], { bin: binary.path, advisory: true, config: path.resolve(__dirname, "../.semgrep.yml"), timeoutMs: 30000, configProbeTimeoutMs: 10000 });
    assert.equal(scanned.ok, true, JSON.stringify({ reason: scanned.reason, error: scanned.errorCode, stderr: scanned.run?.stderr }));
    assert.equal(scanned.summary.errors || 0, 0);
    assert.equal(scanned.findings.length, 3, "each pinned rule detects its positive fixture");
    assert(scanned.findings.every(finding => finding.path === "unsafe.js"), "argument arrays, TLS verification and credential presence booleans are not findings");
    for (const id of ["harness-no-disabled-tls-verification", "harness-no-environment-secret-logging", "harness-no-interpolated-shell-command"]) assert(scanned.findings.some(finding => finding.checkId.endsWith(id)), id);
    console.log("pinned Semgrep rules: positive and negative fixtures passed");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
