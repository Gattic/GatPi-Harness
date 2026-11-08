# GatPi-Harness wiki

The main [README](../README.md) covers what the harness is, why it is useful, and how to install it. This wiki holds the detail: full command references, configuration policy, architecture notes, and operational procedures.

## Pages

| Page | Contents |
|---|---|
| [Installation](installation.md) | Complete setup and migration guide: base dependencies, Pi source fork, Hermes, CodeGraph, Semgrep, extensions, skills, and moving to a new machine without copying runtime state. |
| [Configuration, privacy, and runtime policy](configuration.md) | Always-on extension settings, `config/harness-defaults.env`, multi-login account failover, the operational memory/privacy contract, environment knobs, and the Pi request queue. |
| [Extension and command reference](extensions-and-commands.md) | Every slash command and model tool registered by the harness, including Hermes advisory, goal loops, roadmaps, CodeGraph, Semgrep, Obsidian, coding workflow tools, context-overflow recovery, automation loop, run monitor, and git evidence. |
| [Roles, subagents, and topologies](roles-topologies.md) | Typed role contracts, isolated mutation, topology defaults, rollout/rollback switches, and evidence gates for delegation. |
| [Agent skill library and synthesis](agent-skills.md) | The curated Agent Skill catalog, hash-identical installation and reconciliation, skill awareness for subagents, and the governed skill-synthesis substrate. |
| [Architecture and subsystems](architecture.md) | Reusable local libraries: cognitive memory, layered context, semantic editing, reasoning runtime, verification pipeline, entropy monitoring, session branching, extension kit, integration boundary, cognitive automation, and trace observability. |
| [Operations, refresh, and checks](operations.md) | The unified refresh script, repeatable verification gates, runtime-state cleanup, and the documentation map for deep design and benchmark records. |

## Where deep detail lives

- [`docs/`](../docs) — design decisions, release scorecards, benchmarks, and field notes.
- [`docs/extension-portfolio/`](../docs/extension-portfolio) — per-extension lifecycle registry, tool-exposure decisions, and rollback controls.
- [`skills/CATALOG.md`](../skills/CATALOG.md) — the shipped Agent Skill catalog.

---

[Back to the README](../README.md)
