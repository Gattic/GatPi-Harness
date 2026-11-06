# fix-recall

- **Schema:** 4
- **Owner:** debug tooling maintainer
- **User problem:** Retrieve confirmed fixes for similar failures
- **Unique trigger:** Non-obvious command/test failure
- **Canonical surface:** fix_recall
- **Overlap decision:** debug_ledger owns the current attempt thread
- **Mutation class:** metadata-write by default; pure read with record:false
- **Privacy class:** redacted resolved summaries plus privacy-safe attribution metadata
- **Success metric:** Prior fix reduces repeated failed attempts
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_FIX_RECALL
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `fix_recall`: **keep**; canonical=fix_recall; trigger=Non-obvious command/test failure; evidence=unique trigger documented and regression coverage retained

## Retrieval telemetry

By default each lookup appends one private attribution row under `.pi/fix-recall/`. The row contains an opaque retrieval ID, timestamp, result counts, source classes, and a hash of the returned match set. It never stores the query, error text, prompt, transcript, private reasoning, raw tool output, or local paths. Pass `record:false` to the `fix_recall` tool, or use `/fix-recall --no-record`, for a pure read that creates no retrieval ID or telemetry state. Fix Recall never applies a retrieved change automatically.

## Comparative evidence boundary

Synthetic matches and unit tests establish deterministic behavior only; they do not establish comparative efficacy. The open exact-version field experiment remains insufficient data, so no ship, retire, merge, or rollout decision is authorized before its preregistered cohort and observation window are complete.

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
