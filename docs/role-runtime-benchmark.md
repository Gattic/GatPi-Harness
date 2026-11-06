# Role runtime v2 benchmark and rollout

Specialist schema-v2 tasks inherit the parent model/effort unless a per-role
environment override is configured, and have no task/run
budgets or correction caps. Their usage is observational and subjective feedback
is non-blocking; generic-role budget metrics below do not impose specialist
limits. Native domain fixtures establish only their declared executable checks,
not live effectiveness. The matched field protocol remains unrun; see
[Explicit specialist tasks](specialist-tasks.md).

Role runtime v2 is promoted by measured gates, not by configuration availability alone. The deterministic benchmark is local, synthetic/redacted, and transcript-free:

```bash
node tests/role-runtime-benchmark.test.js
node scripts/benchmark-role-runtime.js --fixture-only
```

Use an explicit private report path to preserve deterministic evidence:

```bash
node scripts/benchmark-role-runtime.js \
  --fixture-only \
  --output .pi/role-runtime/benchmarks/latest.json
```

The output directory is hardened to `0700` and the report to `0600`. Reports contain fixture IDs, counters, rates, latency summaries, hashes, and gate verdicts—not prompts, transcripts, tool-result bodies, secrets, or source-file bodies.

## Deterministic cohorts

`tests/fixtures/role-runtime/manifest.json` pins:

1. fake-RPC terminal, budget, and tool-accounting cases;
2. weighted small read-only repository tasks with gold file outcomes;
3. weighted isolated mutation tasks with expected patch and verification outcomes;
4. reviewer/verifier known-defect and clean controls;
5. the reviewed router classification corpus.

A real-project run is deliberately not executable through the fixture runner. Deterministic evidence alone never authorizes field rollout. At R0, `PI_ROLE_FIELD_PILOT=1` permits explicitly invoked read-only roles so a live cohort can be collected. The sole automatic exception is the independently gated `PI_ROLE_WORKER_SHADOW_CANARY=1` path: one exact DeepSeek-V4.1-Flash/low worker may run for a bounded read-only classifier match in an interactive parent session, with its result kept separate. It never permits mutating roles or generic automatic topology routing.

## Metrics and bars

The report covers completion by role/contract, false success/failure, timeout/cancellation, queue/execution/total p50/p95, actual calls versus budgets, tool call/result parity, forbidden/unavailable tools, parent isolation, patch outcomes, typed outputs, evidence completeness, router precision/recall, requested/effective model-and-thinking parity, human correction/rejection, accepted-result cost/tokens, retained disk growth, and privacy findings. The runtime fingerprint includes `config/harness-defaults.env`, so changing the canonical role inference matrix invalidates prior benchmark and field evidence.

Promotion requires:

- zero deterministic false successes;
- zero unreported budget overruns;
- exact tool call/result accounting with explicit unmatched IDs;
- zero forbidden calls or unavailable-tool launches;
- zero parent mutations before explicit patch apply;
- 100% typed validity among succeeded runs;
- read-only completion at least 90%, timeout at most 5%, and p95 under 120 seconds;
- isolated mutation patch+verification reliability at least 90%;
- router precision at least 90% and zero auto-execution for opt-out/publish/destructive cases;
- mutation p95 within the manifest's preregistered fixture-size bar;
- zero privacy, transcript, or secret findings.

The full harness, Pi fork, and TUI/RPC checks remain an external release gate. A fixture report does not claim they passed.

## Live field cohort

Every new schema-v4 `role-run` records a canonical terminal category, typed-result validity, exact tool accounting validity, queue/execution/total duration, runtime/contract/result/source versions, runtime-source hash, mutation mode, fixed eligibility reason, selected/effective model, selected/effective thinking level, and policy sources. It stores no task, result body, provider payload, transcript, or private reasoning.

Generate a private aggregate report with an exact active-session exclusion:

```bash
node scripts/audit-role-runtime.js \
  --sessions ~/.pi/agent/sessions \
  --current-session /exact/current/session.jsonl \
  --output .pi/role-runtime/audits/latest.json
```

Eligible field runs are same-source schema-v4 live read-only terminal runs. Deliberate fixtures and operator cancellations are excluded and counted by reason; provider failures, malformed outputs, incomplete tools, accounting failures, and timeouts remain in the denominator. Promotion requires at least 30 eligible runs, completion >=90%, timeout <=5%, p95 <=120 seconds, 100% typed-result validity, 100% tool-accounting parity, and one exact cohort. Before 30 runs, every rate gate is `insufficient-data`. The historical Luna task-specific inference pilot additionally required 100% requested/effective profile parity, at least 95% typed terminal validity, zero privacy or mutation violations, no unsupported-claim or verification-quality regression against Sol/xhigh, no false-success/false-failure regression, complete accounting, lower measured cost, and improved or explicitly bounded p95 duration. Current defaults use `local/DeepSeek-V4.1-Flash-1017` for every model-backed role, with planner/reviewer/coder/refactorer/evidence-auditor at `high`, researcher/benchmark at `medium`, and worker/verifier at `low`. Prior Luna/Sol/Astra cohorts do not establish DeepSeek-V4.1-Flash quality; changing the model matrix invalidates their runtime fingerprint.

## Stages

| Stage | Scope |
|---|---|
| R0 | containment; v1 compatibility remains available, deterministic fixtures plus an enabled read-only field pilot; router advisory except for the guarded one-worker shadow canary |
| R1 | explicit read-only planner/researcher/reviewer pilot |
| R2 | explicit isolated coder/refactorer/verifier pilot in approved Git repositories |
| R3 | bounded explicit planner/coder/verifier and reviewer/verifier topology pilot |
| R4 | `suggest` is the normal advisory surface after router gates |
| R5 | optional explicit `delegate` after a separate opt-in real-project pilot |

A deterministic report plus a fresh passing >=30-run live field report can authorize at most R4. Either report alone leaves R0. Neither authorizes hidden background mutation.

## Runtime selection and rollback

```text
PI_ROLE_RUNTIME_VERSION=1|2
PI_ROLE_MUTATION=off|isolated
PI_TOPOLOGY_AUTO_ROUTE=off|suggest|shadow|delegate
PI_ROLE_SIDECAR=0|1
PI_ROLE_ROLLOUT_STAGE=R0|R1|R2|R3|R4|R5
PI_ROLE_RUNTIME_BENCHMARK_REPORT=.pi/role-runtime/benchmarks/latest.json
PI_ROLE_RUNTIME_BENCHMARK_MAX_AGE_MS=604800000
PI_ROLE_RUNTIME_FIELD_REPORT=.pi/role-runtime/audits/latest.json
PI_ROLE_RUNTIME_FIELD_MAX_AGE_MS=86400000
PI_ROLE_FIELD_PILOT=0|1
PI_ROLE_WORKER_SHADOW_CANARY=0|1
```

`src/role-runtime-rollout.js` separates evidence-selected rollout from explicit operator configuration. When `PI_ROLE_ROLLOUT_STAGE` is omitted, deterministic and live-field evidence must both pass and can select at most R4; missing, stale, mismatched, incomplete, mixed-cohort, or non-passing evidence leaves R0. When the stage is explicitly configured, it is authoritative and runtime status records `stageAuthority=configured-environment`, the lower `evidenceAuthorizedStage`, and `evidenceOverride=true` when applicable. This does not relabel benchmark or field evidence. Router `off`, `suggest`, `shadow`, and `delegate` settings are likewise honored, and missing/invalid router configuration now fails closed to `off`. At configured R5 with runtime v2, isolated mutation, sidecars enabled and `PI_MULTI_AGENT_TOPOLOGIES_ENABLED=1`, manual topology execution is available in normal sessions. A non-off router mode is needed only for separately approved automatic routing, not explicit tool/command launches. Manual availability is not a passing field-evaluation result. All code mutation remains in isolated worktrees until explicit parent patch application. `PI_ROLE_FIELD_PILOT=1` and `PI_ROLE_WORKER_SHADOW_CANARY=1` remain R0 collection controls. `PI_MULTI_AGENT_TOPOLOGIES_ENABLED=0`, router off, `R0`, version 1, mutation off, and sidecar off remain immediate state-preserving rollbacks.

Runtime Doctor reports selected/runtime versions, mutation mode, requested/effective stage, deterministic and field evidence status, eligible live sample size, pilot state, and legacy/current state split:

```text
/doctor-role-runtime
/runtime_doctor roleRuntime
```

Use `/doctor-cleanup-preview` before any role-state cleanup. Cleanup is manifest-first and retains active, failed/timed-out/cancelled, unapplied patch, and open debug-ledger-referenced evidence.
