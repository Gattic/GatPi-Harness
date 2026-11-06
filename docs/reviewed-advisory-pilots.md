# Evidence-driven advisory automation

## Current protocol: machine verification v2

The goal is automated, reproducible decisions—not human outcome approval. The
verification workflow now uses `exp-machine-verification-advisory-v2`. It neither
requests human reviews nor accepts model self-ratings. The former
`/skill-pilot-review` and `/entropy-pilot-review` commands are retired.

This is a deliberately narrow first automation layer. Its endpoint is **delivery
of execution evidence for frozen repository checks**, not general code quality,
subjective helpfulness, semantic source relevance, or arbitrary claim truth.
Those concepts must not be inferred from command success or invocation counts.

## End-to-end behavior

1. A genuine interactive verification request enrolls before any exposure. It
   begins `Verify`, `Check`, or `Review` (optional `Please`), mentions a change,
   patch, or diff, and does not request implementation, repair, publication, or
   pilot administration. Extension-authored continuations and headless fixtures
   do not enroll.
2. The harness freezes the initial tree fingerprint and repository-defined checks
   inferred for the current changed files. Unrelated quick-test fallbacks are
   excluded. The repository's full verification command can cover the frozen
   baseline. An absent executable oracle produces **inconclusive**, not approval.
3. The session is assigned to control or candidate. Both arms receive identical
   frozen-check instructions. Only candidate receives the optional exact-version
   `change-verify` reminder. There is at most one enrolled case per session.
4. Run the frozen checks through `verification_center`, using the supplied command
   specifications or the repository full check. The runtime consumes the actual
   tool result, compares it with the persisted Verification Center proof, verifies
   executed-command provenance, time window, noncached exit codes, coverage, and
   unchanged tree, and automatically writes a compact Evidence Binder packet.
   **No manual capture or outcome form is needed for this protocol.**
5. On settlement the machine assessment is fixed. A complete, honestly failing
   verifier run is a resolved verification task, with `verificationResult: fail`.
   It is not a passing-code claim. Missing, stale, interrupted, partial, timed-out,
   or mismatched evidence remains inconclusive and stays in the assigned denominator.
   A proven source-tree mutation stops the verification-only cohort.
6. At the fixed terminal horizon, the harness automatically decides whether the
   exact advisory reminder may be enabled. There is no human decision gate.

Example eligible request:

> Verify the changes in the current diff. Leave source files unchanged and report
> the exact verifier results and limitations.

Use genuinely needed tasks; do not rerun completed work just to harvest samples.
The harness's fixed baseline may be broader than a manually selected spot check;
this is necessary to prevent cherry-picking easy checks after treatment exposure.

## Statistical and action boundaries

- Fixed horizon: 120 assigned cases or 45 days; no repeated-peeking promotion.
- At least 30 cases and 30 independent sessions per arm, with 14 observed calendar
  days and a 14-day span. All assigned cases must be settled. Inconclusive cases
  count as zero evidence delivery, not missing samples to discard.
- Candidate reminders must actually have been delivered. Measurement overflow
  blocks qualification. Model/thinking, implementation, configuration, protocol,
  and installed skill identity must match their pins.
- Candidate delivery-rate lower Wilson bound minus control upper Wilson bound
  must be at least 0.05. This conservative separated-interval rule replaces the
  old comparison of two lower bounds.
- Each p95 latency, model-call, tool-call, and model-visible-context cost must be
  at most 110% of control. Private reasoning and old context are not counted.
- No observed verifier-policy violations. This is a scoped invariant, **not** a
  claim that a generic privacy scan proves absence of all privacy problems.
- Before enabling the reminder, registered machine packets and the full proof
  digests are revalidated, with a 16 MiB total proof-read budget. Missing or changed
  artifacts block the decision; stored `pass` flags alone cannot grant authority.

The only newly permitted action is **enable the exact advisory reminder for
eligible verification tasks**. It changes neither skill approvals/ranking nor
model/tool permissions. Drift or `/skill-pilot-stop` disables it. Post-decision
reminders are not mixed back into the randomized cohort.

Automatic skill synthesis, code repair, publication, general routing, retrieval
mode promotion, canonical memory writes, and entropy interventions are outside
this action contract. They remain disabled or governed by their existing gates.
They require their own executable oracles and causal evidence—not a human rubber
stamp, and not reuse of this delivery-completeness endpoint.

## Initialization and status

Preregister the machine experiment before initializing. Once pinned source changes
are complete:

```sh
node scripts/manage-advisory-pilots.js init
node scripts/manage-advisory-pilots.js status
node scripts/manage-advisory-pilots.js record-verdicts
```

Then `/reload` to load both the reasoning runtime and Verification Center changes.
A loaded pre-v2 extension cannot produce v2 executed-command provenance.

```text
/skill-pilot-status
/skill-pilot-stop
```

Status includes machine assessments and their Evidence Binder IDs,
`humanReviewRequired: false`, `automaticAssessment: true`, and the separately
reported `automaticReminderEnabled` decision. Insufficient evidence means **no
activation**, not a request for human labels. Status reads do not reset cohorts.
A changed pin requires a new explicitly preregistered cohort, not silent mixing.

Status and new verification turns name the current pause in `blocked`. If the
pinned skill file is missing (for example archived or uninstalled), the reason
is `provenance-file-missing`. Changed bytes, configuration, implementation or
approvals produce `source-or-configuration-changed`. Both pauses leave the pin
unchanged and enroll nothing. Restoring the exact pinned bytes resumes
collection only if nothing else has drifted. `init` refuses to enroll a missing
provenance file.

## Preserved historical evidence

- `.pi/advisory-skill-pilot/pilot.json` is the original human-review v1 cohort.
  Its cases and labels are not rewritten or imported into the new experiment.
- `.pi/advisory-skill-pilot/machine-pilot.json` holds v2 machine assessments,
  bounded to 120 cases and 2 MiB, with private locked storage. Only hashes, IDs,
  measurements and closed machine-status values are retained—not prompt/output
  bodies, raw session identifiers, or private reasoning.
- `evidence_827feab79ade8d1b` remains the original failing resume-integrity proof.
  The repair's fresh regression evidence does not rewrite that historical result.
- Entropy and extension usefulness reports are returned under `legacyDiagnostics`.
  Their subjective labels are not silently replaced by tool-success heuristics.
  They are not prerequisites for this bounded verification automation.
- The 30-task retrieval candidate packet remains unapproved historical preparation.
  No human gold labels were manufactured, no paid paired evaluation was launched,
  and semantic retrieval quality is not inferred from this experiment.

The compounding report exposes the new machine pilot separately. Its delivery
endpoint cannot satisfy the old C3/C5 quality/privacy claims or authorize M1+.

## Resume-integrity regression

`scripts/run-code-context-test-selection-benchmark.js` binds the saved
`contractHash`, `cohortKey`, and `goldManifestHash` to the freshly computed plan
before processing any resumed rows or writing output. The public-CLI regression
checks foreign cohort identifiers, foreign gold identifiers, both together,
changed contracts, mixed/duplicate rows, invalid environments, and `--no-resume`.
Rejection must preserve corpus, manifest, and output bytes exactly. A valid
completed resume still succeeds without changing its result rows.
