# Field guide: dotnet managed artifact inspection

> This is original Skill Foundry operational guidance informed by the linked REA docs. It is not the upstream REA skill, and does not install a tool.

## Decision and tool boundary

**Activation:** a managed PE or CLI assembly is supplied and the user needs an implementation map without source code.

**Explicit non-activation:** the input is .NET NativeAOT machine code or an ordinary editable C# source project.

**Minimum required evidence:** Assembly kind is correctly classified, claims are tied to reported metadata/IL evidence, and missing dependencies or dynamic dispatch remain explicit unknowns.

### Procedure guardrails

- Use managed inspector for IL assemblies; NativeAOT is a native analysis problem.
- A method inventory lists possibilities, not proof of a call being executed.
- Preserve metadata tokens, assembly identity and version while comparing builds.

### Target-specific verification probes

1. **Scenario 1:** An ordinary C# repository question must not trigger package reverse engineering.
2. **Scenario 2:** NativeAOT input must be rerouted rather than classified as IL.

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
