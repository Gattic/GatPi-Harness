# codegraph

- **Schema:** 4
- **Owner:** retrieval maintainer
- **User problem:** Dependency-aware symbol and affected-test queries
- **Unique trigger:** Explicit graph query when index is ready
- **Canonical surface:** codegraph_* tools; /codegraph-files for explicit file-tree inspection
- **Overlap decision:** code_context is the canonical provider-neutral facade
- **Mutation class:** read-only/index update
- **Privacy class:** local index metadata
- **Success metric:** Fresh queries return useful symbols/tests or explicit degradation
- **Dependency readiness:** CodeGraph binary/index
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_CODEGRAPH
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `codegraph_affected`: **keep**; canonical=codegraph_* tools; /codegraph-files for explicit file-tree inspection; trigger=Explicit graph query when index is ready; evidence=unique trigger documented and regression coverage retained
- `codegraph_context`: **keep**; canonical=codegraph_* tools; /codegraph-files for explicit file-tree inspection; trigger=Explicit graph query when index is ready; evidence=unique trigger documented and regression coverage retained
- `codegraph_doctor`: **keep**; canonical=codegraph_* tools; /codegraph-files for explicit file-tree inspection; trigger=Explicit graph query when index is ready; evidence=unique trigger documented and regression coverage retained
- `codegraph_query`: **keep**; canonical=codegraph_* tools; /codegraph-files for explicit file-tree inspection; trigger=Explicit graph query when index is ready; evidence=unique trigger documented and regression coverage retained
- `codegraph_status`: **keep**; canonical=codegraph_* tools; /codegraph-files for explicit file-tree inspection; trigger=Explicit graph query when index is ready; evidence=unique trigger documented and regression coverage retained
- `codegraph_sync`: **keep**; canonical=codegraph_* tools; /codegraph-files for explicit file-tree inspection; trigger=Explicit graph query when index is ready; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
