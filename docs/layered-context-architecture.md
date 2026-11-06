# Semantic multi-layer context architecture

This repo now contains a structured cognitive context architecture in `src/layered-context.js`. It is intentionally **not** a naive vector-store memory system: every memory block has an explicit layer, policy, score, integrity status, and observable packing decision.

## Layers

- **L0 operating principles**: immutable rules, system constraints, core behavior. Protected by default and never compacted.
- **L1 project constitution**: architecture memory, invariants, API contracts, coding standards. Protected from eviction; compacted only by extracting/merging invariants.
- **L2 active task state**: objectives, investigations, refactor plans. Medium TTL, high task-query weight.
- **L3 working set**: open files, recent tool outputs, short horizon reasoning. Short TTL and dependency-aware relevance.
- **L4 scratchpad**: volatile speculation and disposable exploration. Very short TTL, no guaranteed allocation.

## Retention policies

Each layer defines independent defaults:

- TTL (`defaultTTL`)
- base weight (`baseWeight`)
- minimum token allocation (`minBudgetRatio`)
- protection (`protected`)
- compaction eligibility (`compactable`)

Blocks can override TTL, importance, architectural importance, dependency references, verification status, and protection.

## Semantic decay

`semanticScore()` computes inspectable factors:

- recency
- access frequency
- dependency relevance
- architectural importance
- verification status
- query relevance
- access recency
- layer weight

Expired unprotected blocks are excluded during packing. Protected L0/L1 content receives a score floor to prevent architectural eviction.

## Packing engine

`pack({ tokenBudget, query, dependencyFocus })`:

1. Scores every block semantically.
2. Reserves per-layer budget according to layer policy.
3. Distributes remaining budget by weighted demand.
4. Admits protected invariants before lower-priority context.
5. Evicts only non-protected blocks on global overflow.
6. Returns both packed text and observations explaining inclusion/removal.

Observability includes included/removed block IDs, layer, token estimates, score factors, reasons, per-layer allocation, and final token use.

## Compaction

`compactLayer(layer)` supports:

- summarization compaction into semantic summary blocks
- semantic compression through first-sentence extraction and duplicate elimination
- invariant extraction from stale architectural/significant blocks into L1
- contradiction elimination by rejecting contradicted blocks and unverified conflicts

L0 is not compacted. L1 architecture can be protected or summarized into invariant form rather than discarded.

## Context integrity

Insertion runs `checkIntegrity()` before storing memory:

- rejects contradicted memories
- rejects unverified conflicts with protected memories
- deduplicates highly similar same-layer memories
- supports explicit `supersedes` and `contradicts` edges
- requires L0 blocks to be protected

This protects against conflicting rules, duplicate architecture facts, stale assumptions, and poisoning attempts.

## Migration plan

1. **Inventory existing context sources**: system/developer rules, Hermes durable recall, session task state, tool outputs, scratch reasoning.
2. **Map sources to layers**:
   - system/developer invariants -> L0
   - durable Hermes architecture/constraints -> L1
   - current prompt objectives and active plans -> L2
   - file/tool working set -> L3
   - speculative notes -> L4
3. **Wrap each source as `ContextBlock`** with verification and source metadata.
4. **Run integrity checks** before admission.
5. **Replace linear prompt packing** with `pack()` and pass packed text plus observability to diagnostics.
6. **Schedule compaction** on session boundaries and before budget pressure.
7. **Expose metrics** in harness diagnostics and regression scripts.

## Metrics

`metrics()` reports total blocks/tokens plus per-layer block count, token count, protected count, expired count, and average score. Packing observations report allocation and token-use decisions for each prompt.
