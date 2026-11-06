# Task-Specific Subagent Model and Reasoning Policy

Status: implemented; production rollout remains contained at R0 with suggest-only routing and mutation off

## Objective

Make Pi harness subagent inference deterministic and task-appropriate by mapping each registered role to an explicit model and thinking level. Preserve GPT-5.6 Sol with strong reasoning for planning, implementation, review, refactoring, and evidence-audit work. Delegate clearly bounded, lower-reasoning work to GPT-5.6 Luna, the fastest and most economical available model, without weakening tool, workspace, result, privacy, or rollout controls.

## Baseline behavior before implementation

The role router already maps tasks to registered roles and topologies, and role contracts already vary prompts, tools, workspaces, budgets, context, and result schemas. However, built-in role model policies currently inherit the parent model, while RPC sidecars pass `--model` but do not explicitly pass `--thinking`. Fresh child sessions therefore fall back to Pi's global `defaultThinkingLevel`, currently `xhigh`.

The proposed policy makes both model and thinking level explicit at the role boundary.

## Design principles

1. Use the registered role as the first deterministic task-specific policy boundary.
2. Do not add a second free-form difficulty classifier in the initial implementation.
3. Use Luna only for roles whose work is explicitly bounded and low consequence.
4. Keep Sol at `xhigh` for planning and high-consequence implementation/review roles.
5. Pass model and thinking as separate CLI options; do not hide thinking in a `model:level` suffix.
6. Resolve and record requested and effective inference settings without storing prompts, provider payloads, transcripts, or private reasoning.
7. Fail before provider execution when model/thinking policy is invalid or the child starts with a mismatched effective profile.
8. Retain the existing workspace, mutation, tool, typed-result, budget, and rollout gates unchanged.
9. Keep explicit process-environment values as operator overrides over guarded repository defaults.
10. Do not add compatibility shims or silent migrations for incomplete role policies.

## Canonical role policy

| Role | Model | Thinking level | Rationale |
|---|---|---:|---|
| `planner` | `openai-codex/gpt-5.6-sol` | `xhigh` | Planning establishes architecture, scope, dependencies, risks, and executable roadmap structure. |
| `researcher` | `openai-codex/gpt-5.6-sol` | `medium` | Nontrivial repository evidence gathering and bounded synthesis. Simple lookups should use `worker`. |
| `reviewer` | `openai-codex/gpt-5.6-sol` | `xhigh` | Correctness, security, policy, and regression review is high consequence. |
| `coder` | `openai-codex/gpt-5.6-sol` | `xhigh` | Implementation remains on the strongest default reasoning profile initially. |
| `verifier` | `openai-codex/gpt-5.6-luna` | `low` | Executes approved verification commands and reports exact outcomes without repairing failures. |
| `refactorer` | `openai-codex/gpt-5.6-sol` | `xhigh` | Invariant-preserving refactoring requires deep reasoning. |
| `benchmark` | `openai-codex/gpt-5.6-luna` | `medium` | Performs bounded metric collection, comparison, and validity reporting. |
| `evidence-auditor` | `openai-codex/gpt-5.6-sol` | `xhigh` | Must detect contradictions, unsupported claims, provenance gaps, and partial truth. |
| `worker` | `openai-codex/gpt-5.6-luna` | `low` | Canonical role for easy, bounded, read-only delegated tasks. |
| `coordinator` | no model | N/A | Handler-only deterministic aggregation. |
| `memory-curator` | no model | N/A | Handler-only deterministic curation from verified upstream results. |
| `skill-intake-handler` | no model | N/A | Handler-only governed skill-intake stage. |
| `tool-specialist` | no model | N/A | Handler-only narrow tool execution. |

Luna is deliberately limited to `worker`, `verifier`, and `benchmark` in the initial policy. Moving research, planning, coding, review, refactoring, or evidence audit to Luna requires separate quality evidence.

The local Pi catalog confirms that `openai-codex/gpt-5.6-luna` is reasoning-capable. Its listed input and output rates are 25 times lower than Sol's corresponding rates. The speed characterization is a stated product requirement and should be measured during the live pilot rather than treated as already proven by this plan.

## Policy contract

Extend the existing role `modelPolicy` with a first-class thinking setting:

```js
modelPolicy: {
  mode: "inherit" | "preferred" | "fixed",
  preference: "provider/model" | null,
  fallback: "inherit" | "provider/model",
  thinkingLevel: "inherit" | "off" | "minimal" | "low" |
                 "medium" | "high" | "xhigh" | "max",
}
```

### Resolution precedence

Resolve model and thinking independently in this order:

1. `PI_ROLE_MODEL_<ROLE_ID>` and `PI_ROLE_THINKING_<ROLE_ID>` operator environment overrides.
2. The registered role contract's `modelPolicy`.
3. The parent session's current model and effective thinking level when the contract requests `inherit`.

Normalize role IDs for environment variables using the existing uppercase underscore convention. For example, `evidence-auditor` maps to `PI_ROLE_MODEL_EVIDENCE_AUDITOR` and `PI_ROLE_THINKING_EVIDENCE_AUDITOR`.

### Required semantics

- Every model-backed sidecar launch receives both `--model <provider/model>` and `--thinking <level>`.
- `inherit` is resolved in the parent before spawning; it is never left for the child to reinterpret through global settings.
- Model strings containing a trailing Pi thinking suffix are rejected for role-policy configuration. Model and thinking must remain separate and independently observable.
- Invalid model or thinking configuration fails before child launch.
- Handler-only roles do not resolve or launch a model profile.
- Custom read-only roles inherit the parent model and effective thinking level. They do not automatically receive Luna because their difficulty is unknown.
- No silent Luna-to-Sol fallback is added initially. Missing model access or authentication should produce a clear failed launch rather than an unrecorded policy substitution.
- If Pi clamps or otherwise changes the requested level, the role sidecar detects the mismatch before its first provider request and fails closed.

## Canonical configuration

Add the reviewed fleet defaults to `config/harness-defaults.env`:

```dotenv
PI_ROLE_MODEL_PLANNER=openai-codex/gpt-5.6-sol
PI_ROLE_THINKING_PLANNER=xhigh
PI_ROLE_MODEL_RESEARCHER=openai-codex/gpt-5.6-sol
PI_ROLE_THINKING_RESEARCHER=medium
PI_ROLE_MODEL_REVIEWER=openai-codex/gpt-5.6-sol
PI_ROLE_THINKING_REVIEWER=xhigh
PI_ROLE_MODEL_CODER=openai-codex/gpt-5.6-sol
PI_ROLE_THINKING_CODER=xhigh
PI_ROLE_MODEL_VERIFIER=openai-codex/gpt-5.6-luna
PI_ROLE_THINKING_VERIFIER=low
PI_ROLE_MODEL_REFACTORER=openai-codex/gpt-5.6-sol
PI_ROLE_THINKING_REFACTORER=xhigh
PI_ROLE_MODEL_BENCHMARK=openai-codex/gpt-5.6-luna
PI_ROLE_THINKING_BENCHMARK=medium
PI_ROLE_MODEL_EVIDENCE_AUDITOR=openai-codex/gpt-5.6-sol
PI_ROLE_THINKING_EVIDENCE_AUDITOR=xhigh
PI_ROLE_MODEL_WORKER=openai-codex/gpt-5.6-luna
PI_ROLE_THINKING_WORKER=low
```

Do not add model or thinking variables for handler-only roles. The existing defaults loader must continue preserving any value already present in the process environment.

## Exact implementation changes

### `config/harness-defaults.env`

- Add the canonical model/thinking matrix above.
- Keep role rollout at R0 and mutation off while the new policy is validated.
- Document that easy delegated work should use `worker`, not an underpowered override of a complex role.

### `src/harness-environment.js`

- Extend the guarded value pattern to accept `/` so canonical `provider/model` strings are valid.
- Continue rejecting whitespace, quotes, shell interpolation, command substitution, and arbitrary shell syntax.
- Do not generalize this parser into a shell environment parser.

### `src/role-contracts.js`

- Add constants for Pi thinking levels and policy values including `inherit`.
- Add required `modelPolicy.thinkingLevel` validation.
- Add `roleThinkingEnvName(roleId)` alongside `roleModelEnvName(roleId)`.
- Replace model-only selection with a single inference-profile resolver that returns:

```js
{
  selectedModel,
  fallbackModel,
  selectedThinkingLevel,
  modelPolicySource,
  thinkingPolicySource,
}
```

- Apply environment, contract, and parent precedence independently for model and thinking.
- Reject invalid thinking levels.
- Reject role model strings that embed a thinking suffix.
- Ensure every built-in model-backed role has a complete policy and every handler-only role remains zero-model.
- Clarify the `worker` role description as the route for easy bounded read-only delegation.
- Clarify that `researcher` is for nontrivial evidence collection or synthesis rather than simple lookup.

### `src/subagents.js`

- Add a helper to read the parent effective thinking level from `context.thinkingLevel` or `context.ctx.thinkingLevel`.
- Resolve the full inference profile in `SubagentRunner.rpcArgs()`.
- Add `--thinking <selectedThinkingLevel>` beside `--model <selectedModel>` for model-backed launches.
- Pass the expected model and thinking level to the child in fixed, non-secret sidecar environment variables.
- Keep normal Pi model resolution and authentication handling; do not call provider APIs during policy resolution.
- Capture the RPC `get_state` model and thinking level as the effective child profile.
- Fail a role-v2 run if the effective profile differs from the resolved requested profile.
- Add bounded diagnostics fields for requested/selected/effective thinking and policy source.
- Preserve existing model/tool/wall-clock/result budgets and queue accounting.

### `.pi/extensions/reasoning-runtime/index.ts`

Pass both current model and current effective thinking level through every subagent-capable context:

```ts
{
  model: ctx.model,
  thinkingLevel: ctx.thinkingLevel,
}
```

Update all of these paths:

- direct `create_subagent` execution;
- `/subagent-run` command execution;
- `/topology-run` command execution;
- model-callable `run_topology` execution;
- explicit auto-role-router execution;
- governed topology paths that launch model-backed nodes.

Extend parent-session role-run provenance with:

- `selectedThinkingLevel`;
- `effectiveThinkingLevel`;
- `thinkingPolicySource`.

Do not append prompts, provider request bodies, thinking text, or child transcript content.

### `src/multi-agent-topologies.js`

- Preserve `modelPolicy.thinkingLevel` through role registration and cloning.
- Preserve it when narrowing a role for a topology node.
- Pass it into `SubagentTopologyExecutor` and the branch-backed subagent record.
- Continue requiring reviewed policy elevation before a node may broaden or change model policy.
- Ensure handler-only nodes ignore inference settings and never launch a child.

### `extensions/role-sidecar/index.ts`

- Extend the local `RoleContract` type with the complete model policy.
- Decode and validate the expected model and thinking values supplied by the parent launch.
- During `session_start`, activate tools and verify `ctx.model` plus `ctx.thinkingLevel` against the expected profile.
- Recheck immediately before the first provider request.
- Abort before provider use if model or thinking differs, including any Pi capability clamp.
- Keep the existing model-call budget, reviewer submission reserve, tool/path policy, and typed terminating result behavior.

### `src/role-run-provenance.js`

- Add bounded fields for requested, selected, and effective thinking level plus policy source.
- Increment the role-run provenance schema from 3 to 4.
- Rename version-specific field-list identifiers if needed so the canonical allowlist name does not imply the obsolete schema.
- Keep all new fields categorical and bounded.
- Explicitly exclude prompts, provider payloads, private reasoning, transcript bodies, tool output, and credentials.

### Runtime evidence and versioning

- Keep RoleResultEnvelope schema v2 and topology schema v3 unchanged because their public result and graph formats do not change.
- Treat `modelPolicy.thinkingLevel` as completing the already-existing role model policy rather than creating a second orchestration contract.
- Require the field in current contracts; do not add a compatibility shim that reconstructs it from old defaults.
- Let the runtime source fingerprint invalidate deterministic and field evidence produced by the previous execution policy.
- Keep rollout at R0 until current-source deterministic checks and the read-only live pilot pass.

### Documentation

Update:

- `docs/runtime-configuration.md` with environment variables, precedence, matrix, and rollback behavior;
- `docs/multi-agent-topologies.md` with the full model policy contract and role matrix;
- `docs/subagents.md` with explicit child model/thinking inheritance and enforcement semantics;
- `docs/role-runtime-benchmark.md` with inference-profile evidence and live-pilot bars;
- any role-sidecar portfolio or topology cookbook sections that currently describe model inheritance without thinking-level policy.

Documentation must distinguish requested, selected, and effective settings and state that Luna is initially restricted to `worker`, `verifier`, and `benchmark`.

## Test plan

### `tests/harness-environment.test.js`

Add coverage for:

- the complete canonical role matrix;
- provider/model values containing `/`;
- explicit environment values overriding repository defaults;
- rejection of shell interpolation and command-like values after `/` support is added;
- absence of inference variables for handler-only roles.

### `tests/role-contracts.test.js`

Add coverage for:

- every model-backed role having a valid model policy and thinking level;
- every handler-only role retaining zero model calls;
- environment override precedence over contract and parent values;
- contract values taking precedence over inherited parent values;
- exact inheritance of the parent's effective thinking level;
- invalid thinking levels failing validation;
- embedded model thinking suffixes failing validation;
- normalized environment names for hyphenated roles;
- custom read-only roles inheriting rather than automatically selecting Luna.

### `tests/subagents.test.js`

Add coverage for:

- RPC argv containing both `--model` and `--thinking`;
- `worker` resolving to Luna/low;
- `verifier` resolving to Luna/low;
- `benchmark` resolving to Luna/medium;
- `planner`, `reviewer`, `coder`, `refactorer`, and `evidence-auditor` resolving to their exact Sol levels;
- parent model and effective thinking both being inherited when requested;
- launch environment containing expected model/thinking values;
- diagnostics preserving selected and effective levels;
- mismatch or clamp becoming a canonical failed result rather than a successful run.

### `tests/role-sidecar.test.js`

Add coverage for:

- the encoded contract containing the thinking policy;
- expected model/thinking environment being set;
- sidecar startup checking both effective values;
- mismatch aborting before any provider call;
- matching policy preserving existing tool and typed-result behavior;
- no thinking or model data leaking into result summary fields beyond bounded categorical provenance.

### `tests/role-consumer-contracts.test.js`

Add coverage for:

- topology nodes preserving model and thinking policy;
- built-in topologies using only registered role profiles;
- unreviewed node overrides being unable to alter inference policy;
- handler-only topology nodes remaining model-free;
- implementation and high-consequence review roles never resolving to Luna.

### `tests/role-runtime-benchmark.test.js`

Add coverage for:

- role-run provenance schema 4;
- model/thinking fields surviving sanitization only as bounded categorical data;
- private markers in prompts, transcripts, provider payloads, or reasoning never surviving;
- deterministic fixtures asserting the full role matrix;
- requested/effective policy mismatch counting as an execution-truth failure;
- benchmark runtime hashes changing with inference-policy source changes.

### New `tests/role-reasoning-policy.test.js`

Add a focused table-driven test that asserts:

1. Every model-backed built-in role resolves exactly one model and one thinking level.
2. Luna is used only by `worker`, `verifier`, and `benchmark`.
3. `planner`, `reviewer`, `coder`, `refactorer`, and `evidence-auditor` use Sol at `xhigh`.
4. `researcher` uses Sol at `medium`.
5. Handler-only roles resolve no inference profile and make no model call.
6. Global default thinking is never consulted after an explicit role profile resolves.
7. Explicit process environment overrides remain deterministic and observable.
8. Invalid or mismatched policy fails closed.

### Integration and smoke checks

Extend the existing fake RPC/sidecar launch smoke to capture and assert exact argv without using a live provider. Add a bounded read-only live pilot only after deterministic tests pass. Do not use mutating roles to collect the initial inference-policy cohort.

## Verification sequence for implementation

Run checks in this order after the feature is implemented:

1. Focused syntax and contract diagnostics for changed JavaScript/TypeScript files.
2. `tests/harness-environment.test.js`.
3. `tests/role-contracts.test.js`.
4. `tests/role-reasoning-policy.test.js`.
5. `tests/subagents.test.js`.
6. `tests/role-sidecar.test.js`.
7. `tests/role-consumer-contracts.test.js`.
8. `tests/role-runtime-benchmark.test.js`.
9. Existing topology and auto-role-router tests affected by context propagation.
10. Fake RPC/TUI subagent and topology smokes.
11. Repository changed-profile verification.
12. Full `scripts/check-all.sh` verification, including optional TUI checks when required by repository policy.
13. Final diff and Git-aware verification.

Use repository verifier tooling to infer and run the exact commands rather than reconstructing test invocations when implementation begins.

## Rollout plan

### R0: deterministic containment

- Keep `PI_ROLE_ROLLOUT_STAGE=R0`.
- Keep `PI_ROLE_MUTATION=off`.
- Pass all unit, contract, provenance, privacy, fake RPC, and sidecar checks.
- Confirm zero provider calls occur for invalid or mismatched policy.
- Regenerate the deterministic role-runtime benchmark against the new runtime fingerprint.

### Read-only live pilot

Collect at least 30 exact-version independent model-backed runs using only the Luna-routed read-only/evidence roles that are safe under the existing pilot controls. Pre-register and enforce these bars:

- 100% requested model/thinking profile match;
- at least 95% typed terminal validity;
- zero privacy violations;
- zero mutation violations;
- zero unsupported accepted claims attributable to policy routing;
- verification accuracy no worse than the Sol/xhigh baseline;
- no increase in false success or false failure rate;
- p95 duration improved or explicitly bounded against baseline;
- measured model cost lower than baseline;
- complete model-call, tool-call, timing, and termination accounting.

A clamp, model substitution, missing provenance field, or profile mismatch fails the policy gate.

### Promotion boundary

- Keep auto-role routing suggest-only during the pilot.
- Do not move `researcher`, `planner`, `coder`, `reviewer`, `refactorer`, or `evidence-auditor` to Luna based only on latency or cost.
- Any expansion of Luna requires a separate labeled corpus or live cohort with role-specific quality bars.
- Existing mutation, isolation, roadmap, verification, privacy, and result-schema gates remain independently mandatory.

## Rollback

Because existing process environment values win over guarded defaults, operators can restore inheritance or a prior model/level by overriding the relevant `PI_ROLE_MODEL_*` and `PI_ROLE_THINKING_*` variables before process startup. The global containment rollback remains disabling role sidecar execution or auto routing through the existing controls. Rollback must not silently reinterpret already-recorded role-run provenance.

## Non-goals

- Dynamically predicting arbitrary task difficulty from prompt text.
- Switching models in the middle of a child run.
- Retrying failed Luna output automatically on Sol.
- Lowering reasoning for coding, planning, review, refactoring, or evidence audit before quality evidence exists.
- Changing tool permissions, mutation authority, workspace isolation, or typed result schemas.
- Persisting prompts, provider payloads, transcripts, private reasoning, or raw tool output for routing analysis.

## Acceptance criteria

The implementation is complete only when:

1. Every model-backed role resolves a deterministic model and thinking level.
2. Planner resolves to Sol at `xhigh`.
3. Luna is limited to worker/low, verifier/low, and benchmark/medium.
4. Child RPC argv always carries both model and thinking.
5. Parent and child agree on the effective profile before provider use.
6. Invalid, unavailable, clamped, or mismatched policy fails clearly and truthfully.
7. Role-run provenance records bounded selected/effective policy fields without private data.
8. Deterministic tests and the full repository verification pass.
9. The read-only live pilot meets all pre-registered bars before rollout advances.
10. No parent-tree mutation, routing authority expansion, or compatibility layer is introduced by the inference policy itself.
