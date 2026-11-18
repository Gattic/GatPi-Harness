# Source study: `morluto/rea` and changes to Skill Foundry

**Review date:** 2026-10-27\
**Source:** https://github.com/morluto/rea\
**Audit tier:** Public GitHub repository README, primary agent skill, and selected linked technical documentation were inspected by browser. Direct Git clone failed (`Could not resolve host: github.com` from execution container), so this is **not** a complete source-tree audit or a reproduction of REA's runtime capabilities. `tools/audit_repositories.py` now includes REA among all 19 origins to facilitate full tracked-file scanning on a machine with GitHub access.

## What REA is

REA is an agent-integrated reverse-engineering toolkit with MCP and CLI interfaces. It supports analyses of native binaries, packaged applications, Electron/JavaScript, managed .NET assemblies, Android, firmware, and recorded browser/network behavior, with specialized families that vary by platform and installed provider. Its entry skill is [`reverse-engineer-anything`](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/SKILL.md). The GitHub file view on the review date identified approximately 514 lines and a 35.1 KB primary skill, plus references. This makes it an excellent specialized source but an expensive default to load for simple tasks.

REA's reported results carry Evidence, source identity/locations, bounded coverage and unknowns. Exact available operations and the fields of their input/output schemas depend on the **connected REA server**, not the version of repository main. The build environment did not install or run REA, its MCP server, Ghidra, Hopper, IDA, JADX, Docker or AgentEnv. No new Skill Foundry skill has been claimed runtime verified against them.

## Strengths to preserve

1. **Target-first decision making:** static JS directories and ASARs use `analyze_javascript_application` without opening a native target; Android code uses Android package readers; managed assemblies have their own route. An `open_binary` session is appropriate for a native artifact and many archive workflows, not every possible input.
2. **Authority discipline:** observations have locations and identities, inferences are distinct, and unresolved conclusions stay unresolved. The source skill explicitly warns that static code analysis cannot establish runtime events.
3. **Retained Evidence:** `normalized_result`, Evidence IDs, retained views and portable bundles enable audited follow-up without rerunning costly whole-target operations. For large files, summary-first and stable page/item retrieval improves context efficiency.
4. **Explicit provider scope:** installed skill instructions, MCP registration, analysis engines and host prerequisites are separate components. A working JS reader need not depend on an unavailable native disassembler. A connection failure should trigger diagnosis of the **actual blocker**, not ritual repair.
5. **Bounded operations:** timeouts, resource constraints, cleanup markers and process ownership are treated as first-class outcomes. A client timeout does not prove the server operation has stopped.
6. **Useful offline workflows:** HAR analysis and static JavaScript recovery do not inherently require a live browser or running target; captured data can support API-surface inference and exported JavaScript analysis.
7. **Capture-driven evaluation:** recorded HAR data can be turned into an AgentEnv environment, but read/write behavior remains bounded by what the capture established and the chosen replay/state mode.
8. **Explicit rights and safety:** the source repo's MIT tool license is not a grant of rights over target applications, captures, proprietary code, voice samples, or embedded media.

## Weaknesses, risks and mitigations

| Observed concern | Impact on skill quality | Our design response |
| --- | --- | --- |
| Broad entry skill spans many target types and tools | Large context footprint and inappropriate activation | 20 narrow task skills with positive and negative triggers and domain tests; select one lead skill. |
| Main-branch docs can precede installed npm/MCP functionality | Invented tool invocations and repeated errors | Every REA skill requires checking actual connected tool schemas and offers a non-REA fallback. |
| Some native providers require external software and platform-specific setup | Tool not available despite skill installation | Readiness skill separates MCP registration, provider, host and user approval; repairs start with scoped dry-run. |
| Decompiled pseudocode and inferred endpoint templates are not authoritative execution traces | Overclaiming and incorrect recommendations | Mandatory authority/coverage ledger and explicit observed/inferred/unknown distinctions. |
| Captures and crash dumps can contain secrets and private data | Data leakage in reports and training fixtures | Redacted reports, synthetic identities and permission gate before capture or export. |
| Browser action workflows can mutate state or navigate beyond starting origin | Unintended writes, network access or expenditures | Predeclared scope, deterministic test data, no side effects without permission. |
| Recorded environment coverage is inherently incomplete | False simulation parity or unsupported actions | Show replay/state boundaries, record unsupported writes and run isolated smoke verification when tools exist. |
| Full native providers and training envs unavailable during this build | Unable to validate real task success | Explicit NOT TESTED maturity; offline static tests limited to our own helper scripts. |

## Mapping to new original skills

| User intent | Lead skill | Verification emphasis |
| --- | --- | --- |
| Decide which REA analysis to use | `rea-capability-routing` | Live tool schema vs source, installation/permission boundaries |
| Inventory an opaque artifact | `shipped-artifact-provenance` | Hashes, container layers, safe member traversal |
| Understand native function behavior | `native-binary-behavior-analysis` | Address/digest binding, decompiler uncertainty |
| Trace shipped Electron/JS | `javascript-electron-artifact-recovery` | Module IDs, IPC relations, static coverage |
| Analyze managed .NET assembly | `dotnet-managed-artifact-inspection` | CLI metadata vs NativeAOT, IL limits |
| Inspect an Android APK | `android-apk-code-audit` | Manifest/method/overload fidelity and JADX prerequisites |
| Analyze frozen Python | `python-frozen-app-inventory` | CArchive vs loader separation |
| Inspect embedded firmware | `firmware-region-forensics` | Byte offsets, tool prerequisites, isolated extraction |
| Audit binary hardening declarations | `binary-mitigation-inventory` | Metadata vs live enforcement; signature verification limits |
| Observe a declared browser journey | `browser-scenario-evidence` | Deterministic actions, side effects and origin boundaries |
| Model recorded API traffic | `web-capture-api-surface` | Original request ordinals vs inferred paths |
| Inspect captured scripts | `captured-web-script-recovery` | Script provenance and static trace |
| Validate Evidence-based conclusions | `rea-evidence-lineage-review` | Authority, IDs, coverage and justified pairings |
| Independently implement an observed feature | `closed-app-feature-reimplementation` | Clean-room design, actual parity tests and rights |
| Compare two shipped releases | `artifact-version-delta-analysis` | Subject identity and comparable analysis settings |
| Convert HAR to local evaluation environment | `recorded-agentenv-simulation` | State vs replay, confirmed effects and smoke |
| Observe authorized native execution | `native-runtime-evidence` | Permission, process ownership, cleanup |
| Triage core or IPS | `recorded-crash-evidence-analysis` | Matching build IDs and careful cause attribution |
| Inspect local model headers | `model-file-metadata-forensics` | Header vs full weight hash, no quality inference |
| Audit captured personal-data flows | `application-privacy-runtime-audit` | Redaction, consent, capture coverage |

## Existing skills revised

**21** existing skills received context-specific specialist rules: `task-skill-router`, `codebase-onboarding`, `systematic-debugging`, `secure-code-review`, `dependency-supply-chain-security`, `application-fuzz-testing`, `web-app-pentest-authorized`, `security-threat-model`, `ai-prompt-injection-defense`, `browser-qa-cross-device`, `evidence-led-research`, `technical-documentation-investigation`, `technical-specification`, `test-driven-implementation`, `api-contract-engineering`, `source-license-provenance`, `skill-factory`, `skill-red-team-evaluation`, `privacy-data-minimization`, `website-discovery-architecture`, and `observability-slo-design`. Each changed skill now has two extra targeted evaluation cases.

The revisions intentionally do **not** make REA a mandatory dependency. They improve handling when the task genuinely involves shipped artifacts, runtime observations, capture records, provenance mismatches or unavailable tools.

## Offline tooling and reliability

- `tools/check_evidence_ledger.py` checks a **Skill Foundry-authored human claim ledger**, not the native REA Evidence wire format. It verifies IDs, authority labels, comparisons and local SHA-256 when requested. It does not establish that claims are substantively true.
- `skills/shipped-artifact-provenance/scripts/artifact_inventory.py` is a pure-stdlib, read-only ZIP/file inventory that never extracts or executes inputs. It bounds archive decompression and flags unsafe member paths. It is a fallback, **not** a replacement for REA's full readers.
- `tests/test_rea_evidence.py` covers integrity checks, wrong pairings, path escape, unsupported runtime conclusions and ZIP member safety under offline fixtures.

## How to perform the full REA source audit later

Use a GitHub-accessible machine and run:

```bash
python tools/audit_repositories.py --repo morluto/rea --out source-audit/rea
```

The audit inventories **tracked `SKILL.md` files** and scores editorial signals. It still does not exercise them. For complete repository understanding, manually inspect the detailed REA technical references and inspect installed MCP schemas for the release to be used; preserve a pinned commit and an explicit tool-version receipt.

## Primary sources consulted

- [REA repository and requirements](https://github.com/morluto/rea)
- [Primary `reverse-engineer-anything` agent skill](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/SKILL.md)
- [Installation and readiness](https://github.com/morluto/rea/blob/main/docs/installation.md)
- [MCP contracts](https://github.com/morluto/rea/blob/main/docs/mcp-contracts.md)
- [CLI and Evidence](https://github.com/morluto/rea/blob/main/docs/cli.md)
- [Evidence workflow references](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/references/evidence-workflows.md)
- [Connection and recovery](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/references/connection-and-recovery.md)
- [JavaScript reconstruction](https://github.com/morluto/rea/blob/main/docs/javascript-artifact-reconstruction.md)
- [JavaScript feature tracing](https://github.com/morluto/rea/blob/main/docs/javascript-application-workflows.md)
- [Android analysis](https://github.com/morluto/rea/blob/main/docs/android-analysis.md)
- [Browser scenario contract](https://github.com/morluto/rea/blob/main/docs/browser-scenario-contract.md)
- [Captured web script export](https://github.com/morluto/rea/blob/main/docs/website-script-export.md)
- [AgentEnv environment bundles](https://github.com/morluto/rea/blob/main/docs/agent-environments.md)
- [Raw binary headerless mapping](https://github.com/morluto/rea/blob/main/docs/raw-binary.md)

All external links refer to moving main-branch content unless explicitly version-pinned by the upstream provider. Recheck before running a real investigation.
