# lsp

- **Schema:** 4
- **Owner:** code tooling maintainer
- **User problem:** Compiler-backed definitions, references, diagnostics, and rename
- **Unique trigger:** Compiler-sensitive symbol task
- **Canonical surface:** lsp
- **Overlap decision:** ast_refactor handles lexical/mechanical changes
- **Mutation class:** read-only plus preview-apply rename
- **Privacy class:** local source on demand
- **Success metric:** Server-backed facts or explicit advisory fallback
- **Dependency readiness:** language server when available
- **Lifecycle:** core
- **Default model exposure:** default
- **Rollback/control:** PI_LSP
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `lsp`: **keep**; canonical=lsp; trigger=Compiler-sensitive symbol task; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
