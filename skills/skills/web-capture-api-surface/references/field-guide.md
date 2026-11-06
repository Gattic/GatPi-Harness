# Field guide: web capture api surface

> This is original Skill Foundry operational guidance informed by the linked REA docs. It is not the upstream REA skill, and does not install a tool.

## Decision and tool boundary

**Activation:** a saved HAR, SAZ or other supported network capture needs endpoint discovery, privacy review, or response classification.

**Explicit non-activation:** the user wants an OpenAPI design based solely on a known backend source, with no capture to inspect.

**Minimum required evidence:** All endpoint claims tie to captured record ordinals, unknown or unrecorded routes remain unknown, and no network replay occurred without separate authorization.

### Procedure guardrails

- A captured request proves it occurred in that capture, not that it always occurs.
- `api-surface` groups are inferred; original method/URL and record ordinals are the observed facts.
- Do not leak bearer tokens, cookies, session identifiers or email addresses from captures.
- Offline HAR inspection is not permission to probe the original service.

### Target-specific verification probes

1. **Scenario 1:** An uncaptured endpoint must not be inserted as an observed server route.
2. **Scenario 2:** Captured credentials must be redacted from example data and logs.

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

- [REA: .agents/skills/reverse-engineer-anything/references/evidence-workflows.md](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/references/evidence-workflows.md)
- [REA: docs/cli.md](https://github.com/morluto/rea/blob/main/docs/cli.md)

Accessed as publicly indexed documentation on 2026-10-27. Verify current contracts and provider readiness before real use.
