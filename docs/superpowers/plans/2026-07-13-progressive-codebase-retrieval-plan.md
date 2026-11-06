# Progressive Codebase Retrieval Implementation Plan

> **Status:** Proposed. Implement batch-by-batch; do not enable automatic context injection or test suppression until the rollout gates pass.
>
> **Execution note:** This is a program-level roadmap, not one `/execute-plan` input. Expand and review one batch at a time as a task-level implementation plan before changing source; do not execute Batches 0-6 as one change set.

**Goal:** Turn the harness's existing CodeGraph and Semgrep capabilities into a compiler-aware, build-aware, token-budgeted retrieval system that reveals code progressively and can prove whether its retrieval strategy improves agent outcomes.

**Architectural principle:**

> Do not give the model a codebase. Give it a small, queryable model of the codebase, and reveal source code progressively.

**Architecture:** Existing CodeGraph + Semgrep, a real lazy LSP client behind the existing `lsp` facade, structured ripgrep results, a token-budgeted repository map, a local build/configuration graph, a branch-aware content ledger, and retrieval-specific tracing.

**Tech Stack:** Node.js 20+; CommonJS libraries under `src/`; project-local TypeScript extensions under `.pi/extensions/`; CodeGraph, Semgrep, ripgrep, language servers, CMake File API, compilation databases, and filesystem-backed JSON/JSONL state.

**Repository verification:** Focused tests run directly with `node tests/<name>.test.js`; the full repository gate is `bash scripts/check-all.sh`.

**Deferred scale-out:** SCIP/Sourcegraph/Glean, Zoekt, CodeQL/Joern, and embeddings remain provider options behind stable contracts. They are not prerequisites for the local implementation.

---

## 1. Current State and Confirmed Gaps

### Existing strengths

- CodeGraph is installed and indexed for this repository: 204 files, 4,165 nodes, and 12,254 edges. `src/codegraph-adapter.js` already provides status, query, task context, affected tests, file listing, sync, path confinement, output truncation, and mutation-based freshness tracking.
- Semgrep is installed and ready. `src/semgrep-adapter.js` already normalizes findings and can augment finding files with CodeGraph-affected tests.
- `src/layered-context.js:237-309` already has explicit scoring, token allocation, packing observations, and per-layer metrics for **cognitive memory**.
- `src/project-intelligence.js` inventories languages, manifests, CI, source/tests, symbols, changed files, and verifier profiles.
- `src/build-runner.js` and `src/test-runner.js` provide inferred/pinned execution, bounded output, failure hints, and rerun support.
- `src/trace-observability.js` and `.pi/extensions/trace-observability/index.ts` already capture tool, context, token, verifier, latency, and session events.
- `src/semantic-editor.js` already supports content hashes and optimistic file application.

### Confirmed gaps

1. **The current `lsp` tool is not compiler-grade semantic navigation.** `src/lsp-adapter.js` identifies itself as `fallback-lsp-adapter`; definitions, references, hover, and rename are lexical/regex operations. It does not maintain a language-server session. Current status also shows no TypeScript/Python/Go/Rust language server installed, and the registry does not check `clangd`.
2. **CodeGraph context is bounded by node/code counts, not a strict token budget.** `codegraph_context` accepts `maxNodes` and `maxCode`; it does not produce architecture cards, ranked symbol cards, or a measured `budget_tokens` envelope.
3. **The existing context packer is the wrong store for source context.** `LayeredContextMemory` is for durable/task/working memory. Source cards, content hashes, ranges, and per-session visibility need a separate retrieval ledger so code is not promoted into cognitive memory.
4. **Build awareness is discovery-only.** Project Intelligence sees manifests and scripts, and Build Runner sees commands, but there is no target ownership, configured dependency, action/artifact, generated-source, translation-unit, or compiler-flag graph.
5. **Search is fast but not card-based.** Built-in `rg`/bash and CodeGraph can locate text, but large candidate sets can still become raw model context. There is no shared search-result identity, structural dedupe, source-kind filtering, or exact-match ranking contract.
6. **Impact selection loses provenance.** `testImpact()` combines graph tests too broadly across changed files, test-path classifiers differ across modules, untracked files are omitted in several change detectors, and Verification Center only turns a narrow `*.test.js` subset into commands.
7. **Freshness is inconsistent.** CodeGraph CLI reports the index up to date while `.pi/codegraph/state.json` can remain stale because old mutation events are not reconciled against the current revision/clean tree. A stale advisory result can still influence test selection.
8. **Tracing is generic, not retrieval-evaluative.** Tool calls are visible, but the harness does not record candidate generation, ranking strategy, selected cards, duplicate/unused context, tokens until localization, or causal control/candidate outcomes. `contextAttributionReport()` currently uses keyword matching rather than explicit retrieval strategy IDs.
9. **Normalization is partial.** Build/test/LSP/CodeGraph/Semgrep adapters still retain or expose raw output paths in different shapes; malformed or degraded provider output is not consistently classified.

---

## 2. Decisions and Boundaries

### Decisions

1. **Keep existing adapters as provider boundaries.** Extend `src/lsp-adapter.js`, `src/codegraph-adapter.js`, `src/semgrep-adapter.js`, and `src/project-intelligence.js`; do not replace them with a second parallel stack.
2. **Add one read-oriented agent facade:** `code_context`, with an operation enum. The intended operations are:
   - `repoMap`
   - `search`
   - `symbolGet`
   - `symbolRelations`
   - `buildQuery`
   - `changeImpact`
   - `diagnostics`

   Continue to use the existing `semantic_patch`/`edit` tools for mutation. Direct `codegraph_*`, `lsp`, and `semgrep_*` tools remain available for backend diagnostics and compatibility, but normal coding guidance should prefer `code_context` once it reaches advisory mode.
3. **Use a direct JSON-RPC LSP client first.** The harness already has an agent-facing `lsp` facade, path policy, output handling, and file mutation queue. A lazy direct client fills the semantic gap with less routing and deployment overhead than introducing MCP as another required layer. Serena remains a comparison pilot, not the core dependency.
4. **Start lexical search with `rg --json`.** It is already locally available and sufficient for one repository. Keep a provider interface so Zoekt can be added for persistent multi-repository search later.
5. **Start build ingestion with CMake File API and `compile_commands.json`.** These are highest value for the harness's C++ use cases. Add provider interfaces for Bazel/Cargo/Go/TypeScript later.
6. **Keep source retrieval state separate from cognitive memory.** Store retrieval state under `.pi/code-context/`, keyed by project identity, revision, configuration, path, and content hash.
7. **Never gate on stale or degraded providers.** Such results may be shown as advisory cards, but cannot suppress baseline tests, claim resolved semantics, or authorize an edit.
8. **Progressive retrieval is explicit before it is automatic.** No `before_agent_start` source-map injection in the first rollout. The agent calls `code_context`; shadow telemetry measures behavior before optional automatic Level 0 injection is considered.

### Non-goals for the immediate program (Batches 0-6)

- No embeddings-only code RAG or vector database.
- No second generic AST engine; retain Semgrep and existing AST tools.
- No always-on CodeQL/Joern traversal.
- No generated/vendored/dependency code in default results.
- No automatic replacement of full verification with selected tests.
- No full-file summaries or LLM-generated symbol summaries as a source of truth.
- No coupling to CodeGraph's internal SQLite schema.

---

## 3. Target Architecture

```text
Task / diff / diagnostics / failed tests
                 |
          Query + budget planner
                 |
   +-------------+-------------+----------------+
   |             |             |                |
 lexical      semantic      structural       build/config
 rg/Zoekt     LSP/SCIP      CodeGraph       CMake/compile DB
   |             |             |                |
   +-------------+-------------+----------------+
                 |
      normalized cards and fact edges
                 |
      rank + fuse + structural dedupe
                 |
       strict token-budgeted packer
                 |
 branch-aware content/context ledger
                 |
          `code_context` tool
                 |
             coding agent
```

### Source-of-truth rules

- LSP supplies resolved definitions, references, implementations, type/hover data, diagnostics, and workspace edits.
- CodeGraph supplies broad repository relationships, graph neighborhoods, centrality/proximity candidates, and affected-test hints.
- Semgrep supplies syntax-aware policy/security findings.
- Build providers supply target/configuration/action/artifact facts.
- Lexical providers supply exact strings, identifiers, errors, keys, URLs, fields, and flags.
- Source text remains authoritative. Cards carry revision and content hashes; generated summaries never substitute for source.

### Progressive detail levels

- **Level 0 — architecture card:** 300-700 tokens, repository/subsystem/build summary.
- **Level 1 — repository map:** 1,000-2,000 tokens, paths, signatures, relations, targets, and tests; no bodies.
- **Level 2 — symbol cards:** normally 80-200 tokens each.
- **Level 3 — selected excerpts:** complete target body plus only required types/callers/tests.
- **Level 4 — full file:** explicit fallback only when file-local state, macros, generated code, or broad edits require it.

---

## 4. Shared Retrieval Contracts

Create a provider-neutral contract before adding more backends.

```js
{
  schemaVersion: 1,
  id: "symbol-or-result-id",
  provider: "lsp|codegraph|semgrep|ripgrep|build",
  queryId: "retrieval-query-id",
  revision: "git-sha-or-working-tree-fingerprint",
  configuration: "default-or-config-hash",
  sourceKind: "first_party|generated|vendored|dependency|build_output",
  path: "src/example.cpp",
  range: { startLine: 10, startColumn: 1, endLine: 20, endColumn: 2 },
  symbolId: "optional-stable-symbol-id",
  kind: "definition|reference|implementation|diagnostic|target|test|text",
  signature: "optional extractive signature",
  snippet: "bounded extractive snippet",
  score: 0.94,
  scoreReasons: ["exact_identifier", "changed_file_distance=1"],
  contentHash: "sha256-or-git-blob",
  freshness: "fresh|stale|unknown",
  degradation: null,
  provenance: [{ provider: "lsp", operation: "definition" }]
}
```

Every provider response must also report:

- elapsed milliseconds
- candidates retrieved and candidates returned
- bytes/tokens retrieved and returned
- truncation/degradation state
- revision/configuration/freshness
- stable query and strategy IDs
- whether the result is advisory or gating-safe

---

## 5. Execution Program

### Batch 0 — Contracts, Change Normalization, and Baseline

**Goal:** Establish stable result, freshness, telemetry, and benchmark contracts before adding new retrieval behavior.

**Entry:** Current CodeGraph/Semgrep/LSP adapters and trace runtime remain unchanged in behavior.

**Exit:** Existing providers can be wrapped in deterministic cards; all later batches share one change-set and telemetry vocabulary; a control baseline exists.

#### Task 0.1 — Add normalized retrieval contracts

**Files:**
- Create: `src/code-context-contracts.js`
- Create: `tests/code-context-contracts.test.js`
- Modify: `src/result-rendering.js`
- Modify: `tests/result-rendering.test.js`

- [ ] Define card, relation, diagnostic, test, build-fact, provider-status, and retrieval-envelope constructors/validators.
- [ ] Define `sourceKind`, `freshness`, `degradation`, and `gatingSafe` semantics.
- [ ] Add deterministic IDs and stable ordering; never use timestamps or mtimes as content identity.
- [ ] Add compact rendering that preserves IDs, paths, ranges, signatures, scores, reasons, freshness, errors, and content refs.
- [ ] Ensure malformed provider data becomes an explicit degraded envelope rather than an empty successful result.

#### Task 0.2 — Centralize revision and change-set normalization

**Files:**
- Create: `src/code-context-revision.js`
- Create: `tests/code-context-revision.test.js`
- Later consumers: `src/codegraph-adapter.js`, `src/project-intelligence.js`, `src/test-runner.js`, `.pi/extensions/verification-center/index.ts`

- [ ] Use `git status --porcelain=v2 -z` plus HEAD to include staged, unstaged, untracked, renamed, copied, and deleted paths.
- [ ] Normalize separators, repository-relative paths, and source kind once.
- [ ] Define working-tree revision as `{ head, statusFingerprint, configurationHash }`.
- [ ] Reconcile adapter freshness against actual revision/content, not old mutation events alone.
- [ ] Preserve rename source and destination so test/build impact can follow both sides.

#### Task 0.3 — Add a real-task retrieval benchmark skeleton

**Files:**
- Create: `tests/fixtures/code-context/`
- Create: `scripts/benchmark-code-context.js`
- Create: `docs/code-context-benchmark.md`
- Modify: `src/trace-observability.js` to reserve a `retrieval` event category/schema

Fixture groups:
- duplicate symbol names, overload-like declarations, re-exports, shadowing, comments/strings
- polyglot paths and generated/vendored exclusions
- changed/untracked/renamed/deleted files
- valid/malformed/truncated provider output
- positive and negative source-to-test edges
- gold task-to-file/symbol/span judgments

Record the broad-read control before enabling candidate routing:

```text
localization_recall
localization_precision
tokens_until_first_relevant_symbol
tokens_until_correct_edit_location
duplicate_context_ratio
unused_context_ratio
tool_calls_until_patch
compile_cycles_until_green
tests_selected_vs_tests_needed
wall_clock_ms
cost_per_successful_task
```

#### Verification

```bash
node tests/code-context-contracts.test.js
node tests/code-context-revision.test.js
node tests/result-rendering.test.js
node scripts/benchmark-code-context.js --fixture-only
bash scripts/check-all.sh
```

#### Stop condition

Do not start provider fusion until malformed output, revision changes, rename/delete cases, stable ordering, and compact field preservation are covered.

---

### Batch 1 — Compiler-Resolved Semantic Navigation

**Goal:** Turn the existing `lsp` facade into a real semantic layer while preserving deterministic fallback behavior.

**Entry:** Batch 0 contracts exist.

**Exit:** Definition/reference/implementation/type/diagnostic/rename results identify their backend and are compiler-resolved whenever a server is available. Lexical fallback can never masquerade as resolved semantics.

#### Task 1.1 — Split the current fallback from the facade

**Files:**
- Modify: `src/lsp-adapter.js`
- Create: `src/lsp-fallback.js`
- Create: `src/lsp-server-registry.js`
- Create: `tests/lsp-adapter.test.js`

- [ ] Move current regex symbol/reference/hover/rename behavior into an explicit fallback provider.
- [ ] Add language detection for C/C++/CUDA and a registry for `clangd`, `typescript-language-server`, Pyright/Pylsp, `gopls`, and `rust-analyzer`.
- [ ] Return `backend: live-lsp|compiler|fallback`, negotiated capabilities, and `gatingSafe` on every operation.
- [ ] Permit fallback definition/reference/search as advisory; make fallback rename preview-only by default.
- [ ] Add path, symlink, CRLF, collision, shadowing, comment/string, truncation, timeout, and abort tests.

#### Task 1.2 — Add a lazy JSON-RPC LSP session manager

**Files:**
- Create: `src/lsp-client.js`
- Create: `src/lsp-session-manager.js`
- Create: `tests/fixtures/fake-lsp-server.js`
- Create: `tests/lsp-session-manager.test.js`
- Modify: `.pi/extensions/lsp/index.ts`

- [ ] Start a server only on the first semantic operation for a language/root; never in the extension factory or prompt hot path.
- [ ] Implement initialize/capability negotiation, request IDs, cancellation, bounded stderr, process failure classification, document open/change/close, and clean shutdown.
- [ ] Close all session-scoped servers in `session_shutdown`; recreate after `/reload`, `/new`, `/resume`, or `/fork`.
- [ ] Key sessions by repository root, server, language, and build configuration.
- [ ] Add deterministic fake-server tests for multiplexed requests, out-of-order responses, diagnostics notifications, timeout, cancellation, crash, and restart.

#### Task 1.3 — Implement semantic operations and safe workspace edits

**Files:**
- Modify: `src/lsp-adapter.js`
- Modify: `.pi/extensions/lsp/index.ts`
- Modify: `src/semantic-editor.js`
- Modify: `tests/semantic-editor.test.js`
- Modify: `tests/lsp-adapter.test.js`

Operations:
- definition
- references
- implementations
- incoming/outgoing calls where supported
- type hierarchy where supported
- hover/type data
- diagnostics
- document/workspace symbols
- prepare rename / rename
- code actions as advisory previews

- [ ] Convert LSP locations and workspace edits into normalized cards/patch previews.
- [ ] Require expected content hashes before applying a workspace edit.
- [ ] Queue the entire read-modify-write window with `withFileMutationQueue()` for every touched file.
- [ ] Refuse apply on stale hashes, overlapping edits, paths outside the root, unsupported resource operations, or degraded fallback results.
- [ ] Preserve `lsp renamePreview` before `renameApply`; report per-file hashes and exact server provenance.

#### Task 1.4 — Compare Serena without coupling to it

- [ ] Run a small optional pilot against the same benchmark queries if Serena is locally available.
- [ ] Compare startup cost, language coverage, result fidelity, edit safety, and deployment complexity.
- [ ] Adopt Serena only as an optional semantic provider if it beats the direct facade on measured value. Do not expose a second model-facing tool solely for the pilot.

#### Verification

```bash
node tests/lsp-session-manager.test.js
node tests/lsp-adapter.test.js
node tests/semantic-editor.test.js
bash scripts/check-extensions-smoke.sh
bash scripts/check-all.sh
```

#### Stop condition

No operation may label lexical matches as semantic, and no rename may apply without a successful preview and hash validation.

---

### Batch 2 — Structured Search and Token-Budgeted Repository Map

**Goal:** Return compact ranked cards and a strict signatures-first repository map rather than raw search blocks or arbitrary CodeGraph context.

**Entry:** Normalized cards exist; semantic provider can produce resolved cards when available.

**Exit:** The agent can localize ordinary tasks through one read-only facade without seeing bodies until it asks for them.

#### Task 2.1 — Add a structured lexical provider

**Files:**
- Create: `src/lexical-search-adapter.js`
- Create: `tests/lexical-search-adapter.test.js`

- [ ] Execute `rg --json` with argument arrays, cancellation, path confinement, source-kind filters, and internal high candidate limits.
- [ ] Group matches by symbol/file, dedupe identical ranges/snippets, and return 10-20 cards by default.
- [ ] Rank exact identifiers/error strings/config keys ahead of fuzzy/comment/generated matches.
- [ ] Include cursors for expansion instead of dumping all candidates.
- [ ] Preserve full raw output externally only for troubleshooting; it must not be the default model content.

#### Task 2.2 — Add repository map ranking and strict packing

**Files:**
- Create: `src/repository-map.js`
- Create: `tests/repository-map.test.js`
- Modify: `src/codegraph-adapter.js` to expose structured JSON candidate methods without rendering them first
- Modify: `src/project-intelligence.js` to provide a compact architecture-card input

Candidate seeds:
- user terms and exact symbols
- mentioned paths/symbols
- current change set
- diagnostics and failed tests
- recently selected symbols
- stack frames
- owning build targets when available

Initial deterministic score:

```text
0.30 task/exact-term similarity
0.18 mentioned-symbol proximity
0.12 changed-file proximity
0.12 diagnostics/failure proximity
0.12 graph proximity/centrality
0.08 build-target relevance
0.05 relevant-test proximity
0.03 recent-selection relevance
```

- [ ] Use CodeGraph as the structural candidate router, not the sole source of truth.
- [ ] Render architecture and signature/relationship cards only; exclude bodies at Level 1.
- [ ] Pack against `budgetTokens`, report estimated/serialized token use, and never silently exceed the requested budget.
- [ ] Preserve at least one high-confidence exact match before graph-central but task-weak nodes.
- [ ] Add deterministic tie-breaking and generated/vendored exclusion tests.

#### Task 2.3 — Register the thin `code_context` extension

**Files:**
- Create: `.pi/extensions/code-context/index.ts`
- Create: `src/code-context-service.js`
- Create: `tests/code-context-extension.test.js`
- Create: `tests/code-context-service.test.js`
- Modify: `tests/extension-import-boundary.test.js`
- Modify: `tests/productization-extensions.test.js`
- Modify: `docs/integration-boundary.md`
- Modify: `docs/productization-extensions.md`
- Modify: `docs/runtime-configuration.md`
- Modify: `README.md`
- Modify: `scripts/check-extensions-smoke.sh` only if discovery needs explicit coverage

Initial operations:

```text
repoMap(task, seeds, changedPaths, budgetTokens, revision)
search(query, mode, paths, languages, kinds, limit, cursor)
symbolGet(symbolId, detail=card|outline|body, relatedTypes, revision)
symbolRelations(symbolId, relationKinds, direction, depth, limit, revision)
diagnostics(scope, revision, sinceRevision, severity, deduplicate)
```

- [ ] Keep the extension registration layer thin; all ranking/packing/provider logic lives under `src/`.
- [ ] Add `src/code-context-service.js` to the public extension-import allowlist and document the new adapter boundary.
- [ ] Document the tool, environment/mode behavior, optional-provider degradation, and non-blocking defaults when the extension is introduced—not only at final rollout.
- [ ] Include clear backend/freshness/degradation information in results.
- [ ] Keep existing `lsp` and `codegraph_*` tools for admin/debug compatibility.
- [ ] Add prompt guidance to prefer `repoMap`/cards before broad reads, but do not disable existing tools yet.

#### Verification

```bash
node tests/lexical-search-adapter.test.js
node tests/repository-map.test.js
node tests/code-context-service.test.js
node tests/code-context-extension.test.js
node tests/extension-import-boundary.test.js
node tests/productization-extensions.test.js
node tests/extension-load.test.js
bash scripts/check-extensions-smoke.sh
bash scripts/check-all.sh
```

#### Stop condition

The benchmark must show deterministic map output, zero budget overruns, correct exact-match retention, and no source body in Level 1 cards.

---

### Batch 3 — Build and Configuration Graph

**Goal:** Make target ownership, configured dependencies, generated sources, translation units, artifacts, and compiler flags queryable and usable as ranking/impact signals.

**Entry:** `code_context` can return repository maps and symbol/search cards.

**Exit:** `buildQuery` answers ownership/dependency/artifact/configuration questions with provenance and can enrich repository maps without running a build automatically.

#### Task 3.1 — Define build facts and provider interface

**Files:**
- Create: `src/build-graph.js`
- Create: `src/build-graph-store.js`
- Create: `tests/build-graph.test.js`

Relations:

```text
file --owned-by-target--> build_target
build_target --depends-on--> build_target
build_target --produces--> artifact
generator --generates--> source_file
test_target --tests--> build_target
translation_unit --compiled-with--> configuration
symbol/file --included-in--> translation_unit
```

- [ ] Key facts by repository, revision, configuration, provider, path, and content hash.
- [ ] Preserve multiple configurations/commands for one source file.
- [ ] Record provenance for every fact and classify unsupported/degraded providers.
- [ ] Keep storage behind an interface; use the repository's filesystem-backed JSON/JSONL convention with atomic writes and deterministic in-memory storage for tests. Treat SQLite as a later optional backend only after the minimum runtime is raised above Node.js 20 or a durable production fallback is accepted. Do not couple to CodeGraph's private database.

#### Task 3.2 — Ingest compilation databases and CMake File API

**Files:**
- Create: `src/build-graph-compile-commands.js`
- Create: `src/build-graph-cmake-file-api.js`
- Create: `tests/fixtures/build-graph/`
- Create: `tests/build-providers.test.js`

- [ ] Discover configured `compile_commands.json` and CMake reply directories without recursively scanning build outputs.
- [ ] Parse working directory, compiler, language mode, defines, includes, flags, output, and duplicate commands per source.
- [ ] Parse CMake codemodel targets, sources, dependencies, artifacts, generated flags, and configurations.
- [ ] Treat existing replies as read-only facts; never configure/build merely to answer a query.
- [ ] Exclude secret-like environment values and command payloads from model output; return normalized flag summaries and hashes.

#### Task 3.3 — Integrate pinned and lightweight project facts

**Files:**
- Modify: `src/build-runner.js`
- Modify: `src/project-intelligence.js`
- Modify: `.pi/extensions/project-intelligence/index.ts`
- Modify: `tests/build-runner.test.js`
- Modify: `tests/project-intelligence.test.js`

- [ ] Reuse `.pi/project.json`, package scripts, manifests, CI, and known test binaries as lower-confidence build facts.
- [ ] Make Project Intelligence report build-provider status and graph fingerprint, not duplicate the graph.
- [ ] Keep Build Runner responsible for execution; Build Graph is read/query only.

#### Task 3.4 — Add `buildQuery` and map enrichment

**Files:**
- Modify: `src/code-context-service.js`
- Modify: `.pi/extensions/code-context/index.ts`
- Modify: `src/repository-map.js`
- Modify: `tests/code-context-service.test.js`

```text
buildQuery(entities, relation=owner|deps|rdeps|actions|artifacts|configurations,
           configuration, maximumDepth, maximumResults)
```

- [ ] Add owning targets, relevant configurations, generated-source provenance, and likely test targets to symbol/map cards.
- [ ] Never merge facts from different configurations without labeling them.

#### Deferred providers after the local gate

- Bazel `query`, `cquery`, and `aquery`
- Cargo metadata
- `go list -json`
- TypeScript project references
- Gradle/Maven
- schemas and deployment manifests

#### Verification

```bash
node tests/build-graph.test.js
node tests/build-providers.test.js
node tests/build-runner.test.js
node tests/project-intelligence.test.js
node tests/code-context-service.test.js
bash scripts/check-all.sh
```

#### Stop condition

Gold fixtures must have complete owner/config/artifact provenance, and multi-configuration files must never collapse into one ambiguous command.

---

### Batch 4 — Branch-Aware Context Ledger and Structured Output

**Goal:** Avoid resending unchanged code while remaining correct across edits, compaction, branches, reloads, and configuration changes.

**Entry:** Cards carry revision/content hashes; `code_context` is read-only.

**Exit:** Unchanged visible content returns references; stale or compacted-away content is resent; all retrieval/build/test/diagnostic outputs are compact by construction.

#### Task 4.1 — Add content-addressed cache and ledger

**Files:**
- Create: `src/code-context-ledger.js`
- Create: `src/code-content-cache.js`
- Create: `tests/code-context-ledger.test.js`
- Modify: `.gitignore`
- Modify: `src/runtime-cleanup.js`
- Modify: `tests/runtime-cleanup.test.js`
- Modify: `src/project-identity.js` only if a reusable identity helper is needed

State root:

```text
.pi/code-context/
  index-state.json
  ledgers/<session-id>.json
  objects/<content-hash>.json
  benchmarks/
```

- [ ] Add `.pi/code-context/` to `.gitignore` before writing runtime state.
- [ ] Use Git blob IDs for unchanged tracked content and SHA-256 for working-tree/generated content.
- [ ] Cache cards, ranges, hashes, and bounded extracts by default; do not duplicate complete source files unless an explicit operation requires a temporary object.
- [ ] Use atomic writes, restrictive local permissions where supported, configurable size/age limits, and previewable garbage collection integrated with Runtime Cleanup.
- [ ] Track loaded symbol detail levels, file ranges, diagnostics, build configuration, revision, and last visible session entry.
- [ ] Reconstruct branch state from active tool-result `details` on `session_start`; persist only concise ledger deltas as custom/session state.
- [ ] Distinguish **known in cache** from **still visible to the model**. If compaction or branch navigation removes the source-bearing tool result from active context, resend the source/card rather than returning an unusable `unchanged` reference.
- [ ] Scope refs by project identity, revision, configuration, and content hash.

#### Task 4.2 — Wire lifecycle and invalidation

**Files:**
- Modify: `.pi/extensions/code-context/index.ts`
- Modify: `src/code-context-service.js`
- Reuse/extend: `src/codegraph-adapter.js` mutation detection
- Modify: `tests/code-context-extension.test.js`

- [ ] On `edit`, `write`, `semantic_patch`, LSP rename, and recognized modifying bash, mark only touched paths/neighborhood summaries stale.
- [ ] Re-hash on access; mutation events are hints, never the sole freshness proof.
- [ ] Handle `session_start`, `session_shutdown`, compaction, fork/tree navigation, and reload according to Pi's session lifecycle.
- [ ] Return `content_ref` only when the same or greater detail remains visible and unchanged.

#### Task 4.3 — Normalize diagnostics, tests, and command output at their source

**Files:**
- Create: `src/diagnostic-normalizer.js`
- Create: `src/test-result-normalizer.js`
- Create: `tests/diagnostic-normalizer.test.js`
- Create: `tests/test-result-normalizer.test.js`
- Create: `tests/test-runner.test.js`
- Modify: `src/lsp-adapter.js`
- Modify: `src/build-runner.js`
- Modify: `src/test-runner.js`
- Modify: `src/semgrep-adapter.js`
- Modify: `src/result-rendering.js`
- Modify: `.pi/extensions/output-compactor/index.ts`

- [ ] Deduplicate diagnostics by provider/code/path/range/message and support `sinceRevision` deltas.
- [ ] Normalize test pass/fail/skip, failure kind, expected/actual, top frames, command, duration, and output ref.
- [ ] Strip ANSI, progress, repeated warnings/frames, success-name floods, and unchanged diagnostics.
- [ ] Preserve full raw output outside model context with hashes and paths for targeted expansion.
- [ ] Treat generic Output Compactor as a safety net; adapters should already return compact content.

#### Verification

```bash
node tests/code-context-ledger.test.js
node tests/code-context-extension.test.js
node tests/diagnostic-normalizer.test.js
node tests/test-result-normalizer.test.js
node tests/lsp-adapter.test.js
node tests/test-runner.test.js
node tests/semgrep-adapter.test.js
node tests/result-rendering.test.js
node tests/build-runner.test.js
node tests/runtime-cleanup.test.js
bash scripts/check-all.sh
```

#### Stop condition

Pass edit/reload/fork/compaction tests proving no stale body is referenced and no still-needed body disappears behind a content ref.

---

### Batch 5 — Provenance-Preserving Change Impact and Test Selection

**Goal:** Combine semantic, graph, build, runtime, and historical evidence without turning weak candidates into mandatory facts.

**Entry:** Revision/change normalization, semantic relations, build facts, and content identity exist.

**Exit:** `changeImpact` returns source-to-test edges with confidence/provenance buckets, and Verification Center can safely augment baseline tests in shadow/advisory modes.

#### Task 5.1 — Build the static impact engine

**Files:**
- Create: `src/change-impact.js`
- Create: `src/test-paths.js`
- Create: `tests/change-impact.test.js`
- Modify: `src/project-intelligence.js`
- Modify: `.pi/extensions/test-gap-planner/index.ts`

Inputs:
- exact changed paths/symbols
- CodeGraph calls/imports/affected tests
- LSP implementations/references/call hierarchy
- build target ownership/rdeps/test targets
- Semgrep finding locations and risk

Outputs:

```text
mustRun
highConfidence
graphOnly
historical
uncoveredRisk
```

Each source-to-test edge must retain provider, relation path, configuration, confidence, freshness, and estimated runtime.

- [ ] Remove the global graph-test union that makes every test appear related to every file.
- [ ] Centralize test-path support for JS/TS/CJS/MJS, Python, Go, Rust, C/C++/CTest binaries, and configured custom tests.
- [ ] Prevent stale/degraded providers from producing `mustRun` edges.
- [ ] Report uncovered high-risk symbols/targets explicitly.

#### Task 5.2 — Add `changeImpact` and safe verifier integration

**Files:**
- Modify: `src/code-context-service.js`
- Modify: `.pi/extensions/code-context/index.ts`
- Modify: `src/test-runner.js`
- Modify: `.pi/extensions/verification-center/index.ts`
- Create: `tests/verification-center-impact.test.js`

```text
changeImpact(changedPaths, changedSymbols, includeBuildTargets,
             includeTests, includeRuntimeEdges, confidenceThreshold,
             maximumRuntime, maximumResults)
```

Rollout behavior:
- `shadow`: record recommendations only
- `advisory`: show recommendations; baseline remains unchanged
- `select-tests`: add high-confidence tests to baseline; never remove baseline/full gates
- `on`: eligible for broader routing only after benchmark approval

- [ ] Convert every supported test card into an executable command through Test Runner rather than hard-coding `*.test.js`.
- [ ] Respect maximum runtime by selecting from confidence buckets without dropping `mustRun` tests.
- [ ] Persist selected-test provenance in Verification Center evidence.
- [ ] Treat `unknown`, `not-applicable`, `degraded`, and `no-verifiers` distinctly from success.

#### Task 5.3 — Ingest dynamic and historical edges after static gates pass

**Files:**
- Create: `src/test-evidence-index.js`
- Create: `tests/test-evidence-index.test.js`
- Modify: `.pi/extensions/verification-center/index.ts`
- Modify: `src/learning-loop.js`

- [ ] Ingest coverage/test execution traces as `test --covered/loaded/called--> entity` edges with configuration and revision.
- [ ] Record test duration distributions for runtime-budget selection.
- [ ] Add historical co-change/fix similarity as low-confidence evidence only; never promote it above direct coverage/build facts without review.
- [ ] Keep owners/reviewers and architecture/history document linking as adjacent metadata, not source code context.

#### Verification

```bash
node tests/change-impact.test.js
node tests/test-evidence-index.test.js
node tests/project-intelligence.test.js
node tests/verification-center-impact.test.js
node tests/learning-loop.test.js
bash scripts/check-all.sh
```

#### Stop condition

High-risk fixture recall must be 100%, overall affected-test recall at least 95%, precision at least 70%, and no stale/degraded edge may suppress a baseline test.

---

### Batch 6 — Retrieval Telemetry, Evaluation, and Controlled Rollout

**Goal:** Measure which retrieval strategies help, then promote only strategies that reduce context without reducing task success.

**Entry:** Local semantic/map/build/ledger/impact stack works in explicit or shadow mode.

**Exit:** Every retrieval decision is attributable; benchmark/control comparisons are reproducible; rollout mode changes require evidence.

#### Task 6.1 — Emit retrieval-specific trace events

**Files:**
- Create: `src/code-context-telemetry.js`
- Modify: `src/code-context-service.js`
- Modify: `.pi/extensions/code-context/index.ts`
- Modify: `.pi/extensions/trace-observability/index.ts`
- Modify: `src/trace-observability.js`
- Modify: `tests/trace-adapter.test.js`

Use one namespaced `pi.events` channel such as `code-context:retrieval` so the retrieval service does not create a second trace runtime. The Trace Observability extension must capture its current session context on `session_start`, subscribe once per extension instance, unregister on shutdown/reload, and ignore events when tracing is disabled or unavailable. Event payloads carry stable session/project IDs rather than a long-lived `ctx`; no callback may retain a stale Pi context across session replacement.

Events:
- query classified / budget planned
- provider started/completed/degraded
- candidates retrieved/deduped/ranked/selected
- context packed / ref reused / content expanded
- selected tests proposed/executed
- edit location first reached
- verification outcome linked

Privacy rule: telemetry stores IDs, hashes, counts, scores, paths where policy allows, and bounded snippets only when explicitly enabled. It must not duplicate full source or transcripts. Telemetry remains optional and non-blocking; retrieval behavior must be unchanged when Trace Observability is absent.

#### Task 6.2 — Replace keyword attribution with explicit strategy attribution

**Files:**
- Modify: `src/learning-loop.js`
- Modify: `.pi/extensions/learning-loop-coordinator/index.ts`
- Modify: `tests/learning-loop.test.js`

- [ ] Add retrieval strategy/query/run IDs to learning outcomes.
- [ ] Aggregate success, quality, cost, latency, and correction rates by strategy and rollout mode.
- [ ] Keep attribution advisory until there are enough paired control/candidate tasks.
- [ ] Record human correction and fallback-to-broad-read events as negative evidence.

#### Task 6.3 — Complete benchmark and rollout gates

**Files:**
- Modify: `scripts/benchmark-code-context.js`
- Modify: `docs/code-context-benchmark.md`
- Modify: `docs/runtime-configuration.md`
- Modify: `README.md`
- Add env/mode handling in `.pi/extensions/code-context/index.ts`

Mode:

```text
PI_CODE_CONTEXT_MODE=off|shadow|advisory|select-tests|on
```

Promotion bars:

| Metric | Required bar |
|---|---:|
| Gold path/test normalization | 100% |
| Definition MRR | >= 0.90 |
| File Recall@5 | >= 0.95 |
| Relevant-span nDCG@10 | >= 0.85 |
| High-risk affected-test recall | 100% |
| Overall affected-test recall | >= 0.95 |
| Affected-test precision | >= 0.70 |
| Stale/degraded results used as gating evidence | 0 |
| Repository-map budget overruns | 0 |
| Median retrieval/context tokens vs broad-read control | >= 35% lower |
| Task-success pilot | candidate successes >= control with no critical-task regression |
| Default-on non-inferiority | lower bound of a paired 95% confidence interval exceeds a preregistered, power-justified margin |
| Duplicate context ratio | <= 0.10 |
| Warm explicit retrieval p95 | <= 2 seconds |
| Shadow prompt-hot-path overhead p95 | <= 100 ms |
| Trace overhead | < 5% |

- [ ] Define task success, critical-task regression, localization, duplicate context, and unused context operationally in the benchmark document before collecting promotion evidence.
- [ ] Use at least 30 representative paired tasks as an exploratory gate before `select-tests`; treat a 50-task run as a pilot, not proof of a one-point margin.
- [ ] Before `on`, calculate the required paired sample size from observed control success and a preregistered non-inferiority margin/confidence level; do not promote from a fixed arbitrary task count.
- [ ] Include multi-file bugs, interface changes, configuration-specific failures, generated code, regression-test selection, and similar historical fixes.
- [ ] Keep rollback as an environment-mode change; no migration should be required to return to current tools.

#### Verification

```bash
node tests/trace-adapter.test.js
node tests/learning-loop.test.js
node scripts/benchmark-code-context.js --fixture-only
node scripts/benchmark-code-context.js --report .pi/code-context/benchmarks/latest.json
bash scripts/check-all.sh
```

#### Stop condition

Do not enable `select-tests` or `on` from anecdotal wins. Promotion requires a saved benchmark report meeting all applicable bars and no unresolved privacy/policy findings.

---

### Batch 7 — Optional Scale-Out and Deep Analysis

This batch is intentionally gated on Batch 6 evidence and is not part of the immediate local delivery.

#### Semantic persistence and multi-repository search

- Add a SCIP provider behind the semantic contract when live LSP startup/index latency becomes material.
- Add Sourcegraph or Glean only for centralized/multi-repository deployment.
- Add Zoekt behind the lexical contract when `rg --json` no longer meets latency/scale bars.
- Do not change the `code_context` schema when switching providers.

#### On-demand dataflow

Add CodeQL or Joern only for classified deep-analysis questions:

```text
trace dataflow from source to sink
find paths between symbols
find writes to a field
find dominating guard conditions
```

Return bounded path cards with expandable node IDs. Never put deep analysis in the default repository-map loop.

#### Embeddings

Use embeddings only as a fusion signal for conceptual issue language, design documents, and similar historical fixes. They must not define symbol identity, references, overrides, build edges, or dataflow.

---

## 6. Cross-Batch Hotspots and Sequencing

### Critical dependency chain

```text
contracts/revision
  -> live semantic backend
  -> normalized search + repo map
  -> build/config facts
  -> content ledger
  -> impact/test selection
  -> evidence-backed rollout
```

### Hotspot files

- `src/lsp-adapter.js` and `.pi/extensions/lsp/index.ts`: Batch 1 only, then small integration edits in Batches 4/6.
- `src/project-intelligence.js`: currently mixes indexing, build discovery, and impact selection. Avoid concurrent work across Batches 0, 3, and 5.
- `.pi/extensions/verification-center/index.ts`: impact and evidence hotspot; change only after static impact contracts are stable.
- `.pi/extensions/trace-observability/index.ts`: add retrieval event subscription once, then keep provider code emitting through `pi.events`.
- `src/result-rendering.js`: establish card-preservation behavior in Batch 0 before normalizers depend on it.
- `tests/productization-extensions.test.js`: registration coverage only; do not treat it as behavioral verification.

### Parallel work that is safe

- In Batch 1, fake LSP server/session tests can proceed in parallel with fallback extraction after contracts are fixed.
- In Batch 2, lexical provider and repository-map ranker can proceed in parallel against shared cards.
- In Batch 3, compile-commands and CMake providers can proceed in parallel against shared build facts.
- In Batch 4, diagnostic and test normalizers can proceed in parallel; ledger lifecycle work should remain isolated.
- In Batch 5, runtime-evidence ingestion begins only after static impact output is stable.

### Work not to parallelize

- LSP workspace-edit application and semantic-editor hash changes.
- Revision/freshness changes across multiple adapters.
- Project Intelligence impact refactor and Verification Center selected-test integration.
- Ledger lifecycle behavior and compaction/branch handling.
- Rollout mode changes and benchmark threshold changes.

---

## 7. Definition of Done

The immediate program (Batches 0-6) is complete when:

- `lsp status` reports live semantic providers separately from fallback and compiler diagnostics.
- The `code_context` facade supports the seven read operations without duplicating mutation tools.
- Repository maps obey strict budgets and contain signatures/relations, not bodies.
- Build queries identify target/configuration/artifact provenance for CMake/compilation-database fixtures.
- Content refs remain valid across edits, reloads, compaction, and branches, or content is resent.
- Impact results preserve per-edge provenance and produce executable test commands across supported frameworks.
- Existing CodeGraph, Semgrep, LSP fallback, Build Runner, Test Runner, and Verification Center behavior remains available when `PI_CODE_CONTEXT_MODE=off`.
- Full `bash scripts/check-all.sh` passes.
- A saved paired benchmark meets the rollout bars before any gating behavior is enabled.

## 8. Recommended First Execution

Start with **Batch 0 only**. It is the smallest reversible foundation and prevents every later backend from inventing its own card, freshness, path, and telemetry shapes. Once Batch 0 is green, execute Batch 1 immediately; compiler-resolved semantics remains the highest-ROI capability gap.
