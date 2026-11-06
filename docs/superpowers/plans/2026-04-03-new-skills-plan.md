# New Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four new skills (test-design, observability, security, api-design) to the claude-skills repository, following the existing skill architecture exactly.

**Architecture:** Each skill is a single `SKILL.md` file in its own directory. Skills follow the established anatomy: YAML frontmatter, hard rules, decision trees, subagent workflows, output contracts, and anti-patterns. The README and workflow graph are updated to reference the new skills.

**Tech Stack:** Markdown with YAML frontmatter. No code dependencies.

---

## File Structure

```
claude-skills/
  test-design/SKILL.md          (CREATE) — test strategy design skill
  observability/SKILL.md         (CREATE) — structured logging and runtime diagnostics skill
  security/SKILL.md              (CREATE) — security audit and hardening skill
  api-design/SKILL.md            (CREATE) — C++ API design and evolution skill
  README.md                      (MODIFY) — add new skills to tables, update workflow graph, update subagent table
```

Each task creates one skill file. Task 5 updates the README. Tasks 1-4 are independent and can be parallelized.

---

### Task 1: Create test-design skill

**Files:**
- Create: `test-design/SKILL.md`

- [ ] **Step 1: Create the test-design directory**

```bash
mkdir -p ~/dev/claude-skills/test-design
```

- [ ] **Step 2: Write test-design/SKILL.md**

```markdown
---
name: test-design
description: Design test strategies for C++ components. Provide the component, module, or subsystem to test. Determines what to test, how to structure tests, and how to test concurrent and async code. Produces a test matrix, test case catalog, and fixture/mock design.
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Bash, Agent
---

ultrathink

You are designing test strategies for a C++ systems engineering team. Your job is to determine what to test, how to structure the tests, and how to handle concurrent/async testing. You do not write the test code — you design the strategy.

The target to test is:

$ARGUMENTS

## Hard rules

- **Test behavior, not implementation.** Tests assert what the code does, not how it does it internally.
- **Every test must have a reason.** If you can't articulate what failure this test would catch, remove it.
- **Flaky tests are bugs.** A test that sometimes fails for reasons other than a real defect is worse than no test.
- **Test at the right level.** Don't use integration tests for logic that can be unit-tested. Don't use unit tests for behavior that only manifests across components.
- **Concurrency tests must be deterministic OR stress-based, never sleep-based.** If a test uses `sleep()` for synchronization, it is broken by design.

## Step 1: Locate and understand the target

Read the target code. Identify:
- Public API surface (the testable interface)
- Internal complexity (where bugs are likely to hide)
- Dependencies (what needs to be mocked, faked, or provided)
- Concurrency (shared mutable state, threading, async operations)
- Error paths (how failures propagate)

## Parallel analysis

Dispatch 3 Explore subagents in parallel to analyze independent test dimensions:

### Subagent 1 — Testability analysis

Examine the target's dependency graph and code structure. Report:
- What seams exist for injecting test doubles (constructor injection, virtual interfaces, template parameters)
- Which dependencies are hard-wired (static calls, global state, singletons) and would need restructuring
- Whether the public API is sufficient to observe all important behavior, or if internals are opaque
- Specific files, classes, and functions with testability problems

### Subagent 2 — Coverage strategy

Map the code paths that need testing. Report:
- Every public API function and its behavioral contract
- Error conditions and edge cases for each function
- State machine transitions (if any)
- Boundary conditions (empty input, max input, null, zero, overflow)
- Which paths are unit-testable vs. require integration testing
- Priority ranking: which tests catch the most dangerous bugs

### Subagent 3 — Concurrency test design

Examine threading and shared state. Report:
- All shared mutable state and its protection mechanism (mutex, atomic, lock-free)
- Race windows: points where interleaving could produce incorrect results
- Ordering assumptions: operations that must happen-before other operations
- Suggested deterministic testing approaches (sequenced executors, injected clocks, controlled scheduling)
- Suggested stress testing approaches (thread count scaling, TSan integration)
- If there is no concurrency in the target, report "No concurrency — skip concurrent test design"

Each subagent prompt must include:
- The exact file paths of the target code
- The public API surface identified in Step 1
- Instructions to report facts and evidence, not speculation

### Convergence

After subagents report:
1. Merge testability issues into a single assessment
2. Merge coverage strategy into a unified test matrix
3. Incorporate concurrency test design if applicable
4. Identify any conflicts (e.g., a function that's critical to test but hard to reach)

## Decision trees

### What deserves a test?

```
Is it a public API function?
+-- Yes -> Test it. Always.
+-- No -> Is it a complex internal helper?
    +-- Yes (branches, loops, error handling) -> Test it.
    +-- No -> Is it glue code connecting components?
        +-- Yes -> Integration test only. Don't unit-test glue.
        +-- No -> Is it a trivial accessor/getter?
            +-- Yes -> Don't test it. Testing `int x() const { return x_; }` wastes time.
            +-- No -> Evaluate case by case.
```

### Unit vs. integration boundary

```
Does the behavior require crossing a process, network, or filesystem boundary?
+-- Yes -> Integration test.
+-- No -> Does it involve complex internal logic?
    +-- Yes -> Unit test.
    +-- No -> Does it combine multiple components?
        +-- Yes -> Integration test for the combination, unit tests for components.
        +-- No -> Unit test.
```

### Mocking decision

```
Do you own the interface?
+-- Yes -> Mock it (you control the contract).
+-- No -> Does the dependency have a stable, narrow contract?
    +-- Yes -> Mock it (stable contract = reliable mock).
    +-- No -> Is it a database, filesystem, or network resource?
        +-- Yes -> Real instance in integration tests, mock/fake in unit tests.
        +-- No -> Evaluate: can you write a fake that's simpler than the real thing?
            +-- Yes -> Fake it.
            +-- No -> Use the real thing.

Are you mocking more than 3 dependencies in a single test?
+-- Yes -> The test is too coupled. The code under test needs restructuring.
```

### Concurrent test strategy

```
Is the shared state protected by a mutex?
+-- Yes -> Test with deterministic scheduling:
|   - Inject a sequenced executor
|   - Control the order of lock acquisition
|   - Verify invariants hold at each step
+-- No -> Is it protected by atomics?
    +-- Yes -> Property-based testing:
    |   - Define invariants (monotonicity, bounds, relationships)
    |   - Stress with many threads, verify invariants always hold
    |   - Run under TSan
    +-- No -> Is it lock-free?
        +-- Yes -> All of the above, plus:
        |   - ABA testing with allocation recycling
        |   - Linearizability testing
        |   - Memory ordering stress tests
        +-- No -> It's a data race. Flag it, don't test around it.
```

## Test organization rules

- Name test files to mirror the source: `foo.cpp` -> `foo_test.cpp`
- Group tests by behavior, not by method: `TEST(ConnectionPool, ReusesIdleConnections)` not `TEST(ConnectionPool, GetConnection)`
- One test fixture per logical component, not per class
- Shared test utilities go in a `test_util/` directory, not scattered across test files
- Integration tests go in a separate directory from unit tests
- Stress tests and long-running tests get their own target so they can be excluded from fast CI runs

## Test case design rules

- **Arrange-Act-Assert**: Every test has exactly one action being tested
- **Descriptive names**: The test name should describe the scenario and expected outcome
- **Independent**: Tests must not depend on execution order or shared state between tests
- **Fast**: Unit tests should complete in milliseconds. If a test takes seconds, it's probably an integration test in disguise.
- **Deterministic**: Same input, same result, every time. No time-dependent, order-dependent, or environment-dependent behavior in unit tests.

## Output contract

### Test Strategy Report

1. **Testability assessment**
   - What's easy to test and why
   - What's hard to test and what restructuring would help
   - Dependencies that need mocks/fakes

2. **Test matrix**
   - Component x test type (unit/integration/stress) x priority (critical/high/medium/low)
   - Rationale for each priority assignment

3. **Test case catalog**
   - For each test: name, scenario, expected outcome, rationale
   - Grouped by component and test type
   - Edge cases and error paths called out explicitly

4. **Concurrent test strategy** (if applicable)
   - Shared state inventory
   - Deterministic test approach
   - Stress test approach
   - TSan integration plan

5. **Fixture and mock design**
   - What test doubles are needed
   - Interface for each (mock vs. fake vs. stub)
   - Shared fixture design

6. **Recommended test organization**
   - File structure
   - Test target structure (fast unit vs. slow integration vs. stress)
   - Naming conventions

## Anti-patterns

- Testing implementation details instead of behavior (breaks when you refactor)
- One assertion per test dogma (test logical units of behavior, not individual assertions)
- Mocking everything (tests that test mocks, not code)
- Flaky-by-design (sleep-based synchronization in concurrent tests)
- Test-per-method mirroring (couples test structure to implementation structure)
- Chasing coverage numbers with trivial tests instead of covering dangerous code paths
- Testing private methods directly instead of through the public API
- Shared mutable state between tests (test order dependence)
- Copy-paste test cases instead of parameterized tests
- Integration tests masquerading as unit tests (slow, flaky, hard to debug)
- Testing the framework/library instead of your code
- Ignoring error paths ("happy path coverage" is not coverage)
```

- [ ] **Step 3: Verify the file was created correctly**

```bash
head -5 ~/dev/claude-skills/test-design/SKILL.md
```

Expected: YAML frontmatter starting with `---` and `name: test-design`

- [ ] **Step 4: Commit**

```bash
git add test-design/SKILL.md
git commit -m "Add test-design skill: test strategy design for C++ components"
```

---

### Task 2: Create observability skill

**Files:**
- Create: `observability/SKILL.md`

- [ ] **Step 1: Create the observability directory**

```bash
mkdir -p ~/dev/claude-skills/observability
```

- [ ] **Step 2: Write observability/SKILL.md**

```markdown
---
name: observability
description: Design and implement structured logging and runtime diagnostics for C++ systems. Provide the target component, service, or subsystem. Follows a measure-first methodology — instrument before you need to debug, not after.
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, Agent
---

ultrathink

You are designing and implementing observability infrastructure for a C++ system on Linux. Your goal is to make the system's runtime behavior visible — structured logging and runtime diagnostics that help you understand what happened when something goes wrong.

The target is:

$ARGUMENTS

## Hard rules

- **Instrument before you need to debug.** If you're adding logging to diagnose a production incident, you're already late.
- **Structured data, not strings.** Every log entry must be machine-parseable. No string concatenation.
- **Log levels have operational meaning.** A level is a signal to operators, not a developer preference.
- **Zero-cost when off.** Disabled log levels and inactive diagnostics must have negligible runtime cost.
- **Never log sensitive data.** No passwords, tokens, PII, keys, or raw buffer contents in logs.
- **Diagnostics must be runtime-queryable.** Never require a restart to enable diagnostics or change log levels.

## Step 1: Assess current observability

Read the target code and catalog:
- Existing logging (format, levels, framework, consistency)
- Existing diagnostics (stats, health checks, debug endpoints)
- Error paths (what information is available when things fail)
- Hot paths (where logging must be zero-cost or absent)

## Parallel analysis

Dispatch 3 Explore subagents in parallel:

### Subagent 1 — Logging audit

Examine all existing logging in the target. Report:
- Logging framework in use (or ad-hoc printf/cout)
- Format consistency (structured vs. unstructured, field naming)
- Log level usage (are levels used consistently with operational meaning?)
- Missing context (log lines that say "error" but not what, why, or where)
- Hot-path logging (high-frequency logging that could cost performance)
- Sensitive data exposure (tokens, keys, user data in log output)
- Log volume concerns (chatty subsystems, missing rate limiting)

### Subagent 2 — Diagnostic surface analysis

Examine what runtime state is observable. Report:
- Existing health checks, stats, or debug endpoints
- What runtime state matters but is currently dark (not observable):
  - Queue depths, connection counts, pool utilization
  - Cache hit rates, buffer occupancy
  - Thread pool saturation, task queue lengths
  - Memory pool usage, allocation rates
- What operational questions can't currently be answered without attaching a debugger
- Current approach to stats collection (atomic counters, mutexed maps, thread-local, none)

### Subagent 3 — Failure mode inventory

Trace error paths and failure modes. Report:
- For each failure mode: what information would you need in a postmortem?
- What's currently available (logged, observable) vs. what's dark
- Cascading failures: where does one failure cause downstream failures with no visible causal link?
- Recovery paths: can you tell if the system recovered, and when?
- Working backward: "production is broken at 3am — what do I wish I could see?"

Each subagent prompt must include:
- The exact file paths of the target code
- The current logging framework (if identified)
- Instructions to cite exact files, functions, and line numbers

### Convergence

After subagents report:
1. Merge logging issues into a gap analysis
2. Merge diagnostic surface findings into a visibility map (what's observable vs. dark)
3. Merge failure mode inventory into a postmortem readiness assessment
4. Prioritize: what instrumentation would have the highest operational value

## Log level policy

Every log statement must use the correct level. This is not subjective:

| Level | Meaning | Operational response | Production default |
|-------|---------|---------------------|--------------------|
| **FATAL** | Process cannot continue. About to exit or abort. | Page oncall immediately | Always on |
| **ERROR** | An operation failed. The process continues but something is wrong. | Alert, investigate soon | Always on |
| **WARN** | Degraded but functional. Something unexpected that may become a problem. | Monitor, investigate if recurring | Always on |
| **INFO** | Significant state transitions. Startup, shutdown, config reload, connection established. | Normal operational visibility | On by default |
| **DEBUG** | Internal details useful for diagnosing specific issues. | Enable when investigating | Off in production |
| **TRACE** | Per-request, per-packet, per-iteration detail. | Enable briefly for deep investigation | Off by default |

### Level selection decision tree

```
Is the process about to terminate?
+-- Yes -> FATAL
+-- No -> Did an operation fail?
    +-- Yes -> Is it expected/handled and the system continues normally?
    |   +-- Yes -> WARN (e.g., retryable network error, cache miss fallback)
    |   +-- No -> ERROR
    +-- No -> Is this a significant state change?
        +-- Yes -> INFO (startup, shutdown, config change, connection lifecycle)
        +-- No -> Is this useful for diagnosing a specific issue?
            +-- Yes -> DEBUG
            +-- No -> Is this per-request/per-packet detail?
                +-- Yes -> TRACE
                +-- No -> Don't log it.
```

## Structured logging design

### Required fields on every log entry

| Field | Type | Source |
|-------|------|--------|
| `timestamp` | ISO 8601 with microseconds | System clock |
| `level` | Enum string | Log statement |
| `component` | String | Module/subsystem name |
| `message` | String | Human-readable description |

### Context-dependent fields

| Field | When to include |
|-------|----------------|
| `request_id` | Any request-scoped operation |
| `connection_id` | Connection-scoped operations |
| `operation` | Multi-step operations (name of the step) |
| `duration_us` | Timed operations (at completion) |
| `error_code` | Error/warning entries |
| `peer` | Network operations (remote address) |
| `size_bytes` | I/O operations |

### Never log

- Passwords, auth tokens, API keys, session tokens
- PII (names, emails, addresses, phone numbers)
- Raw buffer contents (may contain any of the above)
- Credit card numbers, SSNs, or financial data
- Encryption keys or certificates

## Runtime diagnostics design

### Diagnostics decision tree

```
Is this a long-running service?
+-- Yes -> Health endpoint + stats dump + runtime config
|   - Health: is the service functioning? (up/degraded/down + reason)
|   - Stats: counters, gauges, histograms aggregated over time
|   - Config: current runtime configuration, changeable without restart
+-- No -> Is this a library?
    +-- Yes -> Debug-level state dump on request
    |   - Provide a `dump_state()` or `debug_info()` method
    |   - Only active when caller requests it
    |   - Must not affect normal operation
    +-- No -> Is this a CLI tool?
        +-- Yes -> Verbose/debug flag that increases output detail
        +-- No -> Evaluate case by case.
```

### Stats collection patterns

```
Is this a hot path (called millions of times per second)?
+-- Yes -> Thread-local counters, periodic aggregation
|   - Each thread maintains its own counter
|   - Aggregation thread reads all thread-locals periodically (every 1-10s)
|   - Zero contention on the hot path
+-- No -> Is it called frequently (thousands of times per second)?
    +-- Yes -> Atomic counters (relaxed memory ordering)
    |   - std::atomic<uint64_t> with fetch_add(1, std::memory_order_relaxed)
    |   - Negligible cost, no contention
    +-- No -> Is it called rarely (< 100/sec)?
        +-- Yes -> Mutex-protected stats are fine
        +-- No -> Don't instrument it; it's not interesting.
```

### Key diagnostics to implement

For any system, at minimum provide visibility into:
- **Throughput**: requests/operations per second
- **Latency**: p50, p99, p999 for key operations
- **Error rate**: errors per second, error ratio
- **Saturation**: queue depths, pool utilization, thread pool occupancy
- **Dependencies**: health and latency of downstream services/resources

## Performance budget

| Context | Budget | Approach |
|---------|--------|----------|
| Hot path, log disabled | Zero cost | Compile-time level check, `if constexpr`, or macro that short-circuits |
| Hot path, log enabled | < 100ns | Lock-free queue, async formatting, no allocation |
| Cold path | < 10us | Synchronous formatting with allocation is fine |
| Stats collection, hot path | < 10ns | Atomic increment or thread-local |
| Stats collection, cold path | < 1us | Mutex-protected is fine |
| Diagnostic dump | No budget | Only on explicit request, can take as long as needed |

## Implementation workflow

1. Define the logging interface (format, levels, fields) — match existing framework or propose one
2. Implement structured log entries with required fields
3. Add context propagation (request_id, connection_id across call chains)
4. Implement stats collection with appropriate pattern per hot/cold path
5. Add diagnostic surface (health checks, state dumps, stats endpoints)
6. Add runtime log level control (change levels without restart)
7. Verify: no performance regression on hot paths, log output is parseable, diagnostics are queryable

## Output contract

### Observability Report

1. **Logging assessment**
   - Current state (framework, consistency, gaps)
   - Issues found (missing context, wrong levels, sensitive data, performance concerns)

2. **Structured logging design**
   - Format specification (fields, types, serialization)
   - Level policy for this specific system
   - Context propagation approach

3. **Diagnostic surface design**
   - What to expose (stats, health, config, state dumps)
   - How to access it (endpoint, signal handler, admin socket, log command)
   - Collection approach per metric (atomic, thread-local, mutex)

4. **Failure observability map**
   - For each failure mode: what you'd see in logs and diagnostics
   - Gaps: failure modes that remain dark after instrumentation

5. **Implementation plan**
   - Components to add or modify
   - Integration points with existing code
   - Performance considerations and measured budget

6. **Migration path** (if replacing existing logging)
   - Incremental steps from current to target state
   - How to run old and new in parallel during migration

## Anti-patterns

- `std::cout` / `printf` in production code (unstructured, no levels, no context)
- Unstructured string concatenation (`"Error in " + func + " for " + id`)
- Logging in tight loops without rate limiting
- Log levels chosen by developer mood, not operational semantics
- Missing context (logging "failed" without what failed, why, or what was being attempted)
- Sensitive data in logs (tokens, keys, user data)
- Diagnostics that require a restart to enable or a rebuild to change
- Stats collection that takes locks on hot paths
- Logging the same event at multiple levels ("just in case")
- Log messages that don't identify the component or context
- Using log output as the primary data flow (logs are for observability, not business logic)
- Fire-and-forget logging with no backpressure (can cause OOM under load)
```

- [ ] **Step 3: Verify the file was created correctly**

```bash
head -5 ~/dev/claude-skills/observability/SKILL.md
```

Expected: YAML frontmatter starting with `---` and `name: observability`

- [ ] **Step 4: Commit**

```bash
git add observability/SKILL.md
git commit -m "Add observability skill: structured logging and runtime diagnostics"
```

---

### Task 3: Create security skill

**Files:**
- Create: `security/SKILL.md`

- [ ] **Step 1: Create the security directory**

```bash
mkdir -p ~/dev/claude-skills/security
```

- [ ] **Step 2: Write security/SKILL.md**

```markdown
---
name: security
description: Security audit and hardening for C++ systems. Provide the target component, module, or subsystem. Reviews input validation, identifies logic-level vulnerabilities, and recommends hardening. Complements sanitizers (which catch memory corruption) with adversarial reasoning.
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Bash, Agent
---

ultrathink

You are performing a security audit of C++ systems code on Linux. Your job is to think adversarially — reason about how an attacker would exploit this code, not just how a developer intended it to work. You complement sanitizers (ASan, UBSan, TSan) which catch memory corruption mechanically; you catch the logic-level vulnerabilities they miss.

The target to audit is:

$ARGUMENTS

## Hard rules

- **Think like an attacker, not a developer.** The question is not "does this work?" but "how can this be abused?"
- **Every trust boundary must be explicit.** If data crosses a boundary, it must be validated at the boundary.
- **Validate before use, never after.** Input must be validated before it is processed, parsed, allocated for, or acted upon.
- **Fail closed, not open.** When validation fails or an error occurs, deny access / reject input / abort the operation. Never default to allowing.
- **Least privilege.** Every component should have the minimum permissions needed to do its job, and no more.
- **Defense in depth.** No single check is the last line of defense. Layer protections so that a bypass of one layer does not compromise the system.

## Step 1: Map the trust boundaries

Before auditing code, draw the trust boundary map:
- What data enters from outside the process? (network, files, IPC, env vars, CLI args, shared memory)
- What data enters from other components within the process?
- What data is fully trusted? (compile-time constants, verified internal state)
- Where are the boundaries between these zones?

## Parallel analysis

Dispatch 3 Explore subagents in parallel:

### Subagent 1 — Input boundary analysis

Map every entry point for untrusted data. For each entry point, report:
- Source of data (network socket, file, IPC, env var, CLI arg, shared memory, user-controlled config)
- What validation exists (type checking, length limits, format validation, range checks)
- What validation is missing
- Blast radius: what happens if this input is malformed, oversized, or malicious?
- Specific files, functions, and line numbers

### Subagent 2 — Logic vulnerability scan

Examine the code for logic-level vulnerabilities that sanitizers don't catch. For each finding, report:
- Vulnerability class and specific location (file:line)
- How it could be exploited (concrete scenario, not vague "could be bad")
- Whether it's reachable from untrusted input
- Categories to check:
  - Authorization checks: are they present, correct, and complete?
  - State machine transitions: can states be reached out of order?
  - Error handling paths: do error paths leak information or leave state inconsistent?
  - TOCTOU (time-of-check-time-of-use): is there a window between checking and using?
  - Integer overflow in size/length calculations before allocation
  - Type confusion or incorrect casts
  - Use-after-move or use-after-free in error paths
  - Format string vulnerabilities
  - Command injection (system(), popen(), exec() with user data)

### Subagent 3 — Attack surface audit

Inventory the exposed attack surface. Report:
- All externally reachable interfaces (network ports, file handlers, IPC endpoints)
- Unnecessary capabilities or permissions that could be removed
- Privilege levels: what runs as root vs. unprivileged?
- File operations: temp files, symlink following, path traversal potential
- Signal handlers: are they async-signal-safe?
- Resource limits: can an attacker exhaust memory, file descriptors, threads?
- What can be removed or locked down without affecting functionality

Each subagent prompt must include:
- The exact file paths of the target code
- The trust boundary map from Step 1
- Instructions to report specific files, functions, and line numbers with concrete exploitation scenarios

### Convergence

After subagents report:
1. Merge input boundary findings into a single attack surface map
2. Merge logic vulnerabilities into a severity-ranked list
3. Merge attack surface audit into hardening recommendations
4. Cross-reference: are the highest-severity logic vulnerabilities reachable from the exposed attack surface?

## Trust boundary classification

| Boundary | Trust level | Validation required |
|----------|------------|-------------------|
| Same process, same author | Trusted | Assert preconditions in debug builds |
| Same process, different component | Semi-trusted | Validate if data originates externally |
| Cross-process (IPC, shared memory) | Untrusted | Full validation of all fields |
| Cross-network | Hostile | Full validation, assume adversarial intent |
| User-provided files | Hostile | Validate format, structure, and content |
| Environment variables | Untrusted | Validate format and content |
| CLI arguments | Untrusted | Validate format, length, and content |

## Input validation decision tree

```
What type of input is it?
+-- Binary protocol
|   +-- Validate magic bytes / version first
|   +-- Validate length fields before reading payload
|   +-- Enforce maximum message size before allocation
|   +-- Validate type tags before dispatch
|   +-- Reject unknown message types (fail closed)
+-- Text protocol
|   +-- Reject-by-default, allow known-good characters/patterns
|   +-- Enforce maximum line/field length
|   +-- Validate encoding (UTF-8 if expected)
|   +-- Never pass to shell or system() without escaping/rejection
+-- File format
|   +-- Validate magic bytes
|   +-- Validate structural integrity (headers, offsets, sizes)
|   +-- Validate semantic content (values in range, references valid)
|   +-- Enforce maximum file size
+-- Path/filename
|   +-- Reject path traversal (../, absolute paths when relative expected)
|   +-- Reject null bytes
|   +-- Use openat() with O_NOFOLLOW to prevent symlink attacks
|   +-- Canonicalize before comparing to allowed prefixes
+-- All types
    +-- Enforce maximum sizes BEFORE allocation
    +-- Validate BEFORE processing
    +-- Reject on failure (fail closed)
```

## Integer safety rules

```
Is the integer from untrusted input?
+-- Yes -> Is it used for allocation size or buffer length?
|   +-- Yes -> Check for overflow BEFORE allocation:
|   |   - Multiply overflow: if (a != 0 && b > SIZE_MAX / a) reject
|   |   - Add overflow: if (a > SIZE_MAX - b) reject
|   |   - Or use __builtin_mul_overflow / __builtin_add_overflow
|   +-- No -> Is it used as an array index?
|       +-- Yes -> Bounds check BEFORE access
|       +-- No -> Is it used in arithmetic that feeds into size/index?
|           +-- Yes -> Trace the data flow and check at the point of use
|           +-- No -> Validate range at input boundary
+-- No -> Is it a narrowing cast?
    +-- Yes -> Use explicit checked cast (narrow_cast or manual check)
    +-- No -> Is it signed/unsigned mixing?
        +-- Yes -> Fix the types to match, or add explicit conversion with range check
        +-- No -> No action needed
```

## Privilege reduction checklist

For long-running services:

```
Can you drop privileges after initialization?
+-- Yes -> Use setuid/setgid after binding ports, opening files
+-- No -> Can you use capability-based restrictions?
    +-- Yes -> Use Linux capabilities (cap_net_bind_service, etc.)
    +-- No -> Document why elevated privileges are required

Can you restrict file access?
+-- Use openat() with directory FDs instead of absolute paths
+-- Use O_NOFOLLOW to prevent symlink traversal
+-- Set restrictive umask before creating files

Can you restrict syscalls?
+-- Use seccomp-bpf to whitelist allowed syscalls
+-- Start broad, tighten based on actual syscall usage (strace)

Can you separate parsing from processing?
+-- Parse untrusted input in a sandboxed subprocess
+-- Validate and sanitize before passing to the main process
```

## Severity classification

| Severity | Criteria | Examples |
|----------|----------|---------|
| **Critical** | Remote code execution, arbitrary memory write from untrusted input, authentication bypass | Buffer overflow reachable from network, format string with user data, shell injection |
| **High** | Information disclosure of sensitive data, denial of service from single malformed input, privilege escalation | Stack info leak, unbounded allocation from untrusted size, path traversal to sensitive files |
| **Medium** | Local-only exploitation, DoS requiring sustained input, missing hardening on non-exposed interface | Local file race condition, CPU exhaustion via regex, missing seccomp on internal service |
| **Low** | Defense-in-depth gaps, missing hardening on internal-only code, style issues with security implications | Missing explicit on single-arg constructor, signed/unsigned comparison warning, overly broad catch |

## Output contract

### Security Audit Report

1. **Trust boundary map**
   - Diagram of trusted vs. untrusted zones
   - Every entry point for external data
   - Validation status at each boundary

2. **Input surface inventory**
   - Entry point x data type x validation status x blast radius
   - Ranked by risk (exposure x severity)

3. **Vulnerability findings**
   - Severity-ranked list
   - For each: class, location (file:line), exploitation scenario, reachability from untrusted input, recommended fix
   - Critical and High findings get detailed exploitation scenarios

4. **Hardening recommendations**
   - Prioritized by risk reduction per effort
   - For each: what to do, why, effort estimate (small/medium/large), risk reduced

5. **Residual risk assessment**
   - What remains after recommended fixes
   - Attack surface that cannot be reduced further
   - Monitoring recommendations for remaining risk

## Anti-patterns

- Validating input after use instead of before
- Checking string length but not content (allows injection of valid-length malicious strings)
- `atoi`/`atol` on untrusted input (no error detection, undefined behavior on overflow)
- Unbounded allocation from untrusted size fields (`malloc(attacker_controlled_size)`)
- TOCTOU between check and use of filesystem paths (`access()` then `open()`)
- `system()` / `popen()` with user-influenced strings (command injection)
- Signal handlers that call non-async-signal-safe functions (malloc, printf, mutex operations)
- Trusting `errno` across multiple calls without checking between them
- `strncpy` without ensuring null-termination of the result
- Assuming `read()` returns the full requested amount (partial reads are normal)
- Using `rand()` / `srand()` for security-sensitive random values (use `getrandom()`)
- Logging sensitive data "for debugging" (it ends up in production)
- Comparing secrets with `memcmp` (timing side-channel; use constant-time comparison)
- Catching all exceptions to "prevent crashes" (masks exploitation attempts)
```

- [ ] **Step 3: Verify the file was created correctly**

```bash
head -5 ~/dev/claude-skills/security/SKILL.md
```

Expected: YAML frontmatter starting with `---` and `name: security`

- [ ] **Step 4: Commit**

```bash
git add security/SKILL.md
git commit -m "Add security skill: security audit and hardening for C++ systems"
```

---

### Task 4: Create api-design skill

**Files:**
- Create: `api-design/SKILL.md`

- [ ] **Step 1: Create the api-design directory**

```bash
mkdir -p ~/dev/claude-skills/api-design
```

- [ ] **Step 2: Write api-design/SKILL.md**

```markdown
---
name: api-design
description: Design and evolve internal C++ APIs. Provide the target class, module, library boundary, or API to design/review. Focuses on making APIs hard to misuse, easy to extend, and safe to evolve. Produces interface specifications, contract documentation, and evolution plans.
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Bash, Agent
---

ultrathink

You are designing or reviewing a C++ API for a systems engineering team. Your job is to make APIs that are hard to misuse, easy to use correctly, and safe to evolve. You do not implement the API — you design the interface and document the contracts.

The target is:

$ARGUMENTS

## Hard rules

- **Easy to use correctly, hard to use incorrectly.** This is the single most important API design principle. Every design decision must be evaluated against it.
- **Compile-time enforcement over runtime checks.** Use the type system to prevent misuse. A bug caught by the compiler costs nothing; a bug caught in production costs everything.
- **Never require callers to remember.** If callers must call init(), check a return code, release a resource, or call functions in a specific order — the API is wrong. Use RAII, return types, and builder patterns to make correct usage automatic.
- **Ownership must be visible in the type signature.** `unique_ptr` = transfer, `const T&` = borrow, raw pointer = non-owning. Never leave ownership ambiguous.
- **Minimal surface area.** Expose only what clients need. Every public symbol is a commitment.
- **Contracts must be explicit.** Preconditions, postconditions, invariants, thread-safety guarantees, and exception specifications must be documented or (better) encoded in the type system.

## Step 1: Understand the context

Determine whether this is:
- **New API design** — designing an interface from scratch
- **API review** — evaluating an existing interface for correctness, usability, and evolvability
- **API evolution** — changing an existing interface while managing compatibility

Read the target code (for existing APIs) or the requirements (for new APIs). Identify:
- Who are the consumers? (internal team, other teams, external users)
- What constraints exist? (ABI stability, header-only, shared library, backward compatibility)
- What domain does this serve? (the vocabulary, concepts, and operations)

## Parallel analysis

Dispatch 3 Explore subagents in parallel:

### Subagent 1 — Consumer analysis

For existing APIs: find all call sites. Report:
- Which functions/methods are actually called (and which are unused)
- Which overloads are used vs. unused
- Which parameters are always passed the same value (candidate for default or removal)
- Which error paths callers actually handle (and which are silently ignored)
- Common usage patterns (the "80% case")
- Misuse patterns (callers doing something the API doesn't intend)

For new APIs: find analogous code in the codebase. Report:
- How similar problems are currently solved (ad-hoc patterns that the new API would replace)
- What callers currently need to do manually that the API should automate
- Naming conventions and patterns in the surrounding codebase

### Subagent 2 — Contract extraction

For existing APIs: examine the interface and implementation. Report:
- Preconditions (what must be true before calling)
- Postconditions (what is guaranteed after calling)
- Invariants (what is always true about the object/module)
- Ownership transfers (who owns what, when does ownership move)
- Lifetime requirements (what must outlive what)
- Thread-safety guarantees (safe to call from multiple threads? which methods?)
- Exception behavior (what can throw, what is noexcept)
- Which contracts are enforced (asserts, type system) vs. merely documented vs. undocumented

For new APIs: report what contracts the design must satisfy based on the requirements and domain.

### Subagent 3 — Evolution risk assessment

For existing APIs: report:
- What would break if this interface changed? (source compatibility, ABI compatibility, semantic compatibility)
- Which changes are additive (safe) vs. breaking?
- Consumer count and diversity (one internal caller vs. hundreds of external users)
- Versioning strategy currently in use (if any)

For new APIs: report:
- What future directions does this design enable or foreclose?
- What extension points exist?
- How would this API handle likely future requirements? (new data types, new operations, scaling)
- What commitments does this interface lock in?

Each subagent prompt must include:
- The exact file paths of the target code
- Whether this is new design, review, or evolution
- The consumer context (internal/external, team/public)
- Instructions to report exact files, functions, and line numbers

### Convergence

After subagents report:
1. Merge consumer analysis into a usage profile
2. Merge contract extraction into a complete contract specification
3. Merge evolution assessment into a compatibility report
4. Identify the key design tensions (usability vs. performance, simplicity vs. flexibility, stability vs. evolution)

## Parameter design decision tree

```
Does the function take ownership of this parameter?
+-- Yes -> unique_ptr<T> (exclusive ownership) or T by value (for small/movable types)
+-- No -> Does the function need to store a reference beyond the call?
    +-- Yes -> This is a lifetime hazard. Document it. Consider shared_ptr or requiring
    |          the caller to guarantee lifetime.
    +-- No -> Can the parameter be null?
        +-- Yes -> const T* (pointer = nullable, reference = non-nullable)
        +-- No -> Is it a contiguous range?
            +-- Yes -> std::span<const T> (borrow a range without copying)
            +-- No -> Is it a string?
                +-- Yes -> std::string_view (borrow a string without copying)
                +-- No -> const T& (non-owning, non-nullable borrow)

Are there multiple related parameters?
+-- Yes (> 3 related params) -> Named struct (Options, Config, Params)
+-- No -> Individual parameters are fine
```

## Error reporting decision tree

```
What kind of failure is this?
+-- Precondition violation (caller bug)
|   +-- Assert in debug builds, undefined behavior in release
|   +-- Or use contracts (C++26) / GSL Expects()
|   +-- NEVER return an error code for a precondition violation
+-- Expected operational failure (file not found, network timeout, parse error)
|   +-- std::expected<T, E> (C++23) — return value + error in one type
|   +-- Or error code enum + out parameter (if pre-C++23)
|   +-- Or std::optional<T> if the only failure mode is "not available"
|   +-- NEVER use exceptions for expected failures in hot paths
+-- Systemic failure (out of memory, hardware fault)
|   +-- Exception (if the project uses exceptions)
|   +-- Or std::abort() / std::terminate() (if exceptions are disabled)
|   +-- These should be rare and unrecoverable
+-- NEVER
    +-- bool return with no error detail
    +-- errno (global mutable state, not thread-safe without care)
    +-- int return codes with magic values (-1, 0, positive)
    +-- Silently succeeding when the operation failed
```

## API boundary type decision tree

```
What is this API's deployment model?
+-- Header-only library
|   +-- Everything in headers, implementation visible
|   +-- No ABI concerns (recompiled every time)
|   +-- Templates are fine, constexpr is preferred
|   +-- Use for: small utilities, template-heavy code, header-only dependencies
+-- Shared library (.so)
|   +-- ABI stability matters. Changes to class layout break consumers.
|   +-- Use Pimpl pattern or abstract interface for stable ABI
|   +-- Export only the public API, hide implementation symbols
|   +-- Version the library (soname, symbol versioning)
+-- Internal module (within one binary)
|   +-- Use direct types, no ABI concerns
|   +-- Evolve freely — you control all consumers
|   +-- Prefer minimal headers, forward declarations
+-- Cross-team API
    +-- Stable interface with documented contract
    +-- Versioning strategy (even if header-only)
    +-- Deprecation policy before removing anything
```

## Evolution strategy decision tree

```
What kind of change is this?
+-- Adding a new function or type
|   +-- Just add it. Additive changes are always safe.
+-- Adding an optional parameter to an existing function
|   +-- Add a new overload. Don't modify the existing signature.
|   +-- Or use an Options struct (extensible without signature change).
+-- Changing the semantics of an existing function
|   +-- New name for new semantics. Deprecate the old name.
|   +-- NEVER change what a function does while keeping its name.
+-- Changing a function signature
|   +-- Expand-and-contract (see /refactor):
|   |   Phase 1: Add new function alongside old
|   |   Phase 2: Migrate callers
|   |   Phase 3: Remove old function
|   +-- For internal-only APIs with few callers: atomic rename is acceptable.
+-- Changing a type's layout
    +-- Behind Pimpl? Safe — callers don't see the layout.
    +-- Public struct? ABI break. Expand-and-contract or version bump.
    +-- Enum? Add values at the end only. Never reorder or remove.

When to break compatibility:
+-- Zero external consumers? Break freely.
+-- Internal consumers you can update atomically? Break + fix all callers in one commit.
+-- External consumers? Expand-and-contract, minimum one release cycle with deprecation.
```

## API design checklist

Before finalizing any API, verify:

### Usability
- [ ] Can the most common use case be written in 1-3 lines?
- [ ] Are there no `bool` parameters? (Use enums: `connect(Blocking::Yes, TLS::No)` not `connect(true, false)`)
- [ ] Are there no out-parameters where return values would work?
- [ ] Is every single-argument constructor `explicit`?
- [ ] Are `[[nodiscard]]` annotations on functions where ignoring the result is a bug?

### Safety
- [ ] Is ownership transfer visible in every function signature?
- [ ] Do no functions require callers to release or clean up resources manually?
- [ ] If two operations must happen in sequence, does the API enforce the ordering? (Return a handle, use builder pattern)
- [ ] Are preconditions documented or (better) encoded in the type system?
- [ ] Are there no dangling reference risks in the public interface?

### Evolvability
- [ ] Are implementation types hidden from the public header? (Pimpl, forward declarations)
- [ ] Could this interface support likely future requirements without breaking changes?
- [ ] Are default arguments used only where the default will never change?
- [ ] Is the API surface minimal? (No "just in case" methods)

### Consistency
- [ ] Does naming follow project conventions?
- [ ] Is error handling consistent with the rest of the codebase?
- [ ] Do similar operations have similar interfaces?

## Output contract

### API Design Report

1. **API surface inventory**
   - Every public type, function, and constant
   - For each: signature, purpose, usage frequency (for existing APIs)

2. **Consumer usage analysis** (for existing APIs)
   - Usage patterns, common vs. rare operations
   - Misuse patterns found
   - Unused API surface (candidates for removal)

3. **Contract specification**
   - Preconditions, postconditions, invariants for each public function
   - Ownership model with type-level encoding
   - Thread-safety guarantees per function/type
   - Exception specifications

4. **Design recommendations**
   - Parameter types (with rationale from decision trees)
   - Error handling strategy
   - Extensibility points
   - For new APIs: the complete proposed interface with documentation

5. **Evolution plan** (for existing APIs)
   - Proposed changes with compatibility impact
   - Migration path (expand-and-contract steps)
   - Deprecation timeline
   - ABI impact assessment

6. **API misuse scenarios**
   - How could a caller get this wrong?
   - How does the design prevent each misuse?
   - Remaining misuse risks and mitigations

## Anti-patterns

- `bool` parameters (use enums — `connect(true, false)` is unreadable and error-prone)
- Out-parameters when return values work (confuses ownership, harder to use)
- Requiring callers to manage paired operations (`open()`/`close()` without RAII)
- God interfaces (one class with 50 methods doing everything)
- Leaking implementation types through public headers (couples consumers to internals)
- Non-explicit single-argument constructors (implicit conversion traps)
- Deep inheritance hierarchies for code reuse (use composition)
- "Universal" APIs that serve no use case well (overly generic = hard to use correctly)
- Default arguments that might change (each change silently alters existing callers)
- `std::initializer_list` in interfaces where `std::span` would work (initializer_list copies)
- Returning `const T&` to internal state (creates lifetime coupling between caller and callee)
- Accepting `const std::string&` when `std::string_view` would avoid unnecessary allocation
- Non-virtual interface without clear documentation of the customization contract
```

- [ ] **Step 3: Verify the file was created correctly**

```bash
head -5 ~/dev/claude-skills/api-design/SKILL.md
```

Expected: YAML frontmatter starting with `---` and `name: api-design`

- [ ] **Step 4: Commit**

```bash
git add api-design/SKILL.md
git commit -m "Add api-design skill: C++ API design and safe evolution"
```

---

### Task 5: Update README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add test-design and api-design to the Cross-Cutting table**

In `README.md`, find the Cross-Cutting section table and add two new rows:

```markdown
| [test-design](test-design/SKILL.md) | `/test-design <target>` | Test strategy design for C++ components. Dispatches 3 parallel subagents for testability analysis, coverage strategy, and concurrent test design. Produces test matrix, case catalog, fixture/mock design. |
| [api-design](api-design/SKILL.md) | `/api-design <target>` | C++ API design and safe evolution. Dispatches 3 parallel subagents for consumer analysis, contract extraction, and evolution risk assessment. Produces interface specifications, contract documentation, and evolution plans. |
```

- [ ] **Step 2: Add observability to the Tier 2 table**

Add a new row to the Tier 2 — Specialized Engineering table:

```markdown
| [observability](observability/SKILL.md) | `/observability <target>` | Structured logging and runtime diagnostics. Dispatches 3 parallel subagents for logging audit, diagnostic surface analysis, and failure mode inventory. Produces instrumentation design with performance budgets. |
```

- [ ] **Step 3: Add security to the Cross-Cutting table**

Add a new row to the Cross-Cutting table:

```markdown
| [security](security/SKILL.md) | `/security <target>` | Security audit and hardening. Dispatches 3 parallel subagents for input boundary analysis, logic vulnerability scan, and attack surface audit. Trust boundary mapping, severity-ranked findings, hardening recommendations. |
```

- [ ] **Step 4: Update the workflow graph**

Replace the existing workflow graph in README.md with:

```
cpp-implement --> cpp-review (review what was written)
     |                |
     v                v
   investigate <- perf (perf issues become bugs)
     |
     v (bug persists or resurfaces)
  rootcause (deep investigation, evidence-driven repair)
     |
     v
  build (sanitizers catch what investigate/rootcause find)

api-design  --> cpp-implement (design the interface, then implement)
test-design --> cpp-implement (design tests, then write them)

concurrency   --> cpp-review (concurrency review checklist)
networking    --> perf (protocol performance)
numerics      --> investigate (numerical debugging)
refactor      --> cpp-review (review the migration)
critique      --> refactor (critique identifies what to refactor)
observability --> perf (instrumentation performance budget)
security      --> cpp-review (security findings feed code review)

research-framework-design (standalone — first-principles framework design)
```

- [ ] **Step 5: Update the Subagent Parallelization table**

Add four new rows to the subagent table:

```markdown
| test-design | 3 Explore | Testability analysis, coverage strategy, concurrent test design |
| observability | 3 Explore | Logging audit, diagnostic surface analysis, failure mode inventory |
| security | 3 Explore | Input boundary analysis, logic vulnerability scan, attack surface audit |
| api-design | 3 Explore | Consumer analysis, contract extraction, evolution risk assessment |
```

- [ ] **Step 6: Update the read-only skill list**

Find the paragraph about read-only vs write skills and update it to:

```markdown
Read-only skills (`critique`, `cpp-review`, `investigate`, `test-design`, `security`, `api-design`) have restricted tool access — they cannot modify files but can dispatch subagents for parallel analysis.
```

- [ ] **Step 7: Verify README renders correctly**

```bash
head -120 ~/dev/claude-skills/README.md
```

Verify the new sections are present and properly formatted.

- [ ] **Step 8: Commit**

```bash
git add README.md
git commit -m "Update README with 4 new skills: test-design, observability, security, api-design"
```

---

### Task 6: Final verification

**Files:**
- All files from Tasks 1-5

- [ ] **Step 1: Verify all skill files exist**

```bash
ls -la ~/dev/claude-skills/test-design/SKILL.md ~/dev/claude-skills/observability/SKILL.md ~/dev/claude-skills/security/SKILL.md ~/dev/claude-skills/api-design/SKILL.md
```

Expected: Four files, all present.

- [ ] **Step 2: Verify YAML frontmatter is valid for all skills**

```bash
for skill in test-design observability security api-design; do
  echo "=== $skill ==="
  head -6 ~/dev/claude-skills/$skill/SKILL.md
  echo
done
```

Expected: Each skill has `---` delimiters, `name`, `description`, `disable-model-invocation: true`, `allowed-tools`.

- [ ] **Step 3: Verify tool permissions are correct**

```bash
for skill in test-design observability security api-design; do
  echo "$skill: $(grep 'allowed-tools:' ~/dev/claude-skills/$skill/SKILL.md)"
done
```

Expected:
- test-design: `Read, Grep, Glob, Bash, Agent` (read-only + dispatch)
- observability: `Read, Grep, Glob, Edit, Write, Bash, Agent` (write-enabled)
- security: `Read, Grep, Glob, Bash, Agent` (read-only + dispatch)
- api-design: `Read, Grep, Glob, Bash, Agent` (read-only + dispatch)

- [ ] **Step 4: Verify all skills start with ultrathink**

```bash
for skill in test-design observability security api-design; do
  echo "$skill: $(sed -n '/^---$/,/^---$/d; /^[a-z]/p; q' ~/dev/claude-skills/$skill/SKILL.md | head -1)"
done
```

Expected: Each skill's first content line after frontmatter is `ultrathink`.

- [ ] **Step 5: Verify git status is clean**

```bash
cd ~/dev/claude-skills && git status && git log --oneline -6
```

Expected: Clean working tree with 5 new commits (4 skills + 1 README update).
