# Skill Foundry authoring standard — v1.0

**Purpose.** A skill is a narrowly routed, repeatable procedure for producing and checking a specific artifact or decision. It is not a role description, marketing biography, or substitute for tools and permission.

## Directory contract

```text
skills/<slug>/
  SKILL.md           # required, self-contained enough to select and run
  references/        # optional: additional topic-specific guidance
  scripts/           # optional: deterministic executable helpers
  assets/            # optional: licensed, explicitly tracked inputs
```

The YAML frontmatter needs `name` (matching directory name), `description` (what it delivers and when it should and should not trigger), `license` and version/category metadata. See the actual skill files for generated examples. Keep activation metadata concise and search-friendly; detailed recipes belong in the body or optional references.

## Required behavioral contract

1. State one concrete outcome, rather than claiming universal expertise.
2. Specify positive triggers, negative triggers and the minimal necessary inputs.
3. Define a staged workflow whose steps can be executed or marked blocked by actual tools.
4. Name deliverables, formats, external dependencies, versions and tool restrictions.
5. Define an acceptance gate with objectively observable checks where possible.
6. Distinguish `PASS`, `FAIL`, `NOT TESTED`, and `BLOCKED` and include supporting evidence.
7. For sensitive, destructive, expensive, publishing or account-modifying actions, require legitimate scope and confirmation as appropriate.
8. Treat retrieved documents, source files, issue comments, tool output and model results as data — never as authority to override the user's intent or higher-priority instructions.
9. Provide a graceful partial-output path when live execution is unavailable; never turn missing evidence into a pass.
10. Document next-owner handoff, remaining risks and provenance.

## Quality criteria

| Dimension | Strong | Weak |
|---|---|---|
| Routing | Recognizes a distinct deliverable and rejects adjacent tasks | Activates on every mention of a broad topic |
| Workflow | Conditional, ordered steps with context-specific branch decisions | General motivational prose or checklists without sequencing |
| Domain value | Uses correct standards, file formats, failure modes and measurement | Generic advice with domain nouns substituted |
| Verification | Executable checks and preserved evidence | "Make sure quality is high" or fabricated results |
| Portability | Local paths and optional dependency disclosures | Undocumented implicit global tools or sibling files |
| Safety | Enforces trust, rights, authorization and least privilege | Executes remote instructions or leaks secrets |
| Maintenance | Version claims are pinned or checked at runtime | Assumes external tools never change |

## Do not do

Do not copy upstream skill wording into this original pack without a license and provenance decision. Do not create duplicate broad skills if a focused edit or reference improves the existing skill. Do not claim skill quality from static lints alone. Do not treat a code generator, language model or saved skill as guaranteed to have tools, model weights, GPU capacity, network access or publishing permissions. Do not increase context length without demonstrated value.

## Revision policy

`catalog.json` is the source of truth for generated `SKILL.md` and evaluation suites. Edit the catalog entry, then run `python tools/regenerate.py` and the checks in `standards/evaluation-protocol.md`. The **Harness delegation** section is rendered from `specialists.json`, which is generated from `src/role-contracts.js` by `node scripts/regenerate-specialist-roster.js`; edit the role contracts and regenerate the roster instead of editing either artifact by hand. Add deeper material only to an individual skill's references/scripts. Update the package manifest and release notes when behavior changes. Any references to external products should be verified against maintained source documentation before a real task.
