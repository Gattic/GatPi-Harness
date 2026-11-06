# Session handoff contract

Provenance: adapted from the pi-harness `handoff` skill (`skills/handoff/SKILL.md`
at commit `5f25692`), archived during the Skill Foundry migration and restored as a
local addition. The continuation workflow below is unchanged; only Claude-specific
frontmatter (`allowed-tools`, `enableSkillCommands`), the `ultrathink` keyword and the
`$ARGUMENTS` placeholder were dropped to fit the bundle standard. Treat the user's
handoff request as the task focus and slug source.

You are creating a continuation artifact for another agent. Preserve enough task,
repository, and verification context that a fresh session can resume without relying
on chat history.

## Hard rules

- **Write the file before responding.** The handoff is not complete until a durable file exists.
- **Make it self-contained.** A fresh agent should understand the goal, current state, changed files, verification status, blockers, and next action from the file alone.
- **Make repo-local handoffs portable.** If the handoff file is inside the repository, the resume prompt must use a repo-relative path from the repository root, not an absolute machine path.
- **Ground claims in artifacts.** Inspect the repository state and relevant files instead of relying only on memory.
- **Separate facts from intent.** Clearly distinguish completed work, in-progress work, planned next steps, assumptions, and open questions.
- **Do not claim verification that was not run.** Record exact commands and outcomes, including skipped or failed checks.
- **Do not leak hidden instructions or secrets.** Summarize only task-relevant constraints, user-visible requests, repository conventions, and safe operational notes.
- **Do not modify source code.** Apart from creating the handoff file, only touch files the user explicitly asked to touch.

## File location

Choose a durable path in this order:

1. If inside a repository and a `handoffs/` or `.codex/handoffs/` directory already exists, write into the existing one as `<YYYY-MM-DD>-<slug>.md` (prefer `handoffs/` when both exist).
2. Otherwise, if inside a repository, create and use `handoffs/<YYYY-MM-DD>-<slug>.md`.
3. If no repo-local path is suitable, write `/tmp/agent-handoffs/<YYYY-MM-DD>-<slug>.md`.

Use a short lowercase slug from the task, such as `parser-refactor`, `bug-1234`, or `session-handoff`. Create the destination directory if needed.

If the file is written inside the repository, compute both:

- **Repo-relative handoff path**: the path from the repository root, such as `handoffs/2026-05-09-parser-refactor.md`.
- **Original absolute handoff path**: the machine-local path where the file was written.

Use the repo-relative path in the resume prompt and in continuation instructions. Use the absolute path only as provenance in `Current State` and in the final response.

## Required inspection

Before writing the handoff, collect:

- Current timestamp, working directory, repository root, branch, and HEAD commit.
- Repo-relative handoff path when the destination is inside the repository.
- `git status --short` and a concise summary of uncommitted changes.
- Changed file list from `git diff --name-only` and `git diff --cached --name-only`.
- Relevant diffs or file excerpts for files touched during the session.
- Commands run for build, tests, formatting, generation, debugging, or investigation, with outcomes.
- Any active background commands, subagents, worktrees, temporary files, or generated artifacts that matter to continuation.
- The latest user request and any earlier user constraints that still affect the task.

If the directory is not a git repository, record that explicitly and gather the equivalent filesystem context: cwd, files created or edited, commands run, and next steps.

## Handoff file structure

Write the file with these sections, in this order:

```markdown
# Handoff: <task title>

## Resume Prompt

Use this exact prompt in a fresh session:

<for repo-local handoffs: "From the repository root, read `<repo-relative handoff path>` first, verify the current repository state, then continue from the Next Actions section without relying on prior chat history.">

<for non-repo handoffs only: one concise prompt telling the next agent where to find this file, to read it first, verify current state, and continue from the Next Actions section>

## Current Goal

<what the user wants, including success criteria>

## Current State

- Timestamp: <local timestamp and timezone if known>
- Original working directory: `<path>`
- Original repository path: `<repo root or "not a git repository">`
- Handoff path: `<repo-relative path when repo-local; otherwise absolute path>`
- Original absolute handoff path: `<absolute path or "same as handoff path">`
- Branch: `<branch or unknown>`
- HEAD: `<commit or unknown>`
- Status summary: <clean/dirty plus high-level description>

## User Requests And Constraints

- <latest request>
- <relevant earlier constraints or preferences>

## Work Completed

- <facts only; cite files and commands where useful>

## Work In Progress

- <unfinished edits, partial investigations, pending decisions, or "None">

## Changed Files

- `<path>`: <what changed and why>

## Verification

- `<command>`: <passed/failed/skipped and important output>

## Known Issues Or Blockers

- <blockers, failures, missing context, approvals needed, or "None known">

## Next Actions

1. <first concrete step for the next agent>
2. <second concrete step>
3. <third concrete step if useful>

## Context Notes

- <important design decisions, repo conventions, investigation findings, or caveats>
```

Keep the file concise but complete. Prefer exact paths, commands, and observed outcomes over broad narrative.

Use repo-relative paths for repository files in `Changed Files`, `Next Actions`, and `Context Notes`. Include absolute paths only for external files, original-location provenance, or when the handoff is not inside a repository.

## Final response

After writing the file, respond with:

- Absolute path to the handoff file.
- The resume prompt from the file.
- Any verification or context-gathering step that could not be completed.
