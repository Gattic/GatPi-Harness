# Cross-agent session-mining improvement loop

Date: 2026-07-11
Status: implemented, explicit/review-gated

## Purpose

The session miner turns recurring behavior in Claude, Codex, and Pi sessions into aggregate evidence for the existing reviewed learning loop:

```text
session JSONL
  -> format adapters
  -> redacted aggregate metrics
  -> stable improvement candidates
  -> learning outcomes
  -> repeated-pattern mining
  -> reviewed proposal
  -> delegated change + verification
  -> later scan measures adoption/regression
```

It closes the gap between one-off manual corpus studies and a repeatable feedback cycle. It does **not** automatically mutate prompts, skills, configuration, or source files.

## Sources

Defaults:

```text
~/.claude/projects/
~/.codex/sessions/
~/.pi/agent/sessions/
```

The adapters understand:

- Claude `message.content` tool-use/tool-result records, explicit `Skill` calls, and attribution metadata.
- Codex response items plus command/patch completion events.
- Pi session messages, `toolCall` blocks, and `toolResult` failure flags.

Only `*.jsonl` session files are scanned. Claude memory Markdown and arbitrary JSON artifacts are not ingested.

Override roots when needed:

```text
PI_SESSION_MINING_CLAUDE_ROOT
PI_SESSION_MINING_CODEX_ROOT
PI_SESSION_MINING_PI_ROOT
```

## Privacy contract

The scanner may inspect session content in memory to classify behavior, but persisted state contains only:

- counts and rates;
- categorical tool, command-family, skill, correction, and workflow labels;
- fixed provider-error, tool-failure, and session-terminal categories;
- HMAC prompt fingerprints made with a random local salt;
- candidate IDs, summaries, and aggregate evidence.

It never persists:

- transcript excerpts or reasoning;
- prompts or assistant responses;
- raw shell commands, arguments, or tool output;
- repository names or filesystem paths;
- credentials or secret-like values.

Unknown labels that are not safe identifiers become salted `private-<kind>:<hash>` values. Local state is mode `0600` where files are created and is ignored under `.pi/session-mining/`.

## Signals

Each rolling-window report includes:

- sessions, user/assistant turns, rows, and bytes by source;
- tool calls and canonical outcome counts (`succeeded`, `domain-negative`, `blocked`, `not-applicable`, `cancelled`, `timed-out`, `infrastructure-failed`, `unknown`), with generic reliability candidates restricted to infrastructure failures/timeouts;
- Pi assistant stop reasons plus fixed provider categories such as `transport`, `timeout`, `context-limit`, `credentials`, and `provider-server`;
- Pi sessions affected by provider errors, sessions whose latest error later recovered, terminal provider failures, unresolved pending sessions, and pending/failed terminal states stale for at least one hour;
- normalized shell-command families such as `cmake --build`, `git status`, `tail`, and `nvidia-smi` without arguments;
- explicit skill calls and separately counted Claude skill-attribution events;
- correction categories (`persistence`, `instruction_miss`, `correction`) without text;
- normalized-repeat prompt groups (case/whitespace/numbers normalized) represented only by salted HMACs;
- repeated three-tool workflow sequences;
- row-window accounting (counted, undated, before/after interval, earliest/latest counted timestamps) plus current candidates and comparable-cohort trend changes.

Candidate IDs are stable across scans. A candidate can therefore be marked `new`, remain present, or become `cleared` after an improvement. Learning outcomes are keyed by candidate plus UTC day and carry candidate-specific classifications, so repeated scans cannot flood the ledger and unrelated findings in one scan cannot masquerade as a repeated pattern; persistence across later days remains mineable.

## Incremental and bounded scanning

`src/session-miner.js` keeps per-file aggregate summaries in `.pi/session-mining/state.json`. File mtime is only an opening optimization. Every parsed dated row is checked against inclusive `sinceAt`/`untilAt` bounds before any semantic aggregation; undated rows are counted and excluded by default. A file summary is reused only when size, mtime, schema, and the exact cohort key are unchanged. Changed/appended files or changed windows are rescanned, and files with no counted rows do not enter the session denominator.

Defaults:

```text
window:       30 days
scan budget:  newest 1 GiB of eligible JSONL
history:      last 100 compact reports
lock:         one scan at a time, stale after 15 minutes
```

The local random salt and cached summaries stay in runtime state and are not exported by the learning loop.

State:

```text
.pi/session-mining/
  state.json       local salt + per-file aggregate cache
  latest.json      latest redacted report
  history.jsonl    compact trend history (last 100)
  scan.lock        present only while scanning
```

## Operator surface

Pi commands:

```text
/learning-scan-sessions [--since-days=N] [--full] [--no-record]
/learning-session-report
/roadmap-start Learning loop dogfood
```

Model tool:

```text
learning_loop operation=sessionScan
learning_loop operation=sessionReport
```

Script/automation surface:

```bash
node scripts/mine-agent-sessions.js --since-days=30 --record-outcomes
node scripts/mine-agent-sessions.js --since-days=7 --json
node scripts/mine-agent-sessions.js --full --max-bytes=1073741824
```

The script is suitable for a user-managed daily systemd timer or cron entry. Scheduling is intentionally not installed automatically.

## Reviewed improvement loop

1. **Scan** — run the incremental miner. Candidate outcomes are recorded by default from the Pi command/tool; the script requires `--record-outcomes`.
2. **Accumulate** — do not react to one weak signal. Re-scan after real work so candidate persistence and rates become measurable.
3. **Mine patterns** — run `/learning-patterns --mine --min=2` (or the failure-only variant).
4. **Propose** — run `/learning-propose --min=2`. Generated skill/test/prompt/config proposals remain drafts.
5. **Review** — run `/learning-review <id>` for evidence, privacy, policy, and impact gates.
6. **Approve explicitly** — prompt/config/skill changes never auto-approve.
7. **Delegate safely** — use Skill Synthesis, reviewed `edit`/`ast_refactor`, or a policy-approved config workflow; the learning loop itself does not mutate files.
8. **Verify** — run focused verification and bind evidence.
9. **Measure** — scan the next window and compare native-tool adoption, failure rate, correction rate, and candidate clearance.

## Candidate interpretation

Candidates are leads, not conclusions:

- `tool-failure`: inspect the fixed failure-category breakdown before hardening a tool; expected nonzero commands and safety-policy blocks are not runtime crashes.
- `provider-failure`: correlate transport/timeout categories with runtime traces, transport fallback, and retry latency before changing global settings.
- stale terminal states are interruption indicators, not proof of a process crash; distinguish an abandoned active session from a terminal provider failure.
- `workflow-repetition`: determine whether the repeated sequence is legitimate or deserves a tool/skill fast path.
- `skill-adoption-gap`: inspect selector precision and telemetry; do not increase prompt noise blindly.
- `user-correction`: review instruction adherence without storing or replaying the user's words.
- `automation-adoption`: compare repeated shell families with their existing native tool equivalent.

The miner deliberately avoids automatic causal claims. A falling failure/adoption rate after a verified change is stronger evidence than a single cross-sectional count.

## Verification

Focused checks:

```bash
node tests/session-miner.test.js
node tests/learning-loop.test.js
node tests/learning-loop-coordinator.test.js
node tests/tool-surface-router.test.js
```

`tests/session-miner.test.js` covers all three formats, error deduplication, secret/path/command non-persistence, salted prompt repetition, canonical domain-versus-infrastructure outcomes, strict mixed-window row filtering, undated-row policy, exact-cohort cache reuse, trend compatibility, candidate generation, and learning-outcome conversion.
