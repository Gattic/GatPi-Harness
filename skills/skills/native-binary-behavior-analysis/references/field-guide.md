# Field guide: native binary behavior analysis

> This is original Skill Foundry operational guidance informed by the linked REA docs. It is not the upstream REA skill, and does not install a tool.

## Decision and tool boundary

**Activation:** the user supplies an authorized native ELF, PE, Mach-O, or analysis database and asks how a function or behavior is implemented.

**Explicit non-activation:** the user provides only a source repository with straightforward source-level answers, or only wants package member inventory.

**Minimum required evidence:** Each material behavior claim cites code locations or Evidence IDs, addresses are bound to the correct artifact digest, and runtime claims are identified as unobserved unless separately traced.

### Procedure guardrails

- Native provider choice (Hopper, Ghidra or IDA) is separate from REA MCP availability.
- A stripped export table does not imply functions are absent; a decompiled expression is an inference about machine code.
- Prefer focused function results and retained page views over broad unbounded dumps.
- Never execute unfamiliar binaries during a read-only investigation.

### Target-specific verification probes

1. **Scenario 1:** A stripped binary still yields a bounded plan without invented function names.
2. **Scenario 2:** Two binaries with identical function names but different hashes must not have cross-linked evidence.

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
- [REA: docs/mcp-contracts.md](https://github.com/morluto/rea/blob/main/docs/mcp-contracts.md)
- [REA: docs/cli.md](https://github.com/morluto/rea/blob/main/docs/cli.md)

Accessed as publicly indexed documentation on 2026-10-27. Verify current contracts and provider readiness before real use.
