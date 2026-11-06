# Interactive validation log

Validation method: Pi tested itself in a real TUI session launched inside `tmux` from this repo. This exercises interactive command handling rather than print-mode only.

Environment used for validation:

```bash
PI_HERMES_AUTO_RECALL=0
PI_HERMES_AUTO_SYNC=0
PI_COGNITIVE_AUTO_VERIFY=0
PI_COGNITIVE_ORCHESTRATION_ENABLED=0
PI_COGNITIVE_AUTO_BRANCH=0
PI_TRACE_DIR=/tmp/pi-tui-selftest
pi
```

## Results

Latest validation: 2026-05-19, Pi `0.74.1`, `tmux`-driven real TUI session. Stabilization checkpoint: `reasoning-runtime-2026-05-19.5`, source hash `f3135517df1d32efc18913263767430e47946d875aae462bade4596240e26b91`.

| Command / flow | Result |
| --- | --- |
| startup | Loaded exactly `cognitive-automation`, `hermes-memory`, `trace-observability`. |
| `/reload` | Passed; keybindings/extensions/skills/prompts/themes reloaded, no duplicate Hermes extension. |
| `/new` | Passed; new session started and extensions remained active; reasoning artifact state persisted. |
| `/hermes-status` | Passed; showed project key shape `pi:pi-harness:<root-hash>`, cache path, auto recall/sync disabled in test env. |
| `/hermes-recall pi-harness` | Passed; recalled durable Hermes project memory and displayed it in TUI. |
| `/hermes-sync` | Passed; command accepted in real TUI without blocking the harness. |
| `/trace-status` | Passed; showed trace file, metrics, recent count, enabled state. |
| `/trace-live` | Passed; rendered recent live event row in TUI. |
| `/trace-timeline` | Passed; timeline rendered from current trace events. |
| `/trace-errors` | Passed; displayed `No trace errors`. |
| `/trace-export` | Passed; exported JSON under `PI_TRACE_DIR`. |
| `/cognitive-status` | Passed; rendered `Reasoning runtime: boundary-backed` with memory/context/reasoning/verification/branch counts. |
| `/cognitive-context` | Passed; stale `runtime.arch.coordinate`/role architecture context was purged and replaced with `Reasoning runtime architecture`. |
| `/reasoning-plan` | Passed; created an explicit plan artifact. |
| `/reasoning-artifacts` | Passed; listed public artifacts without scratchpad text. |
| `/reasoning-checkpoint` | Passed; created a public reflection checkpoint. |
| `/reasoning-failures` | Passed; displayed no failure-analysis artifacts when none existed. |
| `/reasoning-clear-stale` | Passed; removed stale local role-architecture memory/context entries. |
| `/reasoning-export` | Passed; exported public artifact packet under `.pi/cognitive-automation/` without scratchpad content. |
| `/reasoning-replay` | Passed; rendered public artifact timeline. |
| `/reasoning-debug-context` | Passed; showed scaffold/memory/layered-context/Hermes/trace sources and confirmed stale filtering was inactive because no stale blocks remained. |
| `/cognitive-verify` with `PI_COGNITIVE_AUTO_VERIFY=1` | Passed; scheduled verification and recorded failure evidence/feedback without crashing when the reasoning adapter is unavailable or compatibility-routed. |
| final prompt `say only ok` | Passed; model completed with `ok` and TUI status remained `reasoning-runtime`. |
| longer prompt session | Passed; 12-prompt TUI smoke kept active objective current (`say only ok turn 12`), status reported artifact counts by type/source, and `/reasoning-prune` executed without affecting protected evidence/decision artifacts. |
| `/reasoning-version` | Passed; confirmed running extension version, source fingerprint, template hash, active scaffold/decomposition templates, adapter availability, and config flags after restart/reload. |
| `/reasoning-self-test` | Passed; validates version banner rendering, template richness, semantic architecture memory dedupe, stale-text filtering, and no private scratchpad content exposure. Latest observed result: `ok=true`, architecture memory `count=1`, `duplicateCount=0`. |
| `/reasoning-clear-stale` | Passed in final stabilization validation; result `context=0, memory=0` after stale role-architecture cleanup was already complete. |
| `/reasoning-clear-resolved-validation` | Passed; removes stale `Automatic verification failed` procedural memory for `tests/hermes-memory-lifecycle.test.js` when superseded by later full validation and records a verified `Full validation passed` memory. |
| `/reasoning-prune 30` | Passed in final stabilization validation; protected verifier/failure/decision artifacts preserved. |
| `scripts/check-reasoning-tui-injection.sh` | Passed; starts a real Pi TUI under tmux and verifies `/reasoning-version` plus `/reasoning-self-test` observe adapter availability, runtime banner rendering, architecture memory dedupe, and scratchpad non-exposure. |
| `scripts/check-all.sh` | Passed after stabilization checkpoint; includes tests, extension smoke, reasoning TUI injection smoke, project setup checks, and Hermes regression. |
| prompt latency investigation | Fixed in `reasoning-runtime-2026-05-19.6`; root cause was synchronous `memory.consolidate({ force: true })` on `message_end` over hundreds of memory entries, compounded by accidentally stored encrypted thinking payloads. Auto consolidation is now opt-in and private assistant memory cleanup is available through `/reasoning-clear-private-memory`. |
| `/reload` latency investigation | Fixed in `reasoning-runtime-2026-05-19.7`; root cause was `CognitiveMemoryAdapter` rehydrating persisted memory through `remember()`, causing O(n²) duplicate/contradiction validation during extension startup. Persisted entries now hydrate directly as trusted local state. Local boundary creation dropped from ~7400ms to ~38ms. |
| prompt hot-path profiling | Improved in `reasoning-runtime-2026-05-19.8`; objective memory dedupe now uses cheap adapter scans instead of scored retrieval, objective sync is idempotent across `input`/`before_agent_start`, and stale-state cleanup is limited to startup/manual cleanup instead of every prompt. Existing objective sync dropped from ~60-110ms to sub-3ms in local profiling. |
| `/new` and `/resume` latency investigation | Improved in two passes. Hermes shutdown sync is opt-in with `PI_HERMES_SHUTDOWN_SYNC=1`; default shutdown records a skipped fast-path status instead of walking the full session branch. `reasoning-runtime-2026-05-19.9` also caches the reasoning boundary across same-cwd session replacement, runs stale cleanup only once per cwd, skips cognitive objective persistence for slash commands, and avoids redundant large JSON persists on `/new`, `/resume`, `/fork`, and `/reload`. `/hermes-sync` remains the correctness path for guaranteed durable sync before navigation. |
| scaffold template validation | Passed; post-reload TUI artifact inspection showed non-empty public scaffold summary/templates for new prompts. |
| `/compact` | Passed in prior validation; compaction entry rendered. |
| `/resume` | Passed in prior validation; resume selector opened and was dismissed with Escape. |
| `/fork` | Passed in prior validation; empty new session reported `No messages to fork from`. |

## Notes

- Initial install produced duplicate Hermes extension loading (`hermes-memory` and `hermes-memory.ts`) because the legacy global file still existed. `scripts/install-project-extensions.sh` now removes legacy copied Hermes entries and configures Pi's global settings to load harness extension source directories.
- A second TUI validation at that time confirmed the then-minimal extension list. Current operation intentionally loads the full harness extension set from `~/.pi/agent/settings.json`.

- Hermes recall included old durable notes about role-specialized orchestration and `runtime.arch.coordinate is not a function`; corrective Hermes durable memory now records `src/reasoning-runtime.js` as canonical and `src/cognitive-architecture.js` as compatibility-only. `OrchestrationAdapter.coordinate()` is compatibility-only and creates scaffold artifacts.
- The TUI status label now displays `reasoning-runtime` while old `/cognitive-*` commands remain compatibility aliases.
