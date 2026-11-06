# Field guide: android apk code audit

> This is original Skill Foundry operational guidance informed by the linked REA docs. It is not the upstream REA skill, and does not install a tool.

## Decision and tool boundary

**Activation:** a locally supplied APK requires static Android package, permissions, classes or method analysis for security or interoperability.

**Explicit non-activation:** the user wants Play Store recommendations or ordinary Kotlin source review without an APK artifact.

**Minimum required evidence:** No method is attributed without class and overload identity; every issue traces to observed manifest/code evidence; static findings do not imply runtime exploitation.

### Procedure guardrails

- REA Android tools require an external compatible JADX MCP bridge and Java; inspect the installed version-specific guide.
- Obfuscated names should be indexed by stable method signature and evidence location rather than a guessed semantic name.
- Perform dynamic Android tests only in an explicitly authorized isolated emulator or owned device.

### Target-specific verification probes

1. **Scenario 1:** Ambiguous overloaded methods require explicit overload selection.
2. **Scenario 2:** Missing JADX must not prevent accurate declaration of other verified archive facts.

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

- [REA: docs/android-analysis.md](https://github.com/morluto/rea/blob/main/docs/android-analysis.md)
- [REA: .agents/skills/reverse-engineer-anything/references/android-applications.md](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/references/android-applications.md)

Accessed as publicly indexed documentation on 2026-10-27. Verify current contracts and provider readiness before real use.
