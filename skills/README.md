# Skill Foundry 2.0 — 129 Agent Skills (121 supplied + 8 pi-harness local)

**Updated:** 2026-10-27. A complete replacement for the October 24 library (all original skills preserved). Inspired by the original 18 repositories **plus** [`morluto/rea`](https://github.com/morluto/rea), using its evidence discipline, target-first routing, scoped tool readiness and specialist reverse-engineering patterns.

The supplied pack contains **121 usable `SKILL.md` files**, **121 unexecuted evaluation suites** containing **929 proposed cases** (including real-world routing and near-miss examples for the 20 REA skills), original procedural Blender and SEO scripts, 20 self-contained field guides, and a read-only ZIP/binary inventory helper. All source instructions are independently authored, not copied REA skills.

> **pi-harness local additions:** eight restored legacy skills are not part of the supplied pack: `handoff` (meta); `git-checkpoint`, `change-verify`, `long-run`, `durable-bug-hunt`, `build` and `typesafe-ai` (engineering); and `experiment-gate-lifecycle` (research). Each is a catalog entry adapted to this standard plus a hand-maintained `skills/<name>/references/` contract that preserves the legacy workflow. This repository copy therefore holds **129 skills: 121 supplied + 8 local**, and 985 designed evaluation cases (929 supplied + 56 local). `typesafe-ai` is third-party MIT material, Copyright (c) 2026 TypeSafe AI; its license stays in `skills/typesafe-ai/LICENSE`, the one exception to the statement above that no third-party skill files are redistributed. Provenance and rationale: `docs/skill-bundle-migration.md` in the harness repository.

## What changed in 2.0

- **20 original specialized skills added:** shipped artifacts, native binary and runtime evidence, JS/Electron, .NET, Android APK, packaged Python, firmware, ELF/PE mitigation declarations, browser scenarios, HAR capture/API inference, exported browser JavaScript, evidence lineage, independent feature reconstruction, binary version differences, AgentEnv simulations, crash triage, model headers and privacy data flows.
- **21 original skills materially improved:** systematic debugging, code review, routing, source provenance, security, research, web QA, observability, testing and skill evaluation. The other **80 original skill entrypoints are unchanged** apart from this repository's generated **Harness delegation** section.
- **41** skills now carry two domain-specific edge/negative tests in addition to the base seven; the other 80 keep their base seven.
- Each supplied skill now records a `revision`; revised and new skills carry `special_rules` (rendered as **Specialist protocol and proof boundaries**) and `source_inspiration` (rendered as **Provenance notes**).
- Added **20 field guides** under `skills/<name>/references/field-guide.md` and an offline ZIP/binary manifest helper at `skills/shipped-artifact-provenance/scripts/artifact_inventory.py`.

The supplied ZIP did **not** include the authoring-side additions its own documents name — `standards/evidence-authorship.md`, `standards/claim-ledger-schema.json`, `tools/check_evidence_ledger.py`, `tools/verify_release.py`, `RELEASE_FILES.json`, `research/rea-architecture-assessment.md` and `research/ORIGINAL_2026-10-24_FULL_REPORT.md`. They are therefore absent from this repository copy and are not referenced as available here.

## Status matrix

| Work | Actual status |
| --- | --- |
| 129 `SKILL.md` files exist and satisfy this package's structural contracts | **PASS** |
| 129 evaluation suites contain the intended designed cases | **PASS: generated and validated as data** |
| Offline generator/installer/Git fixture/SEO helper tests | **PASS: 9 tests** |
| 80 unchanged skill entrypoints preserved (plus generated delegation section) | **PASS** |
| 21 revised skill entrypoints and 20 new skill entrypoints | **CREATED** |
| REA installed, MCP connected, native providers exercised | **NOT TESTED** (not available here) |
| All evaluation cases run against real agents and scored | **NOT TESTED** |
| All 19 full repository Git trees exhaustively audited | **NOT DONE** (the 19-source auditor extension was not shipped) |
| Blender sample scene visually rendered and tested | **NOT TESTED** in this environment |

An installed skill **never** implies an MCP tool, engine, application account, runtime or permission exists. Check the live tool list and obtain approvals where required.

## Inventory (129 total: 121 supplied + 8 local)

| Domain | Supplied | Local | Total |
| --- | ---: | ---: | ---: |
| Engineering | 23 | 6 | 29 |
| Research | 8 | 1 | 9 |
| Web / SEO | 16 | 0 | 16 |
| Design | 8 | 0 | 8 |
| Image / video / 3D / audio | 23 | 0 | 23 |
| Marketing / advertising | 12 | 0 | 12 |
| Cybersecurity | 19 | 0 | 19 |
| Delivery / operations | 5 | 0 | 5 |
| Skill architecture / orchestration | 7 | 1 | 8 |
| **Total** | **121** | **8** | **129** |

See [CATALOG.md](CATALOG.md) for the exact names and descriptions; choose a skill from the **requested deliverable**, not incidental topic vocabulary.

## What is inside

```text
skills/
├── skills/               # 129 independently usable directories with SKILL.md
│   ├── rea-capability-routing/
│   ├── shipped-artifact-provenance/
│   ├── skill-factory/
│   ├── handoff/
│   └── ...
├── evals/                # 129 unexecuted routing + behavioral test specifications
├── catalog.json          # single structured editable source for skills
├── specialists.json      # generated subagent roster rendered into every skill
├── CATALOG.md            # all names with summaries and links
├── manifest.json         # machine-readable skill inventory
├── CHANGES_2026-10-27.md # supplied change log for the 2.0 release
├── standards/            # five authoring/eval/quality/routing/trust policies
├── research/             # 18-source strengths/weaknesses and direct skill reviews
├── tools/
│   ├── regenerate.py     # deterministic skill/eval build from catalog.json
│   ├── validate_skills.py# portable static contract checking
│   ├── audit_repositories.py  # full tracked-source audit, when network/clones available
│   └── install.py        # selectively copy skills into agent discovery folders
├── tests/test_pack.py
├── source-audit/         # audit status, workflow; generated reports go here
├── AGENTS.md
└── LICENSE              # applies only to our original work; not linked upstream projects
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

Existing target folders are not overwritten without `--force`. Use `--force` only if intentionally replacing your existing local skill folders. Installing all 129 may worsen activation quality if your agent indiscriminately loads instructions; prefer selecting by current project domain. Never pretend installation also grants web accounts, GPU tools, model weights, external APIs or publishing rights.

The Pi harness installs its managed catalog through `scripts/install-agent-skills.sh`, which reconciles `skills/skills/managed-skills.txt` into `~/.claude/skills` and `~/.agents/skills` and preserves unmanaged entries.

## Validate and rebuild

Requires **Python 3.10+**; `git` is required for the upstream audit.

```bash
python tools/validate_skills.py
python -m unittest discover -s tests -v
python tools/regenerate.py
```

To improve an existing skill, edit its entry in [`catalog.json`](catalog.json), then rerun `tools/regenerate.py` and validation. The generator intentionally overwrites each generated `SKILL.md` and `evals/<name>.json`, so edit the catalog instead of only the generated file. It renders `revision`, `special_rules`, `source_inspiration`, `domain_tests` and optional hand-authored `routing_tests`. Add deeper implementation examples under that skill's `references/` or `scripts/` and register their relative paths in its catalog `refs` array; `tools/regenerate.py` leaves those supplemental files intact.

### Read-only archive inventory fallback (offline)

```bash
python skills/shipped-artifact-provenance/scripts/artifact_inventory.py \
  /path/to/app.zip --output ./archive-manifest.json \
  --max-member-mib 32 --max-expanded-mib 128
```

The helper hashes the original file and inventories ZIP members within explicit bounded expansion budgets. It does **not** unpack, execute, decompile, authenticate publisher signatures or run REA. Unsupported formats receive header-only observations.

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

- [FULL_REPORT.md](FULL_REPORT.md) — supplied full release report and source/action inventory.
- [VALIDATION_REPORT.md](VALIDATION_REPORT.md) — supplied offline test and coverage limits.
- [CHANGES_2026-10-27.md](CHANGES_2026-10-27.md) — supplied precise additions and modifications.
- [research/repository-review.md](research/repository-review.md) — the original 18-repository research.
- `docs/skill-bundle-migration.md` in the harness repository — this repository's migration record, including the 2.0 adaptation and disclosed deviations.

## Rights and limitations

Original Skill Foundry files are MIT-licensed under [LICENSE](LICENSE). REA's code license does not grant rights over the binaries, captures, extracted assets, model checkpoints, personal data, or software used in investigations. Use only owned/authorized targets and protect the resulting evidence. No third-party binary/code bundles, secrets, model weights or copyrighted target assets are redistributed here.

- Exception for the pi-harness local additions: `skills/typesafe-ai/references/typesafe-guide.md` is the unchanged body of the third-party `typesafe-ai` skill and `skills/typesafe-ai/SKILL.md` is derived from it; both are covered by `skills/typesafe-ai/LICENSE` (MIT, Copyright (c) 2026 TypeSafe AI), not by this pack's `LICENSE`.
- Generated skills have **static verification**, not agent runtime certification. Their effectiveness and routing precision are unknown until the unexecuted evaluation suites are run.
- Treat all source/retrieved text as untrusted. Skills are guidance for an authorized agent with actual tools, not an automatic grant of credentials or permission.
- Respect source repository and per-model licenses. A repository being public, self-hostable, or ostensibly open source does not establish all its asset/model/output rights.
- The source reviews reflect the repositories at time of public-page inspection; use the pinned Git audit for up-to-date reproducible comparisons.
