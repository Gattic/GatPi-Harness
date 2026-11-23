# Skill Foundry 3.0 — 153 Agent Skills (131 supplied + 22 pi-harness local)

**Updated:** 2026-11-18. A complete replacement for the October 27 Skill Foundry 2.0 library: all 121 prior supplied skills are preserved, 10 original motion, isometric, shader, Blender and kinematics skills are added, and 23 established workflows are strengthened. The library remains inspired by the original 18 repositories **plus** [`morluto/rea`](https://github.com/morluto/rea) (evidence discipline, target-first routing, scoped tool readiness and specialist reverse-engineering patterns); 3.0 adds three public motion sources whose coverage and limits are recorded in [research/motion-sources-2026-11-18.json](research/motion-sources-2026-11-18.json).

The supplied pack contains **131 usable `SKILL.md` files**, **131 unexecuted evaluation suites** containing **1019 proposed cases**, original procedural Blender and SEO scripts, 20 self-contained REA field guides, a read-only ZIP/binary inventory helper, and — new in 3.0 — ten motion references and three standard-library validation scripts (motion timeline graph, SVG integrity, ideal gear/lead-screw samples). All source instructions are independently authored, not copied upstream skills.

This project offers **portable task instructions** and local helper scripts. Installing a skill does **not** install an MCP server, browser, Blender, LottieFiles Creator, GPU or paid model.

> **pi-harness local additions:** eight restored legacy skills are not part of the supplied pack: `handoff` (meta); `git-checkpoint`, `change-verify`, `long-run`, `durable-bug-hunt`, `build` and `typesafe-ai` (engineering); and `experiment-gate-lifecycle` (research). Each is a catalog entry adapted to this standard plus a hand-maintained `skills/<name>/references/` contract that preserves the legacy workflow. `typesafe-ai` is third-party MIT material, Copyright (c) 2026 TypeSafe AI; its license stays in `skills/typesafe-ai/LICENSE`, one of two exceptions to the statement above that no third-party skill files are redistributed. Provenance and rationale: `docs/skill-bundle-migration.md` in the harness repository.

> **Blender integration (2026-11-23):** fourteen further local skills cover the 3D asset pipeline, and seven supplied 3D skills were revised. Their entrypoints are original, but they bundle reference guides, Blender scripts, an add-on template and in-Blender tests adapted from [EL4CTEO/blender-skills](https://github.com/EL4CTEO/blender-skills) (MIT, Copyright (c) 2026 EL4CTEO) — the second exception to the no-redistribution statement. Every affected skill directory carries `THIRD_PARTY_NOTICES.md`, and each file's origin, digest and changes are in [research/blender-skills-provenance.json](research/blender-skills-provenance.json). This repository copy holds **153 skills: 131 supplied (7 of them revised here) + 22 local**, and 1211 designed evaluation cases.

## Blender integration (2026-11-23)

- **14 skills added:** `3d-asset-quality-gate`, `retopology-uv-unwrap`, `texture-map-baking`, `realtime-asset-optimization`, `game-engine-asset-export`, `facial-blendshape-rigging`, `character-garment-fitting`, `hair-groom-cards`, `stylized-npr-rendering`, `environment-terrain-scatter`, `atmosphere-weather-lighting`, `physics-simulation-baking`, `camera-tracking-matchmove` (media) and `blender-extension-development` (engineering).
- **7 existing skills revised:** `procedural-3d-blender`, `3d-modeling-topology`, `pbr-material-lookdev`, `lighting-render-optimization` and `rigging-animation-retarget` (2.0.0), `blender-cinematic-video-pipeline` (1.1.0) and `task-skill-router` (1.3.0, with end-to-end 3D asset playbooks).
- **Bundled per skill:** 29 field guides, 15 reference documents, 42 Blender scripts with a shared helper, and an extension template. Each script exposes `run(**kwargs)` and prints one JSON result line.
- **Measured, not assumed:** the scripts target Blender 5.2 LTS+ upstream. This pack ran them on Blender 5.1.2, fixed what failed there and records what is 5.2+ or 5.3-only in [version-compatibility.md](skills/procedural-3d-blender/references/version-compatibility.md). Result on 5.1.2: 79 passed, 0 failed, 1 skipped (needs 5.2) of 80 in-Blender tests. Nothing was run on 5.2 or 5.3, and no engine import was exercised.
- Source review, coverage decisions and limits: [research/blender-skills-review.md](research/blender-skills-review.md). Change list: [CHANGES_2026-11-23.md](CHANGES_2026-11-23.md).

### 3D asset workflows

- Game prop: `3d-modeling-topology` → `retopology-uv-unwrap` → `texture-map-baking` → `pbr-material-lookdev` → `3d-asset-quality-gate` → `realtime-asset-optimization` → `game-engine-asset-export`.
- Game character: modeling → retopology → baking → `rigging-animation-retarget` → `facial-blendshape-rigging`, `character-garment-fitting`, `hair-groom-cards` as needed → optimization → export.
- Environment or mood shot: `environment-terrain-scatter` → `atmosphere-weather-lighting` → `lighting-render-optimization`.
- Every geometry-changing stage is gated by `3d-asset-quality-gate`; `task-skill-router` orders the stages from `references/3d-asset-playbooks.md`.

## What changed in 3.0

- **10 original skills added:** `ui-motion-direction`, `brand-motion-system`, `motion-choreography-review`, `lottie-animation-delivery`, `interactive-isometric-explainer`, `isometric-svg-geometry-audit`, `webgl-svg-hybrid-scene`, `blender-cinematic-video-pipeline`, `animation-benchmark-isolation` and `mechanical-animation-kinematics`. Each ships a reference under `skills/<name>/references/` plus two domain-specific edge/negative tests.
- **23 existing skills revised** with motion, rendering, mechanism and routing rules (`special_rules`, `source_inspiration` and a new `revision`); the other **98 supplied entrypoints are unchanged**. [CHANGES_2026-11-18.md](CHANGES_2026-11-18.md) lists both sets.
- **3 runnable validators:** `skills/ui-motion-direction/scripts/check_motion_timeline.py`, `skills/isometric-svg-geometry-audit/scripts/inspect_svg.py` and `skills/mechanical-animation-kinematics/scripts/validate_kinematics.py`. They check static properties only: no visual quality, geometric collision or loaded-mechanism claims.
- **Authoring-side files that the 2.0 ZIP omitted are now present:** `standards/evidence-authorship.md`, `standards/claim-ledger-schema.json`, `tools/check_evidence_ledger.py`, `tools/verify_release.py`, `research/rea-architecture-assessment.md`, `research/rea-provenance.json` and `research/ORIGINAL_2026-10-24_FULL_REPORT.md`, with their offline tests.
- The supplied `RELEASE_FILES.json` is **not** kept here: it hashes the supplied ZIP, and this copy differs from it by design (generated **Harness delegation** section, trigger-only descriptions, eight local skills). It passed `tools/verify_release.py` on the extracted ZIP before adaptation; run that tool against an extracted pack, not this tree.

### Creative workflows

- UI animation: `ui-motion-direction` → `brand-motion-system` (for reusable identity) → `motion-choreography-review` → browser QA.
- Exported Lottie: `ui-motion-direction` → `lottie-animation-delivery` (only if export is explicitly requested and a renderer is available).
- Explanatory technical graphics: `interactive-isometric-explainer` → `isometric-svg-geometry-audit` → `webgl-svg-hybrid-scene` (only for real shader value).
- Blender cinematics: `video-storyboard-shotlist` → `blender-cinematic-video-pipeline` → `mechanical-animation-kinematics` (when needed) → `video-edit-color-delivery`.
- AI model comparisons: `animation-benchmark-isolation` → independent candidate builders → neutral evaluation; never let candidates inspect each other's workspace.

## What 2.0 added (retained)

- **20 original specialized skills added:** shipped artifacts, native binary and runtime evidence, JS/Electron, .NET, Android APK, packaged Python, firmware, ELF/PE mitigation declarations, browser scenarios, HAR capture/API inference, exported browser JavaScript, evidence lineage, independent feature reconstruction, binary version differences, AgentEnv simulations, crash triage, model headers and privacy data flows.
- **21 original skills materially improved:** systematic debugging, code review, routing, source provenance, security, research, web QA, observability, testing and skill evaluation.
- Those **41** skills carry two domain-specific edge/negative tests in addition to the base seven, as do the ten 3.0 additions (51 in total); the remaining skills keep their base seven. The 2026-11-23 Blender integration adds two domain tests to five revised skills and to all fourteen new ones (70 in total).
- Revised and new skills carry a `revision`, `special_rules` (rendered as **Specialist protocol and proof boundaries**) and `source_inspiration` (rendered as **Provenance notes**).
- **20 field guides** under `skills/<name>/references/field-guide.md` and an offline ZIP/binary manifest helper at `skills/shipped-artifact-provenance/scripts/artifact_inventory.py`.

## Status matrix

| Work | Actual status |
| --- | --- |
| 153 `SKILL.md` files exist and satisfy this package's structural contracts | **PASS** |
| 153 evaluation suites contain the intended designed cases | **PASS: generated and validated as data** |
| Offline generator/installer/Git fixture/evidence-ledger/release-manifest/motion, SEO helper and Blender bundle tests | **PASS: 32 tests** (23 supplied + 9 local); the opt-in native Blender test is skipped unless `SKILL_FOUNDRY_BLENDER` is set |
| 124 supplied entrypoints and 126 supplied evaluation suites are unchanged since the 3.0 parity check against the supplied pack; the 7 entrypoints and 5 suites revised on 2026-11-23 differ from it by design | **PASS** (git history) |
| 23 revised skill entrypoints and 10 new skill entrypoints | **CREATED** |
| 7 revised and 14 new 3D/Blender skill entrypoints (2026-11-23) | **CREATED** |
| Bundled Blender scripts on Blender 5.1.2 (`tests/blender/run_all.py`, one build on one machine) | **PASS: 79 passed, 0 failed, 1 skipped** of 80 (the skipped test needs 5.2) |
| Bundled Blender scripts on Blender 5.2 or 5.3; any engine import of exported assets | **NOT TESTED** by this pack (upstream statements only) |
| REA installed, MCP connected, native providers exercised | **NOT TESTED** (not available here) |
| All evaluation cases run against real agents and scored | **NOT TESTED** |
| All 19 full repository Git trees and the three motion sources exhaustively audited | **NOT DONE** (needs network access or local clones) |
| Lottie/dotLottie playback, interactive browser scenes, WebGL effects and the visual quality of Blender renders | **NOT TESTED** in this environment |

An installed skill **never** implies an MCP tool, engine, application account, runtime or permission exists. Check the live tool list and obtain approvals where required.

## Inventory (153 total: 131 supplied + 22 local)

| Domain | Supplied | Local | Total |
| --- | ---: | ---: | ---: |
| Engineering | 23 | 7 | 30 |
| Research | 8 | 1 | 9 |
| Web / SEO | 16 | 0 | 16 |
| Design | 13 | 0 | 13 |
| Image / video / 3D / audio | 27 | 13 | 40 |
| Marketing / advertising | 12 | 0 | 12 |
| Cybersecurity | 19 | 0 | 19 |
| Delivery / operations | 5 | 0 | 5 |
| Skill architecture / orchestration | 8 | 1 | 9 |
| **Total** | **131** | **22** | **153** |

See [CATALOG.md](CATALOG.md) for the exact names and descriptions; choose a skill from the **requested deliverable**, not incidental topic vocabulary.

## What is inside

```text
skills/
├── skills/               # 153 independently usable directories with SKILL.md
│   ├── rea-capability-routing/
│   ├── shipped-artifact-provenance/
│   ├── ui-motion-direction/
│   ├── skill-factory/
│   ├── handoff/
│   └── ...
├── evals/                # 153 unexecuted routing + behavioral test specifications
├── catalog.json          # single structured editable source for skills
├── specialists.json      # generated subagent roster rendered into every skill
├── CATALOG.md            # all names with summaries and links
├── manifest.json         # machine-readable skill inventory
├── CHANGES_2026-11-23.md # local change log for the Blender integration
├── CHANGES_2026-11-18.md # supplied change log for the 3.0 release
├── CHANGES_2026-10-27.md # supplied change log for the 2.0 release
├── CHANGE_INDEX*.json    # supplied new/modified/unchanged name lists for both releases
├── standards/            # authoring/eval/evidence/quality/routing/trust policies and the claim-ledger schema
├── research/             # 18-source review, REA assessment and provenance, 3.0 motion sources, Blender source review and file ledger
├── tools/
│   ├── regenerate.py     # deterministic skill/eval build from catalog.json
│   ├── validate_skills.py# portable static contract checking
│   ├── check_evidence_ledger.py # validate a normalized claim ledger against its listed files
│   ├── verify_release.py # check an extracted supplied pack against its RELEASE_FILES.json
│   ├── check_blender_bundle.py # bundled Blender files against the provenance ledger and notices
│   ├── audit_repositories.py  # full tracked-source audit, when network/clones available
│   └── install.py        # selectively copy skills into agent discovery folders
├── tests/                # offline generator, installer, auditor, ledger, release, helper and bundle tests
│   └── blender/          # tests that run inside Blender (opt-in, see below)
├── source-audit/         # audit status, workflow; generated reports go here
├── AGENTS.md
└── LICENSE              # applies only to our original work; bundled third-party files keep their own notices
```

## Install only what you need

Agent Skills implementations differ in local discovery paths. Choose the correct path for your agent/version; for example, many Codex-style projects scan `.agents/skills/`, Claude Code projects scan `.claude/skills/`, and Cursor projects may use `.cursor/skills/`.

```bash
# From the package root:
python tools/install.py --list
python tools/install.py --target /path/to/project/.agents/skills \
  --skill rea-capability-routing \
  --skill javascript-electron-artifact-recovery \
  --skill rea-evidence-lineage-review

# Preview before opting into installing the entire library:
python tools/install.py --target /path/to/project/.agents/skills --all --dry-run
```

Existing target folders are not overwritten without `--force`. Use `--force` only if intentionally replacing your existing local skill folders. Installing all 153 may worsen activation quality if your agent indiscriminately loads instructions; prefer selecting by current project domain. Never pretend installation also grants web accounts, GPU tools, model weights, external APIs or publishing rights.

The Pi harness installs its managed catalog through `scripts/install-agent-skills.sh`, which reconciles `skills/skills/managed-skills.txt` into `~/.claude/skills` and `~/.agents/skills` and preserves unmanaged entries.

## Validate and rebuild

Requires **Python 3.10+**; `git` is required for the upstream audit.

```bash
python tools/validate_skills.py
python tools/check_blender_bundle.py
python -m unittest discover -s tests -v
python tools/regenerate.py
```

To improve an existing skill, edit its entry in [`catalog.json`](catalog.json), then rerun `tools/regenerate.py` and validation. The generator intentionally overwrites each generated `SKILL.md` and `evals/<name>.json`, so edit the catalog instead of only the generated file. It renders `revision`, `special_rules`, `source_inspiration`, `domain_tests` and optional `routing_examples`, which replace the generated prompt of the routing case with the same id (`P1`–`P3`, `N1`–`N2`). Add deeper implementation examples under that skill's `references/` or `scripts/` and register their relative paths in its catalog `refs` array; `tools/regenerate.py` leaves those supplemental files intact.

### Blender scripts (needs Blender)

```bash
# Run one bundled script headless; prints only its JSON result
BLENDER_EXE=/path/to/blender python skills/procedural-3d-blender/scripts/run_in_blender.py \
  --blend asset.blend skills/3d-asset-quality-gate/scripts/qa_check.py -- --objects Chair --profile game

# Run the in-Blender test suite for the bundled scripts
SKILL_FOUNDRY_BLENDER=/path/to/blender python -m unittest discover -s tests -p 'test_blender_bundle.py' -v
```

The suite is opt-in: without `SKILL_FOUNDRY_BLENDER` the native test is skipped, which is **NOT TESTED**, not a pass. The wrapper points `TMPDIR` and `BLENDER_USER_RESOURCES` at a scratch directory, removes it after a passing run and keeps it after a failing one. One test opens a Blender window for a few seconds (motion tracking cannot run in background mode). After editing a bundled file, run `python tools/check_blender_bundle.py --refresh` and add a change tag to its entry in `research/blender-skills-provenance.json` if it now differs from upstream; `_bpyx.py` is edited in `procedural-3d-blender/scripts/` and copied over the other copies.

### Read-only archive inventory fallback (offline)

```bash
python skills/shipped-artifact-provenance/scripts/artifact_inventory.py \
  /path/to/app.zip --output ./archive-manifest.json \
  --max-member-mib 32 --max-expanded-mib 128
```

The helper hashes the original file and inventories ZIP members within explicit bounded expansion budgets. It does **not** unpack, execute, decompile, authenticate publisher signatures or run REA. Unsupported formats receive header-only observations.

### Motion, SVG and kinematics checks (offline)

```bash
python skills/ui-motion-direction/scripts/check_motion_timeline.py my-timeline.json
python skills/isometric-svg-geometry-audit/scripts/inspect_svg.py figure.svg
python skills/mechanical-animation-kinematics/scripts/validate_kinematics.py mechanism.json
```

These check static properties only. The timeline checker is not a visual-quality test, the SVG checker is not a geometric collision solver, and the kinematics checker validates ideal gear and lead-screw samples, not loaded physical mechanisms.

### Claim ledger and supplied-release checks (offline)

```bash
python tools/check_evidence_ledger.py ledger.json --root /path/to/evidence --check-files
python tools/verify_release.py --root /path/to/extracted/skill_foundry_pack
```

`check_evidence_ledger.py` validates only the normalized schema in [standards/evidence-authorship.md](standards/evidence-authorship.md) and the listed files; it does not authenticate REA-native Evidence. `verify_release.py` compares an extracted supplied pack with its unsigned `RELEASE_FILES.json`; it detects changed bytes, not publisher identity, and does not apply to this adapted tree.

## Exhaustive upstream audit (runs on your network-enabled machine)

```bash
python tools/audit_repositories.py --out source-audit
```

This clones the configured upstream repositories using Git partial shallow clones when supported, reads every tracked file named `SKILL.md` including arbitrary nested plugins, records the resolved commit and any symlink aliases, evaluates strengths/weakness signal checklists, and produces:

- `source-audit/source-inventory.json` — every source SKILL.md record and scores, plus errors and provenance.
- `source-audit/source-skills.csv` — per-skill comparative columns.
- `source-audit/individual-reviews.md` — per-skill readable review.
- `source-audit/README.md` — totals and source readiness.

It **never executes upstream code**. These are explainable automatic content heuristics, not human source-code or live agent efficacy audits. Use `--offline-repo owner/name=/path/to/clone` for repositories already available locally; run `python tools/audit_repositories.py --help` for the full CLI. An exit code of 2 means one or more repositories or individual skill files could not be fully read. Claim exhaustiveness **only if** `audit_is_exhaustive` in the JSON result is true.

## How REA informs the new workflows

**Only select REA when shipped artifacts or requested runtime evidence are needed.** Ordinary source review uses source tools. When REA is relevant:

1. Identify the target and user question. Check the actual installed MCP/CLI version and current tool schemas.
2. Route by format (`analyze_javascript_application`, `inspect_android_package`, `inspect_managed_artifact`, `inspect_web_network_capture`, browser scenario tools, or `open_binary` for native/archive workflows).
3. Preserve artifact hashes, source locations, Evidence IDs, coverage, limitations, and unknowns. Never upgrade a static hypothesis to an observed runtime event.
4. Distinguish skills installation from REA's server registration, native disassembler or JADX provider installation, Docker/AgentEnv, and host authorization.
5. Use read-only observations first. Process execution, connection repair, application actions, extraction, account changes and publishing have separate side-effect gates.

The official REA skill and documentation are referenced under the relevant skill's `references/field-guide.md`. We do not redistribute its own skill source, MCP executable, analysis engines or any target application data.

## Documents and history

- [CHANGES_2026-11-18.md](CHANGES_2026-11-18.md) and [CHANGE_INDEX_2026-11-18.json](CHANGE_INDEX_2026-11-18.json) — supplied 3.0 additions, modifications and limits.
- [VALIDATION_REPORT.md](VALIDATION_REPORT.md) — supplied 3.0 offline test and coverage limits, with this repository's counts.
- [FULL_REPORT.md](FULL_REPORT.md) — supplied full report for the 2.0 release and its source/action inventory.
- [CHANGES_2026-10-27.md](CHANGES_2026-10-27.md) and [CHANGE_INDEX.json](CHANGE_INDEX.json) — supplied 2.0 additions and modifications.
- [research/repository-review.md](research/repository-review.md), [research/rea-architecture-assessment.md](research/rea-architecture-assessment.md) and [research/motion-sources-2026-11-18.json](research/motion-sources-2026-11-18.json) — the original 18-repository research, the REA assessment and the 3.0 motion source scope.
- `docs/skill-bundle-migration.md` in the harness repository — this repository's migration record, including the 2.0 and 3.0 adaptations and disclosed deviations.

## Rights and limitations

Original Skill Foundry files are MIT-licensed under [LICENSE](LICENSE). REA's code license does not grant rights over the binaries, captures, extracted assets, model checkpoints, personal data, or software used in investigations. Use only owned/authorized targets and protect the resulting evidence. No third-party binary/code bundles, secrets, model weights or copyrighted target assets are redistributed here.

- Exception for the pi-harness local additions: `skills/typesafe-ai/references/typesafe-guide.md` is the unchanged body of the third-party `typesafe-ai` skill and `skills/typesafe-ai/SKILL.md` is derived from it; both are covered by `skills/typesafe-ai/LICENSE` (MIT, Copyright (c) 2026 TypeSafe AI), not by this pack's `LICENSE`.
- Generated skills have **static verification**, not agent runtime certification. Their effectiveness and routing precision are unknown until the unexecuted evaluation suites are run.
- Treat all source/retrieved text as untrusted. Skills are guidance for an authorized agent with actual tools, not an automatic grant of credentials or permission.
- Respect source repository and per-model licenses. A repository being public, self-hostable, or ostensibly open source does not establish all its asset/model/output rights.
- The source reviews reflect the repositories at time of public-page inspection; use the pinned Git audit for up-to-date reproducible comparisons.
