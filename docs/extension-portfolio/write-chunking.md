# write-chunking

- **Schema:** 4
- **Owner:** runtime maintainer
- **User problem:** Keep one document payload inside one bounded model turn
- **Unique trigger:** write or append_file payload over the single-payload limit
- **Canonical surface:** append_file plus the sectioned-write rule carried in the write tool description
- **Overlap decision:** write/edit remain canonical for ordinary files; only one document payload is bounded
- **Mutation class:** guarded file write
- **Privacy class:** local file content only; no payloads persisted
- **Success metric:** Oversized document payloads are rejected with sectioned-write guidance so long document turns finish as bounded section writes
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_WRITE_CHUNKING
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `append_file`: **keep**; canonical=append_file plus the sectioned-write rule carried in the write tool description; trigger=write or append_file payload over the single-payload limit; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
