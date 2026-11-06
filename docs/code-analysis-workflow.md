# Risk-focused code analysis

## One lookup per question

- Localize unfamiliar code with `code_context repoMap` or `search`, then read the relevant source. Do not repeat the same lookup through AST and CodeGraph.
- `ast_search` is **regex-backed lexical/declaration matching**, not a parser. It can match strings/comments and miss complex syntax. `ast_refactor` is a checkpointed lexical replacement, not a scope-aware rename: preview, inspect the diff, apply, and run tests. Use live LSP for semantic rename/references.
- Use CodeGraph for dependency questions. `code_context symbolRelations` invokes actual `callers`/`callees`, supports `symbol` **names**, `relationKinds: ["calls"]`, incoming/outgoing/both, and depth 1. IDs, other relations and deeper traversal are explicitly unsupported. Name ambiguity and incomplete call resolution remain advisory limitations; no lookup is presented as a relationship.
- AST status, preview and no-op apply do not invalidate the graph. Successful apply/rollback does. Let auto-sync catch up; explicitly sync only if the next graph query still needs it.
- Choose one impact lookup: `changeImpact`, `codegraph_affected`, or the combined Semgrep bridge. An empty graph result never justifies omitting baseline tests. Index freshness alone is not proof of exhaustive test coverage.

## Security checkpoints

`gitverify` and Verification Center **run** invoke `src/security-checkpoint.js` once for security-sensitive changed source (auth/secrets/permissions, subprocess/shell operations, path/crypto operations), or a broad change of at least ten source files. Planning reports selected paths without scanning. Deleted, generated, dependency and documentation files are not scan targets. Sources over the 1 MiB content-inspection limit are selected conservatively. This is risk triage, not a complete vulnerability classifier.

These explicit verification checkpoints work while `PI_SEMGREP_ADVISORY=0` keeps background enrichment off. `PI_SEMGREP=0` still disables the provider. Rules resolve from an explicit config, `PI_SEMGREP_CONFIG`, repository `.semgrep.yml`, then `p/default`. This harness pins three small JS/TS rules in `.semgrep.yml` for disabled TLS verification, environment-secret logging, and concatenated shell execution. They are not a comprehensive security ruleset, nor do they cover every language. Registry packs can change upstream; only the checked-in local rules are pinned.

Metrics are off; scanning has a 30-second default subprocess timeout (Verification Center override: `PI_SEMGREP_VERIFY_TIMEOUT_MS`), five seconds per file, plus separate bounded config validation and graph lookup. Config readiness and reliability identities include local rule contents, so editing rules invalidates prior config evidence. The report distinguishes clean, findings, unavailable and not-applicable. Inspect existing checkpoint results instead of launching a duplicate scan. Findings and affected-test hints are advisory and cannot suppress baseline verification. Verification Center retains explicit required-provider readiness policy through `input.requiredProviders: ["semgrep"]`; readiness is not a zero-findings gate.

## Opt-in runtime test evidence

For a supported direct Node test, infer the command and run it with coverage explicitly enabled:

```text
/test-runner-infer --profile changed tests/example.test.js
/test-runner-run --profile changed --coverage tests/example.test.js
```

The tool also accepts `coverage: true` and `configuration: "default"`. Coverage is off by default and accepts only `node tests/name.test.js`-style single-file commands, not package-manager/full-suite wrappers. No experiment is started and no test is omitted by enabling coverage.

V8 packets are processed in a dedicated temporary directory and removed in `finally`. Ingestion accepts at most 256 packets / 32 MiB; this is an **ingestion bound, not a hard disk quota on the test process**. Free temporary space is checked before capture. Only first-party source/test relationships, duration samples, revision/configuration and evidence hashes persist in `.pi/code-context/test-evidence.json`; no raw V8 packet or source body persists there. The index caps relationships at 5,000 and duration-bearing tests at 1,000; collection reports accepted/rejected counts. At capacity, fresh gating-safe observations with a known revision reclaim superseded dynamic records in the same configuration. Current-revision records, other configurations and explicit historical evidence are preserved; if no records can be reclaimed, new relationships are rejected. Unknown-revision, stale or failed observations cannot trigger eviction.

A relationship means source executed during that command, not that a particular assertion checked it or that the test set is exhaustive. Failed tests, source mutations during a run, unknown/stale revisions and configuration mismatches cannot produce current gating-safe evidence. Change Impact validates revision/configuration on lookup and keeps baseline tests regardless of these hints.

## Measure outcomes, not tool counts

Existing extension telemetry supplies source/session-qualified opportunities and latency/output-size metadata. The existing human review surface additionally accepts an optional `analysisOutcome`:

- AST: `correct-localization`, `refactor-verified`;
- CodeGraph: `correct-localization`, `tests-relevant`;
- Semgrep: `finding-actionable`, `tests-relevant`.

Each outcome is `{ "kind": "…", "passed": true|false }`, requires an acted interactive opportunity, a human reviewer and validated evidence IDs. The extension-ops opportunity-review report separates these observations under `codeToolOutcomes`. CodeGraph/Semgrep observations have their own bounded quota and do not consume the existing pilot quota. Calls, tests, and scanner cleanliness are **not** usefulness labels. Observational outcomes do not promote providers or establish causal productivity gains; the existing preregistered pilot, reviewed retrieval experiments, gates, budgets and human evidence remain unchanged. No open experiment needs to be rerun to exercise these features.

## Recommended installations

Priority for this JS/TS repository: **TypeScript plus typescript-language-server**. The locally verified combination is TypeScript **6.0.3** with typescript-language-server **6.0.2**. With approval, install these exact versions:

```sh
npm install --global typescript@6.0.3 typescript-language-server@6.0.2
```

Do not use the unpinned TypeScript install for this setup: the observed TypeScript 7 package lacked `lib/tsserver.js`, which this language-server integration requires. These instructions do not perform an installation.

The runtime detects `typescript-language-server` on `PATH` and invokes `--stdio`; a custom path can be supplied with `PI_LSP_TYPESCRIPT_LANGUAGE_SERVER_BIN`. After installation, use `lsp status`, then a focused definition/references/rename-preview request to confirm the live backend rather than the lexical fallback. Installing a server does not make every fallback diagnostic semantic.

Install other servers only for languages actually used:

| Language | Package / provider | Executable detected |
|---|---|---|
| Python | `pyright` (or `python-lsp-server`, not both by default) | `pyright-langserver` / `pylsp` |
| C/C++/CUDA | LLVM `clangd` | `clangd` |
| Go | `golang.org/x/tools/gopls` | `gopls` |
| Rust | rustup `rust-analyzer` component | `rust-analyzer` |

For genuinely parser-backed structural matching, consider **ast-grep** (`@ast-grep/cli`) in a separately approved integration. Installing it alone does not change the current regex-backed `ast_*` tools. CodeGraph and Semgrep are already installed locally; another vector index, graph service or scanner is not required for this workflow.
