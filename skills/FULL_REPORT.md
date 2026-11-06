# Skill Foundry v2.0 — full release report

> **pi-harness note:** the supplied 2.0 ZIP omitted the authoring-side additions named below (`standards/evidence-authorship.md`, `standards/claim-ledger-schema.json`, `tools/check_evidence_ledger.py`, `tools/verify_release.py`, `RELEASE_FILES.json`, `research/rea-architecture-assessment.md` and `research/ORIGINAL_2026-10-24_FULL_REPORT.md`). They are absent from this repository copy. The report content below is otherwise reproduced as supplied.


**Release:** 2026-10-27  
**Contents:** 121 original modular AI Agent Skills covering software engineering, research, website development, SEO, marketing, advertising, 3D/media production, cybersecurity, delivery, and meta-skill engineering.  
**What changed:** integration of the public [`morluto/rea`](https://github.com/morluto/rea) reverse-engineering framework's evidence-first patterns into **20 new skills** and **21 updated existing skills**. All 101 original skills remain in this complete package.

## 1. Executive result

The delivered folder contains **121 `SKILL.md` files**, **121 corresponding designed evaluation files**, **929 unique test-case slots** (847 base positive/negative/behavior cases plus 82 specialist scenarios), a curated structured catalog, and reproducible tooling for regeneration, validation, installation and upstream source inventory. The package's **16 offline tests pass**. The previous October 24 release is preserved as the baseline, with 80 original SKILL.md files unchanged byte-for-byte.

**Proof limit:** Static tests measure syntax, structure, local helper behavior and package consistency. **They do not establish** high real-world agent accuracy, native decompilation correctness, real-world browser behavior or performance improvements. The REA server/tools and heavy analysis providers are **not installed/tested** in this execution environment. No full 19-upstream-Git-tree audit is claimed; cloning was DNS-blocked, while public main-branch source pages were read.

## 2. What the new source contributes

REA provides a concrete method for evidence-backed understanding of shipped software. Its agent skill covers multiple formats: native binaries, Electron and JavaScript, managed .NET, Android, Python packages, firmware, recorded website behavior, model headers and native/runtime captures. It emphasizes **artifact byte identity**, **bounded/tool-specific inspection**, **observations/inferences/unknowns**, **retained Evidence**, **disambiguating provider availability from MCP registration**, **controlled side effects**, and **careful timeout and cleanup handling**. The implementation supports static and runtime operations differently; a file's headers and a decompiled function are not equivalent to proving an operation occurred at runtime.

The REA entry skill is rich but large; our approach is to separate it into narrowly activated specialist skills so an agent doesn't load a broad reference for ordinary source-code tasks. Each new skill is independently original, not a vendored version of upstream `reverse-engineer-anything`.

**Upstream source links:** [primary skill](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/SKILL.md), [installation](https://github.com/morluto/rea/blob/main/docs/installation.md), [CLI and Evidence](https://github.com/morluto/rea/blob/main/docs/cli.md), [MCP contracts](https://github.com/morluto/rea/blob/main/docs/mcp-contracts.md), [browser scenarios](https://github.com/morluto/rea/blob/main/docs/browser-scenario-contract.md), [AgentEnv environments](https://github.com/morluto/rea/blob/main/docs/agent-environments.md). Detailed findings and limitations are in [research/rea-architecture-assessment.md](research/rea-architecture-assessment.md).

## 3. Every new skill and its distinct job

| New skill | Owns | Key acceptance risk |
| --- | --- | --- |
| `rea-capability-routing` | Matching a given artifact and permission scope to installed tool/provider | Skill instructions do not register MCP; use actual schemas. |
| `shipped-artifact-provenance` | Immutable artifact hash, package layers and member inventory | Version labels/signatures not automatically authenticated. |
| `native-binary-behavior-analysis` | Focused call/dataflow and pseudocode interpretation | Static existence is not observed execution. |
| `javascript-electron-artifact-recovery` | Deployed module and Electron IPC/source graphs | Partial semantic coverage and native digest joins. |
| `dotnet-managed-artifact-inspection` | Managed CLI assemblies, type/method maps | Do not mix IL and NativeAOT. |
| `android-apk-code-audit` | APK manifest, classes, methods and references | External JADX/Java prerequisites and overload identification. |
| `python-frozen-app-inventory` | Python archive application layer, member data | Distinguish PyInstaller CArchive from bootloader. |
| `firmware-region-forensics` | Firmware regions, offsets and optional extraction | Isolate extraction and avoid guessed architectures. |
| `binary-mitigation-inventory` | PE/ELF mitigation/import/certificate declarations | Metadata is not cryptographic validation or runtime enforcement. |
| `browser-scenario-evidence` | Deterministic live browser scenario observations | Navigations and writes require explicit authorization. |
| `web-capture-api-surface` | Offline HAR/SAZ request/response groups | Inferred route templates are not proven schemas. |
| `captured-web-script-recovery` | Captured script export and static tracing | Trace only bodies actually retained in capture. |
| `rea-evidence-lineage-review` | IDs, subject hashes, authority and comparisons | Unmatched records do not establish behavior differences. |
| `closed-app-feature-reimplementation` | Independent lawful reconstruction and parity tests | Protect proprietary code/assets; label untested behavior. |
| `artifact-version-delta-analysis` | Comparing two shipped builds or capture sets | Differences require equivalent coverage and valid matches. |
| `recorded-agentenv-simulation` | HAR-derived local agent test environment | Do not fabricate write support outside observed effects. |
| `native-runtime-evidence` | Authorized execution/attach observations and cleanup | A timed-out operation may still be running. |
| `recorded-crash-evidence-analysis` | Core/IPS triage and matching symbol context | Historical PIDs cannot authorize live attach. |
| `model-file-metadata-forensics` | GGUF/safetensors headers and tensor declarations | Header-only inspection is not full-file validation. |
| `application-privacy-runtime-audit` | Consent-based personal-data flow observations | Never publish captured personal data or assert absence from incomplete capture. |

The above workflows are differentiated by their target, the minimum evidence needed, side effects and quality gate. Each skill includes a field guide with its own examples, negative scenarios, source references and claim worksheet.

## 4. How the 21 original skills improved

The original cross-domain workflows remain valid. Specifically revised skills: `task-skill-router`, `codebase-onboarding`, `systematic-debugging`, `secure-code-review`, `dependency-supply-chain-security`, `application-fuzz-testing`, `web-app-pentest-authorized`, `security-threat-model`, `ai-prompt-injection-defense`, `browser-qa-cross-device`, `evidence-led-research`, `technical-documentation-investigation`, `technical-specification`, `test-driven-implementation`, `api-contract-engineering`, `source-license-provenance`, `skill-factory`, `skill-red-team-evaluation`, `privacy-data-minimization`, `website-discovery-architecture`, and `observability-slo-design`.

The revisions add conditional evidence requirements and no-false-invocation routing. Ordinary codebase or website work does **not** require REA or binary scanning; relevant workflows can use specialized REA skills if the request actually provides shipped artifacts or a runtime evidence need. Multiple skills do not independently claim ownership of the same final deliverable. See the original `SKILL.md` versus the updated file and [CHANGES_2026-10-27.md](CHANGES_2026-10-27.md).

## 5. Library-wide skills architecture

The skills use the following contract: bounded positive/negative activation; requested deliverable; explicit minimum inputs and permissions; steps with actual tool constraints; independent specialist guardrails where needed; acceptance gates with **PASS / FAIL / NOT TESTED / BLOCKED**; anti-patterns; optional detailed references or deterministic helper scripts; provenance and handoff. External documents, binary strings, browser responses and captured evidence are *data*, never executable instructions to the agent.

The total domain distribution is: engineering **23**, security **19**, media/3D **23**, web/SEO **16**, marketing **12**, research **8**, design **8**, delivery **5**, and meta **7**. The [catalog](CATALOG.md) lists the complete 121 names. Source-of-truth updates belong in `catalog.json`, not in overwritten generated entrypoints.

## 6. Validation, reproducibility and installation

```bash
# Run inside unpacked skill_foundry_pack/:
python tools/regenerate.py
python tools/validate_skills.py
python -m unittest discover -s tests -v

# List or selectively install skills:
python tools/install.py --list
python tools/install.py --target /path/to/project/.agents/skills \
  --skill rea-capability-routing --skill native-binary-behavior-analysis \
  --skill rea-evidence-lineage-review --dry-run

# Complete source inventory when internet or local clones are available:
python tools/audit_repositories.py --out source-audit
```

The static test suite passes in this build environment. Individual REA operations, native engines, browser action tools, Docker/AgentEnv and skill prompt behavioral suites remain **NOT TESTED**. All 19 real Git repository heads remain **NOT EXHAUSTIVELY AUDITED**. See [VALIDATION_REPORT.md](VALIDATION_REPORT.md) for exact checks, and [source-audit/STATUS.md](source-audit/STATUS.md) for known source-audit limits.

## 7. Helper scripts and their real guarantees

`tools/check_evidence_ledger.py` checks an **original normalized human ledger** for claim authority, supported IDs, cross-artifact pairing, file path confinement and actual local SHA-256. It does not parse/authenticate REA-native Evidence or prove a claim is true. `skills/shipped-artifact-provenance/scripts/artifact_inventory.py` inventories only input bytes and ZIP members, with expansion budgets and hazardous-path detection; it does not run or decompile an artifact. Those two tools have meaningful local negative tests. All other original scripts and reference files from the October 24 library remain packaged.

## 8. Rights, permissions and limitations

REA's MIT license applies to REA source code, **not** to every program analyzed with it, third-party model data or confidential captures. No upstream REA code or skill text, model weights, app binaries, intercepted credentials or extracted third-party assets are included in this package. Actual target analysis must be restricted to assets and runtime behavior the user owns or is authorized to inspect. Capture and simulation artifacts require independent privacy and distribution checks.

The version of REA installed at execution time, live tool schemas and provider errors outrank broad or moving main-branch documentation. The next meaningful quality milestone is running the domain and routing evaluation cases against real agents and permitted test artifacts with controlled ground truth, not inflating a static skill count.

## 9. Complete file maps and history

- [README.md](README.md): user setup and full package table.
- [CATALOG.md](CATALOG.md): 121 individual skill links.
- [CHANGES_2026-10-27.md](CHANGES_2026-10-27.md): 20 new and 21 changed workflows.
- [CHANGE_INDEX.json](CHANGE_INDEX.json): per-skill hashes against the original ZIP.
- [research/rea-architecture-assessment.md](research/rea-architecture-assessment.md): linked source assessment, design rationale and future audit commands.
- [research/repository-review.md](research/repository-review.md): original 18-repository architectural study.
- [research/ORIGINAL_2026-10-24_FULL_REPORT.md](research/ORIGINAL_2026-10-24_FULL_REPORT.md): preserved baseline full report.
- [standards/evidence-authorship.md](standards/evidence-authorship.md): evidence tiers and the optional normalized claim schema.
- [VALIDATION_REPORT.md](VALIDATION_REPORT.md): current verification results and honest test boundaries.

## Release reproducibility and integrity

The package contains `RELEASE_FILES.json`, which lists SHA-256 and byte lengths of every distributed file except the manifest itself, and `tools/verify_release.py` to verify the extracted package. This detects local changes but is not a signed publisher attestation. Twenty REA skills now have four additional natural, scenario-based routing evaluation prompts each. Live-agent measurements remain unperformed.
