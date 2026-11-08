# Agent skill library and synthesis

The harness ships a curated Agent Skill catalog and a governed synthesis substrate. Skills are copied, not symlinked, and reconciliation preserves user-owned skills.

## Agent skill library

The Skill Foundry catalog now holds 129 skills under `skills/`, with invocable directories in `skills/skills/`: 121 supplied by the 2026-10-27 pack plus eight legacy skills restored and adapted to the pack standard because the pack does not cover their workflows: `handoff`, `git-checkpoint`, `change-verify`, `long-run`, `durable-bug-hunt`, `experiment-gate-lifecycle`, `build` and the third-party MIT `typesafe-ai`. See [`skills/CATALOG.md`](../skills/CATALOG.md) for the catalog, [`skills/README.md`](../skills/README.md) for authoring/evaluation tools, and [the migration record](../docs/skill-bundle-migration.md) for legacy backups, the 2.0 adaptation and disclosed deviations. Validate the harness and refresh the local copies with the unified entry point:

```bash
scripts/pi-harness-refresh.sh --skills
```

The lower-level `scripts/install-agent-skills.sh` validates the exact catalog in `skills/skills/managed-skills.txt`, installs hash-identical copies, and records `.pi-harness-managed-skills` in each destination. Later runs prune only names recorded in that destination manifest and removed from the source catalog; unrelated user-owned skills are preserved. Use `--list` or `--dry-run` to inspect the reconciliation.

Awareness runs in both directions. Every generated `SKILL.md` carries a **Harness delegation** section listing the registered specialist/subagent roles rendered from `skills/specialists.json`, which is generated from `src/role-contracts.js` by `scripts/regenerate-specialist-roster.js`, plus the delegation tools and an inline fallback for harnesses without them. Every role-v2 contract carries a bounded skill roster built from `skills/catalog.json` by `src/skill-awareness.js`: children see every current skill and the ones governing their role, while skill discovery stays disabled, so the parent passes the relevant body when exact procedure matters. The roster reaches a child once, and an oversized roster degrades with an explicit truncation marker instead of failing extension load. Retired skills are absent from both surfaces and `tests/skill-awareness.test.js` fails if one reappears. See [Subagents](../docs/subagents.md#skill-awareness).

## Skill synthesis substrate

A self-improving procedural skill synthesis layer is available at:

```text
src/skill-synthesis.js
```

It captures public execution traces/topology runs, scores outcomes, extracts reusable procedural skills, stores failure patterns, retrieves relevant skills for new tasks, injects advisory skill context, replays captures, compares skills, sandbox/A-B scores skill use, evaluates effectiveness, supports provider-registered curated skills, enforces approval/rollback governance, and can render topology templates from skills. It is exposed through `createPiIntegrationBoundary(...).skills` and `/skill-*` commands in the cognitive automation extension.

Docs, tests, and example:

```bash
node tests/skill-synthesis.test.js
node examples/skill-synthesis-example.js
```

See `docs/skill-synthesis.md` for the architecture, governance, commands, and lifecycle.

---

[Back to the README](../README.md) · [Wiki index](README.md)
