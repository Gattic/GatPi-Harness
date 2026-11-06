# Field guide: python frozen app inventory

> This is original Skill Foundry operational guidance informed by the linked REA docs. It is not the upstream REA skill, and does not install a tool.

## Decision and tool boundary

**Activation:** a PyInstaller executable or related Python application archive is supplied for authorized compatibility, investigation or preservation.

**Explicit non-activation:** a normal Python project with source and requirements files can be analyzed directly.

**Minimum required evidence:** Application conclusions cite CArchive members rather than bootloader-only disassembly; all analyzed members and unknown extraction limits are recorded.

### Procedure guardrails

- A native bootloader and a Python application payload have different trust and interpretation scopes.
- Compressed or encrypted bytecode may remain opaque; distinguish listing from successful recovery.
- Runtime options in CArchive are not files.

### Target-specific verification probes

1. **Scenario 1:** A PyInstaller input must not be summarized from native loader functions alone.
2. **Scenario 2:** Archive runtime options must not be emitted as imaginary files.

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

- [REA: .agents/skills/reverse-engineer-anything/SKILL.md](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/SKILL.md)
- [REA: docs/cli.md](https://github.com/morluto/rea/blob/main/docs/cli.md)

Accessed as publicly indexed documentation on 2026-10-27. Verify current contracts and provider readiness before real use.
