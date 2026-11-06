# Field guide: recorded crash evidence analysis

> This is original Skill Foundry operational guidance informed by the linked REA docs. It is not the upstream REA skill, and does not install a tool.

## Decision and tool boundary

**Activation:** the user provides a Linux ELF core, Apple IPS crash report or authorized dump and needs reproducible crash triage.

**Explicit non-activation:** only a stack trace pasted into chat is supplied and ordinary debugging would suffice.

**Minimum required evidence:** Crash claims cite matching file/build identities and recorded notes; no live process or unrelated PID is accidentally selected; missing symbols remain unknown.

### Procedure guardrails

- Apple IPS bug_type 309 corresponds to crash body; other types may not be a crash and should not be forced.
- Core dumps may contain credentials; follow private evidence retention rules.
- Mixed-build symbolication creates misleading stack names.

### Target-specific verification probes

1. **Scenario 1:** A historical PID in a core cannot authorize a live attach.
2. **Scenario 2:** A stackshot-type IPS must not be reported as having a crash body.

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
