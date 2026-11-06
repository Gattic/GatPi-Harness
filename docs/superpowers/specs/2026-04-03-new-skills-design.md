# New Skills Design: test-design, observability, security, api-design

**Date:** 2026-04-03
**Status:** Draft

## Overview

Four new skills to fill workflow gaps in the claude-skills repository. All follow the existing skill architecture: YAML frontmatter, hard rules, decision trees, subagent parallelization, output contracts, and anti-pattern catalogs. Targeted at the same audience — elite Linux-first C++ engineering teams.

## Skill 1: `test-design`

**Invoke:** `/test-design <target>`
**Purpose:** Design test strategies for C++ components — deciding what to test, how to structure tests, and how to test concurrent/async code.
**Tools:** Read, Grep, Glob, Bash, Agent (read-only with subagent dispatch — designs tests, doesn't write them)

### Subagents (3 parallel Explore)

1. **Testability analysis** — examines the target's dependency graph, identifies seams, evaluates how testable the current design is, flags code that needs restructuring
2. **Coverage strategy** — maps code paths, error conditions, edge cases, invariants; determines what unit vs integration vs stress tests are needed
3. **Concurrency test design** — identifies shared mutable state, race windows, ordering assumptions; designs deterministic and stress-based concurrent test strategies

### Decision Trees

**What deserves a test?**
- Public API behavior: always
- Internal helpers: only if complex/tricky
- Glue code: integration test only
- Trivial getters: never

**Unit vs integration boundary:**
- Crosses a process/network/filesystem boundary → integration
- Complex internal logic → unit
- Both → both

**Mocking decision:**
- Own the interface? Mock it
- Third-party with stable contract? Mock it
- Database/filesystem? Real instance in integration, mock in unit
- Mocking more than 3 things? Test is too coupled, redesign

**Concurrent test strategy:**
- Deterministic first (inject clocks, sequenced executors, controlled scheduling)
- Stress second (thread count scaling, sleep injection, TSan)
- Property-based for invariants

### Anti-Patterns

- Testing implementation details instead of behavior
- One assertion per test dogma (test logical units of behavior)
- Mocking everything (tests that test mocks, not code)
- Flaky-by-design (sleep-based synchronization in concurrent tests)
- Test-per-method mirroring (couples test structure to implementation structure)
- Missing edge cases in favor of happy path coverage metrics
- Testing private methods directly instead of through public API

### Output Contract

1. Testability assessment (what's easy/hard to test, what needs restructuring)
2. Test matrix (component x test type x priority)
3. Test case catalog with rationale for each
4. Concurrent test strategy (if applicable)
5. Fixture/mock design
6. Recommended test organization (file structure, naming)

---

## Skill 2: `observability`

**Invoke:** `/observability <target>`
**Purpose:** Design and implement structured logging and runtime diagnostics for C++ systems. Measure-first methodology — instrument before you need to debug, not after.
**Tools:** Read, Grep, Glob, Edit, Write, Bash, Agent (write-enabled — produces implementation)

### Subagents (3 parallel Explore)

1. **Logging audit** — examines existing logging: inconsistent formats, missing context, log levels misused, high-frequency hot-path logging that costs performance, sensitive data leaking into logs
2. **Diagnostic surface analysis** — identifies what runtime state matters: health checks, queue depths, connection states, cache hit rates, memory pool usage, thread pool saturation. Maps what's observable today vs what's dark.
3. **Failure mode inventory** — traces error paths and failure modes; determines what information you'd need in a postmortem that you don't currently have. Works backward from "production is broken, what do I wish I could see?"

### Decision Trees

**Log level selection:**
- FATAL: process cannot continue
- ERROR: operation failed, needs attention
- WARN: degraded but functional
- INFO: significant state transitions (startup, shutdown, config reload)
- DEBUG: internal detail, off in production
- TRACE: per-request/per-packet, off by default

**What to log:**
- State transitions: always
- Request/response boundaries: always
- Error conditions with context: always
- Happy-path internals: debug only
- Per-iteration loop bodies: never in production

**Structured fields:**
- Every log line gets: timestamp, level, component, message
- Context-dependent: request_id, connection_id, operation, duration_us, error_code
- Never: passwords, tokens, PII, raw buffer contents

**Runtime diagnostics decision:**
- Long-running service? Health endpoint + stats dump
- Library? Debug-level state dump on request
- Latency-sensitive? Lock-free counters, periodic aggregation
- Multi-threaded? Per-thread stats, aggregated on read

**Performance budget:**
- Hot path logging: zero allocation, constexpr format strings
- Cold path: allocation OK
- Stats collection: atomic counters or thread-local accumulation
- Diagnostic dump: only on explicit request, can be expensive

### Anti-Patterns

- `std::cout` / `printf` in production code
- Unstructured string concatenation (`"Error in " + func + " for " + id`)
- Logging in tight loops without rate limiting
- Log levels chosen by developer mood, not operational semantics
- Missing context (logging "failed" without what failed, why, or what was being attempted)
- Sensitive data in logs (tokens, keys, user data)
- Diagnostics that require a restart to enable
- Stats collection that takes locks on hot paths

### Output Contract

1. Logging assessment (current state, gaps, inconsistencies)
2. Structured logging design (format, fields, level policy)
3. Diagnostic surface design (what to expose, how to access it)
4. Failure observability map (failure mode -> what you'd see in logs/diagnostics)
5. Implementation plan (components, integration points, performance considerations)
6. Migration path (if replacing existing ad-hoc logging)

---

## Skill 3: `security`

**Invoke:** `/security <target>`
**Purpose:** Security audit and hardening for C++ systems — input validation, logic-level vulnerabilities, and attack surface reduction. Complements sanitizers (which catch memory corruption) with reasoning about adversarial intent.
**Tools:** Read, Grep, Glob, Bash, Agent (read-only with subagent dispatch — audits and recommends, doesn't modify code)

### Subagents (3 parallel Explore)

1. **Input boundary analysis** — maps every point where untrusted data enters: network sockets, file parsing, IPC, environment variables, command-line args, shared memory. For each: what validation exists, what's missing, what's the blast radius of malformed input.
2. **Logic vulnerability scan** — examines authorization checks, state machine transitions, error handling paths, TOCTOU windows, integer overflow in size calculations, type confusion, use-after-move. Focuses on bugs sanitizers don't catch.
3. **Attack surface audit** — inventories exposed interfaces, unnecessary capabilities, privilege levels, file permissions, signal handlers, temp file usage, symlink following. Identifies what can be removed or locked down.

### Decision Trees

**Input validation strategy:**
- Binary protocol? Validate length/type fields before parsing payload
- Text protocol? Reject-by-default, allow known-good
- File format? Validate magic bytes, then structural integrity, then semantic validity
- Always: enforce maximum sizes before allocation

**Trust boundary classification:**
- Same process, same author: trusted
- Same process, different component: validate at interface if data originates externally
- Cross-process: untrusted
- Cross-network: hostile

**Hardening priority:**
- Internet-facing: harden everything
- Internal service: harden input parsing + privilege boundaries
- Library: document trust assumptions, validate at API boundary
- CLI tool: validate all file/path inputs

**Integer safety:**
- Arithmetic on untrusted sizes? Check overflow before allocation
- Index from untrusted source? Bounds check
- Cast narrowing? Explicit check or use `narrow_cast`
- Signed/unsigned mixing? Fix the types

**Privilege reduction:**
- Drop privileges after setup (setuid)
- Minimize file access (openat + O_NOFOLLOW)
- Restrict syscalls (seccomp where appropriate)
- Separate parsing from processing (privilege separation)

### Severity Classification

- **Critical** — remote code execution, arbitrary memory write from untrusted input, authentication bypass
- **High** — information disclosure of sensitive data, denial of service from single malformed input, privilege escalation
- **Medium** — local-only exploitation, DoS requiring sustained input, missing hardening on non-exposed interface
- **Low** — defense-in-depth gaps, missing hardening on internal-only code, style issues with security implications

### Anti-Patterns

- Validating input after use instead of before
- Checking string length but not content (injection)
- `atoi`/`atol` on untrusted input (no error detection)
- Unbounded allocation from untrusted size fields
- TOCTOU between check and use of filesystem paths
- `system()` / `popen()` with user-influenced strings
- Signal handlers that call non-async-signal-safe functions
- Trusting `errno` across multiple calls without checking between them
- `strncpy` without null-termination guarantee
- Assuming `read()` returns the full requested amount

### Output Contract

1. Trust boundary map (what's trusted, what's not, where the boundaries are)
2. Input surface inventory (entry points x validation status x blast radius)
3. Vulnerability findings (severity-ranked, with exploitation scenario for each)
4. Hardening recommendations (prioritized, with effort estimate)
5. Residual risk assessment (what remains after recommended fixes)

---

## Skill 4: `api-design`

**Invoke:** `/api-design <target>`
**Purpose:** Design and evolve internal C++ APIs — class interfaces, library boundaries, and safe migration of existing APIs. Focused on making APIs hard to misuse, easy to extend, and safe to evolve.
**Tools:** Read, Grep, Glob, Bash, Agent (read-only with subagent dispatch — designs and reviews, doesn't implement)

### Subagents (3 parallel Explore)

1. **Consumer analysis** — finds all call sites of the target API (or the analogous code for new APIs). Maps usage patterns: which overloads are used, which parameters are always the same value, which error paths callers actually handle, which features no one uses.
2. **Contract extraction** — identifies the implicit and explicit contracts: preconditions, postconditions, invariants, ownership transfers, lifetime requirements, thread-safety guarantees. Flags contracts that exist but aren't enforced or documented.
3. **Evolution risk assessment** — for existing APIs: what would break if this changed? Binary compatibility (ABI), source compatibility, semantic compatibility. Maps the blast radius of proposed changes. For new APIs: what future directions are foreclosed by this design?

### Decision Trees

**Parameter design:**
- Takes ownership? `unique_ptr` or value
- Borrows, never null? `const T&` or `std::span`
- Borrows, maybe null? `const T*`
- Sink parameter? value + move
- String-like input? `std::string_view`
- Multiple related params? Named struct

**Error reporting:**
- Precondition violation (caller bug)? Assert/contract
- Expected failure (file not found, parse error)? `std::expected` or error code
- Systemic failure (OOM)? Exception or abort
- Never: bool return with no error detail

**API boundary type:**
- Header-only library? Everything in headers, no ABI concerns
- Shared library? Pimpl or abstract interface for ABI stability
- Internal module? Direct types, evolve freely
- Cross-team? Stable interface + versioning

**Evolution strategy:**
- Additive change (new function, new optional param)? Just add it
- Semantic change? New name, deprecate old
- Signature change? Expand-and-contract (from refactor skill)
- Type change? Adapter period with both types

**When to break compatibility:**
- Zero external consumers? Break freely
- Internal consumers you can update atomically? Break + fix all call sites in one commit
- External/many consumers? Expand-and-contract, minimum 1 release cycle

### Hard Rules

- Make interfaces easy to use correctly and hard to use incorrectly
- Prefer compile-time enforcement over runtime checks (strong types, deleted overloads, concepts)
- Never require callers to remember to do something (call init, check error, release resource)
- Ownership transfer must be visible in the type signature
- Default arguments are API surface — don't add them to avoid a breaking change if the default might change later
- If two functions must be called in sequence, make it one function or return a handle that enforces the sequence

### Anti-Patterns

- `bool` parameters (use enums — `connect(true, false)` is unreadable)
- Out-parameters when return values work
- Requiring callers to manage paired operations (open/close without RAII)
- God interfaces (one class doing everything)
- Leaking implementation types through public headers
- Non-explicit single-argument constructors (implicit conversion traps)
- Deep inheritance hierarchies for code reuse (use composition)
- "Universal" APIs that serve no use case well

### Output Contract

1. API surface inventory (current or proposed public interface)
2. Consumer usage analysis (for existing APIs)
3. Contract specification (preconditions, postconditions, invariants, ownership, thread-safety)
4. Design recommendations (parameter types, error strategy, extensibility points)
5. Evolution plan (for existing APIs: migration path, compatibility impact, deprecation timeline)
6. API misuse scenarios (how could a caller get this wrong, and how does the design prevent it)

---

## Cross-Referencing with Existing Skills

These new skills integrate into the existing workflow graph:

```
cpp-implement --> api-design (design the interface first)
                    |
                    v
              test-design (design tests for the interface)
                    |
                    v
              cpp-implement (implement + tests)
                    |
                    v
              cpp-review + security (review code + security audit)
                    |
                    v
              observability (instrument before shipping)
                    |
                    v
              critique (assess production readiness)
```

**Cross-references:**
- `test-design` -> `/concurrency` for threading-specific test strategies
- `test-design` -> `/perf` for benchmark-as-test patterns
- `observability` -> `/perf` for instrumentation performance budget
- `observability` -> `/security` for sensitive data in logs
- `security` -> `/cpp-review` for code-level vulnerability checks
- `security` -> `/networking` for network-facing input validation
- `api-design` -> `/refactor` for expand-and-contract migration
- `api-design` -> `/cpp-implement` for implementation after design

## Skill Summary Table Update

| Skill | Purpose | Tools | Subagents |
|-------|---------|-------|-----------|
| test-design | Test strategy design: what, how, concurrent testing | Read, Grep, Glob, Bash, Agent | 3 parallel Explore (testability, coverage, concurrency) |
| observability | Structured logging and runtime diagnostics | Read, Grep, Glob, Edit, Write, Bash, Agent | 3 parallel Explore (logging, diagnostics, failure modes) |
| security | Security audit: input validation, logic vulns, hardening | Read, Grep, Glob, Bash, Agent | 3 parallel Explore (input boundaries, logic vulns, attack surface) |
| api-design | C++ API design and safe evolution | Read, Grep, Glob, Bash, Agent | 3 parallel Explore (consumers, contracts, evolution risk) |
