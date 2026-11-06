#!/usr/bin/env bash
# Manual, key-gated live check of the TypeSafe System One integration. It sends
# only synthetic text. Not part of scripts/check-all.sh, which stays network-free.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${TYPESAFE_API_KEY:-}" ]]; then
  echo "skip - TYPESAFE_API_KEY is not set"
  exit 0
fi

node - <<'NODE'
const { SystemOneAdapter } = require("./src/integration-boundary.js");
const { buildTurnRequest, decideTurn } = require("./src/typesafe-turn-judgment.js");
const { createTypeSafeClient } = require("./src/typesafe-client.js");

(async () => {
  const adapter = new SystemOneAdapter({ env: { ...process.env, PI_JEV_TURN_INTENT: "on" } });
  const probe = await adapter.probe();
  console.log(JSON.stringify({ probe, readiness: adapter.readiness() }, null, 2));
  if (!probe.ok) process.exit(1);
  if (probe.answeredBy !== probe.pinnedModel) {
    console.error(`pinned model ${probe.pinnedModel} answered as ${probe.answeredBy}`);
    process.exit(1);
  }

  // A full synthetic turn request exercises every question the harness sends.
  const request = buildTurnRequest({ redactedPrompt: "Start the full test suite in the background and tell me when it finishes." });
  const result = await createTypeSafeClient().systemOne(request);
  if (!result.ok) { console.error(`turn request failed: ${result.reason}`); process.exit(1); }
  const decision = decideTurn(result.answers);
  console.log(JSON.stringify({ model: result.model, inputTokens: result.inputTokens, latencyMs: result.latencyMs, decision }, null, 2));
  console.log("typesafe smoke passed");
})().catch((error) => { console.error(error); process.exit(1); });
NODE
