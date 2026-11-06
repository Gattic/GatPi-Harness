# Skill bundle migration — 2026-10-24

## Source and installation contract

The user requested replacement of all current skills with `skill_bundle.zip`,
backup of every old skill, and only new-standard adaptations where gaps justify
one. The supplied Skill Foundry library is maintained under `skills/`:

- 101 invocable directories: `skills/skills/<name>/SKILL.md`.
- Editable source: `skills/catalog.json`; generated catalog: `skills/CATALOG.md`.
- 101 evaluation designs: `skills/evals/`; these are **NOT TESTED** agent cases.
- Standards, references, scripts, provenance, license, and offline tests are
  included, not just the SKILL.md entrypoints.
- Input ZIP SHA-256:
  `c0dbaf0df1da4b562acdf08a8b6ff9286d484bf26269fd0f11147cb11e618312`.
- The initial installation preserved all 234 supplied files byte-for-byte and
  added only `skills/skills/managed-skills.txt`, the sorted 101-name installation
  manifest. The end-to-end follow-up below subsequently patches one helper and
  adds a regression module; the original ZIP and legacy backups remain intact.
  No old skill is retained as an alias or fallback.

Preparation and qualification used `feat/skill-bundle-refresh` at
`~/GatPi-Harness/.worktrees/skill-bundle-refresh`. During those stages,
the primary checkout, other worktrees, existing research evidence, and the input
ZIP were not modified. The initial replacement made no provider requests or
global-settings edits, and no commit, merge or push had been performed then.
Subsequent user-authorized live checks and the local integration decision are
recorded separately below. After integration, normal refresh can run from the
primary checkout; the task worktree and legacy backup remain available.

## Backup and restore

Full pre-migration snapshots are stored outside every skill discovery location:

```text
~/.local/share/pi-harness/skill-backups/20261024T190051Z-skill-bundle-refresh/
  legacy-skills.tar.gz
  manifest.json
```

Archive SHA-256:
`88c7f508548de1fcf4c33d2e95f1507829b7ab373b95cbfb18aae569228cb506`.

| Archive root | Original location | Old skills |
|---|---|---:|
| `repository-skills` | `~/GatPi-Harness/skills` | 23 |
| `agents-skills` | `~/.agents/skills` | 33 |
| `claude-skills` | `~/.claude/skills` | 32 |
| `pi-skills` | `~/.pi/agent/skills` | 1 directory + shared `find-skills` symlink |

There are 34 distinct old skill names across these locations. The backup includes
all supporting files, hidden installer manifests, directory/file modes, and the
original symlink, not merely the skill bodies. `manifest.json` maps archive roots
to original paths and records each file's SHA-256, size, mode, and symlink target.
A temporary extraction was compared against all four live source trees before
any replacement: every entry matched. The archive is approximately 4.81 MiB,
mode 0600 in a mode-0700 directory. Retain this single snapshot; no historical
backups or research evidence were deleted. Temporary owned test fixtures are
cleaned by the tests. Migration backup/staging allowance: 32 MiB each.

To inspect or restore, first verify the archive checksum against the value above,
extract into an empty private directory, and compare it with `manifest.json`:

```bash
backup="$HOME/.local/share/pi-harness/skill-backups/20261024T190051Z-skill-bundle-refresh"
sha256sum "$backup/legacy-skills.tar.gz"
restore="$(mktemp -d)"
tar -xzf "$backup/legacy-skills.tar.gz" -C "$restore"
```

For an intentional rollback, stop skill consumers, move each current destination
out of discovery to a new safety backup, then copy the corresponding extracted
root to the **original destination name** with `cp -a`. Do not copy an extracted
root inside an existing `skills/` directory. Restore both `agents-skills` and
`pi-skills` to their original locations so the relative `find-skills` link works.
Repository rollback belongs in the task worktree; do not overwrite unrelated work
in main or another branch. Keep the archive intact after restoration.

## Coverage decisions

The replacement installs the 101 supplied skills unchanged. The following is a
routing/coverage assessment, **not** proof of equivalent runtime behavior. Old
skills with unique mechanisms stay available in the backup for selective
adaptation; none is silently reinstalled. Broad topical overlap is not treated as
feature parity.

| Old skill(s) | New lead/supporting skills | Decision / remaining gap |
|---|---|---|
| `repo-orient` | `codebase-onboarding`, `technical-documentation-investigation` | Covered task intent; host repository-discovery rules still apply. |
| `api-design` | `api-contract-engineering`, `domain-driven-architecture` | Covered intent. |
| `code-review` | `code-review-evidence`, `secure-code-review` | Covered intent. |
| `security` | `security-threat-model`, `secure-code-review`, `privacy-data-minimization`, `secrets-iam-hardening` | Split among narrower new owners. |
| `observability` | `observability-slo-design` | Covered intent. |
| `perf` | `performance-profiling`, `web-performance-core-vitals` | Covered intent; use actual target-language tools. |
| `test-design` | `test-driven-implementation`, `application-fuzz-testing`, `browser-qa-cross-device` | Core testing covered; standalone cross-language strategy remains a possible reference addition. |
| `build` | `ci-release-engineering`, `systematic-debugging`, `cpp-modern-systems`, `python-production-engineering` | Partial coverage; restored (see **Restored legacy skills**). |
| `concurrency`, `networking`, `numerics` | `cpp-modern-systems`, `api-contract-engineering`, `quantitative-modeling` | Broad overlap only; C++ memory-model, Linux async-I/O, SIMD/numerical recipes are adaptation candidates. |
| `audit`, `refactor` | `code-review-evidence`, `domain-driven-architecture`, `systematic-debugging` | Bounded subsystem audit and behavior-preserving refactor are distinct residual workflows. |
| `subsystem-plan`, `execute-plan` | `requirements-to-roadmap`, `implementation-plan`, `test-driven-implementation`, `multi-agent-delegation` | Planning/implementation coverage, not exact parity. Stable full-plan outcome IDs and continuation rules remain required by host policy. |
| `durable-bug-hunt` | `systematic-debugging` | Partial coverage; restored. Existing open debug threads must not be retried or rewritten. |
| `change-verify` | `acceptance-quality-release`, `code-review-evidence` | Partial coverage; restored. |
| `experiment-gate-lifecycle` | `experiment-design-analysis`, `generative-model-evaluation` | Partial coverage; restored. Existing experiment bars remain unchanged. |
| `research-framework-design` | `evidence-led-research`, `quantitative-modeling`, `systematic-literature-review` | Evidence/modeling overlap; novel competing-formulation derivations are not a direct replacement. |
| `frontier-math-proof-engineering` | `quantitative-modeling`, `evidence-led-research` | Formal proof-assistant/certificate/claim-ledger workflow is an explicit gap. |
| `long-run` | No exact replacement | Restored; heavily used (see usage evidence below). |
| `git-checkpoint` | `ci-release-engineering` (adjacent only) | Restored. Commit permission is still separate. |
| `handoff` | Restored `handoff` (local addition) | Generic per-artifact handoff sections did not replace it; restored and adapted below. |
| `find-skills` | `task-skill-router`, `skill-factory`, `source-license-provenance` | Local selection/authoring covered; external registry discovery is not equivalent and is not needed for this replacement. |
| `typesafe-ai` | `secure-llm-rag-engineering`, `generative-model-evaluation` (adjacent only) | Restored with its third-party MIT license. |
| `hyperframes`, `hyperframes-core`, `hyperframes-cli`, `hyperframes-animation`, `hyperframes-keyframes`, `hyperframes-audio`, `hyperframes-creative`, `hyperframes-registry`, `media-use` | `text-to-video-production`, `video-storyboard-shotlist`, `video-edit-color-delivery`, `audio-design-mix`, image/rights/voice skills | General media intent covered. HyperFrames HTML timing, seek-safe timelines, CLI/registry and media-ledger adapters are **not** replaced by generic video instructions. All old references/scripts are archived; no framework default is carried forward. |

### Adaptation quality gate

For a future gap-specific task, prefer a narrow reference in the matching new
skill over another broad duplicate. Read the archived implementation, check its
license/provenance and current API docs, then use the new `skill-factory` workflow
and `standards/authoring-standard.md`. Edit `catalog.json`, regenerate bodies and
evals, and synchronize the managed manifest if names change. Require matching
activation/anti-activation criteria, concrete inputs/artifacts, failure handling,
trust boundaries, an observable acceptance gate, and at least three positive,
two negative, and adversarial/blocked eval designs. Run static/offline checks and
record real host routing plus a representative task before claiming an adaptation
is host-tested or production-quality. Do not promote archived text merely because
it used to work. This migration makes no such quality or performance claim.

## Maintenance and acceptance

From this task worktree:

```bash
node tests/generic-agent-skills.test.js
node tests/install-agent-skills.test.js
node tests/pi-harness-refresh-script.test.js
scripts/install-agent-skills.sh --list
scripts/install-agent-skills.sh --dry-run
scripts/install-agent-skills.sh --agents-only --dry-run
```

The installer reconciles Pi's user skill root (`~/.pi/agent/skills`) before
installing: Pi keys skills by their declared name and loads that root ahead of
the shared catalog, so a skill anywhere under that root declaring a managed name
would shadow the managed copy. Such a copy is moved to a timestamped backup
under `~/.pi/agent/backups/skills-shadowed`, preserving its relative path,
instead of silently winning, and `--agents-only` skips the Claude destination
when only Pi is in scope.

The generic test runs the supplied static checker and four offline package tests,
and checks byte-identical regeneration for every catalog body and eval design
(101 supplied plus the restored local skills below) and both generated inventories. Installer tests exercise exact reconciliation,
hash-identical supporting files, dry-run behavior, old managed-name pruning, and
preservation of unrelated user content. The unified refresh fixture follows the
new `skills/skills/` layout.

Normal future refresh uses `scripts/install-agent-skills.sh` (or
`scripts/pi-harness-refresh.sh --skills`). Its conservative unmanaged-entry policy
is unchanged. This **one-time user-authorized full replacement** additionally
archives/removes unmanaged legacy skills, including HyperFrames and the Pi-local
TypeSafe/find-skills entries. The resulting shared and Claude install roots each
contain exactly the 101 new skills. Pi's dedicated root is empty: it discovers the
shared `~/.agents/skills` catalog without duplicate names. Use `/reload` or start a
new Pi session to refresh the current session's advertised skill list.

### Observed migration results

| Gate | Result |
|---|---|
| ZIP CRC, extraction boundaries and full input parity | PASS: 234 files, 101 skills, unchanged bytes |
| Full legacy archive extraction/inventory comparison | PASS: all four roots, file hashes/modes and symlink targets |
| `node tests/generic-agent-skills.test.js` | PASS: static checker, four offline package tests and all generated-file fingerprints |
| `node tests/install-agent-skills.test.js` | PASS, including a new locale-ordering regression |
| `node tests/pi-harness-refresh-script.test.js` | PASS |
| Native installed Pi `DefaultResourceLoader` | PASS: exactly 101 shared skills, zero diagnostics/collisions; in-memory settings, no extensions or agent/provider session |
| Final installed trees/manifests | PASS: exact 101-name inventory, file hashes and modes match source in both destinations; Pi-local root empty |
| Worktree-scoped `git diff --check` | PASS for tracked diff; supplied new files additionally checked against ZIP bytes |

The pre-swap guard initially caught a locale-only ordering difference:
`en_US.UTF-8` sorts `codebase-onboarding` and `code-review-evidence` differently
from the canonical byte order. No live root changed on that failed attempt.
The installer now fixes `LC_ALL=C`; the added regression and subsequent full
staging guard passed without changing skill contents or weakening the check.
The attempt and resolution are recorded in the task worktree's
`.pi/debug-ledger/skill-installer-locale-ordering-differs.json` using the same
`src/debug-ledger.js` backend as `debug_ledger` (the tool itself was not exposed
in this session). No pre-existing debug thread or experiment was retried.

Machine-local evidence is in this worktree's `.pi/skill-migration-install.json`,
`.pi/skill-native-discovery.json`, `.pi/skill-install-staging.log`, and
`.pi/test-runner/raw/`. Temporary retired install roots were removed only after
matching the unchanged archive inventory and passing native discovery. The
permanent backup remains intact. The session-root-only `gitverify` tool cannot
target a nested worktree; the repository-defined focused checks and Git diff
check above were explicitly scoped to this worktree instead. No full application
suite or broad repository-readiness claim is made for this skill migration.

Static/offline validation, native local discovery, installed-file parity, and
backup restoration are migration gates. At the initial replacement boundary,
real model routing, adversarial efficacy, domain-task success, Blender renders,
network audits, and quality/performance improvements were **NOT TESTED**. No
historical experiment was run or relabeled.

## Fresh-session runtime loading smoke — 2026-10-24

**Result: PASS for the bounded loading smoke; no runtime failures observed.**
Five representative migrated skills were each invoked once in a separate fresh
Pi process. The live model read each installed `SKILL.md` and every supporting
file listed below through the actual native `read` tool. The Python helpers were
**read as source, not executed**.

| Skill | Supporting files successfully delivered by `read` | Runtime | Result |
|---|---|---:|---|
| `skill-factory` | `references/evaluation-protocol.md` | 11.260 s | PASS |
| `security-threat-model` | `references/threat-register.md` | 10.990 s | PASS |
| `comfyui-graph-engineering` | `references/graph-contract.md` | 12.222 s | PASS |
| `seo-technical-audit` | `references/issue-schema.md`, `scripts/site_audit.py` | 15.951 s | PASS |
| `procedural-3d-blender` | `references/quality.md`, `scripts/build_product_stage.py` | 13.511 s | PASS |

### Host, boundaries and observed checks

- Host: installed Pi **1.1.0**, native CLI entrypoint
  `~/pi/packages/coding-agent/dist/bundle/cli.js`.
- Selected and observed provider/model: `openai-codex/gpt-6.1-sol` in all five
  cases; requested thinking `off`. No provider/account/model fallback.
- Each invocation used native `/skill:<name>` expansion, default discovery of
  `~/.agents/skills`, `--mode json --no-session`, and only the `read` tool.
  Extensions, MCP, context files, prompt templates and themes were disabled.
  This is isolated core skill loading, **not** a full harness-extension smoke.
- Process working directory was the owned evidence fixture. Its temporary
  `.pi/settings.json` disabled agent retries and provider retries; `--approve`
  applied that fixture configuration for the process only. `--offline` suppressed
  automatic background network activity, not the explicitly requested model
  calls. Normal configured authentication was used; no auth repair, credential
  inspection, or credential values were part of the evidence.
- All five session-header IDs were distinct from one another and the parent
  session. Each native command expanded the installed skill body. All five
  processes exited **0**, reached non-aborted `agent_settled`, and returned the
  requested JSON acknowledgment with the correct first line for every file.
- Independent inspection correlated each `tool_execution_start` path with its
  successful `tool_execution_end` and compared the **complete returned text**
  with frozen installed bytes: **12/12 complete reads**, comprising five skill
  entrypoints and **7/7 supporting files**. This is not a file-existence-only or
  model-self-report pass. No unexpected reads/tools, missing/truncated read
  results, invalid JSONL, stderr diagnostics, provider errors, retries, timeouts
  or output-limit failures were observed.
- Source/installation fingerprints for selected files stayed unchanged. All 234
  supplied bundle files still match the original ZIP byte-for-byte. No skill,
  helper, installer, or other product implementation was repaired during this
  verification follow-up.

### Budget and retained evidence

Managed job `job-mvms4xlo-7e4f` ran from approximately **19:16:17 to 19:17:21 UTC**
and exited **0**. The five cases totaled 63.934 seconds of process runtime;
provider-reported model cost was **$0.1560104** (accounting estimate, not a billing
assertion). Bounds were five processes, 90 seconds and 512 KiB captured output
per case, a 16 MiB evidence allowance, and a $2 reported-cost stop threshold (not
a hard billing cap). No retries or extra provider canaries were run. New retained
evidence is approximately 137 KiB; no historical evidence was deleted.

Evidence is retained in this task worktree at:

```text
.pi/skill-smoke-20261024-01/
  protocol.json               # frozen cases, permissions, budgets and file hashes
  run.cjs                     # bounded driver using existing runProcessGroup helper
  <skill>.input.json          # exact native command, prompt and cwd
  <skill>.events.json         # session/tool/public-final-output evidence
  <skill>.result.json         # per-case process and acceptance observations
  results.json                # all five outcomes and reported usage/cost
  inspection.json             # independent tool-result/source-byte reconciliation
  evidence-sha256.json        # retained-file integrity manifest
  migration-before.md         # report baseline for this follow-up's diff
  fixture/.pi/settings.json   # owned per-process retry configuration
```

Thinking/private-reasoning blocks and deltas were not retained. Inputs and read
outputs are the synthetic smoke request and public migrated skill files, not
personal task content. Protocol SHA-256:
`16e7fc3403390a82d6d48c5e66b58ab9d6dcd6776ae92fd872b778a88baf3fb8`.
Results SHA-256:
`1982dfa5e6380b7474346c6f0811a6e216ff09e337807957b12e1fa7081fab1b`.

To inspect or deliberately reproduce later, use the retained commands and frozen
protocol; `node .pi/skill-smoke-20261024-01/run.cjs` would make new live model
requests and overwrite this run's result files, so do **not** rerun it in place.
Use a new evidence directory and a new bounded run if another test is authorized.

### Failure reconciliation and limitations

**Observed runtime failures: none in these five attempts.** No existing debug
thread or pre-registered experiment was retried, repaired, closed or relabeled.
The absence of a failure in this smoke does not resolve older provider/rate-limit
issues in other sessions.

These are forced-invocation, read-only **loading** cases, not the packaged
positive/negative/adversarial routing suites, a baseline comparison, or a
representative execution of the five domain workflows. The remaining 96 skills
were not live-smoked. Automatic skill selection, generated artifacts, SEO helper
execution, ComfyUI requests, Blender imports/renders, security assessment quality,
adversarial robustness, and efficacy/performance improvements remain
**NOT TESTED** here. Neither the whole pack nor any individual skill is promoted
to `HOST_TESTED` or `PRODUCTION_VALIDATED` by this loading-only observation.

## End-to-end tasks, helper regressions and rendering — 2026-10-24

**Initial E2E cohort result: PARTIAL.** The real SEO helper task passes after a
confirmed fix, and a real chart was rendered and inspected. In this cohort,
native terminal acceptance was incomplete for security/chart because of the
frozen event-output cap; Blender rendering was blocked by the missing runtime.
These historical verdicts remain unchanged. The separate bounded continuation
below records later observations without replacing this cohort or loading smoke.

### Executed task matrix

| Task / attempt | Actual artifacts or execution | Observed verdict |
|---|---|---|
| `seo-before` | Original installed helper on three synthetic HTML pages; 26.273 s | FAIL: helper exited 1 with `AttributeError`; Pi itself exited 0 while correctly reporting task failure. No fabricated report. |
| `seo-after` | Repaired installed helper; `audit.json`, six-row `findings.json`, prioritized `summary.md`; 71.548 s | PASS for offline audit: helper exit 0, fresh session settled and exited 0; exact three pages, six signal types, eight page-level signals. |
| `security` | Three-boundary threat register and DFD; 98.067 s | INCOMPLETE: 1 MiB JSON capture cap fired before backlog/terminal settlement. Partial files retained. |
| `security-compact` | Same boundaries/required fields with compact-prose request; 91.968 s | INCOMPLETE: same cap fired again. No third attempt. The partial 4,772-byte register also exceeded the requested 4 KiB compact target before validation finished. |
| `chart` | Actual SEO report → executed Matplotlib renderer → PNG, editable SVG, CSV, methods/source hash, alt-text and source; 50.075 s | Artifact checks PASS; native-session acceptance INCOMPLETE: capture cap fired before observed `agent_settled`, despite the final assistant reply and complete files. One captured JSON record was truncated. |
| `procedural-3d-blender` | Dependency preflight only | BLOCKED: no `blender` executable or `bpy` module. No installation/download, fake CPython render, geometry validation or Blender output claimed. |

The site fixture has one clean page with intentional `alt=""`, a catalog page
with missing alt, and a broken page with duplicate title, missing metadata/H1/lang
and a valueless robots attribute. Independent checks matched the actual report's
counts and every finding's affected-page list to the HTML-derived evidence.
Observed synthetic markup problems are not Google indexing failures; remediation,
deployment, live crawling and Search Console remain outside this task.

### Confirmed helper defect and regression repair

Python `HTMLParser` returns `None` for a present, valueless attribute. The helper
stored that as `meta_robots`, then called `.lower()` and crashed; valueless
`description` also leaked JSON null instead of the established string value.
The fix normalizes metadata once at the parser boundary:

```python
self.meta[key] = d.get('content') or ''
```

This is an expected malformed-input case for an auditor, not an exception to
suppress. No retries, broad exception handler or alternate helper was added.
`skills/tests/test_helpers.py` exercises the **real CLI**, without mocks/network:

1. Valueless robots content must not crash or invent `noindex`.
2. Valueless description must be the empty-string JSON representation.
3. Exact three-page duplicate/alt/metadata findings, preserving decorative alt.
4. Real `noindex` and missing-alt signals remain visible.
5. Offline page-budget enforcement and invalid-budget rejection.

Before the fix: **3 failed / 2 passed**. `test_runner rerunFailures` after the
fix: **5/5 passed**. The existing repository wrapper
`node tests/generic-agent-skills.test.js` then passed the 101-skill static contract,
all generated-file fingerprints, and **9/9 offline package/helper tests**.
Focused Python compiler diagnostics were clean. Test fixtures clean themselves;
only newly owned compiler/font-cache files were removed, not historical evidence.

Only `skills/skills/seo-technical-audit/scripts/site_audit.py` differs from the
234 original supplied files; the other **233 supplied files are unchanged**.
The new regression module is additional to the managed manifest. Existing
installation reconciliation copied the repaired helper to both `~/.agents/skills`
and `~/.claude/skills`; source and installed bytes were compared directly.
Original helper SHA-256:
`935d24ac013dc775e3489f872224c070cf7311fc8edfbee3675f5d6ee58bb2c6`.
Repaired helper SHA-256:
`44b49e8e9ce3a75d79660513ea1feaf22528f1b0f71591513c6c58d1921bfacf`.
The original helper and first failing report/log remain preserved. The durable
`seo-helper-crashes-on-valueless` thread is resolved with before/after evidence;
no unrelated debug thread was changed. As before, the tool was not exposed and
its unchanged `src/debug-ledger.js` backend recorded these attempts.

### Actual rendered artifact and independent inspection

The `data-visualization-design` task used a **test-owned** Matplotlib 3.10.9/Agg
renderer, not a nonexistent bundled rendering helper. The fresh session copied
and executed that renderer, produced the artifacts below, and wrote alternative
text. The parent independently opened the actual PNG with the image read tool:
all six labels and values **2, 2, 1, 1, 1, 1** are legible, the baseline is zero,
there is no clipping, and the synthetic/source/overlapping-count caveats are
visible. Pillow 12.3.0 confirmed **1200×800** pixels; SVG labels/value annotations,
CSV rows, methods JSON and source digest matched the real helper report exactly.

```text
.pi/skill-e2e-20261024-01/chart/
  chart.png        # actual inspected render
  chart.svg        # editable text labels
  chart.py         # executed rerender source, copied from owned fixture
  counts.csv       # exact issue,count data-table fallback
  methods.json     # source SHA-256, rows, zero baseline, synthetic designation
  alt-text.md      # takeaway, caveats, table reference and rerender command
```

PNG SHA-256:
`7a533c76f0f1119c78f3786679ac15df664bf689af6acc8d081a1694204c40f2`.
Successful pixels/data do **not** override the native stream's capture failure.
The chart artifact passes its scoped checks; a fully settled native run is not
claimed. Likewise, threat-model partial JSON is not a completed security task or
proof of any real security control.

### Bounds, failures retained and next resumable work

All **five of five** allocated fresh Pi processes were used. They expanded native
skills with default installed discovery, the same `openai-codex/gpt-6.1-sol`,
requested thinking `off`, synthetic fixtures and native `read/write/bash` tools.
Extensions, MCP and ambient context/templates were disabled. Fixture-only retry
settings stayed disabled. No provider error was captured, but incomplete streams
cannot establish a complete terminal verdict or clear older provider incidents.

The frozen bounds were 180 s / 1 MiB captured JSON output per process, 16 MiB
artifacts per case, 64 MiB verification-family evidence, and a $3 reported-cost
stop threshold (not a billing cap). Neither output/time/storage limits nor the
five-process allowance were increased. The compact-security follow-up altered
presentation, not the required boundary/control/owner/verification gates, and
failed to remove the capture failure. **No further live calls were launched.**
Captured completed-message cost is **$0.3809888**; interrupted turns may have
unreported usage, so this is incomplete accounting, not final billing. Retained
E2E and earlier loading-smoke evidence together remain below 2 MiB; the legacy
backup is separately preserved unchanged.

Machine-local evidence under `.pi/skill-e2e-20261024-01/` includes the frozen
`protocol.json`, exact `*.input.json`, public `*.events.json`, process
`*.runtime.json`, original helper, before/after regression logs, bundle-test log,
`seo-inspection.json`, `chart-inspection.json`, case outputs, and `results.json`.
`evidence-sha256.json` binds the retained files. Private thinking/reasoning blocks
were not retained. An initial ad-hoc evidence check assumed a scalar finding path;
inspection corrected it to verify the artifact's exact affected-page lists, not
to alter the skill's output or weaken coverage.

The shared capture-limit thread `skill-e2e-security-output-exceeded` remains open;
its failed compact attempt and independent chart observation are recorded, not
marked fixed. This is a verification execution limit, not a proven skill-source
or provider defect; no unrelated Pi protocol repair was attempted.

**Remaining required observations at this cohort's close:** complete native
security artifacts/settlement, observe a fully settled chart session, and run the
Blender helper in a supplied Blender runtime. A new approved bounded run
contract/collector is needed before more live attempts; supplying/installing
Blender is a separate dependency
boundary. Do not rerun in this evidence directory or overwrite the preserved
failures. No automatic continuation is registered. Full-library routing,
adversarial efficacy, production security, SEO impact, 3D geometry/render quality,
and broad skill-quality/performance improvements remain unverified.

## Offline capture qualification — 2026-10-24

**Offline checks PASS; overall acceptance remains PARTIAL.** No Pi session,
SDK, provider/auth check, live smoke script, render or dependency installation
was run for this increment. The original **5/5 live allocation is still exhausted**.

`tests/extension-smoke-runner.test.js` now runs twelve synthetic Node-child
scenarios through the real process collector: complete success; PASS plus
`agent_end` without settlement; truncated settlement/trailing JSON; split
emoji/euro UTF-8 writes including U+2028/U+2029; exactly 1 MiB combined output;
stdout overflow with otherwise ignorable records; combined overflow with each
stream individually below the cap; aborted settlement; resumed work; assistant
error; and nonzero process exit. The positive boundary uses multibyte data to
check byte accounting rather than JavaScript string length.

The new pure `qualifyJsonCapture` function in
`scripts/extension-smoke-runner.js` requires a clean process exit, no capture
failure, valid JSON, non-aborted terminal `agent_settled`, and no assistant
error/abort. It checks **unfiltered stdout + stderr** against **1,048,576 bytes**;
it does not accept an assistant's PASS text as completion. Capture qualification
is not artifact correctness, task acceptance, model identity or fresh-session
proof; those remain separate checks.

The existing raw collector/kill behavior was not changed. Each new synthetic
capture passes the frozen 1 MiB limit explicitly; the shared runner's unrelated
default is unchanged. There is no downstream filter, larger cap, alternate
transport, retry, or live-path rewiring. Existing RPC/model-probe unit cases also
use an explicit Node fake, not the real Pi executable.

Red/green evidence is retained in `.pi/skill-offline-capture-20261024-01/`:
`contract.json`, original source/test/report snapshots, `red.log`, `green.log`,
`results.json`, and `evidence-sha256.json`. The initial test failed because the
capture qualification API did not exist; after implementation the focused suite
passed all twelve new scenarios plus its existing offline cases. Node/compiler
syntax diagnostics were clean. Successful owned temporary fixtures were cleaned;
older evidence and limits were preserved.

This qualifies offline failure detection only. It neither proves a lower-volume
native observation path nor recovers the earlier truncated streams. At this
offline increment's close, security/chart terminal acceptance, Blender
availability, captured-cost uncertainty, and the canonical **2/3 outcomes
complete / 1 blocked** status remained unchanged.

## Bounded native continuation verification — 2026-10-24

**Overall acceptance remains PARTIAL: 2/3 required outcomes complete, 1 blocked.**
The user subsequently authorized missing live verification if prerequisites were
available. A new, explicitly frozen cohort allowed **two sessions total**, one
per distinct available continuation case, with no retries or fallbacks. The
original E2E cohort remains **5/5 used**; its protocol, failures, outputs and hash
manifest were not reset, overwritten or relabeled.

### Prerequisites and changed workflow

Installed native Pi, Matplotlib 3.10.9, Pillow 12.3.0, the frozen helper report and
renderer, and the offline-qualified capture gate were available. The native
JSON writer emits session events; no qualified emission-selector route was
identified. Instead of repeating the failed compact generator, the security case
reviewed the existing register/DFD and wrote only the missing backlog and review
summary. The chart case executed the frozen renderer and verifier rather than
generating another verifier or attaching the PNG to its native stream. The
parent inspected the new PNG directly afterward. This changes upstream task
emission, not raw-byte accounting or downstream capture filtering.

Blender was still absent from PATH and the bounded known-location lookup;
`bpy` was unavailable. The `blenderai-mcp` launcher is not the required runtime.
No install, download, remote substitute, 3D execution or render was attempted.

### Observed cases

| Case | Native capture and process | Artifact/task verdict |
|---|---|---|
| Security review/completion | **PASS:** 43.244 s, 602,077 raw stdout+stderr bytes, exit 0, valid JSONL, non-aborted terminal settlement | **INCOMPLETE under frozen contract:** reviewed register/DFD promoted unchanged and 1,606-byte backlog created; validator exited 1 because review summary is **1,007 bytes**, exceeding its frozen 1,000-byte limit by 7. Child reported FAIL and stopped. |
| Actual chart rerender | **PASS:** 33.690 s, 454,700 raw stdout+stderr bytes, exit 0, valid JSONL, non-aborted terminal settlement | **PASS for this scoped task:** real PNG/SVG/CSV/methods/source and alternative text; machine data/geometry checks and parent visual inspection passed. |
| Blender | Not launched | **BLOCKED:** native runtime unavailable. |

Both new session IDs were distinct and both observed models were exactly
`openai-codex/gpt-6.1-sol`, requested thinking `off`, with native installed skill
expansion. Complete tool-result bytes matched all eight read files: two skill
bodies, the threat-register reference, architecture/register/DFD, and chart
renderer/report. Only the prescribed prepare/validate commands executed; no
unexpected tools, provider errors, retries, native image attachments, output
truncation, timeouts or cap violations occurred.

The security validator's preceding identity, boundary, field, owner and backlog
checks passed before its summary-size assertion failed. Parent review found
concrete B1 ownership, B2 untrusted-content/egress and B3 job/storage controls,
proposed owners, and negative/positive verification strategies. These are
**design proposals, not tested security controls**. The 7-byte failure was not
trimmed away, its limit was not relaxed, and no command or native session was
rerun. Artifact-set completeness and clean settlement do not turn this frozen
case into a PASS. This is continuation/review, not a successful fresh security
register regeneration within the original cap.

The parent opened the actual new 1200×800 PNG. Six labels and values
**2, 2, 1, 1, 1, 1** are legible, zero baseline and proportional bars are correct,
no clipping is visible, and source/synthetic/overlapping-count caveats are
readable. SVG geometry, CSV/methods rows and source digest matched six signal
types/eight signals in the actual helper report. PNG SHA-256 is
`7a533c76f0f1119c78f3786679ac15df664bf689af6acc8d081a1694204c40f2`;
matching the earlier deterministic render does not relabel that earlier failed
capture. The new native command receipt proves this separate rerender.

### Bounds, evidence and remaining work

The new driver uses the unchanged raw collector with an explicit **1,048,576-byte
combined unfiltered stdout+stderr cap per native process**, then calls
`qualifyJsonCapture` before deciding acceptance. It retains the same 180 s per
process, 16 MiB artifacts per case, 64 MiB verification-family limit, same
provider/model, disabled retries, and cumulative $3 reported-cost stop. No cap
increase or provider/account switch was used. Both **2/2** newly allocated
sessions are spent; no further live continuation is registered.

New captured provider-reported cost: **$0.0831984**. Cumulative captured E2E cost:
**$0.4641872**. Earlier interrupted turns still have incomplete accounting; this
is not a billing assertion or hard cost cap. Only the new successful render's
94,023-byte disposable font cache was removed. Failed outputs, original
artifacts, old evidence and the legacy backup remain intact. No skill, product,
installer, provider, authentication or global configuration code changed in this
increment.

Machine-local evidence: `.pi/skill-live-verify-20261024-01/` contains frozen
`protocol.json`, immutable `inputs/`, `run.cjs`, read-only `validate.py`, exact
`*.input.json`, pre-launch `attempts.jsonl`, public `*.events.json`, per-case
`*.result.json`, driver `results.json`, parent `inspection.json`, and
`evidence-sha256.json`. Driver results preserve its pre-parent-inspection phase;
`inspection.json` records the completed parent visual check. Frozen code/input
hashes and all historical E2E evidence digests matched after execution. Private
thinking/reasoning blocks and credentials were not retained.

The capture-limit debug thread remains open with these scoped observations.
These two bounded workflows demonstrate clean native capture, not a generic
wire-volume fix, recovery of lost events, or proof that full regeneration fits
1 MiB. The chart's missing native/visual observation is now supplied; the
security continuation still fails its frozen byte bound, and Blender needs a
supplied native runtime. Another live attempt requires a separate explicit
bounded allocation, not rerunning this cohort. Full-library efficacy, automatic
routing, adversarial qualification, production security and 3D quality remain
unverified. No commit or push was performed during that verification increment.

## Local integration decision — 2026-10-24

The user explicitly authorized committing and locally merging this migration,
with skill activation frequency and usefulness to be assessed after real
sessions. The known PARTIAL runtime evidence above is accepted for integration;
it is not relabeled as a pass. The security continuation's summary-size failure,
missing Blender execution, and unexecuted broader efficacy/routing evaluations
remain disclosed follow-up observations rather than prerequisites to this local
merge. No `HOST_TESTED` or `PRODUCTION_VALIDATED` promotion is made.

Pre-commit focused checks passed: `tests/generic-agent-skills.test.js` (101-skill
contract, generated-byte parity and nine offline tests),
`tests/install-agent-skills.test.js`, `tests/pi-harness-refresh-script.test.js`,
and `tests/extension-smoke-runner.test.js` (including twelve synthetic capture
cases). The full staged whitespace check reports two upstream trailing spaces:
`skills/CATALOG.md:3` and `skills/FULL_REPORT.md:387`. Both documents exactly
match the supplied ZIP and are retained for source fidelity; the remaining
staged paths pass their scoped whitespace check. These formatting warnings are
disclosed, not suppressed, and no commit hook is bypassed.

This authorization includes local commits and merge into `main`, not
push/publish, additional live model calls, or deletion of the task worktree,
legacy backup, preserved failures or original input ZIP.

## Restored legacy skills

Eight archived skills are restored as local additions because no supplied skill
covers their workflows: **109 managed skills = 101 supplied + 8 local**.

| Skill | Category | Reference contract |
|---|---|---|
| `handoff` | meta | `references/handoff-contract.md` |
| `git-checkpoint` | engineering | `references/checkpoint-contract.md` |
| `change-verify` | engineering | `references/verification-contract.md` |
| `long-run` | engineering | `references/long-run-contract.md` |
| `durable-bug-hunt` | engineering | `references/bug-hunt-contract.md` |
| `build` | engineering | `references/build-contract.md` |
| `typesafe-ai` | engineering | `references/typesafe-guide.md` plus `LICENSE` |
| `experiment-gate-lifecycle` | research | `references/experiment-gate-contract.md` |

### Method

- Sources: `skills/<name>/SKILL.md` at `5f25692` (the last pre-migration commit)
  for the seven harness skills; each is byte-identical to all three archived
  installed copies. `typesafe-ai` was an unmanaged install in
  `~/.pi/agent/skills/`; its source is `pi-skills/typesafe-ai/{SKILL.md,LICENSE}`
  in `legacy-skills.tar.gz` (SHA-256 `71ea90d7…9f52` and `835f233f…3b02`).
- Standard form: a `catalog.json` entry regenerated into
  `skills/skills/<name>/SKILL.md` and `skills/evals/<name>.json`, plus a
  hand-maintained reference that keeps the legacy body under a provenance header.
  Reference bodies are byte-identical to their sources except one boundary line
  in `experiment-gate-lifecycle`: the archived `research-framework-design` now
  points to `evidence-led-research` or `quantitative-modeling`, and
  `experiment-design-analysis` is named for estimands, power and randomization.
- Dropped as host-specific or incompatible with the generator: frontmatter keys
  (`allowed-tools`, `enableSkillCommands`, `disable-model-invocation`) and, for
  `handoff`, the `ultrathink` keyword and `$ARGUMENTS` placeholder. The standard
  adds `license: MIT` metadata, required by its validator; the harness repository
  itself has no license file.
- `build` and `experiment-gate-lifecycle` were explicit-command-only
  (`disable-model-invocation: true`). The generator's frontmatter is fixed, so both
  are now model-routable; their descriptions exclude the adjacent bundle owners.
- Every harness tool the contracts name exists in the current extensions:
  `gitevidence`, `gitverify`, `commit_plan`, `test_runner`, `test_project`,
  `build_project`, `lsp`, `codegraph_affected`, `test_gap_planner`,
  `verification_center`, `debug_ledger`, `fix_recall`, `safe_try`,
  `evidence_inbox`, `experiment_ledger`, `run_deck`, `bg_run` and `run_monitor`.
- The generator gains one title case so `typesafe-ai` renders as "TypeSafe AI",
  and the generated `CATALOG.md` header loses a trailing space and the word
  "original", which no longer holds once third-party material is included. No
  supplied skill's generated `SKILL.md` or eval bytes change.

### Third-party license

`typesafe-ai` is MIT-licensed, Copyright (c) 2026 TypeSafe AI. Its original
`LICENSE` is kept byte-identical in `skills/skills/typesafe-ai/`, listed in the
skill's references and installed with it. The guide reference attributes the
source; `skills/README.md` and `skills/standards/trust-provenance.md` record it
as the one exception to the pack's "original work, no third-party skill files"
statement. The restored text is the copy the user had installed, pinned by the
digests above. On 2026-10-24 the vendor's discovery index
(`https://docs.typesafe.ai/.well-known/agent-skills/index.json`) published a
different skill, `type-safe` (`sha256:de71920a…93a6`); adopting it would be a
separate update.

### Usage evidence

Aggregate counts only, from session logs: tool calls that loaded an installed
copy of the skill's `SKILL.md` (edits excluded), across 1,967 Pi session files,
817 Claude Code project logs and 1,016 Codex session logs. Every hit was a Pi
session. No prompt, response or other content was recorded.

| Skill | Loads | Sessions | Last load |
|---|---:|---:|---|
| `change-verify` | 2,012 | 332 | 2026-10-24 |
| `long-run` | 1,342 | 280 | 2026-10-24 |
| `durable-bug-hunt` | 989 | 170 | 2026-10-24 |
| `git-checkpoint` | 737 | 332 | 2026-10-24 |
| `handoff` | 30 | 12 | 2026-10-11 |
| `typesafe-ai` | 26 | 9 | 2026-10-22 |
| `build` | 1 | 1 | 2026-07-09 |
| `experiment-gate-lifecycle` | 0 | 0 | — |

No explicit `/skill:<name>` invocation was found for any of them. `long-run`
loads span 23 projects from 2026-07-15 (July 85, August 141, September 473,
October 643), with 96 sessions in the last 30 days. The near-zero counts for
`build` and `experiment-gate-lifecycle` reflect their former command-only mode.

### Partial-coverage gap evidence

These four skills had partial bundle counterparts. Each was restored because at
least one required behavior below has no owner in the bundle.

| Skill | Covered by the bundle | Not covered |
|---|---|---|
| `change-verify` | Acceptance matrix and PASS/FAIL/BLOCKED/NOT TESTED statuses (`acceptance-quality-release`); diff-scoped findings and merge verdict (`code-review-evidence`) | Verification-only boundary that reports instead of repairing while the parent plan keeps repair authority; commands derived from repository instructions, manifests or CI, never invented; cheapest check first, then a risk ladder; no rerun of unexplained failures; `gitverify` and a changed-file re-read before a readiness claim; harness verifier selection; PASS/FAIL/PARTIAL where only PASS supports readiness |
| `durable-bug-hunt` | Reproducer, competing hypotheses, first incorrect state, minimal fix and regression evidence (`systematic-debugging`) | `debug_ledger` thread before any change, resolved only on evidence; `fix_recall`; no retry of attempts recorded as no-change or worse; `safe_try` checkpoint and revert; normal versus deep mode with at least three hypotheses; ban on masking with retries, sleeps or guards; tool failures are not product evidence |
| `experiment-gate-lifecycle` | Preregistered-style plan, estimand, power, guardrails, analysis and rollout recommendation (`experiment-design-analysis`); model benchmarks (`generative-model-evaluation`) | `experiment_ledger` open/gate/close; new, continuation, reframe and settled states; validity gates kept apart from hypothesis results; managed runs without duplicates; NULL-RESULT recording and no unchanged reruns; implementation, measurement and hypothesis failure classes with one repair rerun; ship, no-go or shelved closure for engineering and ML arms |
| `build` | CI/CD and release pipelines (`ci-release-engineering`); sanitizers and static checks for C++ (`cpp-modern-systems`); Python packaging and lint (`python-production-engineering`); generic failure diagnosis (`systematic-debugging`) | Diagnosing an existing failing build from the repository's build contract and local-versus-CI differences; a failure taxonomy that separates provider or resource failures from source failures; reproducing the exact target through `build_project` or checked-in scripts; first causal error; no suppressed warnings, disabled tests or sanitizers, deleted lockfiles or fallback toolchains; a CI-parity verdict; npm/TypeScript and Cargo specifics |

`git-checkpoint`, `long-run`, `typesafe-ai` and `handoff` had no replacement at
all; see **Coverage decisions**.

### `handoff`

The bundle's skills each end with a short per-artifact `## Handoff` section. That
is not the legacy durable whole-session continuation workflow.

- Source SHA-256 `bb93ab65…d4fe`.
- Preserved workflow: write the file before responding; destination order
  `handoffs/` → `.codex/handoffs/` → `/tmp/agent-handoffs/`; required Git and
  background-work inspection; the eleven sections in their original order; the
  repo-relative resume prompt; no unrun verification claims, secrets or source
  edits; and the final-response contents. The narrowed routing from `fcbd76b`
  (saving a plan or notes to a project file is not a handoff) is kept.
- `tests/agent-skills-pi-load.test.js` still read the pre-migration
  `skills/managed-skills.txt` and failed with `ENOENT`; it now loads every managed
  skill from `skills/skills/` with Pi's own loader.

### Advisory pilot

The open advisory pilot `exp-machine-verification-advisory-v2` pins
`~/.agents/skills/change-verify/SKILL.md`. While that file was archived,
`prepare()` and `report()` threw `ENOENT` for eligible verification prompts
(debug thread `advisory-pilot-throws-after-change`). With `change-verify`
installed again, a temp-directory reproduction using the real pilot code shows
`prepare()` returning `blocked: "source-or-configuration-changed"` and `report()`
returning `identityMatches: false`, instead of throwing. The pilot stays blocked
because the skill content and the runtime source differ from enrollment. Its
experiment record and state are unchanged; whether to re-enroll is an owner
decision. A follow-up change makes the pilot itself treat a missing pinned file
as a pause: `prepare()` returns `blocked: "provenance-file-missing"` and
`report()` reports the same reason, so a future removal cannot crash a turn
(`tests/advisory-skill-pilot-missing-provenance.test.js`).

## Skill Foundry 2.0 replacement — 2026-10-27

The owner supplied `skills.zip` (Skill Foundry 2.0, release date 2026-10-27,
base release 2026-10-24, 121 skills) to replace the installed library on this
machine and the fleet hosts `host-00`, `host-01`, `host-02`, `host-03`, `host-04`,
`host-home`, `local` and `worker-1`. The supplied change index reports 20 new
skills, 21 revised skills and 80 preserved skills; all 101 October 24 skills
remain.

### Payload

- `skills/catalog.json` now holds 129 entries: the 121 supplied entries in
  supplied order plus the eight local restorations, unchanged.
- `skills/tools/regenerate.py` renders the supplied pack's new catalog fields:
  `revision` as the frontmatter `metadata.version`, `special_rules` as
  **Specialist protocol and proof boundaries**, `source_inspiration` as
  **Provenance notes**, `domain_tests` as the evaluation `domain` array, and
  optional hand-authored `routing_tests` that override the generated positive
  and negative prompts. The 20 new skills use those overrides so their authored
  routing cases survive regeneration instead of being replaced by the generic
  generated prompts.
- Regeneration produced `skills/skills/<name>/SKILL.md`, `evals/<name>.json`,
  `CATALOG.md` and `manifest.json` for all 129 skills;
  `skills/skills/managed-skills.txt` lists the same 129 names in byte order.
- The supplied `references/field-guide.md` (20 new skills), the other supplied
  reference files and `skills/shipped-artifact-provenance/scripts/artifact_inventory.py`
  were copied into their skill directories.
- `skills/AGENTS.md`, `skills/README.md`, `skills/standards/evaluation-protocol.md`,
  `skills/standards/installation-routing.md`, the root `README.md`, this record
  and `docs/changelog.md` were updated for the 129-skill catalog;
  `skills/CHANGES_2026-10-27.md` was imported from the pack.

### Disclosed deviations from the supplied ZIP

1. `refs` render as plain relative paths (`- references/field-guide.md`) instead
   of the supplied markdown links. This repository's generator convention
   predates 2.0 and keeps the 80 preserved entrypoints byte-identical apart from
   the generated **Harness delegation** section.
2. `skills/skills/shipped-artifact-provenance/SKILL.md` ends its final
   `special_rules` bullet without a period. The supplied `SKILL.md` has the
   period but the supplied `catalog.json` does not; the catalog is the editable
   source here, so the generated body follows the catalog. No supplied data was
   rewritten.
3. The supplied `skills/seo-technical-audit/scripts/site_audit.py` regressed the
   valueless-attribute normalization fixed in this repository
   (`d.get('content') or ''`). The repository version is retained, and
   `tests/test_helpers.py` passes; the supplied script was not adopted.
4. The supplied ZIP omitted the authoring-side additions its documents name:
   `standards/evidence-authorship.md`, `standards/claim-ledger-schema.json`,
   `tools/check_evidence_ledger.py`, `tools/verify_release.py`,
   `RELEASE_FILES.json`, `research/rea-architecture-assessment.md` and
   `research/ORIGINAL_2026-10-24_FULL_REPORT.md`. They are absent here and the
   adapted `skills/README.md`, `skills/AGENTS.md`, `skills/FULL_REPORT.md` and
   `skills/VALIDATION_REPORT.md` say so instead of linking to them.
5. The supplied `skills/AGENTS.md` placed items 9–11 after its closing
   `See standards/...` line; the adapted file keeps a single ordered list.

### Verification

- `python3 skills/tools/validate_skills.py` → `PASS: 129 skills`.
- `python3 -m unittest discover -s skills/tests` → `Ran 9 tests ... OK`.
- Generated `evals/<name>.json` are byte-equal to the supplied files for all
  121 supplied skills; generated `SKILL.md` match the supplied bodies apart from
  the injected **Harness delegation** section and the disclosed `refs` and
  trailing-period deviations above.
- `git status` shows 21 revised `SKILL.md` files, 20 new skill directories and
  no change to the 80 preserved entrypoints beyond their regenerated delegation
  section.
- `tests/generic-agent-skills.test.js` (129-skill contract, generated-byte
  parity, nine offline tests), `tests/install-agent-skills.test.js`,
  `tests/agent-skills-pi-load.test.js` (129 skills loaded by Pi's own loader),
  `tests/skill-awareness.test.js`, `tests/skill-extension-source.test.js`,
  `tests/skill-governance.test.js`, `tests/skill-intake.test.js`,
  `tests/skill-synthesis.test.js`, `tests/meta-prompt-skill-policy.test.js` and
  `tests/role-consumer-contracts.test.js` pass.
- `scripts/install-agent-skills.sh` reconciled both destinations;
  `~/.agents/skills` and `~/.claude/skills` each hold 129 managed directories,
  a manifest equal to the source manifest and a managed content digest equal to
  the source digest. No unmanaged skill was present on this machine.
- The advisory pilot `exp-machine-verification-advisory-v2` pins
  `~/.agents/skills/change-verify/SKILL.md`; that local skill is unchanged by
  this replacement, so the pinned content identity still matches.

### Fleet deployment

`scripts/update-fleet.sh` deployed the payload commit (`c3ed4f1`) to `host-00`,
`host-01`, `host-02`, `host-03`, `host-04`, `host-home`, `local` and `worker-1`.
Preflight found every host reachable at harness `e037d78` with its Pi runtime
already at the target `283192a8d`, so no Pi rebuild was required.

The first run (`skills-pack-2.0-20261027`) advanced each host checkout, refreshed
extensions and installed the 129 managed skills, then failed every host on the
old gate that required the total skill-directory count to stay identical
(`109 -> 129` on host-00, local and worker-1; `117 -> 137` on host-01, host-03 and
host-home; `114 -> 134` on host-02; `118 -> 138` on host-04), and the
independent verification phase was skipped. That gate assumed a constant managed
catalog; it now compares the digest of user-owned (non-managed) skill
directories instead (commit `8b87c31`, guarded by
`tests/fleet-skill-gate.test.js`). `scripts/check-all.sh` passes 308 test files
after the fix.

The re-run (`skills-pack-2.0-20261027-r2`) fast-forwarded every host to
`8b87c31` and passed independent verification on all eight: 40 checks per host,
39 on the shallow `local`/`worker-1` clones, with no failing check. Each
destination's manifest equals the source manifest
(`39bda51f7ffbeeba919f2ca522e70c1bb81dcef6d3d1cbe0ca648a0a100e820f`), all 129
managed skills are present, and each managed content digest equals the expected
digest (`fad22a4ad99b3d71c75a0d7c8c0c18dbc90a76dae03c0facd2d9144e63da78f0`).

Pre-existing unmanaged skill directories were preserved on every host; the
pre/post user-owned digests match for both `~/.claude/skills` and
`~/.agents/skills`:

| Host | Managed | Unmanaged `~/.claude/skills` | Unmanaged `~/.agents/skills` | Post total (claude/agents) |
|---|---:|---:|---:|---|
| host-00 | 129 | 0 | 0 | 129/129 |
| host-01 | 129 | 8 | 8 | 137/137 |
| host-02 | 129 | 5 | 0 | 134/129 |
| host-03 | 129 | 8 | 8 | 137/137 |
| host-04 | 129 | 9 | 9 | 138/138 |
| host-home | 129 | 8 | 8 | 137/137 |
| local | 129 | 0 | 10 | 129/139 |
| worker-1 | 129 | 0 | 10 | 129/139 |

Evidence: `.pi/fleet-update-skills-pack-2.0-20261027/` and
`.pi/fleet-update-skills-pack-2.0-20261027-r2/` (per-host preflight, update and
verify logs plus exit codes). Hosts run the runtime resources of `8b87c31`; the
documentation-only commit that records this result is later on `main`, so hosts
will fast-forward on the next routine fleet run without changing any installed
extension or skill.
