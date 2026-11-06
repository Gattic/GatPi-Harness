#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { scanExtensionRegistry } = require("../src/extension-registry");
const {
  portfolioRecords,
  portfolioReport,
  renderPortfolioIndex,
  renderPortfolioRecordMarkdown,
} = require("../src/extension-portfolio");

const root = path.resolve(__dirname, "..");
const outputDir = path.join(root, "docs", "extension-portfolio");
const check = process.argv.includes("--check");
const inventory = scanExtensionRegistry({
  cwd: root,
  settings: false,
  extensionPaths: [path.join(root, ".pi", "extensions"), path.join(root, "extensions")],
  runtime: { available: false, tools: [], commands: [] },
});
const frozenTelemetry = {
  eventCount: 90,
  firstAt: "2026-07-25T20:58:38.186Z",
  lastAt: "2026-07-26T08:30:45.132Z",
};

function expectedFiles() {
  const report = portfolioReport(inventory, frozenTelemetry);
  return new Map([
    ["README.md", renderPortfolioIndex(report)],
    ...report.records.map((record) => [`${record.extensionId}.md`, renderPortfolioRecordMarkdown(record)]),
  ]);
}

function main() {
  const expected = expectedFiles();
  if (check) {
    const errors = [];
    for (const [name, content] of expected) {
      const file = path.join(outputDir, name);
      let actual = null;
      try { actual = fs.readFileSync(file, "utf8"); } catch {}
      if (actual !== content) errors.push(name);
    }
    let existing = [];
    try { existing = fs.readdirSync(outputDir).filter((name) => name.endsWith(".md")); } catch {}
    for (const name of existing) if (!expected.has(name)) errors.push(`unexpected:${name}`);
    if (errors.length) throw new Error(`extension portfolio docs are stale: ${errors.join(", ")}`);
    console.log(`extension portfolio docs current (${expected.size} files)`);
    return;
  }
  fs.mkdirSync(outputDir, { recursive: true });
  for (const name of fs.readdirSync(outputDir).filter((name) => name.endsWith(".md"))) if (!expected.has(name)) fs.unlinkSync(path.join(outputDir, name));
  for (const [name, content] of expected) fs.writeFileSync(path.join(outputDir, name), content);
  console.log(`wrote ${expected.size} extension portfolio files`);
}

main();
