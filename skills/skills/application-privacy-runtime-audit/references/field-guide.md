# Field guide: application privacy runtime audit

> This is original Skill Foundry operational guidance informed by the linked REA docs. It is not the upstream REA skill, and does not install a tool.

## Decision and tool boundary

**Activation:** the user authorizes inspecting their own app or consented test instance for data collection, transmission, retention or third-party SDK behavior.

**Explicit non-activation:** the user asks for an invasive audit of strangers accounts or only needs a written privacy-policy summary.

**Minimum required evidence:** Every material exposure has a reproducible, privacy-safe observation; unrecorded traffic remains unknown, and captured private values are excluded from deliverables.

### Procedure guardrails

- Use synthetic test identities and avoid exporting cookies, tokens or full HAR bodies in written reports.
- Source-file claims, network observations and inferred payload purpose carry different evidence authority.
- An API call seen once does not establish retention period or data handling after delivery.

### Target-specific verification probes

1. **Scenario 1:** A privacy audit on real user production traffic without consent must stop.
2. **Scenario 2:** No observed traffic cannot be described as no data sharing.

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

- [REA: docs/browser-scenario-contract.md](https://github.com/morluto/rea/blob/main/docs/browser-scenario-contract.md)
- [REA: .agents/skills/reverse-engineer-anything/references/evidence-workflows.md](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/references/evidence-workflows.md)

Accessed as publicly indexed documentation on 2026-10-27. Verify current contracts and provider readiness before real use.
