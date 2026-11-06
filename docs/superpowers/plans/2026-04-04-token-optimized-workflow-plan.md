# Token-Optimized Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce token usage by 60-70% in the critique-to-execute-plan workflow by eliminating redundant subagent analysis, inlining refactor instructions, batching small items, and compacting output contracts.

**Architecture:** Three skill files are modified. Critique produces enriched action plan items carrying analysis context downstream. Execute-plan inlines refactoring instructions instead of delegating to /refactor, batches small items, and uses compact reports. Refactor gains a pre-analyzed mode for standalone use with enriched context.

**Tech Stack:** Markdown skill files (no code compilation or tests — verification is structural review of each edited file)

---

### Task 1: Add enriched fields to critique's action plan format (critique/SKILL.md)

**Files:**
- Modify: `critique/SKILL.md:96-106` (action plan construction rules)
- Modify: `critique/SKILL.md:219-239` (action plan template in required output format)

- [ ] **Step 1: Add construction rules 11-13**

In `critique/SKILL.md`, after rule 10 (line 106: `10. **Include build and test commands.**...`), add three new rules:

```markdown
11. **Include callers and dependents.** Each item must list the files and symbols that depend on the target, discovered during the architecture/coupling analysis. Format: `file.cpp:line (symbol)`. This eliminates downstream dependency re-discovery.
12. **Include test context.** Each item must list the test files that exercise the target and note coverage gaps. This eliminates downstream test coverage re-assessment.
13. **Include conventions.** Each item must note the naming conventions, error handling patterns, and include style used in the target area. This eliminates downstream convention scanning.
```

- [ ] **Step 2: Update the action plan item template in "Required output format"**

In `critique/SKILL.md`, the action plan item template (inside the `### Phase 1 — Foundation` section) currently looks like:

```markdown
1. `/refactor <specific target>`
   - Addresses: MP-1, MP-3 — <brief description of what these problems are>
   - Rationale: <why this belongs in Phase 1 — dependency, safety, or unblocking reason>
   - Key files: `src/foo.h`, `src/foo.cpp`
   - Scope: Small / Medium / Large

2. `/refactor <specific target>`
   - Addresses: MP-2 — <brief description>
   - Rationale: <reason>
   - Key files: `src/bar.h`, `src/bar.cpp`
   - Scope: Small / Medium / Large
```

Replace with:

```markdown
1. `/refactor <specific target>`
   - Addresses: MP-1, MP-3 — <brief description of what these problems are>
   - Rationale: <why this belongs in Phase 1 — dependency, safety, or unblocking reason>
   - Key files: `src/foo.h`, `src/foo.cpp`
   - Scope: Small / Medium / Large
   - Callers: `src/bar.cpp:42 (uses Foo::run)`, `src/baz.cpp:18 (includes foo.h)`
   - Tests: `tests/test_foo.cpp` covers X and Y; Z path is untested
   - Conventions: snake_case, Result<T> error codes, `<project/...>` includes

2. `/refactor <specific target>`
   - Addresses: MP-2 — <brief description>
   - Rationale: <reason>
   - Key files: `src/bar.h`, `src/bar.cpp`
   - Scope: Small / Medium / Large
   - Callers: `src/main.cpp:100 (calls bar_init)`, `src/util.cpp:55 (includes bar.h)`
   - Tests: `tests/test_bar.cpp` covers init and teardown; error path untested
   - Conventions: snake_case, error codes via errno, `<project/...>` includes
```

- [ ] **Step 3: Add synthesis instruction for action plan context**

In `critique/SKILL.md`, in the "Synthesis (Phase C)" section (around line 83), after the line `- Deduplicate issues across subagents when merging into Major Problems`, add:

```markdown
- When constructing the Action Plan, populate each item's Callers, Tests, and Conventions fields using concrete evidence from the subagent reports: callers/dependents from Subagent 2 (Architecture & Design), test context from Subagent 4 (Testing & Performance), conventions from Subagent 3 (Quality & Operations). These must be specific file paths and line numbers, not vague summaries.
```

- [ ] **Step 4: Verify the edited file**

Read back `critique/SKILL.md` and verify:
- Rules 11-13 appear after rule 10
- The action plan template includes Callers, Tests, Conventions fields on both example items
- The synthesis instruction references the correct subagent numbers
- No duplicate or misplaced text

- [ ] **Step 5: Commit**

```bash
git add critique/SKILL.md
git commit -m "feat(critique): enrich action plan items with callers, tests, conventions

Adds construction rules 11-13 and updates the action plan template so
downstream consumers (execute-plan, refactor) receive pre-analyzed
context and can skip redundant re-analysis."
```

---

### Task 2: Add pre-analyzed mode to refactor (refactor/SKILL.md)

**Files:**
- Modify: `refactor/SKILL.md:43-48` (insert after "Parallel pre-refactoring analysis" subsection ending)

- [ ] **Step 1: Add pre-analyzed mode section**

In `refactor/SKILL.md`, after the "Using the results" subsection (which ends at line 48 with `4. Proceed with the pre-refactoring analysis steps below, filling in any gaps`), add:

```markdown

## Pre-analyzed mode

If the arguments include **Callers**, **Tests**, and **Conventions** fields (as provided by `/critique` action plans), skip the "Parallel pre-refactoring analysis" section entirely. Use the provided context directly:

- Callers → use as dependency map (skip Subagent 1 — Dependency mapping)
- Tests → use as test coverage assessment (skip Subagent 2 — Test coverage)
- Conventions → use as convention scan (skip Subagent 3 — Convention scanning)

Proceed directly to "Pre-refactoring analysis" step 4 (Establish baseline) using the provided information for steps 1-3.

This mode is triggered automatically when all three fields are present in the arguments. No flag is needed. If any of the three fields is missing, run the full parallel pre-refactoring analysis as normal.
```

- [ ] **Step 2: Verify the edited file**

Read back `refactor/SKILL.md` and verify:
- The new section appears between "Using the results" and "Pre-refactoring analysis"
- The trigger condition is clear (all three fields must be present)
- The fallback is explicit (missing fields → full analysis)
- The rest of the file is unchanged

- [ ] **Step 3: Commit**

```bash
git add refactor/SKILL.md
git commit -m "feat(refactor): add pre-analyzed mode to skip subagents when context provided

When invoked with Callers, Tests, and Conventions fields (from /critique
action plans), skips the 3 Explore subagents and uses the provided
context directly. Standalone invocations without these fields are unchanged."
```

---

### Task 3: Replace execute-plan agent prompt template with inlined refactor (execute-plan/SKILL.md)

**Files:**
- Modify: `execute-plan/SKILL.md:81-168` (single-item phase, multi-item phase dispatch, agent prompt template)

- [ ] **Step 1: Replace the single-item phase section**

In `execute-plan/SKILL.md`, replace the single-item phase section (lines 85-89):

```markdown
1. Invoke `/refactor <target>` via the Skill tool with full context
2. After the refactor completes, verify build + tests
3. If verification passes, proceed to the next phase
```

With:

```markdown
1. Execute the refactoring directly using the inlined protocol (see "Inlined refactoring protocol" below) with the item's pre-analyzed context
2. After the refactoring completes, verify build + tests
3. If verification passes, proceed to the next phase
```

- [ ] **Step 2: Replace the agent prompt template**

In `execute-plan/SKILL.md`, replace the entire "Agent prompt template" section (lines 145-168):

```markdown
### Agent prompt template

Each dispatched agent receives this prompt (fill in the bracketed values from the parsed action plan):
```

And its content, with:

```markdown
### Inlined refactoring protocol

This protocol is used both for single-item phases (executed directly) and as the agent prompt for worktree agents. It replaces the previous `/refactor` Skill invocation to eliminate the overhead of loading the refactor skill and its 3 pre-analysis subagents per item.

Each dispatched agent receives this prompt (fill in the bracketed values from the parsed action plan):
```

Then replace the old agent prompt content (the code block from line 148 to 168) with:

````
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
````

- [ ] **Step 3: Update the "Carry forward context" hard rule**

In `execute-plan/SKILL.md`, replace line 22:

```markdown
- **Carry forward context.** When invoking each `/refactor`, include the "Addresses" context so the refactor skill knows what problems to fix and why.
```

With:

```markdown
- **Carry forward context.** When executing each refactoring item, include the full pre-analyzed context (Addresses, Callers, Tests, Conventions) so the inlined protocol has all needed information without re-analysis.
```

- [ ] **Step 4: Update the items parsing section to extract new fields**

In `execute-plan/SKILL.md`, in the "Items" subsection under "Parsing the action plan", the extraction list (lines 52-57) currently reads:

```markdown
Extract from each item:
1. **Item number**: The number within the phase (1, 2, 3...)
2. **Target**: The argument to `/refactor`
3. **Addresses**: The MP-IDs and description (pass this through to the refactor)
4. **Rationale**: Why this item is in this phase
5. **Key files**: The files expected to change (used for merge conflict detection)
6. **Scope**: Small / Medium / Large
7. **Phase**: Which phase (1, 2, or 3) the item belongs to
```

Replace with:

```markdown
Extract from each item:
1. **Item number**: The number within the phase (1, 2, 3...)
2. **Target**: The argument to `/refactor`
3. **Addresses**: The MP-IDs and description (pass this through to the refactoring protocol)
4. **Rationale**: Why this item is in this phase
5. **Key files**: The files expected to change (used for merge conflict detection and batching)
6. **Scope**: Small / Medium / Large (used for verification frequency and batching)
7. **Phase**: Which phase (1, 2, or 3) the item belongs to
8. **Callers**: Files and symbols that depend on the target (used directly by the refactoring protocol)
9. **Tests**: Test files and coverage info (used directly by the refactoring protocol)
10. **Conventions**: Naming, error handling, include patterns (used directly by the refactoring protocol)
```

- [ ] **Step 5: Verify the edited file**

Read back `execute-plan/SKILL.md` and verify:
- The single-item section references the inlined protocol
- The agent prompt template is the new inlined version
- The "Carry forward context" rule references pre-analyzed context
- The extraction list includes all 10 fields
- No references to "Skill tool" or `/refactor` Skill invocation remain

- [ ] **Step 6: Commit**

```bash
git add execute-plan/SKILL.md
git commit -m "feat(execute-plan): inline refactor instructions, eliminate Skill indirection

Replaces /refactor Skill invocations with inlined refactoring protocol.
Each worktree agent now receives pre-analyzed context directly instead
of loading the 227-line refactor SKILL.md and spawning 3 subagents.
Eliminates up to 24 subagent invocations for an 8-item plan."
```

---

### Task 4: Add small-item batching logic to execute-plan (execute-plan/SKILL.md)

**Files:**
- Modify: `execute-plan/SKILL.md` (multi-item phase section, after Step 0)

- [ ] **Step 1: Add Step 0b — Batch small items**

In `execute-plan/SKILL.md`, after the existing "Step 0 — Check for file overlap" paragraph (which ends with `Only items with non-overlapping key files are dispatched concurrently.`), add:

```markdown

**Step 0b — Batch small items.**

After determining which items can run in parallel, group Small-scope items into batches of up to 3. Each batch becomes a single agent dispatch instead of one agent per item.

Batching criteria:
- All items in a batch must be Small scope
- No key file overlap within a batch
- Maximum 3 items per batch
- Items whose key files overlap with a Medium/Large item are NOT batched — they run sequentially relative to that item as determined in Step 0

Medium and Large scope items always get their own dedicated agent.
```

- [ ] **Step 2: Update Step 1 to reference batching**

In `execute-plan/SKILL.md`, replace the Step 1 dispatch instruction:

```markdown
**Step 1 — Dispatch independent items simultaneously.**

For each independent item in the phase, launch an Agent with `isolation: "worktree"`:

```
Agent(
  description: "Refactor <short target name>",
  isolation: "worktree",
  prompt: <see agent prompt template below>
)
```

All independent agents in the phase MUST be dispatched in a single message to run concurrently.
```

With:

```markdown
**Step 1 — Dispatch agents simultaneously.**

For each dispatch unit (a single Medium/Large item, or a batch of Small items), launch an Agent with `isolation: "worktree"`:

```
Agent(
  description: "Refactor <short target name or 'N small items'>",
  isolation: "worktree",
  prompt: <see inlined refactoring protocol for single items, or batch prompt template for batches>
)
```

All agents in the phase MUST be dispatched in a single message to run concurrently.

#### Batch prompt template

For batches of Small-scope items, use this prompt instead of the single-item protocol:

```
You are executing [N] small refactoring items from a critique action plan.

Phase [PHASE], Items [ITEM_NUMBERS].

Execute these items in order within this worktree:

---
### Item [ITEM_NUMBER]: [TARGET]

## What to fix
[ADDRESSES_DESCRIPTION]

## Pre-analyzed context (do NOT re-analyze — use this directly)
- Key files: [KEY_FILES]
- Callers/dependents: [CALLERS]
- Tests: [TESTS]
- Conventions: [CONVENTIONS]

[Repeat the above block for each item in the batch]
---

## Rules
- Separate structural changes from behavioral changes.
- Do not refactor code outside the scope of each item's Addresses description.
- If a change breaks the build, fix it before continuing to the next item.

Since all items are Small scope, build and test once after ALL items are complete.

Build command: [BUILD_COMMAND]
Test command: [TEST_COMMAND]

## Report format (one per item)
Phase.Item: [PHASE].[ITEM_NUMBER]
Status: Success / Failed / Partial
Files changed: <list>
Summary: <1-2 sentences>
Build: pass/fail (shared — reported on last item)
Tests: pass/fail (shared — reported on last item)
Issues: <if any>
```
```

- [ ] **Step 3: Verify the edited file**

Read back `execute-plan/SKILL.md` and verify:
- Step 0b appears after Step 0
- Step 1 references both single-item and batch dispatch
- The batch prompt template is present
- The batching criteria are clear (Small only, no overlap, max 3)

- [ ] **Step 4: Commit**

```bash
git add execute-plan/SKILL.md
git commit -m "feat(execute-plan): batch Small-scope items into shared agents

Groups up to 3 non-overlapping Small items per agent, reducing total
agent dispatches. Medium/Large items still get dedicated agents."
```

---

### Task 5: Replace output contracts with compact versions (execute-plan/SKILL.md)

**Files:**
- Modify: `execute-plan/SKILL.md` (output contract section — "Before execution", "Per-phase report", "Final report")

- [ ] **Step 1: Replace "Before execution" template**

In `execute-plan/SKILL.md`, replace the entire "Before execution" subsection under "Output contract" (the template starting with `## Action Plan Summary` through `Starting Phase 1.`) with:

````markdown
### Before execution

```
## Plan Summary
Build: <cmd> | Test: <cmd> | Baseline: Build pass/fail, Tests N passed

### Phase 1 (N items)
Items: <numbered list with target and scope>
Strategy: all parallel / batched (M batches) / sequential / single

### Phase 2 (N items)
...

### Phase 3 (N items)
...

Deferred: <count> items | Adjacent: <count> items

Starting Phase 1.
```
````

- [ ] **Step 2: Replace "Per-phase report" template**

In `execute-plan/SKILL.md`, replace the entire "Per-phase report" subsection (the template starting with `## Phase N — Complete` through `Proceeding to Phase N+1. / Stopped: <reason>.`) with:

````markdown
### Per-phase report

```
## Phase N — pass/fail
| # | Target | Status | Files changed |
|---|--------|--------|---------------|
| 1 | <target> | pass | foo.h, foo.cpp |
| 2 | <target> | fail | — |

Verification: Build pass/fail | Tests pass/fail (N passed)
```
````

- [ ] **Step 3: Replace "Final report" template**

In `execute-plan/SKILL.md`, replace the entire "Final report" subsection (the template starting with `## Action Plan Execution — Complete / Stopped` through `<anything discovered during execution...>`) with:

````markdown
### Final report

```
## Execution Complete / Stopped

Phases: 1 pass (N/M) | 2 pass (N/M) | 3 skipped
Total: N/M items pass

| # | Ph | Target | Status | Files |
|---|-----|--------|--------|-------|
| 1 | 1 | <target> | pass | foo.h, foo.cpp |

Skipped: <list or "none">
Deferred: <list or "none">
Adjacent: <list or "none">
Final: Build pass | Tests pass (N)
Observations: <if any>
```
````

- [ ] **Step 4: Verify the edited file**

Read back `execute-plan/SKILL.md` and verify:
- All three report templates are replaced
- The compact templates contain all essential fields (no information lost)
- The markdown formatting is correct (code blocks properly closed)

- [ ] **Step 5: Commit**

```bash
git add execute-plan/SKILL.md
git commit -m "feat(execute-plan): compact output contracts to reduce reporting overhead

Replaces verbose report templates with minimal versions. Same essential
information in ~30 lines instead of ~80 lines of template text."
```

---

### Task 6: Update execute-plan anti-patterns (execute-plan/SKILL.md)

**Files:**
- Modify: `execute-plan/SKILL.md` (anti-patterns section)

- [ ] **Step 1: Add new anti-patterns for the new features**

In `execute-plan/SKILL.md`, at the end of the anti-patterns list, add:

```markdown
- Invoking `/refactor` via Skill tool instead of using the inlined refactoring protocol
- Dispatching a separate agent for each Small-scope item when they could be batched
- Running multiple build+test cycles for Small-scope items (verify once at the end)
- Omitting Callers/Tests/Conventions from agent prompts when the action plan provides them
```

- [ ] **Step 2: Verify the edited file**

Read back the anti-patterns section and verify all new entries are present and consistent with the rest of the file.

- [ ] **Step 3: Commit**

```bash
git add execute-plan/SKILL.md
git commit -m "feat(execute-plan): add anti-patterns for new batching and inline features"
```

---

### Task 7: Final structural review of all three files

**Files:**
- Review: `critique/SKILL.md`
- Review: `execute-plan/SKILL.md`
- Review: `refactor/SKILL.md`

- [ ] **Step 1: Review critique/SKILL.md**

Read the full file. Verify:
- Rules 1-13 are sequentially numbered with no gaps
- The action plan template in "Required output format" matches the new format with all 7 fields
- The Phase C synthesis instruction about populating Callers/Tests/Conventions is present
- No orphaned references to old format

- [ ] **Step 2: Review execute-plan/SKILL.md**

Read the full file. Verify:
- No remaining references to invoking `/refactor` via Skill tool
- The inlined refactoring protocol is complete
- Batching logic (Step 0b) appears between Step 0 and Step 1
- Batch prompt template is present in Step 1
- All three compact output templates are in place
- The extraction list has 10 items
- Anti-patterns include the new entries
- The file is internally consistent (no section references something removed)

- [ ] **Step 3: Review refactor/SKILL.md**

Read the full file. Verify:
- "Pre-analyzed mode" section appears after "Using the results"
- The trigger condition (all three fields present) is clear
- The fallback (missing fields → full analysis) is stated
- The rest of the file is unchanged

- [ ] **Step 4: Final commit (if any fixes needed)**

```bash
git add critique/SKILL.md execute-plan/SKILL.md refactor/SKILL.md
git commit -m "fix: address structural review findings across skill files"
```

Only commit if fixes were needed. Skip if all three files passed review.
