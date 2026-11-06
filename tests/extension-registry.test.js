"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { scanExtensionRegistry, smokePlan, renderRegistryMarkdown } = require("../src/extension-registry");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-ext-reg-");
const outside = tmpFixture("pi-ext-reg-outside-");
const projectRoot = path.join(tmp, ".pi", "extensions");
const harnessRoot = path.join(tmp, "extensions");
fs.mkdirSync(path.join(projectRoot, "a"), { recursive: true });
fs.mkdirSync(path.join(harnessRoot, "b"), { recursive: true });
fs.mkdirSync(path.join(outside, "role-sidecar"), { recursive: true });
const aFile = path.join(projectRoot, "a", "index.ts");
const bFile = path.join(harnessRoot, "b", "index.ts");
const roleFile = path.join(outside, "role-sidecar", "index.ts");
fs.writeFileSync(aFile, "export default function(pi){ pi.registerCommand(\"x\",{}); pi.registerTool({ name: \"t\" }); pi.on(\"tool_call\",()=>{}); }\n");
fs.writeFileSync(bFile, "export default function(pi){ pi.registerCommand(\"x\",{}); registerOperationTool(pi, { name: \"helper_tool\", handlers: {} }); }\n");
fs.writeFileSync(roleFile, "export default function(pi){ if (process.env.PI_ROLE_SIDECAR !== \"1\") return; pi.registerTool({ name: \"role_only\" }); }\n");

const settingsPath = path.join(tmp, "settings.json");
const settings = { extensions: [projectRoot, harnessRoot, outside] };
fs.writeFileSync(settingsPath, JSON.stringify(settings));
const runtime = {
  tools: [
    { name: "read", sourceInfo: { source: "builtin", path: "<builtin:read>" } },
    { name: "t", sourceInfo: { source: "extension", scope: "project", path: aFile } },
    { name: "helper_tool", sourceInfo: { source: "extension", scope: "project", path: bFile } },
  ],
  activeTools: ["read", "t", "helper_tool"],
  commands: [
    { name: "x", source: "extension", sourceInfo: { source: "extension", scope: "project", path: aFile } },
    { name: "x:1", source: "extension", sourceInfo: { source: "extension", scope: "project", path: bFile } },
  ],
};
const registry = scanExtensionRegistry({ cwd: tmp, settingsPath, settings, runtime, env: { PI_ROLE_SIDECAR: "0" } });
assert.equal(registry.schemaVersion, 3);
assert.equal(registry.summary.configuredRoots, 3, "all configured settings roots, including an external directory, are read");
assert.equal(registry.summary.extensions, 3);
assert.equal(registry.summary.loaded, 2);
assert.equal(registry.summary.registeredCommands, 2);
assert.equal(registry.summary.registeredTools, 2, "built-in tools are excluded from extension surface totals");
assert.equal(registry.summary.activeTools, 2);
assert.equal(registry.summary.unexplainedDiscrepancies, 0);
assert.equal(registry.conflicts.commandConflicts[0].name, "x");
assert.equal(registry.conflicts.runtimeCommandConflicts[0].name, "x", "runtime duplicate suffixes reconcile to the original command id");
const helper = registry.extensions.find((extension) => extension.name === "b");
assert.deepEqual(helper.declared.helperTools, ["helper_tool"], "registerOperationTool registrations are present in advisory source inventory");
assert.deepEqual(helper.runtime.activeTools, ["helper_tool"]);
const role = registry.extensions.find((extension) => extension.name === "role-sidecar");
assert.equal(role.childOnly, true);
assert.equal(role.eligibility, "ineligible");
assert.equal(role.runtime.status, "inactive");
assert.match(role.runtime.reason, /PI_ROLE_SIDECAR/);
assert.equal(smokePlan(registry).length, 3);
assert.match(renderRegistryMarkdown(registry), /Registered commands\/tools: 2\/2/);
const directFileRegistry = scanExtensionRegistry({ cwd: tmp, settingsPath, settings: false, extensionPaths: [bFile], runtime: { available: false } });
assert.equal(directFileRegistry.extensions[0].name, "b", "a configured index.ts file uses its parent extension directory identity");
assert(!directFileRegistry.extensions.some((extension) => extension.name === "index"));
console.log("extension-registry tests passed");
