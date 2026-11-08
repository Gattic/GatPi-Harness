"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { tmpFixture } = require("./helpers/tmp-fixture");
const { readTelemetryEvents } = require("../src/extension-telemetry.js");

if (!process.argv[2]) {
  for (const mode of ["off", "canary", "all"]) {
    const run = spawnSync(process.execPath, [__filename, mode], { encoding: "utf8", timeout: 30000 });
    assert.equal(run.status, 0, `${mode}: ${run.stdout}\n${run.stderr}`);
  }
  console.log("tool result observer tests passed");
} else {
  (async () => {
    process.env.PI_OUTPUT_COMPACTOR_MODE = process.argv[2];
    // Pin the canary set so this test exercises the outside-canary path rather
    // than depending on which tools the policy table happens to cover.
    if (process.argv[2] === "canary") process.env.PI_OUTPUT_COMPACTOR_CANARY_TOOLS = "read,bash,roadmap_update";
    process.env.PI_OUTPUT_COMPACTOR = "1";
    process.env.PI_EXTENSION_TELEMETRY = "1";
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    const piRoot = fs.realpathSync(path.join(globalRoot, "@earendil-works/pi-coding-agent"));
    const { createJiti } = require(require.resolve("jiti", { paths: [piRoot] }));
    const file = path.resolve(".pi/extensions/output-compactor/index.ts");
    const jiti = createJiti(file, { interopDefault: true, alias: { "@earendil-works/pi-coding-agent": piRoot, typebox: require.resolve("typebox", { paths: [piRoot] }) } });
    const extension = await jiti.import(file);
    const hooks = new Map();
    (extension.default || extension)({ on: (name, handler) => hooks.set(name, handler), registerCommand() {}, registerTool() {} });
    const cwd = tmpFixture("pi-result-observer-");
    const ctx = { cwd, sessionManager: { getSessionId: () => "fixture-session" } };
    const result = async (event, context) => {
      const transformed = await hooks.get("tool_result")(event, context);
      await hooks.get("tool_execution_end")({ ...event, result: { ...event, ...transformed } }, context);
      return transformed;
    };
    const text = (value) => [{ type: "text", text: value }];
    const event = { toolCallId: "native", toolName: "codegraph_query", input: {}, content: text("compact native result"), details: { rendering: { rawChars: 10000, modelChars: 21, budgetTokens: 700 } } };
    assert.equal(await result(event, ctx), undefined);
    let events = readTelemetryEvents({ cwd });
    const native = events.find((row) => row.feature === "tool-result-rendering");
    assert(native, "native result rendering must be observed even when no backstop runs");
    assert.equal(native.tool, "codegraph_query");
    assert.equal(native.inputChars, 10000);
    assert.equal(native.modelChars, 21);
    assert.equal(native.outputChars, 21);
    assert.equal(native.savedChars, 9979);
    assert.equal(native.budgetTokens, 700);

    await result({ ...event, toolCallId: "nested", parentToolCallId: "parent" }, ctx);
    assert.equal(readTelemetryEvents({ cwd }).length, events.length, "nested results do not double-count model-visible output");
    await result({ toolCallId: "read", toolName: "read", input: {}, content: text("small"), details: {} }, ctx);
    assert(readTelemetryEvents({ cwd }).some((row) => row.feature === "tool-result-rendering" && row.tool === "read"), "short non-retrieval results are observed too");

    const body = JSON.stringify({ diagnostic: "PRIVATE_OUTPUT_".repeat(800) });
    const verboseEvent = { ...event, toolCallId: "verbose", input: { verbose: true }, content: text(body), details: { raw: body } };
    assert.equal(await result(verboseEvent, ctx), undefined, "an explicit verbose request survives the backstop");
    const large = { ...event, toolCallId: "large", content: text(body), details: { raw: body, rendering: { rawChars: 20000, budgetTokens: 700 } } };
    const transformed = await result(large, ctx);
    events = readTelemetryEvents({ cwd });
    const measured = events.find((row) => row.feature === "tool-result-rendering" && row.inputChars === 20000);
    assert(measured);
    const finalChars = transformed ? transformed.content[0].text.length : body.length;
    assert.equal(measured.modelChars, body.length);
    assert.equal(measured.outputChars, finalChars);
    assert.equal(measured.savedChars, 20000 - finalChars);
    if (process.argv[2] === "all") assert(finalChars < body.length, "all mode uses the backstop");
    else {
      assert.equal(transformed, undefined);
      assert(events.some((row) => row.action === "bypassed" && row.tool === "codegraph_query" && ["disabled", "outside-canary"].includes(row.reason)), "bypasses remain attributable");
    }
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_OUTPUT_|fixture-session|rawChars|"diagnostic"/, "the observer stores counts, not result bodies or session identifiers");
    const nativeLarge = { ...large, toolCallId: "native-large", details: { rendering: { rawChars: 30000, budgetTokens: 4000 } } };
    assert.equal(await result(nativeLarge, ctx), undefined, "already-budgeted native views are not rendered a second time");
    const later = { ...event, toolCallId: "later-transformer" };
    await hooks.get("tool_result")(later, ctx);
    await hooks.get("tool_execution_end")({ ...later, result: { ...later, content: text("compact native result + later advisory") } }, ctx);
    events = readTelemetryEvents({ cwd });
    assert(events.some((row) => row.feature === "tool-result-rendering" && row.outputChars === 38), "observer measures the final content after later result transformers");
    const { collectHarnessMetrics } = require("../src/harness-metrics.js");
    const metrics = collectHarnessMetrics(cwd);
    assert(metrics.retrievalSavings.savedChars >= 9979, "metrics include native savings, not just backstop savings");
    assert.equal(metrics.retrievalSavings.results, events.filter((row) => row.feature === "tool-result-rendering").length, "backstop signals are not counted twice");
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}
