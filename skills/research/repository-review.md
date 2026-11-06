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
