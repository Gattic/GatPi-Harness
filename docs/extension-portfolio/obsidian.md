# obsidian

- **Schema:** 4
- **Owner:** research-memory maintainer
- **User problem:** Local Markdown research and explicit Hermes curation
- **Unique trigger:** Explicit research/vault request
- **Canonical surface:** obsidian_*
- **Overlap decision:** Obsidian project notes are canonical; Hermes only drafts unverified candidates
- **Mutation class:** read/write/provider explicit
- **Privacy class:** vault-local; bounded explicit provider input
- **Success metric:** Local operations work independently and curation proves readiness
- **Dependency readiness:** vault; optional desktop/Hermes
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_OBSIDIAN
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `obsidian_doctor`: **keep**; canonical=obsidian_*; trigger=Explicit research/vault request; evidence=unique trigger documented and regression coverage retained
- `obsidian_hermes`: **keep**; canonical=obsidian_*; trigger=Explicit research/vault request; evidence=unique trigger documented and regression coverage retained
- `obsidian_import`: **keep**; canonical=obsidian_*; trigger=Explicit research/vault request; evidence=unique trigger documented and regression coverage retained
- `obsidian_note`: **keep**; canonical=obsidian_*; trigger=Explicit research/vault request; evidence=unique trigger documented and regression coverage retained
- `obsidian_search`: **keep**; canonical=obsidian_*; trigger=Explicit research/vault request; evidence=unique trigger documented and regression coverage retained
- `obsidian_status`: **keep**; canonical=obsidian_*; trigger=Explicit research/vault request; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
