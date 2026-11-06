# Field guide: recorded agentenv simulation

> This is original Skill Foundry operational guidance informed by the linked REA docs. It is not the upstream REA skill, and does not install a tool.

## Decision and tool boundary

**Activation:** the user has a HAR or a permitted test web application and needs an AgentEnv sandbox to evaluate agents on recorded API workflows.

**Explicit non-activation:** the user needs a general browser automation script or assumes an environment can faithfully emulate all unseen server behavior.

**Minimum required evidence:** The bundle starts and its observed tool effects are verified in the sandbox; unsupported writes are not asserted to work; test secrets and app data are not leaked.

### Procedure guardrails

- `environment-build` works offline from a captured HAR or supported Evidence; it does not crawl the original app.
- State-derived read/write support is bounded by actual recorded observations and confirmation.
- Generated bundles can contain application data, so publishing requires rights and redaction.
- Differentiate a bundle build test from a real RL training outcome.

### Target-specific verification probes

1. **Scenario 1:** An unconfirmed POST/DELETE must not be represented as a stateful safe write tool.
2. **Scenario 2:** AgentEnv+Docker missing cannot yield a fictional passed smoke test.

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

- [REA: docs/agent-environments.md](https://github.com/morluto/rea/blob/main/docs/agent-environments.md)
- [REA: .agents/skills/reverse-engineer-anything/references/evidence-workflows.md](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/references/evidence-workflows.md)

Accessed as publicly indexed documentation on 2026-10-27. Verify current contracts and provider readiness before real use.
