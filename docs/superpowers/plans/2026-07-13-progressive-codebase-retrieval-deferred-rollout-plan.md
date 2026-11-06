# Deferred Progressive Retrieval Providers and Rollout Plan

**Status:** Evidence-gated and intentionally blocked at baseline. This plan starts only after a named gate is met; it does not authorize provider installation, automatic context injection, or test suppression.

**Depends on:** `c5910fc` (`Implement progressive codebase retrieval`) and `docs/superpowers/plans/2026-07-13-progressive-codebase-retrieval-plan.md`.

**Goal:** Safely evaluate and, only when justified, promote the intentionally excluded work: selected-test rollout, bounded automatic context injection, SCIP, Zoekt, centralized multi-repository search, on-demand CodeQL/Joern analysis, and embedding-assisted retrieval.

## 1. Current Baseline and Claim Boundary

The post-commit scale probe recorded:

- revision: `c5910fcc94ec1261c3eb541326b85b5bbf1d116c`
- first-party footprint: 273 files / 2,343,726 bytes
- `rg --json` warm p95: 13.742 ms over 20 runs, zero failures
- repository count: 1
- classified deep-analysis queries: 0
- conceptual retrieval misses: 0
- optional binaries present: none of Serena, SCIP, Zoekt, CodeQL, or Joern
- decision: `block-batch-7`; eligible providers: none

The local report is `.pi/code-context/benchmarks/scale-gate-latest.json`. It is ignored runtime evidence, not a portable product claim. Reproduce it before every gate review:

```bash
node scripts/probe-code-context-scale-gates.js --iterations 20
```

The implementation remains `advisory` by default. `select-tests` and `on` require compatible saved reports. Stale/degraded providers remain non-gating, selected tests only augment baseline verification, and source bodies are never injected automatically by this plan without a later default-on gate.

## 2. Non-Negotiable Boundaries

1. Extend `code_context`; do not add duplicate generic model-facing retrieval tools.
2. Run optional providers lazily and outside the prompt hot path unless the default-on gate explicitly passes.
3. Keep provider state local, bounded, ignored, atomic, permission-restricted, and covered by Runtime Cleanup.
4. Do not send source, symbols, prompts, traces, or repository identity to a remote provider without an explicit privacy/security review and user configuration.
5. Provider absence, timeout, stale indexes, unsupported languages, malformed output, and version mismatch must produce degraded advisory envelopes.
6. No provider may authorize edits, suppress baseline tests, or claim compiler resolution unless its contract is fresh and gating-safe.
7. Every promotion must be reversible by changing `PI_CODE_CONTEXT_MODE`; rollback must require no data migration.
8. Treat a failed or null gate as settled evidence until repository scale, task mix, provider version, or measured demand materially changes.

## 3. Gate Matrix

| Deferred item | Entry evidence | Current verdict |
|---|---|---|
| `select-tests` | At least 30 representative paired tasks; all impact safety/precision bars; no critical regression or privacy/policy finding | Blocked: no qualifying paired report |
| `on` / automatic Level-1 injection | `select-tests` passed; preregistered powered non-inferiority sample; paired 95% CI lower bound above `-margin`; all token/latency/duplication bars | Blocked |
| SCIP | Measured live-LSP startup/index p95 exceeds the materiality bar or repeated semantic-session failures materially affect tasks | Blocked: no measured pressure |
| Zoekt | Representative `rg --json` warm p95 exceeds 2 seconds or has repeated bounded-timeout failures | Blocked: 13.742 ms, zero failures |
| Sourcegraph/Glean | More than one repository is required and local providers cannot satisfy cross-repository tasks; credentials/privacy approval exists | Blocked: one repository |
| CodeQL/Joern | Classified source-to-sink/path/write/guard questions are observed and current semantic/graph providers miss them | Blocked: zero observed demand |
| Embeddings | Measured conceptual-language or historical-fix misses remain after lexical/graph fusion, with a privacy-safe corpus policy | Blocked: zero observed misses |

## 4. Batch D0 — Preregister and Collect Representative Evidence

**Entry:** A gate review identifies a changed task mix, repository scale, provider reliability problem, or rollout experiment worth measuring.

**Files:**

- Extend: `tests/fixtures/code-context/manifest.json` only for genuinely new task classes
- Extend: `scripts/benchmark-code-context.js`
- Extend: `scripts/probe-code-context-scale-gates.js`
- Add: ignored run inputs under `.pi/code-context/benchmarks/`
- Update: `docs/code-context-benchmark.md`

### Tasks

- [ ] Pin repository revision, build configuration, provider versions, model settings, strategy ID, non-inferiority margin, alpha, power, and task success rules before candidate runs.
- [ ] Collect broad-read control and candidate runs for the same task/revision pairs.
- [ ] Include at least 30 distinct representative tasks before reviewing `select-tests`; do not inflate sample size by repeating the same fixture.
- [ ] Preserve failures, human corrections, broad-read fallbacks, critical-task labels, and privacy/policy findings.
- [ ] Calculate the powered paired sample required for `on` from observed control success and the preregistered margin.
- [ ] Store concise reports and hashes, not transcripts or full source.

### Verification

```bash
node tests/code-context-benchmark.test.js
node tests/code-context-scale-gates.test.js
node scripts/benchmark-code-context.js --fixture-only
node scripts/probe-code-context-scale-gates.js --iterations 20
```

### Stop condition

Stop with `NULL` if there are fewer than 30 distinct paired tasks, missing metrics, unresolved privacy/policy findings, or no changed scale/demand signal. Do not begin provider implementation from anecdotal latency or a single issue.

## 5. Batch D1 — Review and Pilot `select-tests`

**Entry:** Batch D0 produces a report with `promotion.selectTestsEligible=true`.

**Files:**

- Review first: `src/change-impact.js`, `src/test-evidence-index.js`, `src/test-runner.js`
- Review first: `.pi/extensions/verification-center/index.ts`
- Extend tests: `tests/change-impact.test.js`, `tests/test-evidence-index.test.js`, `tests/verification-center-impact.test.js`

### Tasks

- [ ] Independently review every `mustRun` edge source and stale/degraded exclusion.
- [ ] Run `PI_CODE_CONTEXT_MODE=select-tests` on a bounded pilot while retaining all discovered baseline commands.
- [ ] Record selected tests, baseline tests, runtime, failures, uncovered high-risk entities, and evidence IDs.
- [ ] Confirm high-risk recall is 100%, overall recall is at least 95%, precision is at least 70%, and critical regressions are zero.
- [ ] Confirm rollback to `advisory` changes behavior immediately and requires no cleanup or migration.

### Verification

```bash
node tests/change-impact.test.js
node tests/test-evidence-index.test.js
node tests/verification-center-impact.test.js
bash scripts/check-all.sh
```

### Stop condition

Any missed required test, stale/degraded gating edge, baseline suppression, critical regression, or report incompatibility immediately returns the mode to `advisory` and closes the pilot as `FAIL`.

## 6. Batch D2 — Shadow and Pilot Bounded Automatic Context

**Entry:** Batch D1 passes, and Batch D0 produces `promotion.onEligible=true` with a powered paired confidence interval.

**Likely files:**

- Modify: `.pi/extensions/code-context/index.ts`
- Modify: `src/code-context-service.js`
- Modify: `src/code-context-telemetry.js`
- Extend: `tests/code-context-extension.test.js`
- Extend: `tests/code-context-service.test.js`
- Extend: `tests/trace-adapter.test.js`

### Tasks

- [ ] Implement shadow assembly first: compute but do not inject a Level-1 repository map.
- [ ] Compare shadow output with explicit `repoMap` for revision, ranking, budget, source-kind, and freshness parity.
- [ ] Add at most one `before_agent_start` hook per extension instance, with clean lifecycle teardown and no stale Pi context retention.
- [ ] Inject signatures/relations only—never source bodies—and obey a hard token budget.
- [ ] Prohibit network access, server startup, builds, and recursive indexing on the prompt hot path.
- [ ] Emit bounded telemetry for injection decision, token count, latency, selected card IDs, and rollback mode.
- [ ] Require p95 shadow hot-path overhead at or below 100 ms and trace overhead below 5%.

### Verification

```bash
node tests/code-context-extension.test.js
node tests/code-context-service.test.js
node tests/repository-map.test.js
node tests/trace-adapter.test.js
bash scripts/check-extensions-smoke.sh
bash scripts/check-all.sh
```

### Stop condition

Any budget overrun, body leakage, stale/degraded gating use, lifecycle leak, p95 hot-path regression, task-success confidence-interval failure, or privacy finding disables injection and returns to explicit advisory retrieval.

## 7. Batch D3 — Conditional Optional Provider Pilots

Run only the subsection whose gate passes. Pilot one provider at a time so attribution remains identifiable.

### D3.1 SCIP semantic persistence

**Entry:** The SCIP gate passes with measured live-LSP startup/indexing pressure.

- Add a read-only `src/scip-adapter.js` behind the existing semantic contract.
- Normalize definitions, references, symbols, relationships, revision, index freshness, and configuration into existing cards.
- Keep live LSP authoritative for current open-document edits and diagnostics.
- Reject stale revision/configuration indexes as gating evidence.
- Compare startup, query latency, language coverage, fidelity, disk growth, and task success against direct LSP.
- Do not expose a `scip` model tool.

### D3.2 Zoekt lexical scale

**Entry:** The Zoekt gate passes on representative repository measurements.

- Add `src/zoekt-adapter.js` behind the lexical search contract.
- Preserve path confinement, source-kind filtering, exact-match priority, cursors, deterministic ranking, and bounded cards.
- Keep `rg --json` as fallback and control.
- Include index build/update cost and disk retention in the benchmark; never index during prompt assembly.
- Do not change the `code_context` schema.

### D3.3 Sourcegraph or Glean multi-repository search

**Entry:** The multi-repository gate passes and explicit credentials/privacy review is approved.

- Start with a provider-neutral remote search interface and one provider pilot, not both.
- Require repository allowlists, query redaction, secret/path policy, timeout/cancellation, audit logs, and explicit configuration.
- Return compact repository-qualified cards with provider/index revision.
- Keep remote results advisory until local revision/freshness can be reconciled.
- Never persist credentials, remote source bodies, or full query transcripts in traces or learning outcomes.

### D3.4 CodeQL or Joern on-demand dataflow

**Entry:** Classified deep-analysis demand is nonzero and current providers have measured misses.

- Add a classifier for source-to-sink, path-between-symbols, field-write, and dominating-guard questions.
- Pilot one engine behind an on-demand dataflow contract.
- Return bounded path cards and expandable node IDs rather than graph dumps.
- Run no database build or analysis in the default repository-map loop.
- Treat database revision/configuration mismatch as stale and non-gating.

### D3.5 Embedding-assisted fusion

**Entry:** Conceptual/historical retrieval misses are measured after lexical/graph fusion.

- Define an explicit corpus policy for design docs and reviewed historical summaries; source-code embedding requires separate approval.
- Use embeddings only as a ranking/fusion signal.
- Never use vectors to define symbol identity, references, overrides, build edges, or dataflow.
- Compare against lexical/graph controls for recall, nDCG, tokens, latency, cost, and privacy.
- Keep a deterministic non-embedding fallback.

### Shared provider verification

Each pilot must add deterministic adapter tests for absence, version mismatch, malformed/truncated output, timeout, cancellation, stale revision, unsupported language, path escape, bounded output, and clean shutdown. Then run:

```bash
node scripts/benchmark-code-context.js --fixture-only
node scripts/probe-code-context-scale-gates.js --iterations 20
bash scripts/check-extensions-smoke.sh
bash scripts/check-all.sh
```

### Shared provider stop condition

Do not adopt a provider unless it beats the current facade on its preregistered gate without reducing task success, violating privacy, changing model-facing schemas, or adding prompt-hot-path work. A null result leaves the current provider stack unchanged.

## 8. Batch D4 — Promotion, Monitoring, and Rollback

**Entry:** A rollout mode or optional provider pilot passes all preregistered bars and independent review.

### Tasks

- [ ] Save the exact compatible benchmark report and evidence IDs used for authorization.
- [ ] Roll out to a bounded project/task cohort before changing any default.
- [ ] Monitor task success, critical regressions, corrections, broad-read fallback, retrieval tokens, duplication, p95 latency, provider degradation, test recall, and privacy/policy findings.
- [ ] Attribute outcomes through explicit strategy/query/run IDs.
- [ ] Define automatic rollback thresholds before rollout.
- [ ] Verify `PI_CODE_CONTEXT_MODE=advisory` and provider-disable flags restore the current behavior immediately.
- [ ] Update README, runtime configuration, productization docs, and the gate matrix with measured evidence and claim boundaries.

### Final verification

```bash
node scripts/benchmark-code-context.js --input <paired-runs.json> --report .pi/code-context/benchmarks/latest.json
node scripts/probe-code-context-scale-gates.js --iterations 20
bash scripts/check-all.sh
```

No default or provider promotion is complete until the working tree is verified, the report is retained, rollback is exercised, and post-pilot evidence has no unresolved critical, privacy, or policy finding.

## 9. Recommended Next Action

Do not implement Batch D3 now. The next legitimate action is Batch D0 only when at least 30 distinct representative paired tasks or a materially changed scale/demand signal is available. Until then, keep `PI_CODE_CONTEXT_MODE=advisory`, retain explicit `code_context` retrieval, and rerun the scale probe only after a material repository/provider change.
