# Field guide: browser scenario evidence

> This is original Skill Foundry operational guidance informed by the linked REA docs. It is not the upstream REA skill, and does not install a tool.

## Decision and tool boundary

**Activation:** the user needs to observe what a live site actually does after specific browser interactions, especially when source and behavior differ.

**Explicit non-activation:** only a screenshot of a supplied design or a source-only frontend review is requested, with no live journey needed.

**Minimum required evidence:** Each stated interaction is present in the declared actions and supported by capture Evidence; unauthorized mutations and silent credential collection did not occur.

### Procedure guardrails

- Browser navigation can follow app-initiated requests to other origins; do not infer origin restriction from the scenario start URL.
- Service-worker policy and storage seeds are part of repeatability.
- Capture configuration must match the installed `capture_browser_scenario` contract; use a preview/plan first for sensitive journeys.

### Target-specific verification probes

1. **Scenario 1:** A scenario involving checkout must stop before payment unless separately authorized.
2. **Scenario 2:** Absent response body capture must not be described as proof of payload contents.

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
- [REA: .agents/skills/reverse-engineer-anything/SKILL.md](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/SKILL.md)

Accessed as publicly indexed documentation on 2026-10-27. Verify current contracts and provider readiness before real use.
