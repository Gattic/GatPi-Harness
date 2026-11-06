# Field guide: javascript electron artifact recovery

> This is original Skill Foundry operational guidance informed by the linked REA docs. It is not the upstream REA skill, and does not install a tool.

## Decision and tool boundary

**Activation:** an ASAR or extracted production JavaScript/Electron application is supplied without suitable source-level architecture documentation.

**Explicit non-activation:** the user already has complete first-party source and wants normal refactoring, tests, or feature implementation.

**Minimum required evidence:** All traced paths are backed by inventoried modules and evidence IDs, static relationships are not mislabeled as runtime calls, and partial source coverage is disclosed.

### Procedure guardrails

- Semantic relations may be unavailable even when the structural module graph exists.
- A filesystem path can appear in multiple module roles; preserve returned module/node identifiers.
- Large Evidence should be saved and viewed via `inspect_analysis_view` rather than recomputed.
- Exact source_paths require an inventory; do not guess relative paths.

### Target-specific verification probes

1. **Scenario 1:** A missing semantic graph is reported unknown rather than as zero dependencies.
2. **Scenario 2:** A native module with an unmatched digest stays a follow-up, not a confirmed boundary.

## Claim and quality worksheet

| Claim ID | Exact subject SHA-256 / capture ID | Source location or Evidence ID | Authority (observed/inferred/unknown) | Collection coverage | Validation method | Status |
| --- | --- | --- | --- | --- | --- | --- |
| C-001 | Fill from actual artifact, not filenames | Copy original ID/record ordinal | observed / inferred / unknown | inspected scope | repeated capture / static reference / independent test | PASS/FAIL/NOT TESTED/BLOCKED |

Complete the worksheet from real tool output; example row is a schema, not a finding. Carry forward records of timeouts and cleanup uncertainty.

## Recovery and escalation

- If the user gives only source, use ordinary source tools; do not require REA or its providers.
- If the connected REA tool exists, use its **advertised** input schema. Main-branch docs are not proof of installed-server capability.
- If the selected REA tool is missing, distinguish agent registration, provider, host/platform and client approval. Do not perform installation or configuration changes without approval.
- If the target is sensitive, writes data, executes code, captures network/PII, extracts packages or attaches to a process, verify scope and minimize side effects.
- A failed or client-timed-out mutating operation might still be running. Inspect state/cleanup before considering any retry.
- Preserve observations, inferences, unknowns and alternative explanations. Empty/incomplete capture means absence of evidence, not evidence of absence.

## Source reference pages (read only as needed)

- [REA: docs/javascript-artifact-reconstruction.md](https://github.com/morluto/rea/blob/main/docs/javascript-artifact-reconstruction.md)
- [REA: docs/javascript-application-workflows.md](https://github.com/morluto/rea/blob/main/docs/javascript-application-workflows.md)
- [REA: .agents/skills/reverse-engineer-anything/references/javascript-applications.md](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/references/javascript-applications.md)

Accessed as publicly indexed documentation on 2026-10-27. Verify current contracts and provider readiness before real use.
