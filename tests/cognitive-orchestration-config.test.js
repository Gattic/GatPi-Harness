"use strict";
const assert = require("node:assert/strict");
const { createPiIntegrationBoundary } = require("../src/integration-boundary");
const { adapterConfig } = require("../src/integration-config");

(async () => {
  const off = createPiIntegrationBoundary(adapterConfig({ orchestration: { enabled: false } }));
  assert.equal((await off.orchestration.coordinate("x")).enabled, false);
  const on = createPiIntegrationBoundary(adapterConfig({ orchestration: { enabled: true } }));
  const result = await on.orchestration.coordinate("x", { steps: ["record explicit plan artifact"] });
  assert.equal(result.kind, "reasoning.scaffold");
  assert.equal(result.plan.type, "plan");
  console.log("cognitive-orchestration-config tests passed");
})();
