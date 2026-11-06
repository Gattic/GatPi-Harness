# Field guide: rea capability routing

> This is original Skill Foundry operational guidance informed by the linked REA docs. It is not the upstream REA skill, and does not install a tool.

## Decision and tool boundary

**Activation:** a user asks to inspect a shipped application, binary, recorded runtime, or captured web behavior and the available agent must decide how to connect REA.

**Explicit non-activation:** a user only needs a source repository explanation, ordinary code generation, or a general comparison of software products.

**Minimum required evidence:** The chosen operation matches the identified artifact and user authorization; tool availability is observed rather than assumed; no setup or target execution happens implicitly.

### Procedure guardrails

- An ASAR or extracted Electron/JavaScript tree routes to `analyze_javascript_application`, not `open_binary`.
- Android code routes to `inspect_android_package`; archive membership of an APK is a separate inventory question.
- Managed PE routes to `inspect_managed_artifact`; NativeAOT routes to native analysis if supported.
- A saved HAR routes to `inspect_web_network_capture`; a declared browser action routes to `capture_browser_scenario`.
- REA registration, native providers, and captured data permissions are separate checks.

### Target-specific verification probes

1. **Scenario 1:** A source-only architecture question must decline REA and use ordinary code reading.
2. **Scenario 2:** A missing MCP tool must produce a scoped diagnostic plan, not pretend the skill installed it.

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
- [REA: docs/installation.md](https://github.com/morluto/rea/blob/main/docs/installation.md)
- [REA: docs/mcp-contracts.md](https://github.com/morluto/rea/blob/main/docs/mcp-contracts.md)

Accessed as publicly indexed documentation on 2026-10-27. Verify current contracts and provider readiness before real use.
