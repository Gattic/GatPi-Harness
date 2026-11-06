# Field guide: artifact version delta analysis

> This is original Skill Foundry operational guidance informed by the linked REA docs. It is not the upstream REA skill, and does not install a tool.

## Decision and tool boundary

**Activation:** two authorized shipped releases, captured sessions or binary artifacts must be compared for regression analysis or compatibility.

**Explicit non-activation:** only a normal Git source diff and release notes are available and sufficiently answer the question.

**Minimum required evidence:** Every claimed difference has comparable observations from both subjects or is explicitly an unconfirmed hypothesis; unmatched records are not assumed to be additions/deletions.

### Procedure guardrails

- A comparison report must display left/right identity and collection conditions.
- REAs one-to-one record pairing must be explicit and justified.
- Version strings embedded in artifacts are claims, not equivalent to verified release provenance.

### Target-specific verification probes

1. **Scenario 1:** Unmatched record IDs cannot be treated as new runtime behavior by default.
2. **Scenario 2:** A missing second artifact results in a one-sided inventory only.

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

- [REA: docs/cli.md](https://github.com/morluto/rea/blob/main/docs/cli.md)
- [REA: docs/javascript-application-workflows.md](https://github.com/morluto/rea/blob/main/docs/javascript-application-workflows.md)

Accessed as publicly indexed documentation on 2026-10-27. Verify current contracts and provider readiness before real use.
