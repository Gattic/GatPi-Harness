# Native CodeMode

CodeMode is **enabled by default** in ordinary harness sessions, in native Pi's hybrid `codemode.mode: "on"` mode. Direct tools remain available. This is not an opt-in rollout and benchmark results do not control enablement. An explicit Pi `codemode.mode` preference is respected; the harness does not automatically switch to `only`.

Requirements: installed Pi with the public `createCodemodeExtension` factory, nested `ctx.executeTool` pipeline, tool exposure/loadout hooks, and QuickJS worker/WASM assets. The implementation is exercised against linked Pi 1.1.0. There is no legacy executor or Cloudflare service dependency. The normal source-linked extension installation discovers `extensions/codemode/index.ts`; no new installer or global-settings migration is needed.

## Opt out

Launch with `PI_CODEMODE=0 pi` to make the harness CodeMode tool hidden and unreachable, including attempts to auto-activate it. For one session, `pi --exclude-tools codemode` also disables it. Explicit `--tools` allowlists and `--no-tools` are respected. Restricted role children do not gain CodeMode or new tools merely because the parent has it.

Setting `codemode.mode: "on"` controls presentation, not enablement: it is not an opt-out. Changes apply on reload/restart, not by mutating an executing script. Do not disable only this harness extension while leaving an unrestricted native CodeMode tool active; use the documented tool/environment opt-out instead.

## When to use it

Use scripts for deterministic dependent calls, independent read batches, and filtering intermediate data. Keep direct tools for simple operations, model judgment, mutations, approvals, actual verifier execution, specialist delegation and long-running process supervision.

For example, raw JavaScript passed to `codemode` can search local docs and return just paths:

```js
const result = await tools.docs_lookup({ operation: "search", query: "CodeMode" });
return result.results.map(item => ({ path: item.path, startLine: item.startLine }));
```

Only active/eligible `read`, `grep`, `find`, `ls`, `code_context`, `docs_lookup`, and `test_runner` status/listProfiles/infer are exposed to scripts. The native discovery/type descriptions show the reviewed operations. An unavailable or explicitly excluded tool is not granted by this list. No tool is converted to deferred exposure, so existing router eligibility/readiness remains intact.

`code_context`, `docs_lookup`, and `test_runner` have validated structured output schemas. Their `structuredContent` and UI `details` share canonical data; scripts do not parse the rendered summaries. Preserve freshness, provenance, degradation, truncation and outcome fields when making decisions. Native tool-result redaction applies before the script sees data; nested output compaction does not replace canonical results with a presentation summary.

## Limits and authority

The host enforces:

| Resource | Limit |
| --- | --- |
| Script wall time | 60 seconds, including startup; a script may request less |
| Nested calls | 32 per script; exceeding it cancels the script |
| In-flight calls | 4; additional admitted calls wait and cannot start after cancellation |
| Returned output | 2000 estimated tokens; larger text uses native private spill files |
| Source | 131072 characters |
| QuickJS heap | Native Pi's 256 MiB |

Script options cannot increase these limits. `models.*` is not injected, so scripts cannot make extra classifier/image/provider calls. Persistent `store()` writes are explicitly refused and old CodeMode store entries are not exposed through `load()`. Return bounded identifiers instead.

All admitted calls still use native validation, policy/result hooks, cancellation and nested lifecycle events. No direct invocation of a tool's implementation occurs. There is no additional shell/network/file authority: tools retain their existing path policy and operating-system permissions. This is not a sandbox around the Pi host or its extensions, and it does not make source text or arbitrary tool outputs trusted.

The outer result reports canonical nested outcomes even when generated code catches a failure or prints an optimistic answer. A script failure does not undo earlier tool calls. `not-applicable` remains distinct from success, and a completed script is never verification proof. Canonical verifier/evidence stores and their source/command bindings remain authoritative; CodeMode cannot execute or fabricate those gates.

## Observability and privacy

Native events and bounded `nestedCalls` records preserve actual child identities/statuses; the model sees selected script output, not ordinary transcript entries for each child result. Count underlying tool executions separately from the outer CodeMode call. Native transcript record limits are not execution budgets; the harness independently enforces its call limit.

Fleet telemetry remains metadata-only. Local Pi sessions may contain generated scripts, bounded nested arguments and returned output; review them before sharing. Native output spills are exclusive regular files mode 0600, even when stored directly in the shared OS temporary directory. Do not delete their parent directory. Nested source bodies are not marked model-visible merely because the script fetched them, so later context retrieval cannot silently reuse an unseen body.

## Evaluation

`node scripts/benchmark-codemode.js --synthetic` validates the fixed runner with native CodeMode and synthetic provider messages. It is **not live model quality, provider latency, or cost evidence**.

`node scripts/benchmark-codemode.js --live --provider <exact-provider> --model <exact-model> --thinking <level>` runs the fixed live comparison, with no retries or model/provider fallback. It uses the selected provider's existing credentials through a read-only store: refresh, writes, deletion and stored credential commands are refused. It never changes global settings or credentials. Ensure the selected token is already valid; an unavailable model/provider or refresh requirement stops the comparison honestly.

Each mode has one retained run directory under `.pi/codemode-benchmark/`; a repeated run is refused, rather than silently repeating a settled experiment. Identity is validated before registration, independently of managed-job environment inheritance. The explicit `--resume-unstarted <owned-run-directory>` action permits one additive `protocol-02.json`/`summary-02.json` continuation only for a historical `MODEL_IDENTITY_MISSING` preflight with zero cases; original records remain unchanged. An attempted case, provider failure, or existing continuation cannot be retried through this path. The script checks existing primary-checkout experiments and preregisters a separate worktree-local ledger entry before inference. It freezes the 30-task manifest and executable oracles, source/Pi/config/credential/history digests, exact model/thinking identity, counterbalanced order and retention limits. There are ten single-file controls, ten four-file batches and ten dependent route/catalog tasks, paired across 60 fresh sessions.

Results record exact answer plus observed-file evidence, tool failures, model turns, underlying attempts/successes, generated-code size, reported usage/cost and character/4 full-transcript context estimates including tool declarations. Provider-payload estimates are recorded separately when that provider builds an HTTP payload; missing payloads are null, not zero. Provider errors, timeouts and protected-byte drift stop execution; remaining cases remain unrun. Successful owned fixtures are removed; failed fixtures and metadata are retained. No private reasoning or credential values are recorded. Evidence is capped at 64 MiB and fixtures at 128 MiB.

A separately authorized [phase-timed follow-up](codemode-phase-timing.md) uses `scripts/benchmark-codemode-phases.js` for two comparable trials with provider/tool/CodeMode interval accounting and actual provider-reported input/cache/output/reasoning token differences. It never resumes or overwrites this frozen comparison, and default-on remains unchanged.

Benefit targets (not an enablement gate): at least 25% less composed-task estimated context, no more than 10% p95 latency/cost regression, exact oracle/evidence parity and no failed tool gates. Missing cost is unknown, not a pass. These synthetic tasks and a 30-pair pilot do not establish field effectiveness or statistical noninferiority. See `codemode-verification.md` for this implementation's recorded results and limitations.
