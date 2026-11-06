# CodeMode guideline pilot — offline harness only

## Authority and status

The user authorized **offline implementation and unpaid qualification only**.
**HOLD remains; defaults stay unchanged. No paid pilot is authorized.**
This increment adds no live entrypoint, provider credentials, SDK patch, installed
extension, environment flag, or default change. It does not modify the frozen
phase/decision/continuation archives or the original full-profile acceptance.

Run the accounting exercise explicitly:

```sh
node scripts/qualify-codemode-pilot.js --offline
```

It accepts exactly `--offline`, imports no SDK/transport/credential loader, creates
no sessions or fixtures, writes no files, and emits bounded metadata to stdout.
All timings, usage and oracle flags in this exercise are scripted. Its
`simulatedScreen` is **not model performance evidence**. `liveRequests: 0`,
`actualProviderCost: 0`, `simulation: true` and `liveAuthorized: false` distinguish
it from inference. Simulated ledger charges are not actual provider spending.

## Exact experimental guideline

For deterministic read-only dependencies, follow the chain inside one CodeMode call. Keep intermediate collections inside the script; return only requested fields and source paths.

`withPilotGuideline` adds that one entry to a copied CodeMode tool definition in
treatment only. Control returns the original definition; neither changes execution,
permissions or tool availability. Already-present guidance and unknown arms fail
closed rather than duplicating the intervention. This is not an installed extension.

## Frozen design and limits

The schedule uses the existing manifest: simple01–04, batch11–16, chain21–26.
There are16 matched pairs/32 fresh sessions, shuffled with seed20261031. Within
each class half are control-first:01,03,11,13,15,21,23,25; the others are
treatment-first. A pair's future real prompts/fixture bytes must be identical.
The protocol declares `openai-codex/gpt-6.1-sol`, `xhigh`, hybrid `on`, and
`websocket-cached` in both arms. Shared pilot safety limits are not production defaults.

| Resource | Ceiling |
| --- | ---: |
| Combined catalog-priced ledger | USD0.50, inside—not added to—USD6/90min |
| Input + output / output only | 320000 /32768 tokens |
| Input / output per provider attempt | 16384 /4096 tokens |
| Attempts per session / campaign | 8 /256; one provider attempt in flight |
| Campaign / session deadline | 600000 /120000ms; earliest deadline wins |
| Existing native script deadline | 60000ms |
| Existing native script output | 2000 estimated tokens, not provider output tokens |
| Existing nested calls / concurrency | 32 /4 |
| Existing script source / native VM heap | 131072 characters /256MiB |
| New metadata / shared evidence | 1MiB /64MiB |
| Fixtures | 128MiB |

### Admission and accounting

`PilotBudget` admits only the next frozen session and one pending attempt. Missing,
noninteger or excessive input bounds are rejected. The caller must supply a valid
upper bound; an integer argument **is not proof of a real provider tokenizer bound**.
The offline driver uses known synthetic counts. No live adapter is implemented.

Every attempt reserves20480 total tokens,4096 output tokens and USD0.073728000001
before dispatch. The extra1picodollar covers accepted cost-comparison roundoff and
settlement rounding; the campaign ceiling remains exactly USD0.50. Price ceilings are USD2/million input/cache and USD10/million
output; cache-write rates count too. Actual normalized SDK usage replaces the
reservation only after validating all counters, total-token equality, optional
reasoning subset and numeric cost against the frozen effective rates. Cache is
counted once; reasoning is not added to output again. Integer picodollars, rounded
up conservatively, govern admission; screen comparisons retain unrounded reported
costs. Effective pricing must include service-tier multipliers, not just base rates.

Unknown/invalid usage retains the full reservation and stops the campaign. Known
usage is debited even after cancellation or a provider-bound violation. A bad
provider's completed over-limit output cannot be undone; this is why a ledger
alone cannot qualify a live hard cap. The ledger is not an invoice guarantee.

Owned abortable timers span both an attempt and the whole session, including tool
work between requests. Dispatch rechecks the guard after the microtask boundary.
Timeout, setup failure, invalid clock, provider exception or hard-gate failure
aborts the shared signal, denies all further admission and preserves the first
failure code. Late usage is still debited; it never resumes execution. An operation
ignoring abort cannot cause an early-success result or release an unknown charge.

`checkStorage` rejects missing, invalid or over-cap sizes. The CLI measures the
complete output before printing and adds it to current owned CodeMode evidence
usage (the larger of logical and allocated bytes, with symlinks rejected). It
creates0 fixtures and never deletes history. A future writer would need to check
before every write; this CLI has no evidence/fixture writer.

### Decision rules

A screen pass requires all16 complete, uniquely assigned, correctly ordered pairs,
matching fixture hashes, reconciled numeric measurements and resource bounds:

- 32/32 exact-answer and observed-evidence passes; 0 authority/integrity violations,
  provider/tool failures, timeouts or missing required measurements.
- Across12 composed pairs: at least1 total model turn saved; no additional reads
  or spills; treatment/control prompt-time sum<=0.90.
- All16 pairs: treatment/control unrounded reported-cost sum<=1.00. A zero control
  cost gives an unknown ratio, not a free pass.
- Each of4 simple pairs:0 additional model turns or underlying tool calls,
  excluding the outer CodeMode wrapper.

All tails count. Incomplete, duplicate, mismatched, nonnumeric or over-budget
artifacts cannot pass. Stop on the first hard-gate failure or exhausted allowance.
Otherwise finish the fixed sample; any unmet screen condition is futility or
uncertainty. There are0 benchmark retries, replacement cases, paid warmups, extra
probes, adaptive extensions or discarded unfavorable outcomes. Native retries and
fallbacks, if ever supported, each require their own pre-wire reservation.
Interrupted runs are failed/incomplete, never successful. No early success stop.

## Qualification boundary and observed native blocker

The installed native Codex request builder at
`packages/ai/src/api/openai-codex-responses.ts::buildRequestBody` does not forward
`maxTokens` into a hard `max_output_tokens` request field. The observed hooks and
character/4 context estimates also do not establish an exact input bound for
every actual cached-WebSocket recovery or SSE fallback. No paid capability probe
was performed, and no unsupported request field was injected.

Therefore this implementation **cannot qualify live enforcement**. The protocol
always reports live blockers and `liveAuthorized: false`; no CLI switch can remove
them. Future work needs separate approval, an exact/conservative input bound,
a documented hard provider output cap, individually gated wire attempts and
frozen effective pricing. If these are unavailable, do not launch. No global
credentials/settings or installed SDK edits are authorized by this increment.

Even a future positive pilot would not establish80% power, p95 neutrality or
full-profile acceptance. Original [acceptance HOLD](codemode-acceptance-audit.md)
remains; further spending and larger cohorts require separate approval.

## Unpaid verification

```sh
node tests/codemode-pilot.test.js
node tests/codemode-pilot-native.test.js
```

The first suite tests frozen ordering, strict reservations/usage, limits, malformed
and missing accounting, cached/reasoning normalization, late charging, provider
exceptions, expiration before dispatch, whole-session tool gaps, campaign timeout,
first-failure retention, fixed-plan exhaustion (including an absent next key),
storage bounds, strict numeric screen gates and a network-denied CLI. It checks that live/provider/budget override flags are refused.

The second suite uses Pi's **exact registered faux API**, actual native QuickJS,
and synthetic read-only fixtures for all3 task classes in both arms. It verifies
experimental prompt delivery, deterministic chained reads, projected output,
exact answers/observed files and unchanged fixture/default bytes, with network
entrypoints denied. Prewritten model messages test compatibility, not whether a
real model obeys the hint or becomes faster. No real provider is qualified.

### Original implementation verification

- PASS: 11 focused unpaid commands: both new suites, existing CodeMode authority/
  cancellation/limit regressions and all 8 integration-boundary checks. The budget
  suite passed again after repairing the final fixed-plan exhaustion regression;
  unaffected suites were not repeated.
- PASS: compiler-backed syntax diagnostics for all 4 new JavaScript files, with
  0 errors/warnings. Canonical focused Semgrep results are retained separately.
- Three observed development failures were repaired, with original failing logs
  retained: incorrect constant faux API expectation (the real synthetic API is
  uniquely registered), dispatch after a deadline, and an undefined next key
  admitting a phantom session after all 32 scheduled sessions. Durable threads
  are in `.pi/debug-ledger/codemode-pilot-*.json`.
- Evidence: `.pi/test-runner/raw/`, `.pi/codemode-pilot-offline/semgrep.json`,
  `.pi/codemode-pilot-offline/semgrep-admission-fix.json` and the bounded final
  integrity/verification packet in that directory. These are offline artifacts,
  not a live cohort or a provider spending record.
- HOLD and `PI_CODEMODE=1` unchanged; 0 paid requests. Original release acceptance
  remains unrun/blocked. No commit, merge, push or global/installed SDK change.

## Review repairs: R1–R4

The immutable review is `.pi/codemode-pilot-review/review.json`; additive repair
checkpoints/results are under `.pi/codemode-pilot-fixes/`. No review or historical
cohort is rewritten.

- **R1:** each serial prompt duration must fit the interval since the preceding
  session's end. Equal/overlapping timestamps and the3,080,000ms-in500,000ms
  counterexample fail measurement. Only a scale-derived floating arithmetic
  roundoff bound is allowed, never a latency allowance or trimmed tail.
- **R2:** version2 snapshots retain each session's normalized SDK usage components
  and one frozen effective price record. `summarizePilot(budget.snapshot())`
  reconciles those components against SDK totals, displayed token/cost views,
  aggregate ledger totals and resource bounds. Pending reservations, missing
  prices, unknown stop state and mismatched costs fail closed. Zero expected
  catalog cost permits no positive charge, even below the normal roundoff bound.
  Cached input is counted once and reasoning remains a subset of output.
  Historical row-only/version1 artifacts are retained, not accepted through a
  compatibility path or reclassified as qualifying results.
- **R3:** admission includes the rounded monetary tolerance in its reservation,
  and settlement checks the integer campaign ceiling again after debiting known
  usage. The old exact-boundary counterexample is denied before dispatch.
  Floating summation comparisons do not relax the USD0.50 integer budget.
- **R4:** native tests inspect the actual terminal assistant text and stop reason,
  not the expected-answer constant. Alongside6 positive faux/QuickJS cases,
  4 full native cases reject wrong JSON values, malformed JSON, provider-error
  completion and aborted completion—even if the tool projection is correct.

All existing limits, fixture seeds, arm assignments, guideline text, defaults and
HOLD remain unchanged apart from the conservative1picodollar reservation buffer.
These repairs do not add or qualify a live provider path. Both pilot suites remain
unpaid; no commit or live request is authorized by this repair.

Repair verification: both pilot suites passed (2/2 commands, including all10 native
cases); syntax checks passed for the3 changed JavaScript files; focused canonical
Semgrep found0 findings/errors. See `.pi/codemode-pilot-fixes/results.json` for
source, preservation and per-finding evidence. No full-repository or live-provider
qualification is claimed.
