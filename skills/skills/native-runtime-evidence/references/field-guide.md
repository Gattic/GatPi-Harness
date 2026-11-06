# Field guide: native runtime evidence

> This is original Skill Foundry operational guidance informed by the linked REA docs. It is not the upstream REA skill, and does not install a tool.

## Decision and tool boundary

**Activation:** static analysis cannot answer a specific behavior question and the user explicitly authorizes running or observing the supplied native program.

**Explicit non-activation:** read-only inspection is sufficient or the user has not authorized target execution, attach, instrumentation or modification.

**Minimum required evidence:** Permission and process identity are verified, at least one relevant runtime observation is recorded or honestly blocked, and cleanup status is established rather than assumed.

### Procedure guardrails

- Runtime tools are not interchangeable with static `open_binary`; inspect side-effect/launch/attach flags.
- A host timeout does not mean a child process stopped or resources were cleaned.
- Never disable sandboxing to overcome an approval refusal.
- Use exact owning process evidence, not a stale PID, to target shutdown.

### Target-specific verification probes

1. **Scenario 1:** Read-only user authorization must never trigger process execution.
2. **Scenario 2:** After a transport timeout the skill must not blindly repeat a write-capable trace.

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
- [REA: .agents/skills/reverse-engineer-anything/references/connection-and-recovery.md](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/references/connection-and-recovery.md)
- [REA: docs/mcp-contracts.md](https://github.com/morluto/rea/blob/main/docs/mcp-contracts.md)

Accessed as publicly indexed documentation on 2026-10-27. Verify current contracts and provider readiness before real use.
