# Session-derived generic coding skills

> Historical report: the legacy skills described here were archived during the
> [Skill Foundry migration](skill-bundle-migration.md). Their names below describe
> the original study, not current invocable skills. The report's measurements and
> limitations are unchanged.

Date: 2026-07-15  
Status: initial skill pack implemented

## Objective

Use local Pi coding-session evidence to identify repetitive development workflows that should become generic Agent Skills usable across repositories.

The investigation inspected `~/.pi/agent/sessions/` locally, but retained only aggregate counts and categorical workflow labels. No prompts, assistant responses, reasoning, raw commands, tool output, credentials, or transcript excerpts are included here.

## Privacy and methodology

The analysis followed the repository's session-mining privacy contract in [session-mining-loop.md](session-mining-loop.md):

- transcript content was inspected only in memory for fixed-category classification;
- outputs contain counts, safe tool names, fixed command families, and salted/anonymous repository buckets;
- temporary/smoke-test directories and tiny synthetic sessions were excluded from the workflow comparison;
- no local repository paths or names were persisted;
- findings are correlations and adoption gaps, not causal claims.

Two views were used:

1. **Full Pi inventory** for format and volume.
2. **Substantial-session subset** for workflow comparisons: non-temporary JSONL files at least 10 KiB, then sessions with tool activity.

The size cutoff is a noise-control heuristic, not a quality score. It removes many harness-generated smoke sessions but can also omit legitimate short tasks.

## Inventory

Full local Pi session store at investigation time:

- 1,407 JSONL files;
- about 327 MB;
- 70,119 JSONL records;
- zero JSON parse failures;
- date range: 2026-05-21 through 2026-07-15;
- 64,055 message records;
- 32,277 tool-call blocks;
- 9 persistent repository buckets with substantial sessions, plus temporary test buckets.

Most-used Pi tools in the full inventory:

| Tool | Calls |
|---|---:|
| `bash` | 10,532 |
| `read` | 7,143 |
| `edit` | 5,166 |
| `bg_run` | 2,305 |
| `write` | 1,051 |
| `roadmap_update` | 821 |
| `ast_search` | 499 |
| `debug_ledger` | 473 |
| `run_deck` | 351 |
| `test_runner` | 260 |

These totals include older and harness-heavy sessions, so they establish prevalence rather than effectiveness.

## Workflow comparison

The filtered comparison contained 109 substantial sessions with tool activity across 9 persistent repository buckets.

| Repeated workflow | Manual/legacy sessions | Repository buckets | Native fast-path sessions | Repository buckets |
|---|---:|---:|---:|---:|
| Repository Git/status/history shell ritual | 92 | 8 | `repo_context`: 22 | 7 |
| Manual build/test invocation | 47 | 8 | verifier/build tools: 22 | 7 |
| `tail`/`sleep`/watch-style monitoring | 76 | 8 | `run_deck`: 6 | 3 |
| Manual add/commit ritual | 70 | 6 | `commit_plan`: 19 | 7 |
| Three-or-more sequential reads | 98 | 8 | indexed/structural localization: 46 | 9 |

Additional evidence:

- 98 substantial sessions across all 9 persistent buckets contained at least one tool error.
- Common fixed failure categories in the redacted rolling report included command failure, policy boundary, missing resource, exact-edit mismatch, timeout, adapter failure, and malformed arguments.
- Existing native skills are strong in C++ implementation/review/refactoring, research, subsystem planning, execution, and handoff. The clearest gaps are generic operational lifecycle workflows.

The comparison counts presence per session, not raw command occurrences. A session may use both a manual ritual and its native fast path.

## Limitations

- This is a dated local snapshot, not a reproducible benchmark corpus; session files can be appended or removed after the recorded date.
- The 10 KiB cutoff favors longer tasks and may underrepresent concise successful workflows.
- Manual command-family detection is lexical and can count a token inside a nested script or heredoc, so the comparison is a prioritization signal rather than a precise replacement rate.
- Session-level counts overlap and must not be summed into a task total.
- Native-tool presence does not by itself prove that the tool was used correctly or that the session succeeded.

## Selected skill pack

Four non-overlapping lifecycle skills were selected:

| Skill | Trigger boundary | Primary adoption gap |
|---|---|---|
| `repo-orient` (archived; superseded by `codebase-onboarding`) | Read-only entry into an unfamiliar repo/subsystem | repeated Git shell snapshots and broad read sweeps |
| `change-verify` (restored) | Verify an existing change; no repairs or commits | manual or incomplete build/test selection |
| `long-run` (restored) | Manage a command that outlives a normal call | repeated `sleep`/`tail` polling and duplicate launches |
| `git-checkpoint` (restored) | Explicitly requested local commit/checkpoint only | manual staging/commit rituals and mixed changes |

Together they cover:

```text
orient -> implement with an existing domain skill -> monitor long work -> verify -> checkpoint
```

The skills remain thin orchestration over available harness tools. Every skill defines a bounded fallback for repositories or agent harnesses where those tools are unavailable.

## Deferred candidates

### Generic tool recovery

A standalone `tool-recovery` skill was considered but deferred. Tool errors are broad: an exact-edit mismatch, missing index, policy block, timeout, and failed test command do not share one safe recovery action. A universal recovery skill risks triggering after every ordinary failure and overlapping bug investigation.

For this initial pack, each selected skill contains local failure classification and bounded fallbacks. Reconsider a dedicated skill when later scans show one or two recovery sequences recurring across several repositories and a measurable successful postcondition.

### Automated prompt-family skill creation

Repeated prompt fingerprints are deliberately salted and text-free. They are leads, not enough evidence to generate a skill automatically. Any prompt-family candidate still requires local human review, a distinct boundary, and explicit approval.

## Evaluation plan

Re-run the redacted session miner after real adoption time, ideally over a 30-day window:

```text
learning_loop operation=sessionScan
learning_loop operation=sessionReport
```

Measure trends rather than one-off counts:

- `repo_context` use relative to `git status` + `git log` shell families;
- indexed localization relative to sequential read sweeps;
- `build_project`/`test_runner`/`verification_center` use relative to manual build/test families;
- `run_deck`/`bg_run` managed status relative to `tail` + `sleep` monitoring;
- `commit_plan` use relative to manual add/commit rituals;
- tool error and user-correction rates;
- skill selection precision and explicit user rejections.

Promotion criteria for keeping a skill:

1. It is selected for its intended trigger in multiple repositories.
2. It reduces the corresponding manual ritual or failure category.
3. It does not create instruction noise or duplicate a domain skill.
4. Its required evidence is actually collected before completion claims.

Deprecate or narrow a skill if selection is noisy, native-tool adoption does not improve, or users repeatedly correct its boundary.
