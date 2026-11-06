# Jev (TypeSafe System One) integration plan

**Date:** 2026-10-02
**Scope:** Using TypeSafe's Jev model inside `pi-harness` decision points and in the everyday Pi workflow
**Current versions:** Pi 0.84.1, Node 22.22.2, harness `2a80c81`, `jev-latest` → `jev-1.13.0`, TypeSafe agent skill installed for Pi at `~/.pi/agent/skills/typesafe-ai`
**Decision:** Integrate Jev as an opt-in, advisory judgment service. Start with per-turn skill relevance. Then add a shadow-evaluated, per-turn advisory intent judgment to the same request. Every safety, privacy, policy, and approval gate stays deterministic and local.

## Executive summary

Jev is not a chat or coding model and cannot power Pi. It takes a `state` plus typed questions (Choice, Score, Noul) and returns calibrated probabilities. The harness already makes several per-turn semantic decisions with regular expressions and token overlap, and assigns them hand-written confidence constants. Those decisions are what Jev is built for.

The best first integration is **skill relevance**:

- TypeSafe's own skill-suggestion cookbook measured 2.3× fewer wrong skill loads and 2.4× fewer needless loads for an agent harness.
- The harness already has the injection slot (`[L2:skills]`), a small roster (19 model-visible skills), and labels on disk (2,561 `SKILL.md` reads in past sessions).
- Its current relevance signal is token overlap, and every native skill carries the constant confidence `0.82`.

The second integration adds advisory intent questions to the **same** request. Those questions replace the advisory parts of three regex classifiers, which currently disagree with each other at more than 0.9 "confidence" on prompts from this very session.

Cost is negligible: roughly $0.0003 per turn. The real cost is data egress: prompts would go to a new third-party processor. This plan therefore keeps the feature opt-in, redacts and caps the prompt, and sends no tool output, files, transcripts, or memory in Phases 1–2.

## What Jev can and cannot do here

Sources: <https://docs.typesafe.ai/llms.txt> and the pages it links to. All were read live on 2026-10-02.

| Fact | Consequence for the harness |
|---|---|
| `POST https://api.typesafe.ai/v1/systemone`. Bearer `TYPESAFE_API_KEY`. Questions are Choice (≤255 options), Score (≤10 levels), or Noul. | One HTTP call per turn can carry every question ("speculative fan-out"). |
| `jev-1.13.0`: $0.042 per million input tokens; output is free. 64k tokens per request, 32k for state plus the longest question. 40 req/s and 100k tok/s, both adjusting dynamically. | Cost is irrelevant at interactive pace. Rate limits can change without notice, so outages must be harmless. |
| `jev-latest` and `jev-preview` are aliases that move; the response reports the versioned `model`. | Pin `jev-1.13.0` for tuned thresholds and log the answering model. |
| Not trained on customer requests. Zero data retention is enterprise-only. | Treat every request as retained by a third party: redact and minimize. |
| Known jagged edges (jev-1.13): literal reading, counting/numbers/dates, indirection, large irrelevant state, adversarial content, generation. | Keep arithmetic, dates, and counts in code. Send only the fields each question needs. Never let a judgment unlock anything. |
| Choice `confidence = (p_max − 1/n)/(1 − 1/n)`. A Noul has no confidence field (use `|2p−1|`). Choice and Noul thresholds don't transfer. | Tune each threshold per question on our own labels. Don't copy cookbook numbers. |
| Skill-suggestion cookbook (Hermes 182-skill roster, 60-char truncated index, 488 requests, `claude-haiku-4-5`, `jev-1.12`): wrong loads 16.8% → 7.3%, needless loads 9.8% → 4.0%. 37 fixed, 7 broken. | Strong prior, but Pi already shows full descriptions to the model, so expect a smaller gain. It must be measured here. |

## Evidence collected

### Harness decision points today

| Decision | Where | Method today | Jev fit |
|---|---|---|---|
| Skill advisory line in cognitive context | `src/skill-synthesis.js` `scoreSkillRetrieval`; `.pi/extensions/reasoning-runtime/index.ts` `formatSkillAdvisory` | Token overlap (weight 0.38) mixed with status, effectiveness, repository, and tools. Native skills get constant `confidenceScore: 0.82`. Inject max 1 at min score 0.5. | **Strong**: Choice + Nouls (cookbook pattern) |
| Reasoning scaffold modality | `src/task-modality.js` | 9 regexes. Fixed confidences of 0.75–0.99. | **Good** for the non-protected modalities. Its output is consumed only as injected scaffold guidance (no code path enforces `mutationAllowed`/`readOnly`). |
| Optional tool-group activation | `src/tool-surface-router.js` `classifyTask` (11 group regexes) | Regex per group | **Good**: one Noul per group, fails open |
| Obsidian/research intent | `src/obsidian-intent.js` | 5 regexes, fixed confidences | **Good**: one Noul |
| Role intent | `src/role-router.js` (`role-router-v6`) | Regexes, fixed confidences | Deferred: auto roles are off (`PI_AUTO_ROLES=off`) |
| Memory/context recall | cognitive memory `retrieve`, project-memory recall | Lexical | Possible later, privacy-gated (Phase 3) |

These are **not candidates** and stay deterministic:

- `src/policy-enforcement.js` and `src/privacy-guard-scan.js`.
- `src/memory-content-scanner.js`.
- Publish/credential/destructive detection in `task-modality.js` and `role-router.js`.
- Approvals.
- Tool-surface `OPPORTUNITY_SPECS`. These are telemetry, and a measurement must not depend on the thing being measured.

### The regex classifiers disagree on real prompts

I ran this session's prompts through the current classifiers at HEAD `2a80c81`:

| Prompt (abridged) | `task-modality` | `role-router` | tool-surface intents |
|---|---|---|---|
| "What is the best way we can integrate jev ai … Create a plan and save it to a file." | implementation 0.94 | answer 0.96 (`question-only`) | none |
| "… Where do I put my jev api key? …" | answer 0.75 | **destructive 0.99** (`credential-operation`) | none |
| "Investigate why the skills CLI reports … fix it if needed, then rerun … and verify …" | implementation 0.94 | implement 0.92 | none |
| "Verify that a fresh Pi session discovers … without modifying any repositories." | verification 0.94 | verify 0.88 | evidence |

The confidences are per-rule constants, not probabilities. Two classifiers label the same prompt differently, each at >0.9.

The API-key false positive is the safe direction for a protected-action gate and should stay. The problem is advisory consumers reading these numbers as confidence.

### Labels already on disk

- `~/.pi/agent/sessions` holds 1,813 session files (6.7 GB). 313 of them contain 2,561 `read` calls of a `SKILL.md`. These are weak labels for "which skill the agent loaded on this turn".
- Tool calls per turn are weak labels for "which tool groups the turn needed".
- Agent behavior is not ground truth. The harness already has a user-reviewed-gold evidence class (`scripts/report-reviewed-gold-evidence.js`); gates must be decided on reviewed gold.

### Hot-path budget

`before_agent_start` timings from `.pi/cognitive-automation/trace/events.jsonl` (n=331, 2026-07-30 → 2026-10-02):

| Stage | Median | 95th percentile | Max |
|---|---|---|---|
| Total | 43 ms | 95 ms | 664 ms |
| `skillRetrieve` | 20 ms | 49 ms | 623 ms |

The stages already run in `Promise.all`, so a Jev call runs beside them; the added turn latency is Jev's round trip. The cookbook observed 0.09–0.31 s per call. Pi `input` handlers may also be async (Pi `docs/extensions.md#input`).

### Roster and packaging facts

- There are 34 unique skills: 19 are model-visible and 15 use `disable-model-invocation`. The visible descriptions total 8,709 characters (~2.2k tokens), so the whole roster fits in one request with full descriptions.
- One lookalike cluster exists: eight `hyperframes*` skills plus `media-use`. This is exactly the case the cookbook's rerank stage targets.
- The harness has no root `package.json` or `node_modules`; `src/` is dependency-free CommonJS. The API is a single JSON endpoint and Node 22 has `fetch`. The SDK's main extra is retry with backoff; the harness does not retry, so a failed judgment is simply absent for that turn.

## Design principles

1. **Advisory only.** Jev may rank, suggest, or narrow what is shown to the model. It never authorizes an action, approves a policy exception, clears a confirmation, or makes a privacy decision.
2. **Protected decisions stay deterministic.** This covers credential/destructive/publish detection, the policy enforcer, the privacy guard, the memory content scanner, and approvals. Local regex detection of protected actions runs first and short-circuits; protected modalities are never Jev options.
3. **Minimal egress.** Phases 1–2 send only two things:
   - the current user prompt, privacy-scanner-redacted and capped at 2,000 characters (the existing `publicText` cap);
   - public catalog text: skill names/descriptions and tool-group descriptions.

   They never send tool output, file contents, transcripts, memory, private reasoning, absolute paths, or environment values.
4. **Failure means absence.** A missing key, `401`, `422`, `429`, `529`, a timeout, or a network error omits that advisory for the turn and records a fixed reason code. There are no hot-path retries and no second classifier kept as a backup. The single exception is tool-surface narrowing: on failure it falls open to the initially eligible surface, which is the same as running with the router disabled.
5. **Pinned model.** Thresholds are tuned against `jev-1.13.0`, and the config pins that versioned ID. A new model version means re-running the gates.
6. **Measure before promoting.** Each feature goes off → shadow → canary → on. Bars are pre-registered in `experiment_ledger`, and a FAIL or NULL-RESULT removes the Jev path.
7. **One source of truth.** When a Jev judgment is promoted, the regex/lexical logic it replaces is deleted in the same change and every caller is migrated. Shadow-mode coexistence is a bounded experiment, not a permanent dual path.
8. **Opt-in.** Every Jev feature defaults off until its gate passes.

## Target architecture

```text
TYPESAFE_API_KEY  (user shell env: ~/.bashrc.d/typesafe.sh, mode 600)
        │
src/typesafe-client.js        single HTTP client: POST /v1/systemone, GET /v1/models,
        │                     10 s failure timeout, HTTP/network error → fixed reason code,
        │                     records answering model + input tokens; never logs key or payload
src/typesafe-turn-judgment.js builds one per-turn request from (redacted prompt, catalog);
        │                     turns answers into decisions with code-owned thresholds; pure,
        │                     tested with a fake client
src/integration-boundary.js   SystemOneAdapter { enabled, sink }: the only path extensions use;
        │                     disabled → { enabled: false, skipped: true }
        ▼
.pi/extensions/reasoning-runtime   skill relevance line (Phase 1), scaffold modality (Phase 2)
extensions/tool-surface-router     optional tool-group activation (Phase 2)
```

Proposed configuration, documented in `docs/runtime-configuration.md` when it ships:

```text
PI_JEV_SKILLS=off|shadow|on          default off (Phase 1)
PI_JEV_TURN_INTENT=off|shadow|on     default off (Phase 2)
PI_JEV_MODEL=jev-1.13.0
```

These mode flags exist only while a feature is in evaluation. Once a feature passes its gate, its flag is removed and Jev becomes that feature's single path.

- **Telemetry** is metadata-only, matching existing extension telemetry. It records feature, mode, outcome code, latency, input tokens, the answering model, the suggested catalog name, and whether the agent then loaded or used it. It never records prompt text.
- **Readiness** is `SystemOneAdapter.readiness()`, shown in the reasoning-runtime status output beside the other boundary subsystems. It reports key present (boolean only), whether `GET /v1/models` is reachable, and whether the pinned model is accepted. `src/provider-readiness.js` is not reused: it gates verification on the codegraph, semgrep, and visual providers, which is a different concern.

## Phased plan

### Phase 0: Foundation (no behavior change)

1. `src/typesafe-client.js`, tested against a local `node:http` fake server. Cases: success, 401, 422, 429, 529, timeout, malformed body, and an assertion that the key never appears in errors or telemetry.
2. `SystemOneAdapter` in `src/integration-boundary.js`, honoring the enabled/storage/sink contract in `docs/integration-boundary.md`.
3. `SystemOneAdapter.readiness()` and its line in the reasoning-runtime status output.
4. A written privacy decision in `docs/runtime-configuration.md`. It lists exactly which fields may leave the machine and links this plan.
5. `scripts/smoke-typesafe.sh`: a manual, key-gated live check modeled on `scripts/smoke-hermes-advisory.sh`. It is not part of `scripts/check-all.sh`.

**Exit:** `scripts/check-all.sh` passes with no network access, the smoke script receives answers from `jev-1.13.0`, and a fixture audit finds no key or prompt text in traces or telemetry.

### Phase 1: Per-turn skill relevance

**Request:** one call per turn.

- `state`: `{ request: <redacted prompt> }`
- `which`: a Choice over the model-visible roster (name → full description).
- Three `gate::` Nouls asking whether the turn wants an action that a documented procedure serves, using the cookbook's wording as the starting point.
- One `fits::<skill>` Noul per roster skill. That is 19 today, cheap at this size, and in the same round trip.

**Decision in code:** suggest the top Choice option only if the gate mean ≥ *g*, the best shortlisted `fits` ≥ *f*, and the Choice's own confidence ≥ *c*. All three thresholds are tuned on reviewed gold (*c* may tune to 0, which disables it).

**Evaluated variant:** the cookbook's second request, which reranks the top three with the opening of each `SKILL.md`. Adopt it only if it measurably fixes confusion inside the `hyperframes*`/`media-use` cluster.

**Injection:**

- Replace the current native-skill `[L2:skills]` line with `Relevant to this request: <name> (/skill:<name>). Ignore this if it does not fit what the user asked.`
- Inject nothing when nothing fits. Pi's prompt has no "err on the side of loading" instruction, and the harness minimizes injected characters. Test the cookbook's explicit "nothing relevant" sentence only if needless loads stay high.
- Leave Pi's `<available_skills>` roster untouched so prompt-prefix caching is unaffected.
- Governance filters (status, unsafe, approvals) still run in code before the request, so Jev only ranks what is already allowed.

**Known limitation to measure:** follow-up turns such as "yes, do that" carry little context. Evaluate whether adding the previous user prompt (also user-authored, also redacted) to `state` improves recall without raising needless suggestions.

**Gold set:**

- Sample at least 200 turns from sessions:
  - at least 100 positives (a skill was read on that turn), stratified by skill and oversampling the lookalike cluster;
  - at least 100 negatives (no skill read).
- The user reviews and corrects the labels, producing user-reviewed gold.
- Prompts are scanner-redacted. The user approves sending this set to TypeSafe before any evaluation call.

**Arms (offline):** current lexical retrieval; Jev single request; Jev with the rerank variant. Lexical scoring is local, and Jev scoring of 200 turns costs well under $0.01.

**Pre-registered bars (proposed; record in `experiment_ledger` before running):**

- Wrong-suggestion rate on positives ≤ 50% of the lexical baseline **and** ≤ 15% absolute.
- Needless-suggestion rate on negatives ≤ the lexical baseline **and** ≤ 10% absolute.
- Timeouts plus errors ≤ 2%. Latency is reported, not gated.
- Zero over-cap or unredacted-secret payloads in the fixture audit.

**Field stages:**

1. **Shadow:** compute but don't inject; record the suggestion and whether the agent read that skill. Run for at least 100 turns.
2. **On** for at least 100 turns. Compare wrong and needless load rates (computed from session `read` calls) against the shadow window.

**Exit:**

- **PASS:** Jev becomes the only relevance source for skill advisory. Remove the lexical task-similarity term from the hot path, migrate the `/skill-suggest` and topology-suggest callers, and remove `PI_JEV_SKILLS`.
- **FAIL or NULL-RESULT:** remove the Jev skill path.

### Phase 2: Advisory intent in the same request (shadow first)

Add these questions to the Phase 1 request. It stays one round trip, with roughly 1–2k more tokens.

- **`modality`:** a Choice over `answer`, `investigation`, `planning`, `implementation`, and `verification`. It feeds only the injected reasoning-scaffold text. Protected modalities are decided locally first and are never offered to Jev.
- **`group::<id>`:** one Noul per optional tool group in `tool-surface-router.js` `GROUPS`, each phrased from that group's purpose.
- **`research_memory`:** one Noul replacing `obsidian-intent.js` `RULES`.

**Labels:**

- **Tool groups:** whether the turn actually called tools from each group (from sessions), plus a reviewed subset.
- **Modality:** reviewed gold.

**Bars (proposed):**

- Per-group recall at least 15 points above the regex at equal or lower false activation.
- Modality agreement with reviewed gold at least 10 points above the regex.
- Shares the Phase 1 request and its failure-rate bar.

**Promotion:** decided per consumer.

- **`tool-surface-router`:** fails open on outage.
- **Scaffold modality text.**
- **`role-router`:** untouched while auto roles are off.

**Exit:** delete the replaced regexes, or record NULL-RESULT and remove the questions. The replaced regexes are the `GROUPS` patterns, the obsidian `RULES`, and the non-protected `task-modality.js` branches.

### Phase 3: Context relevance filter (optional; decide after Phase 1)

**What it does:** asks one Noul per recalled memory or context candidate ("does this contain information needed for the request?"), following the cookbook "Classifying RAG passages" pattern, and drops irrelevant items before injection.

**What it requires:**

- A separate, explicit privacy decision, because memory snippets would leave the machine.
- Scanning every candidate with `memory-content-scanner` first.
- Project memory remains M0/read-only regardless.

**Bars:**

- Injected-context precision above the current lexical selection.
- Fewer injected characters.
- No recall loss on reviewed gold.

### Considered and rejected

- **Jev as Pi's model:** not possible; Jev doesn't generate text or call tools.
- **Replacing Hermes:** Hermes generates suggestion text and curation drafts; Jev only judges. Ranking Hermes candidates with Jev is possible later, but there is no current need.
- **Checking final-answer claims against tool evidence** (the citation-check pattern): this would send tool output. Reconsider only after Phase 3's privacy experience.
- **Jev deciding policy, privacy, approvals, publishing, credential, or destructive operations:** these are security boundaries. Jev's documented weakness to adversarial content rules this out.
- **Counting, date, or numeric judgments:** documented Jev weak spots that belong in code.
- **Adding `@typesafe-ai/sdk` to the harness:** no dependency manifest exists, the API is one endpoint, and the SDK's retries are unwanted in the hot path.

## Workflow track: using Jev in your own projects

No harness code is needed for any of this.

- **Key:** `TYPESAFE_API_KEY` in `~/.bashrc.d/typesafe.sh` (mode 600). Every Pi session started from a terminal inherits it. Never paste the key into chat.
- **Skill:** installed for Pi. It loads automatically when relevant; force it with `/skill:typesafe-ai`.
- **SDK, per app repository:**
  - Node: `@typesafe-ai/sdk` (Node ≥20).
  - Python: `typesafe-sdk` (Python ≥3.10).
  - Both read `TYPESAFE_API_KEY` and keep it server-side.
- **Question design:** prototype in the Playground (<https://console.typesafe.ai/playground>) before writing code.
- **Thresholds:** pin the versioned model once they're tuned. Use `experiment_ledger` to pre-register them, and evaluate on your own data, the same discipline as the harness gates above.

## Cost and latency estimate

| Item | Estimate |
|---|---|
| Phase 1 tokens per turn | ≈ 5k input (prompt ≤ ~500, Choice descriptions ~2.2k, 19 `fits` Nouls ~2.2k, gates) |
| Phase 1 + 2 tokens per turn | ≈ 6–8k input |
| Price | ≈ $0.0003 per turn → ≈ $0.30 per 1,000 turns at $0.042/Mtok |
| Latency | One round trip (cookbook: 0.09–0.31 s; ~0.4 s standalone and 0.8–0.9 s inside Pi here), started at `input` in parallel with existing stages. Jev gets as long as it needs; only a 10 s timeout (TypeSafe's SDK default) counts as a failed request. Reported, not gated. |
| Rate limits | Irrelevant at interactive pace; dynamic per TypeSafe, which is why failure means absence |

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Adversarial text in a prompt or skill description steers a judgment | Advisory only; nothing is unlocked by a Jev answer; protected actions are decided locally first |
| Prompts reach a new third-party processor | Opt-in; scanner-redacted, capped prompt plus public catalog only; written privacy decision; enterprise zero data retention if ever required |
| Outage, rate limiting, or a rotated key | Absence semantics; adapter readiness reports it; no retries in the hot path |
| Alias drift changes answers | Pinned `jev-1.13.0`; answering model logged; re-gate on upgrade |
| Cookbook thresholds don't transfer | Thresholds tuned on user-reviewed gold from our own sessions |
| Weak labels (agent loads ≠ correct loads) | Gates decided on the reviewed subset only |
| Short follow-up turns lack context | Measured variant that adds the previous user prompt |
| Complexity growth | Each phase deletes what it replaces or is removed on NULL-RESULT |

## Verification sequence for implementation

1. Unit tests with a fake HTTP server (`tests/typesafe-client.test.js`, `tests/turn-judgment.test.js`). `scripts/check-all.sh` stays network-free.
2. Privacy fixture tests:
   - secrets in a prompt are redacted before the request;
   - tool output and file contents never appear in the payload;
   - the key never appears in errors, traces, or telemetry.
3. A full `scripts/check-all.sh` pass.
4. Manual `scripts/smoke-typesafe.sh`, gated on the key.
5. A fresh-session RPC probe (`pi --mode rpc --no-session`) confirming the injected line and the `before_agent_start` timing.
6. `experiment_ledger` verdicts recorded for every gate, with the exact model ID and harness source fingerprint.

## Decisions needed from the user before Phase 1

1. Approve sending redacted, capped user prompts plus the public skill/tool catalog to TypeSafe during shadow and on modes.
2. Approve building a reviewed gold set from past sessions, and sending its redacted prompts to TypeSafe for offline evaluation.
3. Confirm the proposed bars, or adjust them, before they are recorded in `experiment_ledger`.

All three were approved on 2026-10-02. For decision 2, rows are sent only after the user has reviewed the whole set.

## Implementation status (2026-10-02)

Built and verified; configuration and the privacy boundary are documented in `docs/runtime-configuration.md#typesafe-jev-turn-judgment`.

| Step | Status |
|---|---|
| Phase 0: client, adapter, readiness, privacy decision, live smoke | Done. `scripts/smoke-typesafe.sh` passed live: `jev-1.13.0` answered a full Phase 1+2 request (1,353 input tokens) in 282 ms. |
| Phase 1 and 2 code paths (`off`/`shadow`/`on`) | Done. Default `off`. A live `on` session injected `long-run` and `handoff` for matching requests in 942 ms and 807 ms (lexical chose nothing and `find-skills`). The skill and tool-group paths were removed on 2026-10-03 (see Promotion or removal); `PI_JEV_TURN_INTENT` remains. |
| Bars pre-registered | Done: `exp-typesafe-jev-turn-intent-v5` (modality and research-memory intent, judgment `typesafe-turn-judgment-v4`) is open. `exp-typesafe-jev-skill-relevance-v4` was closed as no-go and `exp-typesafe-jev-turn-intent-v4` as superseded after their gold gates. Earlier registrations were closed as shelved before any gate ran: `…-phase` when the latency bar was dropped, `…-v2` and `…-v3` when the first and second field sessions led to judgments `typesafe-turn-judgment-v2` and `-v3`. |
| Gold set | Rebuilt 2026-10-03 from 1,648 sessions: 300 rows. Reviewed by the agent at the user's request, blind to Jev output, under a written labeling standard: 283 approved (163 positives, 120 negatives, 199 modality labels), 17 rejected (3 privacy, 2 extension-authored prompts, 5 ties, 7 not determinable from text). 133 of 283 skill labels differ from the agent-behavior weak labels. After the skill and group questions were removed, the set was migrated to modality-only rows (schema 2); the reviewed skill and group labels behind the recorded verdicts are kept in `.pi/typesafe/gold/candidates-v1-skill-group-labels.jsonl`. |
| Offline gold evaluation | Done 2026-10-03 on the test split (130 rows; thresholds tuned on the 153 dev rows). Skills **FAIL**: wrong-suggestion rate 0.36 (lexical 0.92; bar ≤ 0.15), needless 0.15 (lexical 0.27; bar ≤ 0.10). Tool groups **FAIL**: no threshold keeps false activation at or below the regex's 0.02; at 0.5 recall is 0.93 vs 0.60 with false activation 0.15 vs 0.02. Modality **PASS**: 0.84 vs 0.43. Recorded as `gold-offline`, `gold-offline-tool-groups`, and `gold-offline-modality`. Re-run on 2026-10-03 with the modality-only request (judgment v4): modality **PASS** again, 0.837 vs 0.435 on the same 92 test labels (5 of 283 answers changed); 567 instead of 5,860 input tokens per request, p50 307 ms and p95 410 ms; recorded as `gold-offline-modality` on v5. |
| Field shadow, then on | Not started; each needs ≥100 judged turns under judgment v4. |
| Promotion or removal | Done 2026-10-03 (user decision, following the exits above): the Jev skill path (questions, roster, thresholds, `PI_JEV_SKILLS`, the Jev `[L2:skills]` line) and the tool-group questions are removed; lexical skill retrieval and the regex tool groups are the only paths. Modality and research-memory intent continue to the field gates under v5. |
| Phase 3 | Not started; needs its own privacy decision. |

Finding during live verification: every in-session request first timed out because `EntropyPersistenceAdapter.recordSnapshot` re-read the full entropy snapshot history (88 MB, 76,973 lines here) on each observation, blocking Pi's main thread for 4–11 s per turn. It now increments the stored count; this also removes that delay from every turn, with or without Jev. The history itself is bounded only when `runtime-cleanup` apply is run (2,000 lines / 10 MB policy). About 450 ms of main-thread work after the request starts remains inside the measured judgment latency.

Differences from the design above, decided during implementation:

- The judgment module is `src/typesafe-turn-judgment.js`, and turn records are a local file (`~/.pi/agent/typesafe/turns.jsonl`, shared by every project after the first field session showed per-project files hid records from the report) rather than extension telemetry, because they carry per-turn agreement fields the telemetry schema does not have.
- Phase 2 covers the Obsidian research-memory consumer as well as tool-surface routing and scaffold modality.
- The request is started at `input`, not `before_agent_start`, so tool-surface routing (an `input` handler) can use it. Shadow mode adds no turn latency.
- When the intent judgment is unavailable in `on` mode, the scaffold uses a new neutral `unclassified` modality instead of a guessed label.
- The gold set excludes `/` invocations and turns whose skill reads include skills hidden from the model, and splits rows deterministically into dev (threshold tuning) and test (bar verdicts).
- The SKILL.md rerank variant is implemented as an evaluation helper but not run: it would send skill bodies, which needs a separate approval.
- Subagent sessions are never judged, because their prompts are written by the parent model rather than the user. Field gates count interactive sessions only.
- No speed goal (user decision, 2026-10-02): the 1.5 s deadline, `PI_JEV_DEADLINE_MS`, and the 600 ms p95 latency bar were removed before any data was collected. In `on` mode each turn waits for Jev; a request counts as failed only after TypeSafe's SDK default timeout of 10 s. That bound stays because Pi cannot cancel a turn while it waits before the agent starts.
- After the first field session (flyingbird, 2026-10-02; 6 judged turns, all `ok` in 439–553 ms), judgment `typesafe-turn-judgment-v2` adds a floor on the skill Choice confidence, because a context-free "Implement the plan in full." suggested `hyperframes` at confidence 0.17, and scopes the `ci` tool-group description to remote CI and pull requests, because "...or verification" made it fire for a local playtest. Field gates count only records made under the judgment being evaluated.
- After the second field session (flyingbird after a restart, 2026-10-02; 2 judged turns, both `ok`), judgment `typesafe-turn-judgment-v3` scopes the `memory` tool-group description to Pi's memory system, because "Save the plan to a file…" activated it (0.61). The same session showed that the tool surface failed open, switching on every optional tool, for the post-compaction "carry on" prompt, which TypeSafe deliberately does not judge. Extension-sent prompts now keep the active tools, and other unjudged prompts use the local classifier; only a failed judgment fails open.
- The 2026-10-03 field sessions showed that every turn-start change to the tool surface invalidated the Anthropic prompt cache: Pi rebuilds the system prompt (its tool list) and the tool definitions whenever the active set changes. The tool surface now only grows within a session. Replaying the Anthropic sessions from 2026-09-20 on, this avoids 20 of 29 change-caused full-context rewrites (about $16 over 13 sessions) for about $1.40 of extra cached tool tokens; keeping every optional tool on would avoid all 29 but add about $21 of tool tokens.
- The scaffold originally reached the model only on a session's first turn, so a judged modality on later turns was never seen. Fixed after the first field session: the scaffold section is re-sent whenever the modality changes.

## Completion definition

**Phase 1** is complete when all of the following hold:

- a PASS (or FAIL/NULL-RESULT) verdict is recorded with the exact model and source fingerprint;
- exactly one skill-relevance path remains in the code;
- `docs/runtime-configuration.md` documents the shipped behavior and privacy boundary;
- `scripts/check-all.sh` passes.

**The integration** is complete when Phases 1 and 2 each have a recorded verdict and every promoted judgment has replaced, rather than duplicated, the logic it superseded.

## Primary references

- **Harness:**
  - `src/skill-synthesis.js`
  - `.pi/extensions/reasoning-runtime/index.ts`
  - `src/task-modality.js`
  - `src/tool-surface-router.js`
  - `extensions/tool-surface-router/index.ts`
  - `src/obsidian-intent.js`
  - `src/role-router.js`
  - `src/integration-boundary.js`
  - `docs/integration-boundary.md`
  - `docs/runtime-configuration.md`
  - `scripts/smoke-hermes-advisory.sh`
  - `scripts/report-reviewed-gold-evidence.js`
- **TypeSafe:**
  - <https://docs.typesafe.ai/introduction/coding-agents.md>
  - <https://docs.typesafe.ai/models.md>
  - <https://docs.typesafe.ai/api.md>
  - <https://docs.typesafe.ai/confidence.md>
  - <https://docs.typesafe.ai/model-jaggedness/jev-1.13.md>
  - <https://docs.typesafe.ai/cookbooks/skill_suggestion.md>
  - <https://docs.typesafe.ai/patterns/fan-out.md>
  - <https://docs.typesafe.ai/cookbooks/classifying_rag_passages.md>
  - <https://docs.typesafe.ai/sdk/javascript.md>
