# Field guide: binary mitigation inventory

> This is original Skill Foundry operational guidance informed by the linked REA docs. It is not the upstream REA skill, and does not install a tool.

## Decision and tool boundary

**Activation:** a supplied ELF or PE binary must be statically assessed for hardening or release compliance.

**Explicit non-activation:** the task is source-code linting alone, penetration of an unauthorized system, or a runtime exploit demonstration.

**Minimum required evidence:** Claims about declared headers/mitigations are individually verifiable; no result falsely asserts verified Authenticode or live mitigation enforcement.

### Procedure guardrails

- Offline inspection can run without a native disassembler where the corresponding reader exists.
- `inspect_pe_certificates` does not cryptographically verify signatures.
- CFG/Guard flags describe image declarations, not absolute protection at runtime.
- Native exports/imports may be empty despite dynamic resolution or different directory types.

### Target-specific verification probes

1. **Scenario 1:** Missing import directory cannot be equated with zero runtime API calls.
2. **Scenario 2:** A PKCS#7 certificate table must not be called a validated signature.

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
