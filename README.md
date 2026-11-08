# GatPi-Harness

**A batteries-included extension harness for [Pi](https://github.com/Gattic/GatPi), the terminal coding agent: verification, reviewable delegation, durable project memory, and long-run supervision — local-first and privacy-bounded.**

Pi is a fast terminal coding agent. GatPi-Harness is the extension layer that turns it into a supervised engineering harness: it keeps the agent honest about what it actually verified, keeps delegation reviewable, keeps project memory local and reviewed, and keeps long work from running unattended and unchecked.

## Why use it

- **Verification before claims.** `gitverify` and `test_runner` run the repository's own checks and record pass, fail, or *not-applicable* evidence. Completion gates never treat unrun work as passing.
- **Reviewable delegation.** Subagents and topology DAGs run in isolated workspaces. Mutating roles return proposed patches that reach your tree only through an explicit, verified apply. Automatic routing is off by default.
- **Local, reviewed project memory.** Sessions stay episodic evidence. Durable memory lives in Obsidian notes you review, recall caches are local and provider-free, and nothing is promoted automatically.
- **Cheaper, better-targeted context.** `code_context` progressive localization, bounded tool output, and task-aware tool routing reduce token spend, context overflow, and repeated-call churn.
- **Long-running work stays supervised.** Background jobs, a run deck, periodic run monitors, and bounded automation loops that pause on stalls instead of looping forever.
- **Evidence you can hand off.** Debug ledgers, experiment gates, commit plans, and evidence binders record attempts and outcomes so failed fixes are not repeated.
- **Private by default.** Runtime state is repo-local and git-ignored; telemetry is metadata-only; provider packets exclude transcripts, private reasoning, secrets, and absolute paths.
- **Portable.** One refresh script manages the Pi fork, extensions, and skills. Migration copies config, not sessions or caches.

## What's included

52 extensions and 129 curated Agent Skills, grouped into capability families:

| Area | What you get | Reference |
|---|---|---|
| Verification & git | `gitverify`, `gitevidence`, Verification Center (with separately governed visual baselines), CI/PR companion | [commands](wiki/extensions-and-commands.md) |
| Delegation | subagents, typed role contracts, topology DAGs, role sidecars, isolated mutation | [roles](wiki/roles-topologies.md) |
| Coding tools | `code_context`, `lsp` diagnostics, `test_runner`, `ast_search`/`ast_refactor`, `docs_lookup`, CodeMode, CodeGraph, Semgrep | [commands](wiki/extensions-and-commands.md) |
| Memory & reasoning | Obsidian-backed project memory, layered context, model-side reasoning runtime, skill synthesis | [architecture](wiki/architecture.md) |
| Long runs | `bg_run`, run deck, run monitor, automation loop, goal loop | [commands](wiki/extensions-and-commands.md) |
| Governance | policy enforcer, privacy guard, evidence binder/inbox, debug and experiment ledgers, roadmap | [commands](wiki/extensions-and-commands.md) |
| Skills | 129 curated Agent Skills installed hash-identically, with reconciliation that preserves your own skills | [skills](wiki/agent-skills.md) |
| Accounts & queue | multi-login failover, shared DeepSeek request queue | [configuration](wiki/configuration.md) |

Optional adapters (Hermes, CodeGraph, Semgrep, Obsidian) degrade to explicit guidance when their binaries are missing; nothing fails silently.

## Requirements

| Dependency | Required? | Notes |
|---|---|---|
| Node.js **>= 22.19.0** | Required | The linked Pi fork requires it. |
| `git`, `npm`, `curl`, build tools | Required | Linux/WSL or macOS. |
| [Gattic/GatPi](https://github.com/Gattic/GatPi) source fork | Required | Cloned to the sibling `../GatPi` and built/linked by the refresh script. Override with `PI_SOURCE_ROOT`. |
| [Hermes](https://github.com/NousResearch/hermes-agent) | Optional | Typed, off-path advisory plans and reviews. |
| CodeGraph CLI | Optional | Project indexing and affected-test selection. |
| Semgrep | Optional | Risk-focused scans during verification. |
| Obsidian | Optional | Human-readable durable project memory. |
| Pi provider login or API key | Required for model use | `/login` after setup. |

## Quick start

```bash
# 1. Clone the harness and install Node 22.19+
git clone https://github.com/Gattic/GatPi-Harness.git ~/GatPi-Harness
cd ~/GatPi-Harness
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc && nvm install 22

# 2. Build and link the Pi source fork (first run skips the full gate)
scripts/pi-harness-refresh.sh --pi --no-check

# 3. Install the extensions and Agent Skills
scripts/pi-harness-refresh.sh --extensions --skills --no-check

# 4. Check the setup (no model login needed)
scripts/check-project-setup.sh
```

Then start Pi and authenticate:

```bash
pi
/login
```

The first runs use `--no-check` because optional adapters are not installed yet. Routine updates use the full gate:

```bash
scripts/pi-harness-refresh.sh --all          # Pi + extensions + skills + checks
scripts/pi-harness-refresh.sh --check-only   # checks without deploying
```

Restart Pi after a `--pi` refresh; use `/reload` after extension or skill changes. Install the optional adapters (Hermes, CodeGraph, Semgrep, Obsidian) and see the migration guide in **[wiki/installation.md](wiki/installation.md)**.

## Documentation

| Document | Contents |
|---|---|
| **[wiki/](wiki/README.md)** | Wiki index: installation, configuration, command reference, roles/topologies, skills, architecture, operations. |
| [wiki/installation.md](wiki/installation.md) | Full install and new-machine migration guide, including optional adapters. |
| [wiki/extensions-and-commands.md](wiki/extensions-and-commands.md) | Every slash command and model tool the harness registers. |
| [wiki/configuration.md](wiki/configuration.md) | Settings, environment knobs, privacy contract, multi-login, request queue. |
| [docs/](docs) | Design decisions, release scorecards, benchmarks, and field notes. |
| [docs/extension-portfolio/](docs/extension-portfolio) | Per-extension lifecycle registry and tool-exposure decisions. |
| [skills/CATALOG.md](skills/CATALOG.md) | Shipped Agent Skill catalog. |

## Privacy and safety

- Runtime state is repo-local and git-ignored; session JSONL files are never deleted or truncated.
- Durable memory is human-reviewed. The harness can draft candidates but cannot promote, install, publish, or mutate canonical memory automatically.
- Provider packets are bounded, scanner-redacted, and exclude transcripts, private reasoning, unredacted tool output, secrets, command arguments, and absolute paths.
- Publishing (`/git:publish`) is interactive, requires a clean tree, and is never model-callable.
- Defaults are conservative: automatic routing, automatic skill drafting, and mutating delegation are off unless you explicitly opt in.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
