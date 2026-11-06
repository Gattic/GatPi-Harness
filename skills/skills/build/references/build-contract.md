# Build and CI diagnostics contract

Provenance: adapted from the pi-harness `build` skill (`skills/build/SKILL.md` at
commit `5f25692`), archived during the Skill Foundry migration and restored as a local
addition. The workflow below is otherwise unchanged; only its frontmatter (including
`enableSkillCommands`, `disable-model-invocation`) was dropped to fit the bundle
standard. The legacy skill was explicit-command-only; the bundle standard has no such
switch, so it is now model-routable through the narrow triggers in its description.

Resolve build and CI problems from repository evidence without replacing the project's build system or hiding failures.

## Boundary

Use for configuration, compilation, linking, dependency, toolchain, sanitizer, static-analysis, or CI failures. For merely running an expensive build use `long-run`; for final change evidence use `change-verify`.

## Hard rules

- Detect the repository-defined build path before running commands.
- Prefer `build_project`, `test_runner`, CI metadata, and checked-in scripts over guessed command lines.
- Reproduce the exact failing target/configuration when possible.
- Separate source errors, dependency errors, environment errors, and infrastructure failures.
- Do not suppress warnings, disable tests, pin arbitrary old versions, or add fallback toolchains to make a build green.
- Keep local and CI configurations aligned.

## Workflow

### 1. Identify build contract

Inspect project manifests, lockfiles, build files, CI workflows, tool versions, environment requirements, and repository instructions. Record:

- build system and canonical command;
- target/configuration;
- language/toolchain versions;
- dependency installation policy;
- relevant cache/generated artifacts;
- local vs CI differences.

### 2. Classify failure

- configure/manifest/schema;
- dependency resolution or lock drift;
- compile/typecheck;
- link/package/bundle;
- test invocation/discovery;
- sanitizer/static analysis;
- CI environment, permissions, disk, memory, timeout, or provider infrastructure.

A provider or resource failure is not a source failure.

### 3. Reproduce narrowly

Use the smallest repository-defined target that exhibits the issue. Capture the first causal error rather than downstream cascades. Use local compiler/LSP diagnostics where useful.

For long builds, launch through the managed build/run tools instead of blocking or shell polling.

### 4. Fix the build contract

Apply the smallest durable change to checked-in configuration or source. Prefer target-scoped settings, pinned existing dependencies, and explicit version constraints. Do not introduce parallel build systems or duplicate CI logic.

Conditional checks:

- CMake/C++: target-based flags, compile database, ABI/link order, sanitizer compatibility.
- npm/TS: package scripts, lockfile parity, module mode, generated types, workspace boundaries.
- Cargo: feature resolution, target cfg, lock/toolchain parity.
- Python: environment metadata, package extras, interpreter constraints, import/build backend.

### 5. Verify

Run the original failing target, then the nearest broader build/CI check. Confirm generated or cache state is not the only reason it passes.

## Output contract

```text
Build target: <target/configuration>
Canonical command: <repository-defined command/tool profile>
Failure class: <class>
Root cause: <exact configuration/source/environment issue>
Change: <files and rationale>
Verification: PASS | FAIL | PARTIAL
CI parity: confirmed | gap
Residual environment assumptions: <none or list>
```

## Anti-patterns

- Deleting lockfiles or caches as the final fix
- Adding global flags for one target
- Treating the last error as the first cause
- Disabling warnings or sanitizers
- Hand-writing a new build path before checking existing scripts
- Claiming success from a different configuration
