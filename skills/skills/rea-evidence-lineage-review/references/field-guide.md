# Field guide: rea evidence lineage review

> This is original Skill Foundry operational guidance informed by the linked REA docs. It is not the upstream REA skill, and does not install a tool.

## Decision and tool boundary

**Activation:** the user needs an evidence-backed analysis report or wants to compare results collected from two REA sessions or artifacts.

**Explicit non-activation:** only a quick prose summary of known, already cited source code is needed and there are no REA Evidence records.

**Minimum required evidence:** Every observation cites a retained or inline record of the right subject; comparisons do not infer record correspondence from order or display names; inferences remain labeled.

### Procedure guardrails

- MCP retained IDs may be connection-scoped; CLI sessions should save full Evidence to files.
- Pair records explicitly when comparing and only when identity or domain evidence supports pairing.
- Digest mismatch blocks cross-artifact attribution, even if method names match.
- Use tools/check_evidence_ledger.py at library root for optional locally normalized human claim ledgers; it does not validate REA-native Evidence schemas.

### Target-specific verification probes

1. **Scenario 1:** A record absent in one snapshot must stay unknown until coverage and pairing are checked.
2. **Scenario 2:** Client-truncated JSON cannot be accepted as a canonical saved Evidence file.

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
- [REA: .agents/skills/reverse-engineer-anything/references/evidence-workflows.md](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/references/evidence-workflows.md)
- [REA: docs/mcp-contracts.md](https://github.com/morluto/rea/blob/main/docs/mcp-contracts.md)

Accessed as publicly indexed documentation on 2026-10-27. Verify current contracts and provider readiness before real use.
