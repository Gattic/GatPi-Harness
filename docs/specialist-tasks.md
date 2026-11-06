# Explicit specialist tasks

Implementation reference for [R1–R6 / M0–M5](dedicated-subagent-integration-plan.md).
Manual tools are enabled for normal sessions. Specialist execution inherits the
parent model and thinking effort, without task/run budgets or correction caps.
This does not enable automatic routing, installations, parent application or publishing.
**Full-plan operational completion and live benefit remain unestablished.**

## Boundaries and defaults

The implementation extends Roles v2, `TopologyExecutionEngine`, RPC sidecars,
workspace/patch services and the existing verification evidence store. It does
not introduce another scheduler or model-based acceptance vote.

Canonical defaults remain:

```text
PI_ROLE_RUNTIME_VERSION=2
PI_ROLE_ROLLOUT_STAGE=R5
PI_ROLE_MUTATION=isolated
PI_MULTI_AGENT_TOPOLOGIES_ENABLED=1
PI_SPECIALIST_TASKS_ENABLED=1
PI_TOPOLOGY_AUTO_ROUTE=off
PI_ROLE_WORKER_SHADOW_CANARY=0
PI_SUBAGENT_RPC_CONCURRENCY=2
```

Configured R5 is operator configuration, not measured readiness. All eight specialist
contracts (`integrator`, `mathematical-researcher`, `reverse-engineer`,
`3d-modeler`, `3d-critic`, `reliability-investigator`, `code-profiler`, `security-reviewer`) have
`autoRoutePolicy=never`. Existing coder/verifier/planner/patch-reviewer contracts
remain canonical; there are no duplicate implementation or verification aliases.
Normal child skill/extension discovery stays disabled. Children explicitly load
only the approved `multi-login` provider registration and `role-sidecar`.
Multi-login retains the parent's Anthropic OAuth request shaping, native login /
refresh and configured account aliases, but registers no child failover,
cooldown-reset or directory-model hooks. The selected provider/model remains
fixed; a provider failure is reported rather than switching accounts or models.
Normal interactive sessions retain `/login` and multi-account failover behavior.
Reviewed guidance is part of the contract identity, not an invitation to load
arbitrary skills.

The Linux containment path requires usable bubblewrap and system-runtime tools
(or the explicitly reviewed private Blender/Lean/REA runtimes described below). It confines filesystem visibility and disables network access; target binaries are
never executed by static analysis. Ordinary worktrees alone are not a sandbox.
User-wide cooperative worker leases cap specialist-task RPC, contained-command and
build runners at two concurrent workers. Nested approved tools reuse their owned
worker slot. Unmanaged host processes are outside this admission mechanism.
The outer task RPC namespace device-binds only `/dev/null`: the root bind is
`nodev`, so inheriting its unusable null device would fail ignored-stdio launches
with `EACCES`. Other device paths remain visible for explicitly granted inner
sandbox mounts, without granting outer host-device access. Native runners
establish ownership only after successful spawn and
preserve the original launch errno while retaining the worker lease until close.
PID-namespace parent-death cleanup and inner network/filesystem isolation remain
enforced.

Bounded live diagnostic smokes must use an owned cancellation observer and a
finite observation deadline, stop on the first failed review receipt, and never
relaunch after cancellation. Record any admitted-but-cancelled correction child
separately from actual diagnostic calls. These smoke bounds do not reintroduce
general task/model budgets or change the uncapped product-correction contract.
A crash captured intentionally by GDB is an expected diagnostic observation,
not a successful workload exit; a typed dossier or readiness probe alone is not
a passing native smoke.

## Normal-session use

Start a **new Pi process** after updating the canonical defaults. `/reload` loads
new extension code but does not replace already-populated environment values.
Explicit launch overrides of either enablement flag to `0` still disable it.

Ordinary manual `create_subagent` and `run_topology` operations remain available.
The specialist task layer adds exact artifact acceptance and isolated proposals:

1. Configure `.pi/specialist-task-policy.json` when custom/domain checkers are
   needed. It contains checker definitions only; no model/spend approval or
   numeric inference reservation is required. A missing policy supplies the
   built-in dossier checker. Reload after changing a policy.
2. Use `specialist_tasks capabilities`, then `context` for current baseline/role
   identities and checker IDs without launching workers or writing state.
3. Construct a schema-v2 graph with owned paths and executable criteria; run
   `preflight`, then `run`. No extra UI confirmation is required, including headless use.
4. Inspect `status` and `evidence`. Send artifact-linked `feedback` for subjective
   review; it does not block or grant acceptance. `apply` is a separate explicit
   parent action, never a consequence of completion or feedback.

No benchmark cohort is required merely to request an approved manual task.
Ordinary session observations remain an **unqualified** cohort, not the frozen
six-pair evaluation or evidence for automatic routing. The old human-signoff
and accounting-policy gates are superseded; live evaluation remains a separate
required observation. The original
historical delivery entries below retain the settings observed at those times.

## Operator surface

The reasoning-runtime tool is `specialist_tasks`; the library boundary is
`boundary.tasks`. Capabilities are discoverable even when launches are disabled.

| Operation | Meaning |
|---|---|
| `capabilities` | Contract/tool availability, launch enablement and retention limits; discovery is not end-to-end capability evidence. |
| `context` | Read current baseline, role revisions and configured checker IDs/protected sources for graph authoring. No launch. |
| `preflight`, with `graph` | Validate exact baseline/contract/tool identities, ownership, criteria and host storage admission. No launch. |
| `run`, with `graph` | Execute the explicit graph using the parent model and thinking effort. |
| `resume`, with `graph` and `runId` | Reconcile owned process closure and immutable attempts before continuing. |
| `status`, with `runId` | Graph ID/digest, dependency edges, task states, criteria, artifact/proof IDs, observed usage and recovery references. |
| `evidence`, with `runId` and `taskId` | Authoritative current receipt references and bounded diagnostics; native previews are shown separately from metadata. |
| `cancel`, with `runId` | Stop admission and owned execution; cancellation is not acceptance. |
| `feedback` | Record nonempty `text` linked to the exact `runId`, `taskId` and `artifactDigest`. Advisory; never application or executable acceptance. |
| `apply` | Explicitly request application of the accepted patch with its original `graph`; recheck parent state and rerun required executable criteria. |
| `metrics` | Unqualified cohort counts and observed phase/token counters. Not a field-evaluation result. |

These operations do not require an additional UI dialog. Library application
still requires `explicit: true`; the tool's explicit `apply` operation supplies
that intent. Workers cannot apply their own results. Parent authorization and
commit/publish boundaries remain separate.

Status is explicitly `freshness: not-rechecked`: inspecting historical acceptance
does not revalidate current source. `accepted-proposal` never means
`accepted-applied`, nor completion of a parent outcome that requires application.
Raw objectives, shared context, dossiers and private reasoning are not included in
status/aggregate metrics. Evidence and previews are deliberate, separate local
artifact access—not telemetry.

Application is transactional: the patch is applied to the parent tree, the
required executable criteria are re-run there, and the parent is restored from
its recovery journal if verification fails or the tree drifts. The recovery
budget bounds durable recovery data only — backups of paths that already exist
plus the journal — so a patch that only adds files needs no backup budget and its
size does not limit application. An accepted multi-megabyte asset patch applies,
verifies and records application receipts; overwriting an existing file still
requires a budget large enough to hold its backup.

## Reviewed local policy and task graph

The optional `.pi/specialist-task-policy.json` must be a regular, non-symlink,
repository-confined file of at most 64 KiB. Invalid existing policies fail closed;
a missing policy enables only the built-in `dossier` checker. Both topology/task
enablement flags default to `1` for manual use. No policy is installed automatically.

- `schemaVersion: 2`. Legacy accounting/model approvals, task/run budgets,
  correction policies and human acceptance criteria are rejected, not migrated
  or retained as a second execution path.
- `verifiers`: up to 32 unique IDs. Types are `command`, `dossier`, `bezout`,
  `static-elf`, `lean`, `rea`, `glb`, `blender`. Command verifiers supply argv, not shell text,
  and hash-pinned `protectedFiles` outside producer write ownership. Protected
  checker sources are bounded to 1 MiB each. Verifier/source/runtime identities
  participate in freshness; changing an expectation cannot reuse acceptance.

Domain verifier configuration:

| Type | Required binding / scope |
|---|---|
| `bezout` | `target: {kind: "bezout-gcd", a, b, gcd}` using positive decimal integer strings; independently check divisibility and the exact integer identity. |
| `static-elf` | Relative `target`, lowercase `sha256`; optional `roundTripSection` selects one bounded PROGBITS section for independent hex-dump/offset/byte equality checks. |
| `lean` | Full-tree `runtime: {root, sha256}`, pinned system `python: {path, sha256}`, and `target: {path, sha256, declaration, candidateDeclaration, imports, allowedAxioms}`. The task's `leanTarget` must match exactly. |
| `rea` | Full-tree `runtime: {root, sha256}`; pinned system `node`, `objdump`, `readelf` executables (`{path, sha256}`); relative `target`, target `sha256`, exact `authorization`, fixed `operation`, optional `roundTripSection`. |
| `glb` | `path` and declared asset `budget`; structural validation alone does not satisfy a 3D task. |
| `blender` | `glb`, editable `native` path, asset `budget`, reviewed `runtime`; optional `blenderAi: {root, sha256}` and `animation: {object, frames}`. Independent edit/save/reopen, import, geometry/units/material/rig/texture checks, CPU preview and optional motion round-trip. |

Asset geometry/byte constraints are output acceptance and host-protection limits,
not token, model-call, wall-clock or correction budgets.

A Blender verifier must pin `runtime: {root, executable, sha256}`: `root` is the
absolute canonical directory of the approved distribution, `executable` is its
relative executable path (for the official archive, `blender`), and `sha256` is
that executable's lowercase SHA-256. Symlink aliases, missing/non-executable
files, mismatched hashes and workspace-enclosing roots fail closed. No `PATH`
lookup, installer or version shim grants Blender runtime approval.

Each 3D task must bind exactly one required native Blender checker. Its runtime
configuration is also injected into the producer's role contract; task input or
`role_domain` arguments cannot replace it. The dedicated runtime is mounted
read-only at `/runtime`, with network isolation and existing output/storage/RSS/
time limits unchanged. Both producer and checker revalidate the executable hash
before and after execution. Configuration and executable identities participate
in graph/receipt freshness. This pins the executable, **not every bundled library
or concurrent host write**; the distribution root remains operator-controlled.
Configured task capability discovery reports each native checker; unconfigured
roles remain unavailable, even when an unrelated `blender` is on `PATH`.

### Debugger and code-profiler tools

`reliability-investigator` now has fixed `role_domain` operations for GDB native
crash backtraces, Valgrind Memcheck, and syscall summaries. It recommends GDB
when native crash/stack evidence is relevant, preferably against a debug-symbol
build. `code-profiler` is a separate read-only specialist for measured bottlenecks
and optimization recommendations, not code repair. Both inherit parent inference
unless a per-role environment override is configured,
keep automatic routing off, and deny arbitrary shell/edit/write tools.

These roles use `specialist_tasks` graphs (ordinary unbound `create_subagent`
launches cannot supply execution authority). Use `domainInput: {}` for an
inspection-only reliability investigation. For execution, the parent supplies:

```json
{
  "execution": {
    "authorization": "Execute this owned synthetic workload only; no host attachment.",
    "target": "build/example",
    "sha256": "<64 lowercase hex characters for the exact target bytes>",
    "args": ["--fixture"],
    "operations": ["time-profile", "valgrind-callgrind"],
    "timeoutMs": 30000
  }
}
```

Use `taskKind: "analysis"`, read zones for the target and necessary source/data/
libraries, and no write zones. `code-profiler` requires `execution`; the investigator
may omit it. Preflight checks the selected tools, target hash, ownership, argv and
runtime pins before launching a worker. The child calls, for example:

```json
{"operation": "gdb-backtrace", "file": "build/example"}
```

The operation must belong to both the role and `execution.operations`. Tool-call
arguments cannot change the workload, timeout, runtime, GPU grants or sandbox.
Approval of multiple operations is not an instruction to run all of them. Parent
scope controls repetition; neither role may consume a preregistered experiment or
retry an already tried diagnostic without new authorization/evidence. Return
observations to the parent for `debug_ledger` / `experiment_ledger` recording;
those tools are not exposed inside the child.

| Operation | Suggested use / interpretation |
|---|---|
| `gdb-backtrace` (investigator only) | Launch the authorized native program under batch GDB; all-thread bounded stacks on a crash. No host PID attachment, core-file mode, arbitrary commands, auto-loaded scripts or locals dumps. A crash remains a nonzero result, not a successful test. |
| `valgrind-memcheck` (both roles) | Native invalid access, uninitialized values and leaks. Findings return nonzero (97); stderr is preserved. |
| `valgrind-callgrind` | Native instruction/cache costs plus annotated call paths. Simulated costs are not elapsed-time measurements. |
| `valgrind-massif` | Native heap peaks/growth plus `ms_print` summary. |
| `nsys-profile` | Nsight Systems NVTX/OS runtime tracing, with optional CUDA tracing under explicit device grants. Sampling/context-switch collection is disabled; read-only `/sys` supplies required CPU topology. No system-wide tracing. |
| `perf-stat` | Workload-scoped Linux hardware/software counters, with read-only `/sys` hardware metadata (perf requires a sysfs-root mount). Restricted kernels may refuse access; never use sudo or lower kernel protections automatically. |
| `strace-summary` (both roles) | Syscall counts/time for I/O suspicions, without tracing payloads. |
| `time-profile` | GNU time elapsed/user/system time, peak RSS and resource-use baseline. |
| `python-cprofile` | Python script cumulative function costs, top 30 entries. |
| `node-cpu-profile` | Node/V8 sampled CPU profile, top 30 self-sample hotspots. |

System tools resolve from `/usr/bin`, not project/PATH shims. For a private Nsight
installation add `execution.nsysRuntime: {root, executable, sha256}`: canonical
absolute installation root, root-relative executable, and that executable's SHA-256.
For example an installed distribution may use `target-linux-x64/nsys`. The root is
mounted read-only at `/runtime`; it cannot enclose the workspace or be `/` or HOME.
This pins the executable, not every bundled library; the operator controls the
installation. Tool and target bytes are checked before/after collection; these
checks are not an atomic snapshot against concurrent host writes. Discovery
never runs installers/version shims and is not successful collection evidence.

By default there is **no GPU access**. To trace CUDA, explicitly list exact devices
in `execution.gpuDevices`, e.g. `/dev/nvidia0`, `/dev/nvidiactl`, `/dev/nvidia-uvm`.
Only canonical NVIDIA character devices are allowed, and only `nsys-profile`
receives them. This grants access to those host GPU devices, not strong isolation
from the GPU driver/other users. Missing devices, drivers or profiler permissions
are reported, not silently bypassed. CUDA compatibility/collection is machine-specific.

Execution is networkless, has only read-owned workspace mounts, no inherited host
environment/credentials, and no writable source. Scratch and `/output` are each
bounded to 16 MiB (Nsight splits scratch into 15 MiB `/tmp` plus 1 MiB private
`/dev/shm`, never host shared memory); file-size/core, shared worker/RSS, cancellation and
1–120000 ms per-operation transport limits apply. Larger workloads must be scoped
explicitly rather than relaxing these protections. Raw profiles are disposable
sandbox output, not persistent report artifacts. The tool returns bounded summaries,
stdout **and stderr**, exit/signal/termination, and target/tool/argument fingerprints (64 KiB
combined process output). Overflow, timeout and failed collection remain errors;
partial output is retained. No automatic retries or method switches occur.

The supervising RPC runner retains matched `role_domain` native completions as
`diagnosticEvidence` on the persisted subagent result, **outside** the producer's
submission. Each `diagnostic-*` receipt binds the producer/tool-call identity,
operation, target/argument/tool fingerprints, grants, original bounded stdout and
stderr, and the unchanged exit/signal/termination outcome. Only those allowlisted
tool-result fields are retained: no assistant reasoning, arbitrary tool output or
raw RPC transcript. Collection survives message compaction. A 256 KiB aggregate
JSON retention limit fails closed rather than silently truncating receipts; native
attempt admission reserves additional storage within the existing aggregate cap.

The dossier artifact digest binds these runtime receipts as well as the candidate
claims. Missing, mismatched or altered evidence cannot substitute producer prose
or reuse historical acceptance. Reviewers receive exact runtime receipts inline
in `runtimeDiagnostics` and can cite their IDs while comparing original output to
source and dossier claims. Reviewer filesystem ownership stays read-only, and no
new `role_domain` permission or repeat workload execution is granted. This trusts
the supervised tool/CLI transport, not arbitrary text printed by the workload;
it is not a cryptographic attestation against a hostile host.

Executable checkers now run before independent review. Reviewers receive already
persisted artifact-bound `executableChecks`, rather than being asked to validate
an unavailable future verdict. Separate immutable acceptance receipts link the
checker proof, reviewer and diagnostic receipt IDs. Both gates must pass: a
passing checker cannot override failed review, and passing review cannot override
a failed checker. Raw native observations remain distinct from acceptance; a
captured SIGABRT is still an abnormal workload outcome.

Dossiers should cite the exact `role_domain:<operation>` result and output locator,
state units, workload identity, sample counts, overhead and limits, and distinguish
CPU time, wall time, I/O, memory and GPU observations. The built-in `dossier` checker
only checks structural consistency: it does not independently certify performance,
root cause or a speedup. Benchmark acceptance still needs a separately declared
executable criterion and comparable baseline.

`tests/specialist-diagnostics.test.js` exercises real installed native/runtime tools
on disposable synthetic workloads and task integration with fixture-driven inference.
Missing native dependencies are explicit skips. Optional real Nsight CPU collection
in `tests/specialist-nsys.test.js` uses
`PI_TEST_NSYS_RUNTIME=/absolute/binding.json`; it never proves CUDA collection.
Successful owned fixtures are deleted; failures are retained and must not be retried
unchanged or accumulate without checking storage. No existing experiment is consumed.

### Blender MCP tools for the 3d-modeler

The `3d-modeler` allowlist includes `mcp__blender__*` next to `role_domain`, so a
producer can drive a live Blender scene through pi's MCP client instead of writing
blind stage scripts. The role declares `settings.blenderMcp` (`server: blender`,
`localhost:9876`); preflight reports `blender-mcp:server-not-configured:<name>` when
no MCP server of that name is registered in `~/.pi/agent/mcp.json` or the project's
`.pi/mcp.json`, and `blender-mcp:listener-unreachable:<host>:<port>` when nothing is
listening on that port. The listener check reads the kernel's listening sockets
(`/proc/net/tcp`); it never starts Blender or contacts a provider, and where that
table is unavailable the check is skipped rather than reported as unreachable.

Typical producer loop: `mcp__blender__execute_blender_code` to run Python in the
scene, `mcp__blender__get_objects_summary` / `get_object_detail_summary` to inspect
what was built, `mcp__blender__render_viewport_to_path` or
`render_thumbnail_to_path` to render a check view before submitting, then save the
`.blend` and export the GLB from that same session.

MCP tool calls execute inside a host Blender process, outside the `bwrap` sandbox
that contains `role_domain` executions. The contract therefore requires writes to
stay inside the task workspace (`scripts/`, `assets/`) and forbids using MCP tools
to reach the network or the parent checkout. Acceptance is unchanged: independent
native/export checks plus the separate `3d-critic` vision review.

### Required GLB source-convention metadata

The `3d-modeler` producer must write `asset.extras.sourceUnits` and
`asset.extras.sourceAxes` into the exported GLB's JSON chunk, matching
`domainInput.units` and `domainInput.axes` exactly. For a meters/Z-up source:

```json
{"asset":{"version":"2.0","extras":{"sourceUnits":"meters","sourceAxes":"Z-up"}}}
```

GLB coordinates remain standard **meters/Y-up**. These declarations describe the
native source convention; they do not replace geometry, scale or round-trip
checks. Blender's normal glTF exporter does not populate these fields. A
`blender-script` producer must add them after export, preserving the BIN chunk,
four-byte JSON padding, chunk lengths and total GLB length. BlenderAI dispatch
already writes them. Scene/node extras or producer submission claims are not
substitutes: missing or mismatched declarations fail `asset-convention-mismatch`
before independent rendering or vision critique.

### Independent 3D vision critique and refinement

Every `3d-modeler` candidate first runs its pinned native/export checks. A passing
native checker renders a PNG contact sheet of the exact imported GLB: three
256×256 panels, **front, rear, top** from left to right (front/rear are elevated
three-quarter views). The sheet uses non-interlaced 8-bit RGBA PNG, is bounded to
128 KiB and is SHA-256-bound to its checker receipt. Before RPC, validation checks
chunk framing/order and CRCs, a complete compressed image stream, and exact
scanline lengths and filter types. Decompression is capped at the fixed decoded
sheet size; a matching digest or plausible header alone is not sufficient.
It is supplied as an actual RPC image attachment—not base64
inside prompt text—to the dedicated `3d-critic` role.

The critic is a separate, no-session model invocation using the existing sidecar
runtime and the parent model/thinking profile. Independence means separate
context and permissions, not different trained weights: it receives the brief,
requirements, exclusions, checker facts and rendered views, but no producer
self-assessment or prior critique. Its only tool is `submit_role_result`; it has
no file, DCC, mutation, delegation or application authority. The RPC runner
checks that the selected model declares image input support **before** sending
the critic prompt. Missing support blocks the attempt; no text-only fallback or
model switch is performed.

The typed `visualCritique` contains `artifactDigest`, `previewDigest`, a verdict
(`accept`, `revise`, `unable`), observations for all three views, up to six
corrections (`view`, `issue`, `action`), and limitations. Acceptance requires the
exact artifact/preview bindings, all view observations, an `accept` verdict with
no corrections, and passing executable checks. A `revise` verdict requires at
least one actionable correction. The critique and critic identity are retained
in the artifact-bound acceptance receipts; the original executable verdict is
preserved separately. `specialist_tasks evidence` exposes the sheet and critique.

The generator receives `correction.visualCritique` and the prior candidate's
isolated patch for refinement. After a producer interruption, explicit resume
recovers the last artifact-bearing attempt and its matching critique from history.
A newer candidate is never paired with an older candidate's critique. Interrupted
attempts still count toward the limit; resume does not reset the history.
There are **at most three generation attempts**
(initial plus two refinements), counted across resumes. Exhaustion retains a
failed candidate with reason `refinement-limit`; resume cannot reset the cap.
Native check failures also consume attempts and guide correction without asking
the critic to judge unavailable renders. A missing/corrupt preview after a
passing check, stale/malformed critique, `unable`, unsupported vision or provider
failure blocks rather than silently accepting or automatically retrying. Explicit
resumes remain subject to the same attempt bound. Other specialist correction
policies and model-call budgets are unchanged.

A model's visual acceptance is not human aesthetic approval, proof of hidden
geometry, or animation-quality certification. Existing human feedback remains
non-blocking, and parent application is still a separate action. Accounting uses
the existing reviewer phase for the dedicated critic, including its image-context
bytes. Asset attempts reserve 2 MiB of evidence capacity; aggregate run retention
limits remain unchanged.

`tests/specialist-vision.test.js` covers orchestration with injected model/native
responses, including correction, acceptance, exhaustion/resume, interrupted
producer/critic resume, native failure, missing/corrupt/stale/malformed evidence,
inability, provider failure and cancel. `tests/specialist-preview.test.js` checks
complete PNG validation, including truncated chunks, bad checksums, malformed
compressed data, invalid scanlines and bounded decompression.
`tests/subagent-task-rpc.test.js` checks real subprocess image transport and
text-only model rejection. The optional native test below renders real Blender
views but uses a fixture critic; none of these tests establishes live visual
judgment quality.

### Measured acceptance for asset tasks

The vision critique judges a contact sheet, so it can only settle objections that
are visible in three views. A recurring objection such as a flattened stop, a
broken hock line or a narrow ribcage is a measurable property of the exported
artifact, and asking a model to re-read it from a render turns a number into an
opinion. A task may therefore declare `acceptanceMode: "measured"`.

In measured mode the pinned checkers are the anatomy gate: every required
`executable` criterion runs against the exported artifact exactly as before, and
acceptance needs all of them to pass. The native asset checker stays bound — it
supplies the Blender runtime, the unit/axis round-trip and the budgets — but it is
no longer the acceptance authority. Preflight rejects the mode unless at least one
required criterion is bound to a non-`blender-asset` verifier
(`measured-acceptance-needs-measured-checker`), so declaring the mode without a
measuring checker cannot silently degrade to the critic path.

No contact sheet is sent to a critic and no `3d-critic` invocation happens. The
native checker still renders and validates its own preview as part of its gate — an
empty scene must fail — but that image is never attached to a reviewer. The
independent reviewer still runs: for a mutating asset task that is `patch-reviewer`,
which inspects the isolated patch and the checker receipts. Measured receipts carry
`acceptanceMode: "measured"` instead of `visualReview`, so retained evidence names
the path it took and cannot be read as visual approval.

Measured acceptance is deliberately narrower than visual approval. It certifies only
the properties its pinned checkers measure, on the exported artifact, for that
artifact digest. It says nothing about silhouette, coat, expression, unseen geometry,
animation or human aesthetic approval, and it is not a critique: the visual-judgment
path remains the default critic mode, and a human review remains a separate action.
A task must not be reported as visually approved because its measured checkers
passed.

Refinement and attempt limits are unchanged. A measured criterion that runs and
reports failure settles the attempt as `failed` (`verification-failed`), which feeds
`failedCriterionIds` and the checker diagnostics into the producer correction loop up
to the three-attempt limit. A checker that cannot run is different: an unregistered
verifier is refused by preflight, a checker whose pinned source drifted is refused by
preflight, and a checker that fails to execute produces a `blocked` receipt, which
settles the attempt as `verification-infrastructure` and stops the run instead of
retrying.

Only `"measured"` is accepted as a mode value (`TASK_ACCEPTANCE_MODE_INVALID`
otherwise), and only on the `3d-modeler` role (`TASK_ACCEPTANCE_MODE_UNSUPPORTED`
otherwise) — no other role has a vision critique to replace, so declaring the mode
there would read as "the critic was skipped" while changing nothing. A task that
omits the field keeps the critic path. The required measured checker must be a
registered verifier; an unknown verifier id cannot satisfy the mode's requirement.

`tests/specialist-blender.test.js` exercises both paths against the real contained
cube: the critic path asserts the packet carries the measured preview coverage, and
the measured path asserts two passing receipts, no vision critique, no image
attachment to the reviewer, and an unchanged parent. Four further measured graphs
prove the gates are not weakened: a pinned checker that measures a property the
cube lacks leaves the native round-trip receipt passing while the measured
criterion is reported as failed (exit 1) on every attempt; a reviewer that reports
a failed verification turns both passing checks into failed receipts even though
the checkers exited zero; an unregistered verifier id is refused by preflight
(`verifier-unavailable` plus `measured-acceptance-needs-measured-checker`) and
`run` throws before any producer attempt; and editing a registered checker after
its pin fails preflight with `TASK_ORACLE_SOURCE_DRIFT` until the file matches its
recorded digest again. No case accepts or applies, none produces a visual critique,
and the measured runs never invoke `3d-critic`.

### Contained BlenderAI dispatch and animation

With `blenderAi` configured, the full installed add-on tree is hash-pinned and
mounted read-only at `/blenderai/blender_mcp_assistant`. The producer can invoke
`role_domain operation=blenderai-dispatch` with a JSON recipe and declared output
paths. Recipes contain `calls: [{name, arguments}]` and optionally `source`, a
read-owned relative `.blend` path. Calls use the add-on's canonical
`integration_boundary.dispatch_tool`, not arbitrary Python evaluation.

Ordinary write confirmation is disabled only inside this disposable networkless
process. Python execution, file output, UI screenshots and background inspection
remain disabled; destructive/sensitive confirmation gates remain intact. The
wrapper saves `.blend`, `.glb` and optional `.json` results. GLB keeps standard
meters/Y-up coordinates and declares source conventions separately.

An animation checker samples a named object's world transforms at 2–8 distinct
frames, requires finite nonzero motion and agreement between native and imported
GLB transforms. This is a bounded motion/export check, not full animation-quality
or rig-fidelity certification. Subjective feedback is non-blocking.

The provider-free native regression takes an explicitly approved binding JSON via
`PI_TEST_BLENDER_RUNTIME=/absolute/runtime.json node tests/specialist-blender.test.js`.
Without that test-only setting it reports a native skip, not acceptance; with it,
unusable containment or runtime is a failure. The fixture loads its own reviewed
policy in a disposable repository and inherits a fixture parent inference profile.
Add `PI_TEST_BLENDERAI_ROOT=/absolute/blender_mcp_assistant` to exercise canonical
turntable dispatch, animation round-trip, denied calls and stale add-on pins.
It does not install a parent policy or make provider requests.

### Pinned Lean and REA adapters

`src/specialist-runtime.js::runtimeTreeDigest(root)` computes the reviewed
installed-tree pin for Lean/REA, including dependencies, executable permissions
and internal symlink targets. Missing files, changed bytes/modes, escaping links,
unbounded trees and workspace-enclosing roots fail closed. Files are read in
bounded chunks; cached hashes require unchanged inode/size/mode/mtime/ctime.
This scans already installed tools, never installs or discovers credentials.
These tree pins are distinct from Blender's executable-only pin. Read-only mounts
and before/after checks do not make concurrent hostile host writes atomic, and
system libraries beneath the sandbox's existing `/usr` mounts remain trusted.

For `proofMode: "lean"`, supply `domainInput.leanTarget` and exactly one required
`lean` criterion. Its target source must be in read ownership, outside write
ownership, at most 64 KiB, and hash-pinned. `imports` names the exact set of modules
from the pinned runtime library (including implicit `Init`); arbitrary workspace
or downloaded dependencies are unsupported. `allowedAxioms` may contain only
`propext`, `Classical.choice`, and `Quot.sound`, or be empty.

The producer submits `dossier.leanProof: {targetDigest, source}` with at most
32 KiB of Lean source. The target source can declare the expected proposition
with an axiom; the candidate must define `candidateDeclaration` as a theorem.
Reference and candidate compilation are isolated from one another. Bounded
compiled parts are then transported into a separate read-only checker process.
`src/specialist-lean-checker.lean` loads no candidate plugins/initializers,
replays candidate declarations through Lean's kernel, checks the exact target
type/universe parameters and the transitive axiom allowlist. A compiler exit zero,
printed success marker, `sorry`, a new axiom or a different theorem cannot grant
acceptance. This uses the installed Lean kernel, not an independent proof
assistant; it certifies only the pinned proposition, not every dossier claim.

For REA, set `domainInput.reaOperation` to `file_headers`, `section_headers`,
`symbols`, or `relocations`. Exactly one required `rea` criterion must match the
target, digest, authorization and operation. Its configuration is injected into
the producer contract; `role_domain` accepts `operation: "rea-inspect"` and the
exact target file, not arbitrary argv or a replacement runtime. Evidence locators
are `rea:objdump:<operation>:line:<1-based-line>`. Network and target execution
remain forbidden; debug-link following, disassembly and dynamic operations are
not exposed. The checker re-runs REA, validates its evidence envelope, reproduces
stdout independently with pinned objdump, validates literal dossier observations,
and uses the existing independent readelf/optional section round-trip checker.
Unknown provider version/format metadata stays unknown.

Receipts include `domainEvidence` binding the proof source/compiled objects or
static target/observation to the policy, runtime and existing artifact/contract/
verifier identities. Without a reviewed configured verifier, capability discovery
reports `reviewed-lean-policy-required` / `reviewed-rea-policy-required`, not a
missing installation and not operational readiness.

The native fixture is `tests/specialist-lean-rea.test.js`, explicitly configured
with `PI_TEST_DOMAIN_POLICY` pointing to `{lean: {runtime, python}, rea: {runtime,
node, objdump, readelf}}`. Without it the native section reports **SKIP**, never
native acceptance. The fixture uses owned temporary repositories, fixture-driven
producers/reviewers and real installed tools; its local policy does not enable
the parent runtime or authorize live inference.

The graph schema is in `src/subagent-task-contracts.js`; executable examples are
`tests/subagent-task-integration.test.js` and `tests/specialist-domains.test.js`.
Use the current identities returned by `specialist_tasks context`, never copied
historical hashes. Library integrations use the same `roleRevisionHash()` and
`baseline()` implementation behind the boundary.
Every task names requirement IDs, read/write zones, dependencies and artifact
readiness, executable criteria and resource names. Corrections return to the same
producer with failed-criterion facts and linked immutable attempt IDs.
Every required context requirement must be assigned. Cycles, ambiguous overlapping
writers, missing prerequisites, incomplete integration closure and unbound
criteria fail closed. Markdown fanout suggestions are not execution authority.

The parent supplies one bounded context packet. Producers receive their declared
neighborhood and failed criterion facts; reviewers receive the requirement and
candidate, not the producer's persuasive conclusion. Dossiers retain ID-linked
assumptions, evidence locators, limitations and proof obligations. Dangling or
duplicate references fail submission, even without a separate dossier criterion.
A model cannot self-label a claim as machine-checked.

## State, resources and recovery

- Each attempt is immutable after terminal settlement. Product corrections get
  linked new IDs without an attempt cap; infrastructure failures do not
  automatically retry. Accepted dependency artifacts are checked again
  before reuse. Missing/interrupted/stale evidence cannot pass.
- No task/run token, cost, model/tool-call or execution-time budgets apply.
  Producers and reviewers inherit the parent model/effort unless
  `PI_ROLE_MODEL_<ROLE_ID>`/`PI_ROLE_THINKING_<ROLE_ID>` configures an override;
  RPC inference profile overrides remain ignored. Protocol startup health,
  cancellation, containment, transport/output limits and host resource admission
  remain enforced. Generic non-specialist roles retain their existing budgets.
- Usage is observational. Unknown usage and provider-invoiced cost remain
  `null`; SDK-priced cost is reported separately. Measurements distinguish
  queue/startup/execution/verification/integration, context bytes and within-worker
  repeated read requests. Cross-worker duplicate reads remain unknown.
- Default task retention stops at 20 packets, 512 MiB aggregate workspace storage,
  and 64 MiB evidence storage. Workspace admission includes allocated blocks,
  metadata and directory ancestors, plus conservative snapshot/correction
  headroom. Only retained artifacts and one transient reservation for the current
  operation are charged; the transient headroom is replaced on the next attempt
  and cleared at settlement, so retries and later runs are not charged for
  workspaces that were already released. Historical index entries that carry only
  the old accumulated reservation are reconciled additively from their retained
  artifacts when admission would otherwise be refused; their historical values
  remain intact. DCC output admission checks the entire pending batch before import.
  This can reject large repositories; it is not permission to raise limits.
- Parent apply has a separate cooperative exclusive lease. Baseline, candidate,
  index and touched contents are checked before/after verification. Rollback
  restores only still-owned unchanged paths, preserving observed concurrent
  author writes/staging. It is **not OS-atomic against arbitrary host writers**.
- Private apply-recovery journals are separately bounded to 20 records / 64 MiB.
  A partial rollback or interrupted application blocks for manual reconciliation
  and exposes its recovery reference. It is not silently re-applied.
- Caps stop admission; no automatic eviction of failures/history/assets occurs.
  Successful owned test fixtures are disposable. Historical evidence and user
  work require explicit cleanup decisions. Old unbound patch captures fail closed.

## Availability and evidence limits (updated 2026-10-18)

| Capability | Current evidence |
|---|---|
| Core DAG/correction/integration/application | Provider-free real Git/workspace/checker and owned RPC-child regressions; inference is fixture-driven. No live model-benefit claim. |
| Math | Linked research dossiers and exact target-bound positive-integer Bezout certificates pass positive/negative fixtures. Not a general theorem prover. |
| Formal proof | Approved Lean 4.29.1 now passes representative specialist task acceptance: full-tree runtime/dependency pin, independent kernel replay, exact target type and axiom/import policy, artifact-bound receipt. False proofs, wrong propositions, `sorry`, added axioms, missing/extra imports and spoofed output reject. This checks the declared proposition, not general dossier truth or live-model ability. |
| Reverse engineering | Existing contained `readelf` acceptance remains static ELF only. Owner-selected [REA](https://github.com/morluto/rea) 6.5.0 now passes specialist producer/checker task acceptance with full-tree/tool pins, exact authorization/operation binding, independently reproduced header observations and section-byte round trip. Fabricated observations and stale targets reject. No dynamic-target execution or general decompilation claim. |
| 3D | Approved Blender 5.1.2 is hash-pinned through the producer/independent-checker policy. BlenderAI dispatch and named-object animation acceptance are wired into the contained task path. Native evidence and remaining limitations are recorded below; subjective feedback cannot replace executable checks. |
| Reliability/profiling/security | Investigator and code-profiler have explicit contained workload diagnostics and tool-specific guidance; security remains inspection-only. Tool discovery/provider-free fixture acceptance is not live effectiveness or production-performance evidence. |

`tests/specialist-blender.test.js` conditionally runs the real
`tests/fixtures/specialist-cube.py` through the contained adapter, then independently
checks the editable native/export and records optional non-blocking feedback. It validates
Python syntax even without Blender. A successful Node command containing `SKIP`
is not native acceptance. The fake Blender transport in unit tests only tests
containment/import/quota plumbing and never establishes Blender capability.

## Proposed field protocol — intent approved; execution bounds not frozen

Live comparison remains a separate observation, not a prerequisite for manual
use. Freeze concrete task manifests, parent model/thinking identities and host
retention reservations before execution. The revised workflow has no inference
budgets or correction caps; do not reintroduce them as launch prerequisites.
Inspect existing experiments first; historical diagnostics, HTTP-429 failures
and their denominators are not reused/reset by this proposal.

1. Freeze **six matched task pairs**, three with truly independent implementation
   branches and three tightly coupled controls. Single-agent and specialist arms
   share the same baseline, scope, executable criteria and environment.
   Record subjective feedback separately from acceptance.
   Randomize/freeze order before execution. Restrict this first cohort to core
   code tasks; domain cohorts await their toolchain/task approvals.
2. Freeze source/config/contract/checker/model/thinking identities, context policy,
   task manifest digest, concurrency two, uncapped product corrections and no
   automatic infrastructure/provider retries. Check storage reservations for both
   arms against existing 20-packet / 64-MiB evidence and workspace-family limits;
   a full family blocks, not evicts.
3. Both arms inherit the specified parent model and effort. Record all correction
   attempts and actual observed usage; do not turn missing prices or unknown
   provider-invoiced cost into fabricated zero usage or a launch budget.
4. Record assigned arm, all attempts, first-pass/final exact acceptance, false
   acceptance, containment incidents, interventions, artifact reproducibility,
   total input/output/cache tokens, SDK cost versus provider-invoiced/unknown
   cost, and separate phase/total latency. Preserve failures, blocks and nulls in
   assigned denominators; report successful-run latency separately from failures.
5. Proposed decision bars (require approval before running): zero observed false
   acceptance/containment incidents; complete receipt coverage; no final-quality
   regression on matched tasks; total cost ratio at most 2.0; independent-family
   median elapsed time at least 20% lower. Coupled tasks are controls, not assumed
   parallel wins; retain the single-agent recommendation where overhead dominates.
   Report p50/p95 using nearest rank and all sample sizes; with three pairs per
   family, p95 is effectively the maximum and cannot establish fleet reliability.
6. Stop on safety/false-acceptance incidents, source/model drift, host retention
   exhaustion, missing required observations, cancellation or provider errors.
   No adaptive benchmark reruns or changed bars. Product corrections remain
   uncapped; a new benchmark cohort is a separate decision. Feedback, explicit
   parent application and publishing remain separate operations.

Activation remains manual core → explicit eligible domains → suggest-only →
separately approved automatic routing. Rollback disables launches/routing while
preserving evidence. Session lexical counts are recommendations, not routing
training labels or measured delegation benefit.

## Verification boundaries

Narrow gates use `test_runner infer` then `run`; the task/domain suites exercise
G1–G10 portions without providers. `node scripts/extension-smoke-runner.js rpc`
is the existing provider-free real Pi lifecycle mode. The canonical
`scripts/check-all.sh` also invokes a **live full-fleet model smoke**, so it cannot
be run under provider-free authorization. Optional extended TUI gates and the
known RPC terminal-timeout/skill-performance histories remain separate; no
unchanged failure is rerun to manufacture a pass. Final Git-aware checks do not
replace these observations. Required unavailable observations remain incomplete.

### Schema-v2 delivery checkpoint (2026-10-18)

The revised workflow is implemented: no task/run budgets or correction caps,
inherited parent model/effort, executable-only acceptance, artifact-linked
non-blocking feedback and explicit parent application without extra UI dialogs.
Invalidated-candidate feedback remains historical and cannot block current
artifact evidence after repair. Boundary reload refreshes all native adapters.

Current provider-free evidence:

- Focused lifecycle, correction, recovery, task RPC, sidecar, inference,
  integration-boundary, role-consumer, topology and deterministic benchmark suites
  pass. Fixtures include five corrections, 100 sidecar calls, headless operations,
  stale-feedback repair and transactional application.
- SDK-resolved TypeScript check passes with zero diagnostics. The generic LSP
  invocation still lacks this repository's externally installed SDK resolution.
- Native BlenderAI task passes canonical dispatch, editable native/GLB round-trip,
  CPU preview, three-frame nonzero finite motion agreement and negative checks
  for denied calls, stale add-on pin, missing animation, geometry limits and
  transparent preview. Evidence: `.pi/planning/dedicated-subagents/blenderai-v2-acceptance.json`;
  job `job-mvdm1od0-b048` exited zero.
- Native Lean/REA positive/negative task acceptance passes under schema v2;
  job `job-mvdm26nj-d562` exited zero. No provider calls or installations occurred.

Root roadmap outcomes: **5/6 complete** (M0–M4). M5 live comparison remains unrun;
R1–R5 have implementation/local acceptance evidence, while R6's live comparative
benefit is not established. Automatic routing remains off. Full `check-all.sh`
includes live-provider smoke and was not run; historical HTTP-429/field evidence
is preserved rather than relabeled. No commit or publish was performed.

### Historical delivery checkpoint (before schema v2)

The entries below retain earlier evidence and failures. Their human-signoff,
accounting-policy, budget and UI-confirmation requirements are superseded by the
current schema-v2 reference above; they are not current launch blockers.

The 41-command provider-free regression selection initially returned 39 passing
commands and two failures. The new direct extension imports were moved behind the
integration boundary, and the role-effort fixture was expanded to cover the six
new contracts without changing old expectations. The eight affected follow-up
commands pass. Final review then reproduced and repaired two acceptance gaps:
reviewers now receive read-only access to producer write zones, and baseline-only
application rejects parent drift during verification without overwriting the
concurrent edit. All six affected task/domain/startup suites pass afterward. The
original failing regression logs are retained.

One of the 41 commands checks Python syntax and **skips native Blender**; it must
not be counted as a passed native-domain task.

- Real Pi reasoning-runtime RPC lifecycle smoke: passed without a model prompt.
- Versioned local Semgrep rules: zero findings/errors on 13 focused files, then
  three changed boundary files; advisory coverage, not a security proof.
- `gitverify`: diff/staged-diff checks passed; its 36-file security checkpoint was
  clean. It did not run a full repository suite.
- Focused TypeScript check: **passed after the authorized baseline repair**
  below. The initial unconfigured check reported 226 diagnostics; resolving the
  installed SDK exposed five baseline errors, now repaired. The configured
  two-extension check has zero errors; this is not full-release readiness.
- Full `check-all.sh`, extended TUI cohort, native Blender/formal acceptance and
  live benefit evaluation: **not run** in this provider-free delivery.

Private evidence is retained in `.pi/planning/dedicated-subagents/`:
`verification-batch-{1,2,3}.json`, `verification-followup.json`,
`verification-final-review.json`, `static-scan{,-followup}.json`, and
`typecheck-followup.log`; full command output
references remain under `.pi/test-runner/raw/`. Managed regression job:
`job-mvcsdj90-646a` (initial failures preserved); final static/RPC job:
`job-mvcsjsto-97c5` (exit zero).

| Required outcome | Reconciliation |
|---|---|
| R1 contracts/domains | Contracts and honest availability implemented; Blender/BlenderAI, Lean and REA use approved and local toolchain smoke available. Blender runtime wiring and native regression acceptance now pass. Lean/REA adapters now pass bounded representative native task observations; operational completion still needs exact-artifact human visual review and separately authorized live/domain use. |
| R2 lifecycle/DAG | Implemented; provider-free correction, exhaustion, cancellation, owned-process recovery and idempotence evidence. |
| R3 isolation/application | Implemented; real Git integration, immutable capture, separate authorization and concurrent-write-preserving rollback evidence. Cooperative/observed-drift limits remain. |
| R4 acceptance | Implemented; exact required coverage and baseline/artifact/runtime/checker bindings tested. Unavailable domain evidence does not pass. |
| R5 context/resources | Implemented; bounded context/dossier links, shared admission, aggregate storage/reservations and unknown accounting tested. Cross-worker repeated reads remain unknown. |
| R6 recommendations/evaluation | Bounded session evidence, conformance and proposed matched protocol delivered. Live evaluation/benefit and full acceptance closeout remain unrun/blocked, not inferred from fixtures. |

The canonical roadmap remains **4/6 milestones complete**: M0–M3 done; M4 and
M5 full acceptance blocked. This checkpoint is not completion of the full plan.

### Initial typecheck investigation (2026-10-17; historical)

This checkpoint preceded authorization to fix the baseline errors. Its failures
are retained; the repair and current gate results follow in the next section.

The default LSP compiler command is `tsc --noEmit --pretty false --skipLibCheck`
with the two changed extension files. This repository has no `tsconfig.json`,
`package.json` or local `node_modules`; Pi supplies its SDK packages at runtime.
The unconfigured command fails with 226 compiler errors on the working tree and
225 on `HEAD` (`86f0aa5`). Its two changed-line Node declaration errors are
resolution failures, not incorrect uses of Node APIs. The additional lexical
"Unclosed (" warning is not a TypeScript parser diagnostic.

A bounded, private configuration points to the **already installed** Pi 1.1.0,
TypeBox 1.3.27 and Node declarations. It uses TypeScript 6.0.3, strict checking,
ES2024/ESNext with bundler resolution for the jiti-loaded extensions, and the
original `skipLibCheck` setting. No packages, declaration stubs, suppression
comments or repository-wide compiler configuration were added.

The compiler checked current source and the two exact `HEAD` source files with
identical options and declaration fingerprints. Baseline source was supplied
read-only through the compiler host, without resetting or editing the working
tree. Both have **five errors**, all at corresponding unchanged source locations;
`extensions/role-sidecar/index.ts` has none. The two TS2322 messages differ only
in the rendering order/truncation of union members, not their failure chains.
The initial message-text comparator treated those as new; the final comparison
matches exact baseline-mapped source locations and retains both full messages.
All five errors still fail the typecheck; comparison never suppresses them.

Then-unrelated blockers in `.pi/extensions/reasoning-runtime/index.ts`:

| Pre-repair line | Code | Existing blocker (also reproduced at `HEAD`) |
|---|---|---|
| 2 | TS2305 | Installed `@earendil-works/pi-ai` does not export `complete`. |
| 847 | TS2347 | `ctx.ui.custom<any>` supplies a type argument through an `any` context. |
| 2161 | TS2322 | Existing `create_subagent` return helper widens `content[].type` to `string`. |
| 2241 | TS2345 | Existing auto-router call passes a possibly undefined mode. |
| 2271 | TS2322 | Existing `skill_synthesis` blocked-result path widens `content[].type`. |

No additional specialist-caused error remains to repair. The previous
runtime-closure narrowing fix remains effective. No production source changed
in this follow-up. Routing and task activation remain disabled; no commit was
created.

Historical gates:

- `tsc --project .pi/planning/dedicated-subagents/tsconfig.sdk-resolved.json`:
  **failed**, exit 2, the five baseline errors above.
- Eight directly relevant extension/sidecar/task suites plus five additive graph
  hints: **13/13 passed**, provider-free.
- Full-plan domain/live observations remain blocked independently of this result.

Evidence under `.pi/planning/dedicated-subagents/`:
`typecheck-unconfigured-current.json`, `typecheck-unconfigured-head.json`,
`typecheck-sdk-head.json`, `typecheck-sdk-final.json`,
`typecheck-comparison-final.json`, `typecheck-sdk-cli.log`, and
`verification-typecheck-followup.json`. The retained
`typecheck-investigation.cjs` records source hashes, compiler identity,
configuration and declaration fingerprint; its `final` mode rechecks current
source against the retained baseline. The config is local-environment-specific,
not a portable project gate. Managed comparison job: `job-mvct4di4-e4fa`;
final compiler job: `job-mvct765j-09a2`.

### Authorized baseline SDK repair (2026-10-17)

The user subsequently authorized all five baseline fixes. Changes are confined
to `.pi/extensions/reasoning-runtime/index.ts`, the existing startup regression
fixture, and documentation/private evidence; earlier specialist work is preserved.

- Replace the removed standalone `complete` import with the installed
  `ctx.modelRegistry.complete()` API. The configured registry owns request-time
  authentication; SDK error terminal messages remain failed ask runs, not success.
- Use `ExtensionContext` and a typed custom-panel result, retaining the explicit
  command-context check for session forks.
- Preserve the `"text"` discriminator in subagent and blocked skill replies.
  Fixing that discriminator exposed the SDK-required `details` property on
  content-only skill branches; these now explicitly use `details: undefined`,
  without changing their content or adding result data.
- Make `Runtime.autoRouteMode` required, matching its unconditional startup
  initialization. No routing policy or enabled state changes.

Current gates:

- `tsc --project .pi/planning/dedicated-subagents/tsconfig.sdk-resolved.json`:
  **passed**, exit 0, zero diagnostics across both extension entrypoints.
- `node .pi/planning/dedicated-subagents/typecheck-investigation.cjs repaired`:
  **passed**, retained `HEAD` has five errors and current source has zero, using
  the same installed declaration fingerprint and compiler configuration.
- **17/17 affected provider-free test commands passed**: the startup fixture
  (including new ask success/error/throw/abort, panel close/clear/fork, tool-result
  and disabled-router cases) plus 16 affected/regression commands, including all
  five additive graph hints. The regression job `job-mvctt3r3-1c7d` exited zero.
- Full repository, native Blender/formal-domain and live benefit gates remain
  unrun/blocked. Clearing typecheck does not satisfy those independent gates or
  complete the parent plan. Routing/task activation remain disabled; no commit.

Evidence under `.pi/planning/dedicated-subagents/`:
`typecheck-sdk-repaired.json`, `typecheck-comparison-repaired.json`,
`typecheck-sdk-fixed-cli.log`, `verification-baseline-sdk-focused.json`,
`verification-baseline-sdk-regressions.json`, and `verification-baseline-sdk.json`
(the consolidated gate record, including final Git/static checks). The failed
intermediate compiler output is retained as `typecheck-sdk-repaired-cli.log`;
the original five-error and failing behavioral regression logs are not replaced.
No packages, compatibility imports, declaration stubs, compiler suppressions or
weakened assertions were added. The SDK-resolved config remains a local gate,
not a new portable repository typecheck configuration.

### Initial local acceptance review (2026-10-17; historical)

Inspected canonical items `5.1.2` (M4 domains) and `6.1.2` (M5 acceptance/field
comparison). No production or test source changed in this pass. Existing SDK
zero-error evidence remains current; all pre-run changed-file hashes were
unchanged after execution. Automatic routing stayed off, including in manual
TUI fixtures; no installs, live provider calls, parent application or commits.

| Local gate | Observed acceptance result |
|---|---|
| Containment | Passed: actual bubblewrap execution with filesystem/network isolation. |
| Eight selected test commands | Seven fully passed: domain certificates/static ELF, verifier negatives, task integration/recovery, policy, disabled side effects and skill source contracts. Blender command checked Python syntax but **skipped native acceptance**. |
| Installed Lean 4.29.1 | Passed toolchain smoke in containment: `Nat.gcd 84 30 = 6` checked without axioms; false `= 7` rejected. This does **not** supply a pinned specialist checker or formal-task acceptance receipt. |
| Full extension RPC lifecycle | **48/48 probes passed**, no model prompt. |
| Explicit subagent and reasoning TUI | Both passed their local fixture/self-test gates. |
| Planner/coder/verifier topology TUI | **Failed semantic acceptance despite shell exit 0.** The planner fixture omitted required `roadmapPlan`; coder/verifier were blocked. A later researcher-only graph succeeded and satisfied the script's unqualified success grep. |

The final row is a newly confirmed **fixture/test-oracle defect**, not permission
to weaken planner validation. Runtime rejection is correct. The next local repair
is to produce a contract-valid planner fixture and require graph-specific complete
success (plus rejection coverage). It needs no provider or routing activation;
no repair or adaptive rerun was attempted during this inspection/execution pass.
Debug thread: `topology-tui-smoke-false-passes`.

Owner decisions still open at that checkpoint (superseded by the update below):

- Provide/approve a Blender version/runtime and bounded asset task; name the human
  visual criterion/reviewer for the eventual exact artifact.
- Approve the installed Lean runtime/checker pin and representative proof target,
  then authorize the missing checker/receipt adapter work. Lean installation is
  **not** the present blocker.
- Approve real domain tasks and the separate six-pair matched live pilot: exact
  model/thinking identities, task/criterion manifests, numeric token/tool/time/
  spend/retention ceilings, stopping rules and quality/cost/latency bars.
- Full `check-all.sh` still includes live model smoke; no full-suite pass is
  claimed. Automatic-delegate/canary TUI scripts require non-off routing and were
  deliberately not run. Prior fixed-attempt experiments remain untouched.

Evidence: `.pi/planning/dedicated-subagents/local-acceptance-20261017/` contains
`gate-inventory.json`, `decisions.md`, `capabilities.json`, `containment.json`,
`lean-toolchain.json` and the exact positive/negative proof sources, `tests.json`,
RPC/TUI results and retained transcripts. `summary.json` preserves raw command
outcomes; **`acceptance-review.json` overrides the misleading topology command
pass**. `acceptance-final.json` reconciles gate semantics and final Git evidence.
Managed job `job-mvcu8jru-1505` exited 0; that exit does not imply all acceptance
gates passed. About 4.6 MB of new evidence was retained within the 64-MiB family
cap. Parent outcomes remain **4/6 complete, 2 blocked** (workflow 14/18); the new
local G10 defect is recorded alongside, not hidden behind, external blockers.

### Topology acceptance repair and approved tools (2026-10-17)

The topology false-pass is repaired. `scripts/check-topology-tui.sh` now runs in
an owned disposable Git project and calls `scripts/check-topology-tui-results.js`
on fresh persisted packets. Both named graphs must succeed, with every expected
node/role present and successful, no errors/fallback, a schema-valid `roadmapPlan`,
a matching parent application/reconciliation, and a passed verifier verdict with
evidence. Process errors/timeouts are no longer swallowed. Routing stays off.

The deterministic planner emits a valid plan. Proposed-patch fixtures create a
real new file only in their leased isolated workspace, without overwriting an
inherited file. The first repaired-gate run correctly rejected an empty coder
patch and blocked verifier despite researcher success; this failure is retained.
The final real TUI run passed planner/coder/verifier plus researcher, with the
real parent roadmap's SHA-256 unchanged. No source patch was applied to the parent
by the fixture; no repository commit was made.

Seven affected test commands passed, including the new
`tests/topology-tui-acceptance.test.js`: 18 corruption cases through both the
validator and CLI, plus researcher-only/duplicate/malformed/blocked cases.
`tests/role-sidecar.test.js` proves planner schema rejection remains strict and
coder fixtures capture a nonempty patch without touching the parent. Source
wiring, topology/policy, subagent and disabled-side-effect regressions passed.

Owner approvals now name Blender plus `~/dev/BlenderAI`, Lean, and
`https://github.com/morluto/rea`. Local checks used:

- Official checksum-verified Blender **5.1.2**, build `ec6e62d40fa9`, under
  `.pi/toolchains/blender-5.1.2-linux-x64`; no global Blender settings changed.
- BlenderAI checkout `978b9ded53b7e79471a86e4d416e5e7115c52b5b`, unchanged:
  its canonical dispatch requires confirmation before creating the approved
  two-meter cube; approval, read-back, unknown-tool rejection, native reopen and
  GLB reimport passed under network-disabled containment. Exact `.blend`/`.glb`
  artifacts and hashes are retained, without claiming human visual approval.
- Existing Lean **4.29.1** positive/negative, axiom-free gcd smoke remains valid;
  no unnecessary reinstall or unchanged smoke rerun.
- **REA 6.5.0** installed under `.pi/toolchains/rea-6.5.0`, with dependency lock,
  install scripts/optional instrumentation disabled and no agent setup/config
  changes. Contained `inspect-with-objdump ... file_headers` passed against an
  owned ELF copy; SHA-256 before/after and REA evidence agree. No target execution.
  Consulted upstream source revision: `34a88d6c1674710953e2c94bd0a17332cd69ca6f`;
  the installed npm release is separately integrity-pinned, not assumed identical.

Evidence: `.pi/planning/dedicated-subagents/topology-tui-repair-20261017/` retains
both TUI attempts and the superseding `acceptance-final.json`; `approved-domains/`
contains toolchain/asset receipts and pinned documentation. Runtime installs are
separate from the 64-MiB evidence family; only the owned verified Blender download
archive was removed. Existing historical evidence and BlenderAI work were preserved.

G10's local topology blocker is cleared, not the full M5 outcome. Domain adapters,
exact real-domain task/visual criteria and live-pilot model/thinking identities and
hard numeric budgets remain open. Full live-provider and routing-dependent gates
remain unrun; parent outcomes remain **4/6 complete, 2 blocked** (workflow 14/18).

### Pinned Blender adapter increment (2026-10-17)

The approved Blender **5.1.2** distribution is now wired through the reviewed
policy boundary to both the producer and independent native checker. Its
executable SHA-256 is
`ed4a1317936e9993ee5b2c766976bff6fa6c5b7443f611d3367637240fc8593d`.
The contained provider-free native fixture passes: editable save/reopen, matching
GLB reimport/geometry, bounded CPU PNG preview, and a passed native criterion
receipt. The human visual criterion remains **blocked**; no parent patch is applied.

Seventeen focused/affected test commands passed (four initial focused commands,
the real native command, and twelve integration/role/task regressions). Negative
cases include absent/invalid/stale/aliased/non-executable runtime bindings, caller
runtime override rejection, ambiguous checker binding, geometry budget, missing
GLB and a fully transparent render. The first two native attempts are retained:
fixture model preferences did not match its policy, then the previously unrun
headless preview check failed. The fix validates pixels from the actual saved
RGBA PNG; existence alone cannot pass. Final native job: `job-mvcwjrk2-4ea2`.

Semgrep's advisory scan reported **42 files / 0 findings**. The initial broader
Verification Center quick proof **failed** an unrelated existing fixture at
`tests/integration-config-storage.test.js:74`: it assumed requested mode 0644 was
unaffected by umask. The unchanged-HEAD test and source reproduced failure under
077 and passed under 022. That failed proof is retained; the authorized fixture
repair and refreshed acceptance evidence are described below.

Evidence: `.pi/planning/dedicated-subagents/blender-runtime-wiring-20261017/`,
including `attempt-3/native-receipts.json`, the retained failed attempts,
`regressions.json`, `unrelated-umask-gate.json`, and `acceptance-final.json`.
Routing and task opt-ins remain off; no parent policy was installed, no live
provider calls or commits occurred, and the external BlenderAI checkout was not
modified. This increment does not wire BlenderAI dispatch, Lean or REA adapters.
Exact real-domain criteria, human sign-off and concrete live-pilot profiles/budgets
remain open. Parent outcomes remain **4/6 complete, 2 blocked** (workflow 14/18).

### Storage permission fixture follow-up (2026-10-17)

The storage test now deliberately initializes its owned symlink target to exact
0644 permissions with `chmod`, independent of creation-time umask. Both JSON
writes and JSONL appends must still reject symlink destinations without changing
the target's content **or permissions**. The regression exercises umasks 022 and
077 and restores the caller's umask in `finally`; production storage code and
private-file 0600 policy are unchanged.

The focused test passes. Separate process checks under caller umasks 022/077
confirm restoration, and injected JSON/JSONL target-chmod defects are both
rejected by the exact permission assertions. The latest broader quick-gate and
Git/static results are recorded in
`.pi/planning/dedicated-subagents/storage-umask-repair-20261017/acceptance-final.json`.
That packet supersedes the earlier broad-gate failure for current acceptance,
while retaining the original failure and Blender evidence. Unchanged native
Blender checks are not rerun merely for this test-fixture repair.

Human visual approval and live-pilot acceptance remain blocked. No routing/task
opt-ins, live calls, parent application or commits are authorized by these checks;
this is not a full provider/routing-dependent suite pass. Parent outcomes remain
**4/6 complete, 2 blocked**, separately from workflow **14/18**.

### Remaining-approval and tooling audit (2026-10-18)

Six new provider-free/read-only readiness checks passed: prior source/proof
freshness, approved executable/lock pins plus usable containment, archived native
receipt/PNG integrity, retained BlenderAI asset/source hashes, disabled-policy
and honest capability behavior, and existing experiment metadata inventory.
Unchanged successful native/regression suites were not rerun. Existing source
changes, archived failures and experiment denominators were preserved.

At the audit cutoff, no new runtime installation was needed; Lean and REA still
needed their specialist adapters and representative acceptance tasks. The D1/D2
implementation below supersedes those two gaps. Neither blocked a
**core-code-only** live pilot. Blender runtime wiring is complete. BlenderAI
specialist dispatch is an additional requirement only if the chosen task needs
that add-on workflow, not a prerequisite for native Blender acceptance.

The human gate needs an agreed asset brief/budgets, exact visual criteria/views,
a reviewer, and a retained authoritative task/candidate with passed native
receipts. The successful native regression used in-memory state and disposed of
its workspace: its archived `visual` receipt is still blocked and is not a live
approval request. Retained BlenderAI smoke assets also lack a real-task visual
criterion/reviewer and specialist acceptance binding. Approval must identify the
current run/task/artifact digest and all pending human criterion IDs in the
interactive UI; application remains separate.

The live pilot still needs six matched task pairs and frozen order, exact model/
thinking identities and pricing, numeric per-attempt/arm/cohort ceilings,
retention admission, decision bars and stop rules. Then—and only then—review a
local policy, explicitly enable manual task/topology execution, inspect preflight,
and confirm runs. Automatic routing may stay off. Full-fleet provider smoke and
routing/canary gates require separate authorization and remain unrun.

Exact approval fields, existing tool paths/pins, archived artifact identifiers,
accounting-bound formula and the proposed decision bars are recorded in
`.pi/planning/dedicated-subagents/blocker-audit-20261018/decisions-needed.md`;
`readiness-checks.json` and `acceptance-final.json` retain the observations.
Human approval and live-pilot outcomes remain **blocked**; parent progress remains
**4/6 outcomes complete, 2 blocked** (workflow **14/18**).

### D1/D2 representative native acceptance (2026-10-18)

`tests/specialist-lean-rea.test.js` now runs real contained Lean 4.29.1 and REA
6.5.0 through the task service, with fixture-driven producer/reviewer execution.
The Lean task proves exactly `Nat.gcd 84 30 = 6` with no axioms; an additional
case accepts propositional extensionality only under its explicit standard-axiom
allowlist. False proof, unrelated theorem, `sorry`, new axiom, extra/missing import,
forged output, stale source/target/runtime, wrong operation/authorization and
fabricated static observations are negative cases. REA analyzes an owned benign
ELF without executing it and independently round-trips `.interp` bytes.

Both tasks reached `accepted-proposal` with artifact-bound `domainEvidence`,
without changing the parent repository. Test policies/workspaces are disposable;
no parent policy, provider call, model claim, human approval, application or
routing activation is implied. Future tasks still require reviewed exact inputs.
Initial native integration failures are retained, not converted to passes.
Evidence and final gate reconciliation:
`.pi/planning/dedicated-subagents/d1-d2-adapters-20261018/acceptance-final.json`.
The earlier blocker audit remains historical. D1/D2 are implemented with native
representative acceptance; **H1, L1 and L2 remain blocked**. The full parent remains
**4/6 outcomes complete, 2 blocked**, separately from workflow **14/18**.
