# Deterministic semantic editing

`src/semantic-editor.js` provides internal transactional semantic anchoring for LSP workspace edits, integration-boundary consumers, and verification diffs. The standalone Semantic Patch Workbench is retired. User-facing localized edits use `edit`; broad mechanical edits use `ast_refactor` preview/apply/rollback; compiler-sensitive renames use `lsp` preview/apply.

## Anchor contract

Each `SemanticAnchor` records:

- whole-file SHA-256 content hash for optimistic concurrency and stale-patch detection
- semantic region identity, e.g. `function:alpha`, `class:Store`, or a paragraph hash
- lightweight AST node identity for JavaScript/TypeScript-like files when available
- exact and normalized region hashes
- token sequence signature
- structural neighbourhood signatures before/after the region
- dependency signature from `require()` / `import` usage

Resolution is deterministic: exact match wins, then AST identity, semantic region identity, token similarity, neighbourhood similarity and dependency compatibility are scored with fixed thresholds.

## Validation and rejection

Before applying a patch group the engine validates:

- anchor confidence and ambiguity
- surrounding context drift
- overlapping edits
- duplicate generated code
- malformed partial rewrites and unbalanced delimiters
- file hash race conditions for file-backed optimistic writes

Unsafe patches are rejected before any content is committed.

## Transactions and rollback

`SemanticEditEngine.apply()` applies all edits as an atomic group. It creates a corruption checkpoint with inverse semantic patches. If post-apply syntax checks fail, the original content is returned. `rollback(content, checkpoint)` replays the inverse chain.

`transactFiles(fileMap, patchGroups)` provides branch-isolated multi-file transactions in memory. `optimisticApplyFile()` adds compare-and-swap style race detection for concurrent agents.

## Diff and impact analysis

`semanticDiff(before, after, filePath)` reports structural additions/removals/modifications by semantic region and includes dependency impact (`added`, `removed`, `unchanged`).

## Internal integration strategy

1. Replace APIs that accept line ranges or raw `oldText` with `createPatch({ filePath, content, start, end, replacement })` at patch creation time.
2. Persist the resulting anchor object with generated changes.
3. At apply time call `validate()` or `apply()` against the current file contents, never against stale snapshots.
4. Treat rejection as expected safety behavior; regenerate patches from current content instead of forcing application.
5. For concurrent agents, use branch-local file maps or `optimisticApplyFile(filePath, patches, expectedHash)`.
6. Record `engine.metrics()` in CI/agent telemetry to monitor rejected edits, drift, rollback rates and confidence.

## Direct library use

Internal callers that require anchored application can build a patch from a selected region and apply it against current content:

```js
const { SemanticEditEngine } = require("./src/semantic-editor");
const engine = new SemanticEditEngine();
const patch = engine.createPatch({ filePath, content, start, end, replacement });
const result = engine.apply(currentContent, [patch], { filePath });
if (!result.ok) throw new Error(JSON.stringify(result.validation.rejections));
```

This keeps offset selection local to creation while eliminating stale offset-based application. It does not expose a second Pi editing workflow.
