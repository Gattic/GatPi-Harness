# Native CodeMode default-on harness integration

## Authorization and scope

Implement the investigated CodeMode design in full. The user's revision is authoritative: CodeMode is enabled by default in hybrid `codemode.mode: "on"`, with an explicit opt-out. There is no opt-in rollout, automatic move to `only`, or performance-gated enablement. Direct tools remain intentional interfaces, not a compatibility layer.

Worktree: `.worktrees/codemode-default-on`; branch: `feat/codemode-default-on`; starting revision: `5f25692f29501249fe3d95726a15a99e22ccbbee`. All task edits and checks are scoped to this worktree. Do not install into global settings, alter credentials, commit, merge, or push as part of implementation.

## Architecture and invariants

Reuse installed Pi's native QuickJS CodeMode factory and `ctx.executeTool()` pipeline. Do not introduce another executor, Cloudflare runtime dependency, shell-based dispatch, or cognitive orchestrator. Cognitive subsystems remain behind `src/integration-boundary.js` adapters.

Default-on means available, not mandatory: models choose scripts for deterministic chains, parallel reads, pagination and result filtering; direct calls remain appropriate for simple operations and decisions requiring model judgment. Keep the existing tool router's eligibility, exclusions, readiness and stable-session behavior. Do not convert the entire portfolio to `codemode`/`deferred` exposure.

Scripts have no additional authority. Initially restrict nested CodeMode operations to reviewed read-oriented operations; shell, source mutations, approval management, patch application, commits, specialist execution and long-running supervision remain direct. Disable the native `models.*` capability. Enforce deadlines, nested-call and concurrency limits outside generated code. A failed script does not roll back earlier calls.

Canonical structured results must preserve provenance, freshness, degradation, truncation and semantic outcomes. `Script completed` is not a verifier verdict. Domain-negative, blocked, not-applicable, cancelled and unrun states must never become success through output filtering. Existing verifier/evidence stores remain authoritative; session-local nesting correlation must not expand metadata-only fleet telemetry into raw argument/output capture. Review session store and spill-file privacy explicitly.

## Required deliverables and acceptance gates

### 1. Default-on native integration

- Register/configure the public native CodeMode factory, hybrid mode `on` by default, and activate it in ordinary harness sessions without global configuration writes.
- Provide documented environment/session opt-out; preserve explicit CLI tool exclusions, no-tools sessions, and restricted role allowlists.
- Disable `models.*`; use a reviewed nested-operation allowlist with fail-closed execution checks and discovery consistent with eligibility.
- Apply finite host-enforced script deadline, nested execution count, in-flight concurrency, and output limits. Cancellation must reach nested tools.
- Test default activation, opt-out, explicit exclusions, unsupported versions, policy denial, and limits through the actual native runtime.

### 2. Typed tools and nested observability

- Add schemas and validated `structuredContent` for `code_context`, `docs_lookup`, and `test_runner`; use the same canonical result for UI details and programmatic data, rather than parsing formatted text.
- Make output compaction nested-aware so presentation changes do not erase structured data or bypass redaction.
- Preserve nested tool policy hooks, actual execution accounting, privacy-safe telemetry and canonical evidence references. Synthetic failure/filtering cases must not authorize verification claims.
- Test outcome and schema fidelity, partial failures, cancellation, permission boundaries, session persistence and recovery behavior.

### 3. Provider-free acceptance

- Add end-to-end SDK/native CodeMode tests with synthetic provider messages and real harness tool/policy components where deterministic.
- Extend affected defaults/router/tool/compactor/privacy/evidence tests and check import-boundary conventions.
- Infer focused repository checks before running them; run narrow checks first, then affected regression checks. Run scoped compiler diagnostics and a final diff review. Record unrelated failures without repairing open bugs or changing frozen experiments.

### 4. Fixed comparative evaluation

- Implement a frozen 30-task paired manifest: ten simple direct-call controls, ten independent batches and ten dependent/filtering tasks. Use exact executable answer/evidence oracles, not model self-ratings.
- Baseline is current direct tools plus tool-surface routing and output compaction; treatment is the same tools/configuration plus governed CodeMode. Pin source, fixture, Pi, provider, model and thinking identities; counterbalance arm order.
- Record model turns, actual nested/direct tool calls, full model-visible input/declaration/output context, generated-code overhead, reported usage/cost, elapsed time, failures, correctness and evidence validity. Label estimates or missing provider metrics explicitly.
- Check existing experiments and preregister this separate comparison before executing paid runs. No retries, fallback providers, assertion changes or relabeling of historical outcomes. Preserve protected historical evidence and config/credential bytes.
- Proposed benefit targets: >=25% lower model-visible context on composed tasks, no >10% p95 latency/cost regression, exact oracle/evidence parity, and zero authority violations. These are evaluation targets, not a condition for the user-authorized default. A small pilot is not statistical noninferiority proof.
- Budget <=64 MiB task evidence and <=128 MiB newly owned temporary fixtures, one retained run directory per authorized comparison; private files/directories. Preserve failures, remove only newly owned successful temporary fixtures. Check disk before launch. If provider access or required observation is unavailable, retain an explicit incomplete/blocked live endpoint, never substitute synthetic performance as a live pass.

### 5. Documentation and closeout

- Document default-on hybrid behavior, opt-out, reviewed callable operations, resource limits, failure semantics, privacy and evidence boundaries, and benchmark invocation/results.
- Update fleet inventory/portfolio metadata only where changed registration requires it; no unrelated portfolio redesign.
- Reconcile every deliverable as implemented, verified, failed, blocked or unrun with exact evidence. Do not claim unmeasured benefit or repository verification based on the plan alone.

## Verification entry points

Existing relevant checks include `tests/tool-surface-router*.test.js`, `tests/harness-environment.test.js`, `tests/extension-load.test.js`, `tests/extension-telemetry.test.js`, `tests/result-rendering.test.js`, tool-specific tests, and `scripts/check-integration-boundary.sh`. The broad `scripts/check-all.sh` includes live provider/TUI checks and known open diagnostic cases; inspect its scope before launching it and preserve existing experimental constraints.

## Execution notes and pre-inference corrections

- The provider-free 60-case runner validation completed with exact fixture/oracle parity. Its original provider-payload context measurement is unavailable because synthetic providers do not build HTTP payloads. Those historical artifacts remain unchanged; a native regression now proves provider-neutral full-transcript measurement, and payload measurements are separately nullable.
- The first managed live launch did not inherit interactive `PI_PROVIDER`/`PI_MODEL` and stopped at `MODEL_IDENTITY_MISSING`, before model-runtime construction, requests, or case assignment. Preserve its original zero-case protocol/summary and ledger verdict. Identity is now accepted explicitly on the CLI and validated before registration. One explicit `--resume-unstarted` action may continue this exact zero-case preflight with additive protocol/summary version 02 and a newly pinned preregistration; no attempted case, provider failure or existing continuation may retry. This is correction of the launcher before inference, not a retry of measured work or a provider/account switch.

## Sources

- https://blog.cloudflare.com/code-mode/
- https://developers.cloudflare.com/agents/tools/codemode/
- Installed Pi `packages/coding-agent/docs/{codemode,extensions,sdk,settings,cli,security,mcp}.md`, public CodeMode factory and nested tool pipeline.
- Harness `src/tool-surface-router.js`, `.pi/extensions/{policy-enforcer,code-context,docs-lookup,test-runner,output-compactor}/index.ts`, `src/integration-boundary.js`, and canonical telemetry/evidence components.
