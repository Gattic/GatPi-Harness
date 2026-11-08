# Configuration, privacy, and runtime policy

GatPi-Harness is local-first and privacy-bounded by default: runtime state is repo-local, provider packets exclude transcripts, private reasoning, secrets, and absolute paths, and nothing is promoted to durable memory without review. This page collects the settings, environment knobs, and policy details that the main README only summarizes.

## Always-on extension settings

Pi loads the harness through global extension settings:

```text
~/.pi/agent/settings.json extensions = [
  "~/GatPi-Harness/extensions/00-harness-defaults/index.ts",
  "~/GatPi-Harness/.pi/extensions",
  "~/GatPi-Harness/extensions",
  "-builtin:codemode",
  ...unmanaged existing extensions
]
```

`-builtin:codemode` disables Pi's built-in CodeMode so only `extensions/codemode` (the governed policy facade over the same native tool) registers `codemode`; without it Pi warns about the replacement on every start.

## Multiple logins and account failover

Provided by `extensions/multi-login`:

- `config/multi-login.json` is the default; `~/.pi/agent/multi-login.json` replaces it when present. Entries use their provider's own login: for example, Codex models use the `openai-codex` login, not the separate `openai` provider. `config/multi-login.json` ships an example `accounts` and `priority`; replace them with your own logins and model order.
- `accounts` sets logins per built-in provider. Login 1 is the provider itself; logins 2..N are `<provider>-account-N` (sign in with `/login anthropic-account-2`).
- Anthropic OAuth requests on the base provider and every alias apply a billing marker, prompt normalization, and tool-message ordering repair (`src/anthropic-oauth.js`). Both streaming APIs keep Pi's native login/refresh, authentication headers, and transport; API-key requests are unchanged. Offline regression tests cover the payload and OAuth handshake; live provider acceptance is not established by those tests.
- `priority` lists models in failover order. Choose any model as usual; when its account explicitly reports exhausted usage/quota or an authentication failure, that account cools down for `cooldownMinutes` (shared across sessions in `~/.pi/agent/multi-login-state.json`), the session switches to the next usable entry below it (each model on login 1, then logins 2..N), and the turn is retried. A model outside the list falls back to the top; the list never wraps upward. Thinking level carries over, clamped to the new model. A 429 only triggers failover when its message says usage is exhausted (for example, "You're out of extra usage"); generic rate limits/"try again later" errors do not switch models or create/extend a cooldown. Pi's normal retry behavior is unchanged. Cooldowns are local timers, not provider quota resets or remaining-usage telemetry.
- Model selections (including the account alias and automatic failover) are remembered per absolute working directory in `~/.pi/agent/multi-login-models/` (`PI_CODING_AGENT_DIR` overrides the agent directory). Fresh sessions and `/new` restore that directory's last selection; the first visit remembers Pi's current model. `/model` and model cycling update it. Explicit CLI model/provider/scope flags, resumed/forked sessions, and `/reload` keep their own model without replacing the saved choice. Unavailable saved models leave Pi's current model and the saved choice intact. Records contain only provider/model IDs, keyed by a directory hash; project files and global defaults are unchanged.
- `/multi-login` shows the order and status; `/multi-login reset` clears cooldowns, not remembered models.

## Hermes advisory state

Version-controlled Hermes advisory extension source:

```text
extensions/hermes-advisory/index.ts
```

Private Hermes advisory receipts and scorecards:

```text
.pi/hermes-advisory/events.jsonl
.pi/hermes-advisory/scorecard.json
.pi/hermes-skill-candidates/<candidate-id>/
```

Hermes uses independent one-shot advisory requests. It has no durable project conversation, recall cache, or canonical-memory namespace.

## Operational contract

Pi remains the fast coding harness. Canonical project memory lives under `Memory/Projects/<repo>-<root-hash>/` in the managed Obsidian vault. Hermes is a typed, off-path advisor only. Automatic runtime state is repo-local by default; every project identity uses the canonical root hash. Durable notes may contain only reviewed bounded summaries such as:

- decisions
- TODOs/risks
- test/build outcomes
- touched files/modules
- constraints/preferences

Provider packets must not contain transcript arrays or full history, private reasoning, unredacted tool output, secrets, command arguments, or absolute paths. Prompt refinement may include only a scanner-redacted, text-only excerpt of the eight most recent public messages plus bounded public skill telemetry; local task recall remains provider-free and bounded. Hermes can draft plans, reviews, evidence summaries, unverified project-memory candidates, and quarantined Agent Skills; it cannot approve, install, publish, promote canonical memory, or mutate automatically.

See `docs/project-memory-operations.md` for explicit save, recall, privacy review, retention, rollback, and rollout procedures.

`config/harness-defaults.env` is the canonical non-secret environment policy. The first extension applies only missing values, so explicit launch/session environment values remain authoritative. Managed builds, tests, detached jobs, and RPC sidecars have no shared job-count admission limit; each owned process group retains a 6144 MiB RSS ceiling with `SIGTERM` followed by bounded group-only `SIGKILL`. Active context is proactively compacted at 80% usage or 8 MiB of structured context through Pi's append-only compaction API. Existing session JSONL files are never deleted or truncated. See `docs/runtime-configuration.md` for `PI_MANAGED_PROCESS_*` and `PI_COMPACTION_PROACTIVE_*` overrides. `scripts/install-project-extensions.sh` installs the pinned request-queue client, the ordered extension paths, and bounded compaction/retry defaults, applied only where the settings file has no value so existing user preferences (including `retry.enabled`) are preserved; it prunes absolute extension paths left by a previous harness checkout so each tool is registered once, and does not change provider, model, theme, or unrelated packages or extensions.

After editing configured extension source, reload Pi with `/reload`. After editing `config/harness-defaults.env`, start a new Pi process because already-populated process environment values remain authoritative.

## Environment knobs

```text
PI_HERMES_ADVISORY=1             Enable explicit typed Hermes advisory surfaces
PI_HERMES_BIN=hermes             Override Hermes executable
PI_HERMES_PROVIDER=<optional>    Explicit provider override
PI_HERMES_MODEL=<optional>       Explicit model override
PI_HERMES_PROMPT_TIMEOUT_MS=10000
PI_HERMES_CONTROLLER_TIMEOUT_MS=30000
PI_HERMES_AUTH_PROBE_TIMEOUT_MS=30000
PI_HERMES_CURATION_PROBE_TIMEOUT_MS=60000
PI_HERMES_CURATION_TIMEOUT_MS=120000
PI_HERMES_SKILL_AUTO_DRAFT=0     Automatic drafting stays field-gated and off
PI_PROMPT_SUGGESTIONS_REFINE=auto Evidence-gated automatic model refinement (use 1 to force on)
PI_PROMPT_SUGGESTIONS_MODEL=<provider/modelId> Process override for the machine-wide suggestion model
PI_CODEGRAPH=0                    Disable CodeGraph extension
PI_CODEGRAPH_BIN=codegraph         Override codegraph executable
PI_CODEGRAPH_TIMEOUT_MS=120000     Default CLI timeout
PI_CODEGRAPH_ALLOW_OUTSIDE=1       Permit explicit project paths outside cwd
PI_CODEGRAPH_MAX_LINES=2000        Output truncation line cap
PI_CODEGRAPH_MAX_BYTES=51200       Output truncation byte cap
PI_CODEGRAPH_AUTO_SYNC=1           Opt into debounced background sync after edits
PI_CODEGRAPH_AUTO_SYNC_DEBOUNCE_MS=1500 Auto-sync debounce window
PI_CODEGRAPH_ADVISORY=0            Disable advisory enrichment in other workflows
PI_CODEGRAPH_ADVISORY_TIMEOUT_MS=1500 Advisory probe timeout
PI_SEMGREP=0                       Disable Semgrep extension
PI_SEMGREP_BIN=semgrep             Override semgrep executable or Docker wrapper
PI_SEMGREP_CONFIG=p/default        Reproducible default scan config (`auto` conflicts with metrics=off)
PI_SEMGREP_TIMEOUT_MS=120000       Default CLI timeout
PI_SEMGREP_ALLOW_OUTSIDE=1         Permit explicit project paths outside cwd
PI_SEMGREP_MAX_LINES=2000          Output truncation line cap
PI_SEMGREP_MAX_BYTES=51200         Output truncation byte cap
PI_SEMGREP_ADVISORY=0              Disable advisory Semgrep enrichment
PI_SEMGREP_ADVISORY_TIMEOUT_MS=8000 Advisory scan/status timeout
PI_SEMGREP_VERIFY_TIMEOUT_MS=8000  Verification-center advisory timeout
PI_SEMGREP_PATCH_TIMEOUT_MS=8000   Semantic-patch advisory timeout
PI_SEMGREP_METRICS=off             Disable Semgrep metrics by default
PI_SEMGREP_CONFIG_PROBE_TIMEOUT_MS=30000  Bound config validation before scan readiness
PI_OBSIDIAN=0                       Disable Obsidian extension
PI_OBSIDIAN_BIN=obsidian            Override Obsidian executable
PI_OBSIDIAN_VAULT="~/Obsidian/Pi Research" Managed vault path
PI_OBSIDIAN_RESEARCH_ROOTS=...      Comma-separated default import roots
PI_OBSIDIAN_ALLOW_OUTSIDE=1         Permit explicit paths outside cwd/home
PI_OBSIDIAN_AUTO_AWARE=0            Disable automatic model awareness prompt
PI_OBSIDIAN_AUTO_STATUS=0           Disable one-time automatic status probe
PI_ROADMAP=0                        Disable the roadmap checklist extension
PI_ROADMAP_WIDGET_ITEMS=6           Max roadmap items in compact widget
PI_AUTOMATION_LOOP=0                 Disable Ralph-style task loops
PI_AUTOMATION_LOOP_MAX_ITERATIONS=20 Default bounded iteration budget
PI_AUTOMATION_LOOP_MAX_STALLS=3      Pause after repeated identical no-progress turns
PI_AUTOMATION_LOOP_BACKGROUND_POLL_MS=2000 Poll managed work before continuing
PI_AUTOMATION_LOOP_ALLOW_UNBOUNDED=1 Permit explicit --max=0
PI_RUN_MONITOR=0                    Disable periodic long-run monitoring
PI_RUN_MONITOR_INTERVAL_MS=30000    Default monitor polling interval
PI_RUN_MONITOR_TIMEOUT_MS=86400000  Default observation deadline (24h)
PI_RUN_MONITOR_MAX_ACTIVE=8         Active monitors per Pi session
PI_RUN_MONITOR_INTENT_TELEMETRY=1   Metadata-only eligible/acted/terminal cohort
PI_OUTPUT_COMPACTOR_MODE=off|canary|all Selected oversized-result policy (default canary)
PI_OUTPUT_COMPACTOR_CANARY_TOOLS=evidence_binder,extension_ops,learning_loop,run_deck,run_topology,runtime_doctor,verification_center
PI_OUTPUT_COMPACTOR_MODEL_TOOL=0    Keep manual compatibility tool out of the model surface
PI_COMPACTION_RECOVERY_AUTO_CONTINUE_OUTPUT_LIMIT=0 Disable automatic output-limit continuation
PI_COMPACTION_RECOVERY_MAX_OUTPUT_LIMIT_CONTINUATIONS=3 Bound consecutive output-limit continuations
PI_CODE_CONTEXT_MODE=off|shadow|advisory|select-tests|on Progressive retrieval mode (default advisory)
PI_CODE_CONTEXT_RG_BIN=rg             Override the structured lexical search binary
PI_CODE_CONTEXT_SEARCH_LIMIT=15       Default compact search-card page size
PI_CODE_CONTEXT_BENCHMARK_REPORT=.pi/code-context/benchmarks/latest.json Promotion evidence report
PI_CODE_CONTEXT_TELEMETRY_SNIPPETS=0   Keep source snippets out of telemetry by default
PI_LSP=0                            Disable the LSP-style coding tool
PI_LSP_LIVE=0                       Disable lazy live language servers and retain compiler/fallback behavior
PI_TEST_RUNNER=0                    Disable test_runner
PI_TEST_RUNNER_ALLOW_CUSTOM=1       Allow custom command execution; inferred only by default
PI_AST_TOOLS=0                      Disable ast_search/ast_refactor
PI_DOCS_LOOKUP=0                    Disable docs_lookup
PI_PORTFOLIO_EXPERIMENTAL_TOOLS=1  Expose command-only experimental model tools (currently output_compactor)
PI_CODEMODE=0                       Opt out of default-on native hybrid CodeMode
PI_TOOL_SURFACE_ROUTER=0            Disable task/readiness-aware model tool selection
PI_TOOL_CHURN_GUARD=0               Disable repeated-call advisories
PI_WRITE_CHUNKING=0                 Disable sectioned document writes
PI_WRITE_CHUNK_LIMIT=16384          Max characters in one write/append_file payload (0 disables enforcement)
```

Canonical behavior is local-first and guarded: model prompt refinement and skill drafting are off, Hermes owns no recall or shutdown lifecycle, CodeGraph auto-sync is on but advisory, Semgrep automatic advisory scans are off, role mutation is off, role routing is suggest-only, the model tool surface is task/readiness-routed, repeated-call churn is advisory, and selected oversized structured outputs use the measured canary. See `config/harness-defaults.env` for the complete applied environment.

Document writes stay section-sized so one model turn never generates an oversized payload: `write` creates the file with the first section, `append_file` adds each later section, and a payload over `PI_WRITE_CHUNK_LIMIT` is blocked with sectioned-write guidance instead of being sent. `append_file` inserts a separating newline when the existing file does not end with one. The rule is also carried in the `write` tool description, so it is visible where the model decides to compose the payload.

## Pi request queue

Every DeepSeek (`local`) model request joins a shared Redis queue before it is
sent, so at most a configured number run at once across all machines; the rest
wait in FIFO order, and every request is recorded (metadata and token counts, no
prompts). There are no worker processes: each Pi waits for its own slot and sends
its own request. The auto-loaded `extensions/pi-queue/` wraps the provider and
adds `pi_queue_status`, `pi_queue_list` and `/queue-status`; `scripts/pi-queue`
shows status/history and sets the limit. The queue fails closed when unavailable;
set `PI_QUEUE=0` to call DeepSeek directly. See [Pi request queue](../docs/pi-queue.md).

---

[Back to the README](../README.md) · [Wiki index](README.md)
