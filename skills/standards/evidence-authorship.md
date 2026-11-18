# Evidence authorship and integrity protocol (REA-informed)

This document describes **Skill Foundry's own normalized claim ledger**, not the native REA Evidence schema. Do not pass its JSON directly to an REA MCP tool, and do not claim that our checker authenticates REA bundles. REA keeps its own producer-specific graph, `normalized_result`, `evidence_id`, coverage and unknowns. Consult the live REA server's input schemas before requesting records.

## Proof tiers

- **Observed:** actually read from the recorded artifact, original bytes, or permitted runtime capture; provide the artifact ID/hash, tool or parser name, original location/record ordinal and bounded coverage.
- **Inferred:** an interpretation with observed supporting evidence and an explicit alternate explanation or limitation. For example, a static call graph may suggest a likely code path but cannot prove that the call executed.
- **Unknown:** a fact not established by the available records. Missing bodies, missing semantic graphs, unmatched comparisons and unsupported architecture are unknowns; do not replace with invented evidence.

## Identity discipline

Store the complete original artifact digest. Match captured scripts to their original browser response IDs. When comparing builds, keep separate artifact IDs and tool environments; a same-named function is not a cryptographic match. For REA comparison workflows, only specify record pairs when independent identity facts justify them. Unmatched records are not by themselves proof of addition, removal or functional regression.

## Redaction and safety

Avoid saving personal information or secrets in curated evidence summaries. A saved HAR, crash dump, model header, archive or binary may contain sensitive contents; treat the file itself as access-controlled even when the report is redacted. Offline inspection does not authorize live API replays, execution, process attachment, external publication or any other side effect.

## Example use

Copy `standards/claim-ledger-schema.json` to your workspace, replace all example values using observed facts, and run:

```bash
python tools/check_evidence_ledger.py /path/to/ledger.json --root /path/to/artifacts --check-files
```

The checker validates references, claim authority, comparison pairing, path confinement and actual local file SHA-256 when `--check-files` is selected. It does **not** inspect proprietary code, validate upstream REA authenticity, or establish the claims' real-world truth. Read this tool's output as a local bookkeeping check, not as an independent scientific validation.

## Sources

- [REA CLI and Evidence](https://github.com/morluto/rea/blob/main/docs/cli.md)
- [REA MCP contracts](https://github.com/morluto/rea/blob/main/docs/mcp-contracts.md)
- [REA evidence workflows](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/references/evidence-workflows.md)

Source docs were reviewed 2026-10-27. Installed server schemas take precedence over moving documentation on `main`.
