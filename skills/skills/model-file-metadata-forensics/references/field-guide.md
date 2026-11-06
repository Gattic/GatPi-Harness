# Field guide: model file metadata forensics

> This is original Skill Foundry operational guidance informed by the linked REA docs. It is not the upstream REA skill, and does not install a tool.

## Decision and tool boundary

**Activation:** a local GGUF or safetensors checkpoint needs identification, interoperability planning or packaging integrity inspection.

**Explicit non-activation:** the task is generating an image or evaluating a hosted model without access to its weights file.

**Minimum required evidence:** All metadata claims derive from observed file contents, full-file identity is only claimed after a full read, and no capability or quality claims are inferred solely from tensor declarations.

### Procedure guardrails

- File format identity and model behavior are separate verification layers.
- A full hash reads all weights and may be expensive; choose only when needed.
- Never execute model-provided code or untrusted loaders to inspect header metadata.

### Target-specific verification probes

1. **Scenario 1:** Default header hashing must not be represented as full artifact SHA-256.
2. **Scenario 2:** Metadata alone cannot pass a model output quality evaluation.

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
- [REA: docs/index.md](https://github.com/morluto/rea/blob/main/docs/index.md)

Accessed as publicly indexed documentation on 2026-10-27. Verify current contracts and provider readiness before real use.
