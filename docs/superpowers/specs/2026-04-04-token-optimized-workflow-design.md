# Token-Optimized Critique-to-Execute-Plan Workflow

## Problem

The critique -> execute-plan -> refactor workflow has a token multiplication problem. For an 8-item action plan:

- Critique dispatches 4 Explore subagents (necessary, stays as-is)
- Execute-plan dispatches up to 8 worktree agents
- Each worktree agent loads /refactor via Skill tool (227 lines)
- Each /refactor dispatches 3 more Explore subagents for pre-analysis
- Total: 36 subagent contexts, most re-reading files critique already analyzed

The core issue: critique's analysis results don't flow downstream. Refactor re-discovers everything from scratch.

## Solution Overview

Five changes across three skill files:

| # | Change | File | Impact |
|---|--------|------|--------|
| 1 | Enriched action plan items | critique/SKILL.md | Carries analysis downstream |
| 2 | Inline refactor instructions | execute-plan/SKILL.md | Eliminates Skill indirection + 24 subagents |
| 3 | Batch small-scope items | execute-plan/SKILL.md | Fewer agents dispatched |
| 4 | Scope-aware verification | execute-plan/SKILL.md | Fewer build/test cycles |
| 5 | Compact output contracts | execute-plan/SKILL.md | Less reporting overhead |

## Change 1: Enriched Action Plan Items (critique/SKILL.md)

### What changes

Critique's action plan construction rules get 3 new required fields per item. These are populated from information critique's subagents already discover during analysis.

### New action plan item format

```
1. `/refactor <specific target>`
   - Addresses: MP-1, MP-3 — <brief description>
   - Rationale: <why this phase>
   - Key files: `src/foo.h`, `src/foo.cpp`
   - Scope: Small / Medium / Large
   - Callers: <list of files:lines that use/depend on target, from architecture subagent>
   - Tests: <relevant test files and what they cover, gaps noted, from testing subagent>
   - Conventions: <naming, error handling, include style from the target area>
```

### New construction rules to add

- Rule 11: **Include callers and dependents.** Each item must list the files and symbols that depend on the target, discovered during the architecture/coupling analysis. Format: `file.cpp:line (symbol)`. This eliminates downstream dependency re-discovery.
- Rule 12: **Include test context.** Each item must list the test files that exercise the target and note coverage gaps. This eliminates downstream test coverage re-assessment.
- Rule 13: **Include conventions.** Each item must note the naming conventions, error handling patterns, and include style used in the target area. This eliminates downstream convention scanning.

### Subagent prompt update

Add to the synthesis instructions (Phase C): when constructing the action plan, pull callers/dependents from Subagent 2 (Architecture & Design), test context from Subagent 4 (Testing & Performance), and conventions from Subagent 3 (Quality & Operations). These must be concrete (file paths and line numbers), not vague summaries.

## Change 2: Inline Refactor Instructions (execute-plan/SKILL.md)

### What changes

The agent prompt template in execute-plan currently says:

```
Run `/refactor [TARGET]` using the Skill tool with these arguments:
```

This loads the full 227-line refactor SKILL.md and triggers 3 more subagents per item. Replace with inlined refactoring instructions that use the pre-analyzed context from the enriched action plan.

### New agent prompt template

```
You are executing one refactoring item from a critique action plan.

Phase [PHASE], Item [ITEM_NUMBER].

## What to fix
[ADDRESSES_DESCRIPTION]

## Pre-analyzed context (do NOT re-analyze — use this directly)
- Key files: [KEY_FILES]
- Callers/dependents: [CALLERS]
- Tests: [TESTS]
- Conventions: [CONVENTIONS]

## Refactoring protocol

1. Read the key files listed above.
2. Plan the transformation. Break into atomic steps where each step preserves correctness.
3. If the Addresses description requires changes beyond the key files, check callers for needed updates.
4. Make the changes. Follow the conventions listed above.
5. Verify (see verification rules below).
6. Report results.

## Rules
- Separate structural changes from behavioral changes.
- If no tests cover the changed code paths AND Scope is Medium or Large, write tests before refactoring.
- For Small scope with tests listed: trust existing test coverage.
- Do not refactor code outside the scope of the Addresses description.
- If a change breaks the build, fix it before continuing.

## Verification by scope
- Small: Build + test once after all changes are complete.
- Medium: Build + test after each logical step (a step may include multiple file edits).
- Large: Build + test after every individual change.

Build command: [BUILD_COMMAND]
Test command: [TEST_COMMAND]

## Report format
Phase.Item: [PHASE].[ITEM_NUMBER]
Status: Success / Failed / Partial
Files changed: <list>
Summary: <1-2 sentences>
Build: pass/fail
Tests: pass/fail (count if available)
Issues: <if any>
```

### What this eliminates
- Loading refactor SKILL.md (227 lines) x N agents
- Refactor's 3 Explore subagents (dependency mapping, test coverage, convention scanning) x N agents
- For an 8-item plan: 8 Skill tool invocations + 24 subagents eliminated

## Change 3: Batch Small-Scope Items (execute-plan/SKILL.md)

### What changes

New step before dispatch in multi-item phases. Currently every item gets its own worktree agent. With this change, Small-scope items with non-overlapping key files are grouped into batches of up to 3, each batch handled by a single agent.

### New batching logic

Add after the existing "Step 0 -- Check for file overlap":

```
Step 0b -- Batch small items.

After determining which items can run in parallel (non-overlapping key files), 
group Small-scope items into batches of up to 3. Each batch becomes a single 
agent dispatch. Medium and Large scope items always get their own agent.

Batching criteria:
- All items in a batch must be Small scope
- No key file overlap within a batch
- Maximum 3 items per batch
- Items that overlap with Medium/Large items are NOT batched

The agent prompt for a batch lists all items sequentially. The agent executes 
them in order within the same worktree, with a single build+test at the end 
(since all are Small scope).
```

### Batch agent prompt template

```
You are executing [N] small refactoring items from a critique action plan.

Phase [PHASE], Items [ITEM_NUMBERS].

Execute these items in order within this worktree:

---
### Item [ITEM_NUMBER_1]: [TARGET_1]
[Full item prompt as per the inlined refactor template above]
---
### Item [ITEM_NUMBER_2]: [TARGET_2]
[Full item prompt as per the inlined refactor template above]
---

Since all items are Small scope, build and test once after ALL items are complete.

Build command: [BUILD_COMMAND]
Test command: [TEST_COMMAND]

## Report format (one per item)
[Same compact report format, repeated for each item]
```

## Change 4: Scope-Aware Verification (execute-plan/SKILL.md)

### What changes

Already embedded in the inlined agent prompt template (Change 2). The verification rules by scope:

| Scope | Verification frequency |
|-------|----------------------|
| Small | Build + test once at the end |
| Medium | Build + test after each logical step |
| Large | Build + test after every individual change |

This replaces refactor's blanket "build + test after every individual change" rule.

No separate file changes needed beyond what's in Change 2's agent prompt template.

## Change 5: Compact Output Contracts (execute-plan/SKILL.md)

### What changes

Three report templates in execute-plan get shortened.

### Before-execution summary (compact)

```
## Plan Summary
Build: <cmd> | Test: <cmd> | Baseline: Build pass/fail, Tests N passed

### Phase 1 (N items)
Items: <numbered list with target and scope>
Strategy: all parallel / batched / sequential / single

### Phase 2 (N items)
...

Deferred: <count> items | Adjacent: <count> items

Starting Phase 1.
```

### Per-phase report (compact)

```
## Phase N -- pass/fail
| # | Target | Status | Files changed |
|---|--------|--------|---------------|
| 1 | <target> | pass | foo.h, foo.cpp |
| 2 | <target> | fail | -- |

Verification: Build pass/fail | Tests pass/fail (N passed)
```

### Final report (compact)

```
## Execution Complete / Stopped

Phases: 1 pass (3/3) | 2 pass (2/2) | 3 skipped
Total: 5/5 items pass

| # | Ph | Target | Status | Files |
|---|-----|--------|--------|-------|
| 1 | 1 | <t> | pass | ... |

Skipped: <list or "none">
Deferred: <list or "none">  
Adjacent: <list or "none">
Final: Build pass | Tests pass (N)
Observations: <if any>
```

## Change 6: Pre-Analyzed Mode for Standalone Refactor (refactor/SKILL.md)

### What changes

Add a "Pre-analyzed mode" section to refactor/SKILL.md so that when `/refactor` is invoked directly (not from execute-plan) with enriched context (Callers, Tests, Conventions fields), it skips its 3 Explore subagents and uses the provided context directly. This is additive — standalone invocations without these fields still run the full pre-analysis.

### Section to add (after "Parallel pre-refactoring analysis")

```
## Pre-analyzed mode

If the arguments include **Callers**, **Tests**, and **Conventions** fields (as provided by 
/critique action plans), skip the parallel pre-refactoring analysis entirely. Use the provided 
context directly:

- Callers → dependency map (skip Subagent 1)
- Tests → test coverage assessment (skip Subagent 2)  
- Conventions → convention scan (skip Subagent 3)

Proceed directly to "Pre-refactoring analysis" step 4 (Establish baseline) using the provided 
information for steps 1-3.

This mode is triggered automatically when these fields are present. No flag is needed.
```

## Files Modified

1. **critique/SKILL.md** -- Action plan construction rules 11-13, subagent synthesis instructions
2. **execute-plan/SKILL.md** -- Agent prompt template (inlined refactor), batching logic, compact output contracts
3. **refactor/SKILL.md** -- Pre-analyzed mode section (additive, preserves standalone behavior)

## What Does NOT Change

- Critique's 4-subagent analysis structure
- Phase ordering and verification gates between phases
- Worktree isolation for parallel dispatch
- Refactor's standalone behavior when invoked directly (not from execute-plan)
- Stop-on-failure semantics
- Merge conflict handling

## Expected Impact

| Metric | Before (8-item plan) | After |
|--------|---------------------|-------|
| Total subagents | 36 | 4 (critique only) |
| Skill text loaded per agent | 227 lines | 0 (inlined ~40 lines) |
| Agents dispatched | 8 | 4-6 (batching) |
| Build/test cycles (Small items) | Multiple per item | 1 per item/batch |
| Report template size | ~80 lines | ~30 lines |
| Estimated token reduction | -- | 60-70% for execute-plan phase |
