# ast-tools

- **Schema:** 4
- **Owner:** code tooling maintainer
- **User problem:** Lexical declaration search and checkpointed replacements
- **Unique trigger:** Focused declaration search or broad lexical refactor
- **Canonical surface:** ast_search/ast_refactor
- **Overlap decision:** Use read/edit for localized changes; LSP for semantic rename
- **Mutation class:** preview-apply
- **Privacy class:** local source; no durable bodies
- **Success metric:** Refactors preview before apply and changed tests pass
- **Dependency readiness:** none
- **Lifecycle:** core
- **Default model exposure:** default
- **Rollback/control:** PI_AST_TOOLS
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `ast_refactor`: **keep**; canonical=ast_search/ast_refactor; trigger=Focused declaration search or broad lexical refactor; evidence=unique trigger documented and regression coverage retained
- `ast_search`: **keep**; canonical=ast_search/ast_refactor; trigger=Focused declaration search or broad lexical refactor; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
