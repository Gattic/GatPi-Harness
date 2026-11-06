# Unified Evidence and Rollout Center

The Rollout Center is a read-only view over existing rollout and evidence authorities. It does not launch work, record ledger entries, generate scorecards, advance stages, authorize mutation, or update visual baselines.

## Surface

```text
/rollout-center [all|attention|stale]
```

The interactive overlay supports Up/Down or `j`/`k`, Enter/Right for details, `p` for provenance, Tab for filters, `r` for a read-only refresh, Left for the summary, and Esc to close. Headless use returns the same bounded metadata snapshot.

The extension is command-only. Extension Ops remains the extension inventory and portfolio authority.

## Capability model

Every capability keeps four independent verdicts:

1. technical readiness;
2. policy authorization;
3. field proof;
4. rollback/control availability.

The center also returns a fixed `nextObservation` descriptor. It is guidance only and has no action callback. Suggested surfaces are never invoked by the center.

Current adapters cover the extension portfolio, role runtime R0-R5, project memory M0-M5, compounding C0-C5, the Phase-7 scorecard, Verification Center, and Visual Verification. Debug Ledger, Experiment Ledger, Run Deck, and Evidence Binder appear only as bounded operational summaries and do not grant rollout authority.

## Truth and freshness

Native statuses are preserved. `insufficient-data`, `null-result`, stale evidence, provider failure, and missing exact-version identity are never converted into a pass. A planned canary is not execution evidence. Tree freshness and source-specific time/config/source fingerprints remain visible in provenance.

Snapshots are ephemeral. Refresh reconstructs one snapshot from authoritative sources; no Rollout Center state directory or competing history is created.

## Privacy

The adapter recursively rejects prompts, transcripts, private reasoning, commands, arguments, outputs, source bodies, notes, hypotheses, titles, secrets, and absolute paths. It returns only typed statuses, fixed reason/action codes, hashes, bounded counters, timestamps, and opaque evidence/provenance references.

Experiment Ledger schema v2 and the metadata-only Debug/Run summary APIs are prerequisites for aggregation. Legacy Experiment Ledger files are not migrated or aggregated.

## Boundary

Project extensions access the service through:

```js
boundary.rolloutCenter.snapshot(options)
boundary.rolloutCenter.capability(capabilityId)
boundary.rolloutCenter.provenance(provenanceRef)
boundary.rolloutCenter.status()
```

Disable with `PI_ROLLOUT_CENTER=0`.
