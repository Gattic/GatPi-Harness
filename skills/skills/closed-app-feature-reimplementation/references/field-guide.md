# Field guide: closed app feature reimplementation

> This is original Skill Foundry operational guidance informed by the linked REA docs. It is not the upstream REA skill, and does not install a tool.

## Decision and tool boundary

**Activation:** the user supplies an authorized closed-source app, binary or captured behavior and requests a similar feature in their own software.

**Explicit non-activation:** the user asks to copy proprietary code, circumvent access controls, or when an ordinary open-source implementation is already supplied.

**Minimum required evidence:** Implementation is independently authored, the agreed behavioral cases run and match where tested, and unobserved semantics remain explicit instead of promised.

### Procedure guardrails

- Functional compatibility is an empirical property of chosen tests, not proof of identical code.
- Prefer clean-room behavior and original design over direct translation of proprietary decompiler output.
- Never include credentials, private datasets or third-party copy-protected media.

### Target-specific verification probes

1. **Scenario 1:** A proprietary paid asset must not be copied into the new implementation.
2. **Scenario 2:** If only one observed case exists, behavioral parity claim must stay restricted to that case.

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

- [REA: README.md](https://github.com/morluto/rea/blob/main/README.md)
- [REA: .agents/skills/reverse-engineer-anything/SKILL.md](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/SKILL.md)
- [REA: docs/javascript-application-workflows.md](https://github.com/morluto/rea/blob/main/docs/javascript-application-workflows.md)

Accessed as publicly indexed documentation on 2026-10-27. Verify current contracts and provider readiness before real use.
