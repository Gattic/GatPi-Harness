# Installation and routing

The canonical pack source is `skills/<slug>/SKILL.md`. Install only the relevant folders to a path your current agent host actually discovers. Common examples include a project `.agents/skills/` directory, `.claude/skills/` or `.cursor/skills/`; platform support and path semantics are version-specific.

```bash
python tools/install.py --list
python tools/install.py --target /path/to/project/.agents/skills --skill skill-factory --skill secure-code-review
python tools/install.py --target /path/to/project/.agents/skills --all --dry-run
```

Do not overwrite existing user directories without explicit choice (`--force` will replace the matching folder). Avoid loading 129 entire instruction bodies into one context. Use the descriptions/manifest for discovery and load the smallest matching set on demand.

## Routing rule

Choose by *intended deliverable*, not substring match. For instance: a mention of React in an article-summary task should not trigger frontend programming; writing copy for a dashboard should not trigger data visualization engineering. A motion graphics request may require `video-storyboard-shotlist` but not `greenscreen-keying`. Negative triggers have equal status to positive ones.

For multi-skill work, define a dependency graph and choose a single owning skill for each artifact. Handoffs carry file names, constraints, assumptions, source evidence, tests and acceptance status. Do not build competing independent implementations of the same artifact without a comparison objective.

This installer only copies directories. It does not create accounts, install GPU dependencies, download model weights, validate cloud credentials or grant rights to third-party material.
