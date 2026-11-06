# Reasoning runtime stabilization checkpoint

Date: 2026-05-19
Version: `reasoning-runtime-2026-05-19.5`

## Stabilized behavior

- Hidden model context includes a `### Runtime version` banner with extension version, source fingerprint, and scaffold template hash.
- Injected reasoning scaffold is public, model-facing, and guarded against empty stale templates.
- `/reasoning-self-test` validates scaffold richness, rendered banner, stale-text filtering, architecture-memory dedupe, and scratchpad non-exposure.
- `scripts/check-reasoning-tui-injection.sh` starts a real Pi TUI under `tmux` and verifies the running extension path, not just static source.
- Semantic architecture memory is idempotent: only one `Reasoning runtime architecture` memory should remain after reload/startup.
- Resolved historical verification-failure memory can be removed with `/reasoning-clear-resolved-validation` and is superseded by a verified full-validation memory.
- `docs/adr-reasoning-runtime.md` records the architecture decision: model = reasoning engine; harness = cognitive runtime.
- `reasoning-runtime-2026-05-19.6` keeps prompt submission responsive by making automatic memory consolidation opt-in (`PI_COGNITIVE_AUTO_CONSOLIDATE=1`) and by filtering private/encrypted thinking payloads from assistant-turn memory.
- `reasoning-runtime-2026-05-19.7` makes `/reload` responsive by hydrating persisted cognitive memory in linear time instead of re-validating every saved entry with O(n²) duplicate checks.
- `reasoning-runtime-2026-05-19.8` trims prompt hot-path work by using cheap adapter scans for objective-memory dedupe, avoiding duplicate objective sync between `input` and `before_agent_start`, and not running full stale-state cleanup on every prompt.
- `reasoning-runtime-2026-05-19.9` improves `/new` and `/resume` by caching the reasoning boundary across same-cwd session replacement, running stale cleanup once per cwd, skipping slash-command objective persistence, and avoiding redundant large JSON persists during navigation shutdown.
- `reasoning-runtime-2026-05-28.0` adds the auto-role router (`/auto-roles`, `auto_role_router`, `PI_TOPOLOGY_AUTO_ROUTE`) with top-level interactive routing, explicit off/suggest/run modes, subagent-sidecar recursion prevention, and subagent-backed run mode for matched planner/coder/verifier topologies.
- `reasoning-runtime-2026-05-28.1` restores prompt-send UX by making `suggest` the default and ensuring explicit auto-role `run` mode starts background topology work without consuming the user's typed prompt.
- `reasoning-runtime-2026-07-18.0` prevents verifier-driven heap exhaustion by bounding child/custom verifier output, storing compact failure summaries with evidence references, continuously pruning automatic verification triples, using file-copy snapshots, and refusing/preserving oversized legacy JSON state before atomic replacement.

## Compatibility

The active project-local extension remains at the legacy path:

```text
.pi/extensions/reasoning-runtime/index.ts
```

The canonical runtime is `src/reasoning-runtime.js`; `src/cognitive-architecture.js` is compatibility-only.

## Validation checkpoint

Final stabilization validation should include:

```text
/reasoning-version
/reasoning-self-test
/reasoning-clear-stale
/reasoning-clear-resolved-validation
/reasoning-prune 30
/reasoning-debug-context
scripts/check-all.sh
```

Expected result: `/reasoning-self-test` reports `ok: true`, `architectureSemanticMemoryDeduped: true`, and no scratchpad exposure; `scripts/check-all.sh` reports `all checks passed`.
