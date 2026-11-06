# roadmap

- **Schema:** 4
- **Owner:** workflow tooling maintainer
- **User problem:** Visible recursive task and verification checklist
- **Unique trigger:** Multi-step work or explicit tracking
- **Canonical surface:** roadmap_update
- **Overlap decision:** create_subagent fan-out consumes reviewed plans but does not own plan state
- **Mutation class:** local state
- **Privacy class:** task titles/status/evidence references
- **Success metric:** Plan progress and verification remain visible
- **Dependency readiness:** none
- **Lifecycle:** core
- **Default model exposure:** default
- **Rollback/control:** PI_ROADMAP
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `roadmap_update`: **keep**; canonical=roadmap_update; trigger=Multi-step work or explicit tracking; evidence=unique trigger documented and regression coverage retained

## Read-only viewers

The `roadmap:changed` event includes a display-only `viewer` snapshot for pi-dash's TUI
(`o`) and Android (**Roadmap → Open roadmap** in session detail). It contains nested item
and subroadmap paths, statuses, recent notes, an update time, and root-outcome counts
separate from recursive workflow totals. It does not expose private reasoning or change
plan state. The payload includes the first 500 entries / 64 KiB, 500-character titles,
and the latest three notes of 200 characters each. `totalEntries` lets clients disclose
omissions rather than imply a complete tree. Reload sessions after updating the publisher.

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
