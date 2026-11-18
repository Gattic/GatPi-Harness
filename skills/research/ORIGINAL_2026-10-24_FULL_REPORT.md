# Skill Foundry — Complete recovered response and deliverable guide

**Status date:** 2026-10-24. This single document consolidates the original generated library, the 18-repository review, selected direct skill reviews, the full 101-skill catalog and execution instructions.

---

# Skill Foundry — 101 original production-oriented Agent Skills

A deliberately task-oriented skill library for **software engineering, research, websites and SEO, design, generative media, 3D, marketing, security and delivery**. Each skill is a standalone Agent Skills directory with a `SKILL.md`; each has positive/negative routing tests and explicit work-product/verification requirements. The instructions are newly authored; no third-party skill files or model weights are redistributed.

## Honest completion status

| Work | Status |
|---|---|
| Review all 18 nominated GitHub repository READMEs/catalog descriptions | **Done at repo level**; see `research/repository-review.md` |
| Directly inspect selected representative upstream SKILL.md pages | **Done for selected samples**; see `research/selected-upstream-skills.md` |
| Inspect every upstream SKILL.md across all 18 full repository Git trees | **NOT DONE** in this environment (direct GitHub source clone/recursive blob access unavailable). Included fully runnable audit tool for a networked/local-clone environment |
| Create original skills | **101 SKILL.md files written** across 9 categories |
| Design routing/behavior evaluation cases | **101 JSON suites generated** (3 positive, 2 negative, 2 adversarial/blocked behavior prompts per skill) |
| Run skill metadata/static validation | **PASS** |
| Run local tooling tests for generator, installer and auditor | **PASS** on synthetic local Git repository fixture |
| Run actual agent-level routing/behavior tests for 101 skills | **NOT DONE**; test suites are proposals, not evidence of agent performance |
| Run Blender sample render | **NOT DONE** (Blender/`bpy` unavailable in this environment) |
| Run SEO helper on local HTML fixture | **PASS**; public-site crawler remains unverified against a live origin |

## What is inside

```text
skill_foundry_pack/
├── skills/               # 101 independently usable directories with SKILL.md
│   ├── skill-factory/
│   ├── secure-code-review/
│   ├── seo-technical-audit/
│   ├── procedural-3d-blender/
│   ├── comfyui-graph-engineering/
│   └── ...
├── evals/                # 101 unexecuted routing + behavioral test specifications
├── catalog.json          # single structured editable source for skills
├── CATALOG.md            # all names with summaries and links
├── manifest.json         # machine-readable skill inventory
├── standards/            # five authoring/eval/quality/routing/trust policies
├── research/             # 18-source strengths/weaknesses and 9 direct skill reviews
├── tools/
│   ├── regenerate.py     # deterministic skill/eval build from catalog.json
│   ├── validate_skills.py# portable static contract checking
│   ├── audit_repositories.py  # full tracked-source audit, when network/clones available
│   └── install.py        # selectively copy skills into agent discovery folders
├── tests/test_pack.py
├── source-audit/          # audit status, workflow; generated reports go here
├── AGENTS.md
└── LICENSE              # applies only to our original work; not linked upstream projects
```

## Inventory (101 total)

| Domain | Skills |
|---|---:|
| Engineering | 16 |
| Research | 7 |
| Web & SEO | 14 |
| Design | 8 |
| Media / 3D / audio / image / video | 22 |
| Marketing | 12 |
| Security | 12 |
| Delivery / operations | 5 |
| Meta / skill authoring / orchestration | 5 |
| **Total** | **101** |

See [CATALOG.md](CATALOG.md) to discover exact names and choose a skill based on the **requested deliverable**, not incidental topic vocabulary.

## Install only what you need

Agent Skills implementations differ in local discovery paths. Choose the correct path for your agent/version; for example, many Codex-style projects scan `.agents/skills/`, Claude Code projects scan `.claude/skills/`, and Cursor projects may use `.cursor/skills/`.

```bash
# From the unzipped package root:
python tools/install.py --list
python tools/install.py --target /path/to/project/.agents/skills \
  --skill technical-specification \
  --skill test-driven-implementation \
  --skill secure-code-review

# Preview before opting into installing the entire library:
python tools/install.py --target /path/to/project/.agents/skills --all --dry-run
```

Use `--force` only if intentionally replacing your existing local skill folders. Installing all 101 may worsen activation quality if your agent indiscriminately loads instructions; prefer selecting by current project domain. Never pretend installation also grants web accounts, GPU tools, model weights, external APIs or publishing rights.

## Validate and rebuild

Requires **Python 3.10+**; `git` is required for the upstream audit.

```bash
python tools/validate_skills.py
python -m unittest discover -s tests -v
python tools/regenerate.py
```

To improve an existing skill, edit its entry in [`catalog.json`](catalog.json), then rerun `tools/regenerate.py` and validation. The generator intentionally overwrites each generated `SKILL.md` and `evals/<name>.json`, so edit the catalog instead of only the generated file. Add deeper implementation examples under that skill's `references/` or `scripts/` and register their relative paths in its catalog `refs` array. `tools/regenerate.py` leaves those supplemental files intact.

## Exhaustive upstream audit (runs on your network-enabled machine)

```bash
python tools/audit_repositories.py --out source-audit
```

This clones **all 18** exact repositories using Git partial shallow clones when supported, reads every tracked file named `SKILL.md` including arbitrary nested plugins, records the resolved commit and any symlink aliases, evaluates strengths/weakness signal checklists, and produces:

- `source-audit/source-inventory.json` — every source SKILL.md record and scores, plus errors and provenance.
- `source-audit/source-skills.csv` — per-skill comparative columns.
- `source-audit/individual-reviews.md` — per-skill readable review.
- `source-audit/README.md` — totals and source readiness.

It **never executes upstream code**. These are explainable automatic content heuristics, not human source-code or live agent efficacy audits. Use `--offline-repo owner/name=/path/to/clone` for repositories already available locally; run `python tools/audit_repositories.py --help` for the full CLI. An exit code of 2 means one or more repositories or individual skill files could not be fully read. Claim exhaustiveness **only if** `audit_is_exhaustive` in the JSON result is true. Git submodules, undocumented remote releases, and non-`SKILL.md` agent files need separate review.

## Representative domain workflows

**Build secure web functionality:** `technical-specification` → `security-threat-model` → `api-contract-engineering` → `test-driven-implementation` → `accessible-interface-build` → `browser-qa-cross-device` → `acceptance-quality-release`.

**Launch an SEO-ready website:** `website-discovery-architecture` → `responsive-design-system` → `seo-technical-audit` → `structured-data-schema` → `analytics-conversion-instrumentation` → `go-to-market-launch`.

**Create a mixed-media advertising campaign:** `market-segmentation` → `positioning-message-architecture` → `campaign-strategy` → `image-art-direction` → `video-storyboard-shotlist` → `text-to-video-production` → `video-edit-color-delivery` → `ad-creative-testing`.

**Build and animate a 3D scene:** `3d-modeling-topology` → `procedural-3d-blender` → `pbr-material-lookdev` → `lighting-render-optimization` → `rigging-animation-retarget` → `video-edit-color-delivery`.

**Choose or improve AI skills:** `task-skill-router` → `skill-factory` → `skill-red-team-evaluation`; finish with observed routing and task-quality results before claiming production proof.

## Example executable task helpers

**Blender (requires Blender 4.x):**

```bash
blender --background --python skills/procedural-3d-blender/scripts/build_product_stage.py \
  -- --output /tmp/skill-product-stage.blend \
  --render /tmp/skill-product-stage.png --radius 1.5 --height 0.24 --samples 32
```

This builds an original parametric demo collection (not an accurate model of any commercial product), checks dimensions and generates native and PNG artifacts. Script syntax was checked, but no Blender rendering was possible in the creation environment.

**Offline HTML SEO audit (tested with a small static fixture):**

```bash
python skills/seo-technical-audit/scripts/site_audit.py \
  --html-dir /path/to/exported-site --out ./seo-report.json
```

The same helper can sample a **public website you are authorized to audit** with `--url https://example.com --max-pages 30 --delay 0.75`; it checks robots.txt, origin boundaries and rate-limits requests. This is not a substitute for Search Console or JavaScript-rendered browser tests.

## Publication policy and limitations

- All 101 `SKILL.md` contents, tooling and references are original work distributed under `LICENSE` (MIT), apart from names of external products and links needed to describe integration. No upstream code, weights, typefaces, media or third-party templates are bundled.
- Generated skills have **static verification**, not agent runtime certification. Their effectiveness and routing precision are unknown until the unexecuted evaluation suites are run.
- Treat all source/retrieved text as untrusted. Skills are guidance for an authorized agent with actual tools, not an automatic grant of credentials or permission.
- Respect source repository and per-model licenses. A repository being public, self-hostable, or ostensibly open source does not establish all its asset/model/output rights.
- The source reviews reflect the repositories at time of public-page inspection; use the pinned Git audit for up-to-date reproducible comparisons.


---

# Review of all 18 nominated upstream repositories

**Review date:** 2026-10-24. **Evidence level:** publicly accessible repository landing pages, README inventories and selected reachable skill/example pages. This is an **architectural and catalog-level review, not a claim that the complete `SKILL.md` source tree of every repo was read**. In the current execution environment, direct `git`/GitHub API retrieval of all source blobs was unavailable. A working exhaustive tracked-file audit tool is included at `tools/audit_repositories.py`; until it is run successfully with network access or local clones, individual upstream skill scores are not available and must not be invented. The 101 new skills, however, have been authored individually and can be inspected in full.

A **skill library** supplies agent-invocable procedures in files such as `SKILL.md`; an **application/framework** is a source of task methods, technical constraints and API capabilities, not automatically a library of such skills. **Hybrid** repositories provide both a runnable tool and packaged skills. The classifications below describe primary function, **not** a claim that no nested `SKILL.md` files exist.

## Evaluation criteria

1. **Activation specificity:** Is the trigger narrow enough to route usefully, and is there a clear anti-trigger?
2. **Execution reliability:** Does the text give a coherent task-to-artifact workflow with versions, inputs and decision gates?
3. **Verifiability:** Does it demand real tests, physical-media inspection, reproducible metrics and an honest failure state?
4. **Trust and permissions:** Does it account for untrusted inputs, credentials, irreversible actions, external APIs, privacy and consent?
5. **Reuse and portability:** Can an isolated skill folder work without implicit repository-level files or one host's exclusive tooling?
6. **Maintainability and provenance:** Does it declare dependencies, supported versions, licenses, ownership and update expectations?
7. **Usefulness:** Does it solve a distinct recurring problem rather than restating general professional advice?

These are **criteria and repo-level observations**. The scanner applies an explicitly limited, explainable **0–5 per dimension** text heuristic to every available upstream skill; it does not substitute for agent trials.

## Source-by-source evaluation

### 01 — Comfy-Org/ComfyUI
- **Kind:** application/graph framework. **Best use:** image/video/audio/3D pipelines, node graphs, GPU inference and repeatable media generation.
- **Strength:** graph composition makes model steps and data paths inspectable; native workflows and API routes supply concrete integration constraints.
- **Weakness:** model checkpoints, extensions, CUDA/VRAM limits and version drift make seemingly simple workflows brittle; graph correctness is not the same as aesthetic/fidelity correctness.
- **Borrowed pattern:** version-and-model manifests, explicit node graph contracts, seed/parameter logging, import-and-run validation and output inspection.
- **Our derived skills:** `comfyui-graph-engineering`, `image-generation-iteration`, `generative-model-evaluation`.
- **Source:** https://github.com/Comfy-Org/ComfyUI

### 02 — obra/superpowers
- **Kind:** engineering skills and methodology. **Best use:** discovery, planning, systematic debugging, test-driven implementation, verification and review.
- **Strength:** separates cognitive phases (design, test, implementation, review); emphasizes evidence before declaring done and makes small actionable handoffs.
- **Weakness:** full ceremonies can overfit trivial tasks; some workflows depend on subagents, git worktrees or host integrations not installed everywhere.
- **Borrowed pattern:** scope work by task complexity, verify before claiming completion, isolate debugging hypotheses, and retain a fall-back sequential path.
- **Our derived skills:** `test-driven-implementation`, `systematic-debugging`, `implementation-plan`, `code-review-evidence`.
- **Source:** https://github.com/obra/superpowers

### 03 — mattpocock/skills
- **Kind:** engineering/productivity agent skills. **Best use:** research, architecture, specifications, decomposition, implementation, triage and reviews.
- **Strength:** expressive named workflows and practical incremental engineering stages; makes engineering uncertainty and problem framing explicit.
- **Weakness:** interactive discovery is valuable but may ask too many questions when context is already sufficient; some flows inherit tracker/project setup assumptions.
- **Borrowed pattern:** preserve problem vocabulary, give each deliverable one owner, ask only blocking questions, and make ticket/handoff contracts reviewable.
- **Our derived skills:** `codebase-onboarding`, `technical-specification`, `domain-driven-architecture`, `requirements-to-roadmap`.
- **Source:** https://github.com/mattpocock/skills

### 04 — addyosmani/agent-skills
- **Kind:** engineering agent-skill library. **Best use:** disciplined end-to-end software delivery and frontend/backend quality.
- **Strength:** broad lifecycle coverage, explicit red–green–refactor, source-driven work, and a publishable approach to positive/negative activation tests.
- **Weakness:** shared repository-level references can be missing from a single-skill installation (acknowledged in its README); some heavyweight procedures can cost more than they save.
- **Borrowed pattern:** isolated packaging, evidence and counterexample eval cases, anti-rationalization and explicit quality gates; **do not** rely on hidden shared `references/` directories.
- **Our derived skills:** `skill-factory`, `skill-red-team-evaluation`, `code-review-evidence`, `ci-release-engineering`.
- **Source:** https://github.com/addyosmani/agent-skills

### 05 — anthropics/skills
- **Kind:** general-purpose skill examples, authoring tooling and domain-specific document/media workflows.
- **Strength:** concise activation descriptions, progressive disclosure, optional executable helpers and artifact-oriented instructions.
- **Weakness:** some workflows are tightly coupled to file-processing runtimes or model/tool affordances; **licensing varies by skill or resource**, and public availability does not make everything freely redistributable.
- **Borrowed pattern:** short self-contained `SKILL.md`, optional `references/`/`scripts/` only if justified, and precise output-format contracts.
- **Our derived skills:** `skill-factory`, `source-license-provenance`, `acceptance-quality-release`.
- **Source:** https://github.com/anthropics/skills

### 06 — vercel-labs/agent-skills
- **Kind:** specialized frontend/web skills. **Best use:** React patterns, web-design reviews, rendering performance and frontend conventions.
- **Strength:** specificity makes many rules actionable; focuses on perceptible web experience rather than generic developer roleplay.
- **Weakness:** ecosystem-specific assumptions can be irrelevant to static websites or non-React stacks; performance recommendations must be validated in target environment.
- **Borrowed pattern:** technology-specific recipes with relevance gates, user-experience outcomes and measurable browser checks.
- **Our derived skills:** `frontend-state-architecture`, `web-performance-core-vitals`, `accessible-interface-build`, `responsive-design-system`.
- **Source:** https://github.com/vercel-labs/agent-skills

### 07 — openai/skills
- **Kind:** Codex skill catalog, historical source. **Best use:** examples of packaging, skill distribution and system/curated/experimental partitions.
- **Strength:** concrete conventions for reusable skill directories and opt-in installation.
- **Weakness:** **repository README explicitly marks it deprecated** and directs developers to current OpenAI Plugins resources; do not treat its installer instructions or bundled skills as the newest official practice. Check directory-level license files before redistribution.
- **Borrowed pattern:** portable directory layout and separated experimental/curated quality stages, without copying the repository's outdated installation guidance.
- **Our derived skills:** `skill-factory`, `task-skill-router` and the manifest/catalog tooling.
- **Source:** https://github.com/openai/skills

### 08 — trailofbits/skills
- **Kind:** nested security skills/plugin marketplace. **Best use:** rigorous auditing, vulnerability triage, exploitability analysis, source-to-sink reasoning and defensive validation.
- **Strength:** deep specialization, false-positive management, static analysis, secure coding reviews and testing-oriented evidence.
- **Weakness:** substantial tool, domain and host expertise prerequisites; some procedures require explicit authorized scope. **The repository lists CC-BY-SA-4.0**, so copying upstream prose into an unrelated MIT skill pack would create licensing issues.
- **Borrowed pattern:** threat model, concrete evidence, reproducibility, bounded authorized tests and severity grounded in actual preconditions. All our instructions are written independently.
- **Our derived skills:** `secure-code-review`, `security-threat-model`, `application-fuzz-testing`, `dependency-supply-chain-security`, `security-incident-response`.
- **Source:** https://github.com/trailofbits/skills

### 09 — supabase/agent-skills
- **Kind:** narrow database/platform skills. **Best use:** Supabase workflow integration and PostgreSQL design/performance.
- **Strength:** focused data-platform expertise with useful schema, query and access control concerns.
- **Weakness:** platform-specific features should not be mistaken for universal SQL defaults; tenant security cannot be proven using only privileged/service credentials.
- **Borrowed pattern:** engine-specific access matrices, practical role-based negative tests, actual query plans and safe expand/migrate/contract rollout.
- **Our derived skills:** `postgres-schema-rls`, `safe-database-migrations`, `api-contract-engineering`.
- **Source:** https://github.com/supabase/agent-skills

### 10 — debpalash/VoiceStudio
- **Kind:** local-first voice application. **Best use:** synthesis, authorized voice cloning, dubbing and multilingual voice workflows.
- **Strength:** unified production workflow; repo explicitly distinguishes application rights, model/voice rights and authorization of voice clones.
- **Weakness:** variable model, OS, hardware and voice quality; **AGPL-3.0 application license does not grant all model/voice rights**. Cloning requires speaker permission.
- **Borrowed pattern:** provenance for voice models and samples, pronunciation lexicon, listen tests, privacy-aware local/cloud choice, revocation plans.
- **Our derived skills:** `text-to-speech-voice-direction`, `voice-clone-consent`, `multilingual-dubbing-localization`.
- **Source:** https://github.com/debpalash/VoiceStudio

### 11 — OpenBMB/VoxCPM
- **Kind:** research/model implementation for multilingual TTS and voice design.
- **Strength:** strong inspiration for fine-grained speech control and reference-based voice consistency.
- **Weakness:** model-card and checkpoint conditions may differ from code license; speech output quality and identity similarity are not guaranteed by prompts or demo clips.
- **Borrowed pattern:** pin model checkpoints, segment long audio, audit pronunciation and acoustic artifacts, and separate speaker consent from technical cloning support.
- **Our derived skills:** `text-to-speech-voice-direction`, `generative-model-evaluation`.
- **Source:** https://github.com/OpenBMB/VoxCPM

### 12 — openwhispr/openwhispr
- **Kind:** privacy-oriented dictation application. **Best use:** speech-to-text with local or optional hosted engines.
- **Strength:** local/cloud tradeoff and a tangible end-user transcription workflow.
- **Weakness:** speech recognition may mishandle names, numbers, accents, overlap and code-switching; cloud option alters privacy boundaries.
- **Borrowed pattern:** clear ASR provider choice, exact transcript uncertainty markers, protected storage and human spot-checks.
- **Our derived skills:** `speech-transcription-diarization`, `privacy-data-minimization`.
- **Source:** https://github.com/openwhispr/openwhispr

### 13 — freemocap/freemocap
- **Kind:** motion-capture application/framework. **Best use:** camera-based 3D pose trajectories and animation/biomechanics handoffs.
- **Strength:** calibration, synchronized recording, coordinate conventions and measurable reconstruction are ideal procedural skill ingredients.
- **Weakness:** camera placement, occlusion, synchronization and uncertainty strongly affect quality; 3D trajectories are not instantly clean retarget-ready animations.
- **Borrowed pattern:** calibration evidence, reprojection error, confidence flags and separate motion cleanup/retarget tasks.
- **Our derived skills:** `multi-camera-motion-capture`, `rigging-animation-retarget`.
- **Source:** https://github.com/freemocap/freemocap

### 14 — nikopueringer/CorridorKey
- **Kind:** video-keying tool/research application. **Best use:** foreground segmentation and high-quality green-screen matting.
- **Strength:** emphasizes the difficult boundary between mask confidence, edge detail and compelling compositing.
- **Weakness:** temporal artifacts, fine hair, motion blur, spill, GPU constraints and alpha-format assumptions can ruin otherwise convincing still frames.
- **Borrowed pattern:** dual matte/edge inspection, multi-background tests, temporal validation, explicit straight-versus-premultiplied alpha handling.
- **Our derived skills:** `greenscreen-keying`, `image-edit-compositing`.
- **Source:** https://github.com/nikopueringer/CorridorKey

### 15 — latent-spaces/brag
- **Kind:** packaged agent skills plus short launch-video production. **Best use:** transforming completed software projects into shareable product demo videos.
- **Strength:** unusually concrete end artifact, narrative/shot constraints and multi-output delivery (plan, creative brief, share copy, rendered video). The repo explicitly mentions `brag` and `brag-slim` skill variants.
- **Weakness:** depends on actual project/demo readiness and compatible video rendering; tightly coupled model or renderer assumptions can reduce portability.
- **Borrowed pattern:** project-first creative research, timeboxed storyboards, share-ready assets, slim skill dispatch and render-verification gate.
- **Our derived skills:** `video-storyboard-shotlist`, `go-to-market-launch`, `video-edit-color-delivery`.
- **Source:** https://github.com/latent-spaces/brag

### 16 — Autom8AI/Open-Higgsfield-AI
- **Kind:** image/video studio application. **Best use:** multi-model creative experiments and storyboard-to-shot workflows.
- **Strength:** comparative provider/model interface and reference-driven creative pipeline encourage meaningful production experimentation.
- **Weakness:** **self-hosting the UI is not equivalent to local model inference**: its README describes requests to an external Muapi API using API keys. Data privacy, costs, model availability and provider terms must be assessed independently.
- **Borrowed pattern:** provider-capability matrix, image/reference authenticity, credit/cost guardrails, async generation status honesty and per-shot quality checks.
- **Our derived skills:** `generative-model-evaluation`, `text-to-video-production`, `asset-rights-content-authenticity`.
- **Source:** https://github.com/Autom8AI/Open-Higgsfield-AI

### 17 — heygen-com/hyperframes
- **Kind:** video framework **and** packaged skills. **Best use:** deterministic HTML/CSS/motion video generation with CLI render and asset references.
- **Strength:** explicit plan → code → check → preview → render production loop; current README catalogs seven published skills and differentiates core versus on-demand modules; seekable animation supports deterministic testing.
- **Weakness:** framework-specific CLI, dependencies and possibly hosted integrations; `SKILL.md` should not pretend to be a native video renderer. Source includes additional internal agent skills distinct from published modules.
- **Borrowed pattern:** typed render contract, reusable media block registry, exact output playback checks, and selective skill loading.
- **Our derived skills:** `video-edit-color-delivery`, `video-storyboard-shotlist`, `asset-rights-content-authenticity`, `task-skill-router`.
- **Source:** https://github.com/heygen-com/hyperframes

### 18 — opf/openproject
- **Kind:** full project-management application. **Best use:** project milestones, work packages, ownership, boards, roadmaps and coordination.
- **Strength:** robust project-level structure for large engineering/creative programs and measurable handoff ownership.
- **Weakness:** work item creation without permissions, owners, correct dependencies or acceptance evidence becomes administrative overhead; project API details are version-specific.
- **Borrowed pattern:** value-linked work packages, blocked-dependency tracking, risk register, release gates and not marking work complete without proof.
- **Our derived skills:** `openproject-delivery`, `requirements-to-roadmap`, `risk-register-governance`.
- **Source:** https://github.com/opf/openproject

## Patterns we adopted

| Adopt | Why it matters | How it appears in this library |
|---|---|---|
| **Narrow routing with anti-routing** | Prevents calling irrelevant skills | Every description and `Activation boundary` has a use and a *do not use* condition |
| **Specific job and deliverable** | Reduces vague role-playing advice | Each skill names concrete files/specs/assets and acceptance tests |
| **Evidence before success** | Prevents hallucinated completion | PASS/FAIL/NOT TESTED/BLOCKED convention and verification gate |
| **Source/rights boundaries** | Prevents copied licenses, unconsented media and unsafe actions | Original instructions, consent checks, provenance skill and publication gates |
| **Progressive disclosure** | Avoids huge initial context | One `SKILL.md` per specialty, searchable catalog, optional cross-skill routing |
| **Version and environment checks** | Prevents tool/SDK drift | Environment pinned in ComfyUI, browser, ASR, cloud, 3D, DB and CI workflows |
| **Negative and adversarial evaluations** | Guards against over-triggering and injection | 101 JSON suites, each with 3 positive, 2 negative and 2 behavior-oriented tests |
| **Offline/blocked contingency** | Keeps work useful with limited tools | Dedicated failure-handling section in each skill |
| **DAG handoffs, not agent swarms** | Reduces merge conflicts and tool overreach | `task-skill-router` and `multi-agent-delegation` |
| **Measurable domain QA** | Pixel, mesh, audio and security quality cannot be assumed | Color/sync/QC, topology checks, role isolation tests, data provenance |

## Anti-patterns and rejected features

- **Do not** clone long upstream SKILL documents into a new license domain. Derive ideas and independently implement methods, respecting per-file rights.
- **Do not** write a single thousand-line “expert at everything” skill; activation becomes ambiguous and irrelevant instructions contaminate context.
- **Do not** claim every source skill is equally useful. Specialized tools are highly valuable for matching contexts and noise elsewhere.
- **Do not** include unconditional untrusted-shell execution, remote downloads, account mutations, production deployment, voice cloning or paid API calls.
- **Do not** confuse static lint scores or invented benchmark figures with actual agent-level behavior or verified creative output.
- **Do not** trust default app labels like “free,” “private” or “local” without checking hosted generation, API keys, telemetry and model terms.
- **Do not** hard-require a specific host's subagent orchestration when a sequential equivalent is workable.
- **Do not** assume running a skill once proves portability, determinism, accessibility or security.

## Remaining work to meet the literal exhaustive-audit requirement

1. With reliable GitHub access run `python tools/audit_repositories.py --out source-audit`. It visits **all 18** repositories and recursively reads **every tracked file named `SKILL.md`**, including nested plugin trees, pinning each repository commit. The report contains **one section per upstream SKILL.md**, a CSV and JSON dataset.
2. Investigate nested directories, Git submodules and symlink aliases where `SKILL.md` may be exposed by multiple agents. The automated scan is a tracked-file audit, not a magic universal scan of remote releases or submodule contents.
3. Independently read and behavior-test high-priority upstream skills (not only regex scoring), using identical realistic positive/negative prompts. Compare measured activation precision and task success rates with our original skills.
4. Resolve individual notices for scripts, weights, templates, images, and licensed model outputs before importing **any upstream bytes** into this pack; this distribution intentionally bundles none.

Without those steps completed, a claim to have inspected each individual source skill for its full quality would be misleading. The new original skill pack is ready for inspection and further testing separately from the pending exhaustive upstream audit.


---

# Selected upstream SKILL.md direct reviews

**Checked against publicly indexed GitHub individual-file pages on 2026-10-24.** This page records a small, deliberately chosen sample of specific upstream skill documents. It does **not** imply every SKILL.md in the 18 repositories was inspected. Links reference live default branches rather than pinned commits; full immutable revision inventories require `tools/audit_repositories.py` on a network-enabled host. The takeaways below are our independent analysis, not copied skill text.

| Upstream skill | Direct file | Strengths worth learning | Limitations or pitfalls | Derived application |
|---|---|---|---|---|
| Anthropic `skill-creator` | https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md | Intent elicitation, metadata-based activation, progressive disclosure, iterative test/evaluate loop | Overlong interviews can obstruct already-specified requests; test existence alone is not observed performance | `skill-factory`, routing tests, optional references |
| obra `systematic-debugging` | https://github.com/obra/superpowers/blob/main/skills/systematic-debugging/SKILL.md | Root-cause-first hypotheses, minimal experiments, regression checks, escalation when patches accumulate | Strict process may be overkill for trivial failures; must handle no-runtime and urgent incidents pragmatically | `systematic-debugging`, failure-status proof |
| obra `executing-plans` | https://github.com/obra/superpowers/blob/main/skills/executing-plans/SKILL.md | Expected-versus-observed command output, persisted rulings, evidence at task completion | Strong git/plan-script assumptions; a generic skill needs a host-neutral fallback | `implementation-plan`, acceptance gates |
| Addy Osmani `test-driven-development` | https://github.com/addyosmani/agent-skills/blob/main/skills/test-driven-development/SKILL.md | Discover actual project test commands, demonstrate red/green, protect refactors | TDD is not appropriate for all nonbehavioral artifact tasks; external browser/CI tool access may be absent | `test-driven-implementation`, execution evidence |
| Addy Osmani `code-review-and-quality` | https://github.com/addyosmani/agent-skills/blob/main/skills/code-review-and-quality/SKILL.md | Structured correctness, readability, architecture, security and performance review | Every axis has different relevance depending on the diff; avoid false issues and subjective blockers | `code-review-evidence`, `secure-code-review` |
| Supabase `supabase` | https://github.com/supabase/agent-skills/blob/main/skills/supabase/SKILL.md | Broad platform trigger tied to current documentation, Postgres/Auth/Storage/RLS and negative-path reasoning | Platform updates can invalidate static recipes; privileged client checks cannot prove tenant isolation | `postgres-schema-rls`, `safe-database-migrations` |
| HyperFrames `hyperframes` | https://github.com/heygen-com/hyperframes/blob/main/skills/hyperframes/SKILL.md | State-aware routing, ordered sub-workflows, concrete video output contract and reference routing | Framework-specific CLI/hosted services, possible instruction overhead, cannot render without runtime | `video-storyboard-shotlist`, `task-skill-router` |
| HyperFrames `hyperframes-core` | https://github.com/heygen-com/hyperframes/blob/main/skills/hyperframes-core/SKILL.md | Progressive reference loading, deterministic seekable timeline, separate technical and creative ownership | Technical graph and CLI correctness does not prove creative suitability or source rights | `video-edit-color-delivery`, media checks |
| latent-spaces `brag` | https://github.com/latent-spaces/brag/blob/main/skills/brag/SKILL.md | Strongly bounded 15–25 second product-demo deliverable, exact native assets and share copy | Version/model-specific dispatch, third-party render availability, subject must be ready to demo | `go-to-market-launch`, video project handoffs |

## Conclusions from the directly read sample

The strongest procedures turn an underspecified prompt into a **bounded artifact contract**, route by context, articulate dependencies, and demand observed proof. The most portable parts are methods and quality gates, not unverified model/provider-specific commands. When a named upstream skill uses forceful activation or heavy multi-agent ceremony, translate its intent into realistic task boundaries and preserve a sequential fallback. Respect licenses: we synthesized these patterns without redistributing the upstream text.


---

# Skill catalog

**101 original task skills**; regenerated from `catalog.json`.

## delivery (5)

- [`acceptance-quality-release`](skills/acceptance-quality-release/SKILL.md) — Provide a cross-functional release gate based on evidence instead of subjective readiness.
- [`customer-support-knowledge-base`](skills/customer-support-knowledge-base/SKILL.md) — Build accurate support documentation and triage flows for user-facing systems.
- [`openproject-delivery`](skills/openproject-delivery/SKILL.md) — Operate OpenProject work packages with clear ownership, constraints and acceptance criteria.
- [`requirements-to-roadmap`](skills/requirements-to-roadmap/SKILL.md) — Convert ambitions into prioritized deliverable milestones with dependencies and verifiable outcomes.
- [`risk-register-governance`](skills/risk-register-governance/SKILL.md) — Maintain actionable project and operational risk decisions with early-warning indicators.

## design (8)

- [`brand-identity-system`](skills/brand-identity-system/SKILL.md) — Create a coherent, accessible visual identity with usage rules across channels.
- [`data-visualization-design`](skills/data-visualization-design/SKILL.md) — Select and engineer honest charts with explicit semantics and accessibility.
- [`design-critique`](skills/design-critique/SKILL.md) — Critique creative or interface work using prioritized evidence-based criteria.
- [`design-to-code-handoff`](skills/design-to-code-handoff/SKILL.md) — Convert design intent into testable engineering contracts without losing responsive and accessible behavior.
- [`presentation-narrative`](skills/presentation-narrative/SKILL.md) — Design persuasive factual presentations with a coherent evidence-to-decision arc.
- [`product-interface-design`](skills/product-interface-design/SKILL.md) — Translate flows and constraints into polished implementable UI screens and interactions.
- [`typography-layout-system`](skills/typography-layout-system/SKILL.md) — Construct readable typographic hierarchy and layout grids across sizes and content extremes.
- [`ux-research-usability`](skills/ux-research-usability/SKILL.md) — Plan and synthesize user research without mistaking anecdotes for population facts.

## engineering (16)

- [`api-contract-engineering`](skills/api-contract-engineering/SKILL.md) — Design evolvable HTTP/RPC/event interfaces with explicit failures and safe compatibility.
- [`ci-release-engineering`](skills/ci-release-engineering/SKILL.md) — Build reproducible CI, supply-chain checks and staged delivery with rollback readiness.
- [`code-review-evidence`](skills/code-review-evidence/SKILL.md) — Review a change for correctness, security, maintainability and scope fit with reproducible findings.
- [`codebase-onboarding`](skills/codebase-onboarding/SKILL.md) — Build a navigable map of an unfamiliar repository before proposing edits.
- [`cpp-modern-systems`](skills/cpp-modern-systems/SKILL.md) — Implement robust modern C++ components with explicit ownership, numerical and concurrency semantics.
- [`domain-driven-architecture`](skills/domain-driven-architecture/SKILL.md) — Design cohesive modules around domain language and stable boundaries.
- [`frontend-state-architecture`](skills/frontend-state-architecture/SKILL.md) — Design predictable frontend state and component boundaries without excess complexity.
- [`implementation-plan`](skills/implementation-plan/SKILL.md) — Produce dependency-aware tasks small enough to verify and merge safely.
- [`observability-slo-design`](skills/observability-slo-design/SKILL.md) — Instrument services for actionable reliability signals and low-noise incident response.
- [`performance-profiling`](skills/performance-profiling/SKILL.md) — Optimize a measured application bottleneck while preserving correctness.
- [`postgres-schema-rls`](skills/postgres-schema-rls/SKILL.md) — Design PostgreSQL schemas, indexes and row-level security from explicit access contracts.
- [`python-production-engineering`](skills/python-production-engineering/SKILL.md) — Build and harden Python libraries, services and scientific modules with modern tooling.
- [`safe-database-migrations`](skills/safe-database-migrations/SKILL.md) — Plan and execute backward-compatible data changes with reversible checkpoints.
- [`systematic-debugging`](skills/systematic-debugging/SKILL.md) — Find root cause from reproducible evidence rather than symptom-level patches.
- [`technical-specification`](skills/technical-specification/SKILL.md) — Turn a product or engineering request into a testable implementation contract.
- [`test-driven-implementation`](skills/test-driven-implementation/SKILL.md) — Implement behavior in small red-green-refactor cycles with meaningful assertions.

## marketing (12)

- [`ad-creative-testing`](skills/ad-creative-testing/SKILL.md) — Generate distinct advertisement hypotheses and evaluate creative lift without confirmation bias.
- [`brand-safety-compliance`](skills/brand-safety-compliance/SKILL.md) — Review campaigns for platform policy, consumer trust, accessibility and regulatory risk.
- [`campaign-strategy`](skills/campaign-strategy/SKILL.md) — Design integrated campaigns around a measurable business objective and cross-channel constraints.
- [`competitive-ad-intelligence`](skills/competitive-ad-intelligence/SKILL.md) — Analyze public competitor advertising and positioning without assuming private performance data.
- [`copywriting-claims-review`](skills/copywriting-claims-review/SKILL.md) — Create persuasive truthful copy with explicit verification for quantitative and sensitive assertions.
- [`email-lifecycle-marketing`](skills/email-lifecycle-marketing/SKILL.md) — Engineer compliant lifecycle messaging tied to user value and consent.
- [`go-to-market-launch`](skills/go-to-market-launch/SKILL.md) — Coordinate positioning, release readiness, enablement, demand and postlaunch learning.
- [`growth-experimentation`](skills/growth-experimentation/SKILL.md) — Run ethical growth experiments with clean hypotheses and valid inference.
- [`market-segmentation`](skills/market-segmentation/SKILL.md) — Segment real audiences by needs, behavior and reachability rather than unsupported personas.
- [`organic-content-strategy`](skills/organic-content-strategy/SKILL.md) — Develop a sustainable editorial program with distinct audience value and measurable distribution.
- [`paid-media-measurement`](skills/paid-media-measurement/SKILL.md) — Evaluate paid acquisition efficiency with transparent attribution and uncertainty.
- [`positioning-message-architecture`](skills/positioning-message-architecture/SKILL.md) — Translate competitive differentiation into provable audience-specific value propositions.

## media (22)

- [`3d-modeling-topology`](skills/3d-modeling-topology/SKILL.md) — Produce 3D meshes with correct scale, topology and downstream deformation/render use.
- [`asset-rights-content-authenticity`](skills/asset-rights-content-authenticity/SKILL.md) — Document creative media origin and rights while preventing misleading provenance claims.
- [`audio-design-mix`](skills/audio-design-mix/SKILL.md) — Deliver clear, balanced sound design and mixes for speech, music and effects.
- [`comfyui-graph-engineering`](skills/comfyui-graph-engineering/SKILL.md) — Design portable, efficient ComfyUI node graphs with validated input/output contracts.
- [`generative-model-evaluation`](skills/generative-model-evaluation/SKILL.md) — Benchmark creative AI models for quality, latency, cost, controls and policy fit using blind tests.
- [`greenscreen-keying`](skills/greenscreen-keying/SKILL.md) — Create clean transparent mattes with realistic edges, hair detail and spill suppression.
- [`image-art-direction`](skills/image-art-direction/SKILL.md) — Convert a visual objective into a coherent art direction brief before asset generation.
- [`image-edit-compositing`](skills/image-edit-compositing/SKILL.md) — Modify existing imagery while preserving protected content, masks and believable visual integration.
- [`image-generation-iteration`](skills/image-generation-iteration/SKILL.md) — Produce and refine generated images through controlled, reproducible changes.
- [`image-quality-upscale`](skills/image-quality-upscale/SKILL.md) — Improve image resolution/noise while protecting detail and avoiding hallucinated facts.
- [`lighting-render-optimization`](skills/lighting-render-optimization/SKILL.md) — Design readable 3D lighting and optimize renders without unacceptable quality loss.
- [`multi-camera-motion-capture`](skills/multi-camera-motion-capture/SKILL.md) — Design and validate multi-camera motion capture with calibrated geometry and uncertainty.
- [`multilingual-dubbing-localization`](skills/multilingual-dubbing-localization/SKILL.md) — Adapt speech and timing to another language without mistranslating meaning or mismatching lip timing.
- [`pbr-material-lookdev`](skills/pbr-material-lookdev/SKILL.md) — Create calibrated physically based materials and texture sets for consistent rendering.
- [`procedural-3d-blender`](skills/procedural-3d-blender/SKILL.md) — Build parameterized 3D content with reproducible Blender scripts and non-destructive controls.
- [`rigging-animation-retarget`](skills/rigging-animation-retarget/SKILL.md) — Create or validate character rigs and retarget motion while protecting anatomical constraints.
- [`speech-transcription-diarization`](skills/speech-transcription-diarization/SKILL.md) — Produce high-fidelity timestamped transcripts with speaker boundaries and privacy safeguards.
- [`text-to-speech-voice-direction`](skills/text-to-speech-voice-direction/SKILL.md) — Produce natural synthetic voice using pronunciation, pacing and reproducible voice settings.
- [`text-to-video-production`](skills/text-to-video-production/SKILL.md) — Generate controlled short-form video shots with reference continuity and technical QC.
- [`video-edit-color-delivery`](skills/video-edit-color-delivery/SKILL.md) — Finish multi-shot video with coherent pacing, color, audio and platform-specific exports.
- [`video-storyboard-shotlist`](skills/video-storyboard-shotlist/SKILL.md) — Plan shootable or generatable video sequences with continuity and edit-ready timing.
- [`voice-clone-consent`](skills/voice-clone-consent/SKILL.md) — Establish authorization and quality controls for permitted personalized voice synthesis.

## meta (5)

- [`multi-agent-delegation`](skills/multi-agent-delegation/SKILL.md) — Break large bounded projects into reviewable independent contributions with clear ownership.
- [`skill-factory`](skills/skill-factory/SKILL.md) — Author or refactor reusable Agent Skills with measurable quality gates and narrow activation criteria.
- [`skill-red-team-evaluation`](skills/skill-red-team-evaluation/SKILL.md) — Stress-test a skill for false activation, instruction conflicts, impossible claims and unsafe tool usage.
- [`source-license-provenance`](skills/source-license-provenance/SKILL.md) — Track origin, permissions and source trust for third-party material used in a skill or project.
- [`task-skill-router`](skills/task-skill-router/SKILL.md) — Select the minimum set of compatible skills for a multi-domain request without duplicating instructions.

## research (7)

- [`competitive-market-intelligence`](skills/competitive-market-intelligence/SKILL.md) — Compare a competitive landscape using verifiable claims and a decision framework.
- [`data-quality-audit`](skills/data-quality-audit/SKILL.md) — Verify dataset integrity, semantic meaning and reproducibility before analysis or modeling.
- [`evidence-led-research`](skills/evidence-led-research/SKILL.md) — Answer an uncertain question with a source-linked claim ledger and calibrated conclusions.
- [`experiment-design-analysis`](skills/experiment-design-analysis/SKILL.md) — Design and interpret experiments with valid estimands, randomization and guardrails.
- [`quantitative-modeling`](skills/quantitative-modeling/SKILL.md) — Create reproducible mathematical or simulation models with explicit assumptions and numerical checks.
- [`systematic-literature-review`](skills/systematic-literature-review/SKILL.md) — Build a reproducible research synthesis with explicit inclusion rules and bias assessment.
- [`technical-documentation-investigation`](skills/technical-documentation-investigation/SKILL.md) — Resolve unfamiliar APIs, language versions and library behavior from maintained primary sources.

## security (12)

- [`ai-prompt-injection-defense`](skills/ai-prompt-injection-defense/SKILL.md) — Harden agent workflows against instruction smuggling through untrusted content and tools.
- [`application-fuzz-testing`](skills/application-fuzz-testing/SKILL.md) — Find parser/state-machine bugs through controlled fuzzing and minimized regression inputs.
- [`cloud-infrastructure-security`](skills/cloud-infrastructure-security/SKILL.md) — Review cloud networks, workloads and data controls against stated threats and availability needs.
- [`cryptography-protocol-review`](skills/cryptography-protocol-review/SKILL.md) — Review cryptographic workflows for correct threat coverage and safe algorithm/API choices.
- [`dependency-supply-chain-security`](skills/dependency-supply-chain-security/SKILL.md) — Reduce third-party package and build risks with verified provenance and staged upgrades.
- [`privacy-data-minimization`](skills/privacy-data-minimization/SKILL.md) — Design data collection, sharing, retention and deletion around clear user purposes.
- [`secrets-iam-hardening`](skills/secrets-iam-hardening/SKILL.md) — Audit credential exposure, identity permissions and rotation with least-privilege guarantees.
- [`secure-code-review`](skills/secure-code-review/SKILL.md) — Identify exploitable code paths and unsafe assumptions with concrete evidence and fixes.
- [`secure-llm-rag-engineering`](skills/secure-llm-rag-engineering/SKILL.md) — Engineer grounded retrieval-augmented assistants with access controls and evaluable answer quality.
- [`security-incident-response`](skills/security-incident-response/SKILL.md) — Handle confirmed/suspected security incidents with evidence preservation and contained actions.
- [`security-threat-model`](skills/security-threat-model/SKILL.md) — Prioritize credible system threats from trust boundaries, assets and realistic attacker capabilities.
- [`web-app-pentest-authorized`](skills/web-app-pentest-authorized/SKILL.md) — Plan and document scoped web application testing under explicit authorization and safety boundaries.

## web-seo (14)

- [`accessible-interface-build`](skills/accessible-interface-build/SKILL.md) — Ship keyboard-operable, semantically correct web interfaces with tested accessible behavior.
- [`analytics-conversion-instrumentation`](skills/analytics-conversion-instrumentation/SKILL.md) — Implement trusted event analytics, attribution boundaries and privacy-aware conversion measurement.
- [`browser-qa-cross-device`](skills/browser-qa-cross-device/SKILL.md) — Evaluate browser behavior through reproducible end-to-end tests and visual regression evidence.
- [`internal-link-strategy`](skills/internal-link-strategy/SKILL.md) — Build semantic internal links that improve user pathways and page discovery.
- [`international-seo-localization`](skills/international-seo-localization/SKILL.md) — Coordinate locale architecture, international indexing and culturally appropriate site variants.
- [`landing-page-conversion`](skills/landing-page-conversion/SKILL.md) — Design and test conversion-focused pages with honest claims and friction control.
- [`responsive-design-system`](skills/responsive-design-system/SKILL.md) — Create a reusable responsive component system with predictable tokens and states.
- [`seo-content-brief`](skills/seo-content-brief/SKILL.md) — Develop search-intent-aligned content that adds evidence and original value.
- [`seo-technical-audit`](skills/seo-technical-audit/SKILL.md) — Find and prioritize crawl, indexation, rendering and discoverability defects using evidence.
- [`structured-data-schema`](skills/structured-data-schema/SKILL.md) — Add accurate schema.org structured data eligible for applicable rich-result types.
- [`web-migration-seo`](skills/web-migration-seo/SKILL.md) — Migrate site routes/platforms while preserving content equivalence and search discovery.
- [`web-performance-core-vitals`](skills/web-performance-core-vitals/SKILL.md) — Improve real-user web experience by tracing render, network and interaction bottlenecks.
- [`web-security-headers`](skills/web-security-headers/SKILL.md) — Configure secure browser-facing behavior without breaking legitimate site features.
- [`website-discovery-architecture`](skills/website-discovery-architecture/SKILL.md) — Turn a website business goal into a navigable, measurable information architecture.


---

# Quality and adoption standards

The complete executable specification is distributed as separate documents:

- [`standards/authoring-standard.md`](standards/authoring-standard.md): file format, activation, portability, domain QA and what not to do.
- [`standards/evaluation-protocol.md`](standards/evaluation-protocol.md): static checks, 707 designed prompts, real agent routing/outcome measurement, and honest maturity levels.
- [`standards/release-quality.md`](standards/release-quality.md): observable acceptance gates for each kind of deliverable.
- [`standards/installation-routing.md`](standards/installation-routing.md): safe selective installation and artifact-first routing.
- [`standards/trust-provenance.md`](standards/trust-provenance.md): untrusted source content, external media/model licenses, authorization and evidence.

# Honest status and next steps

The package currently meets its own static validation, local synthetic Git-auditor test, and installer tests. The evaluation suites have not been run in an agent host. To satisfy the original request literally, scan all 18 real Git repositories with `python tools/audit_repositories.py --out source-audit`, check the full-tracked-file inventory for completeness, and manually inspect and behavior-test the most relevant upstream skills. This task cannot be truthfully marked as already completed on the basis of public landing pages or the synthetic audit.
