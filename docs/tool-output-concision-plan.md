# Tool-output concision plan

Status: **implemented and verified** on branch `tool-output-concision`; not yet
merged to `main`. Verification evidence is in §4.

## 1. Problem

pi-dash's context breakdown reports `toolResults` as one bucket, so the dashboard
cannot say which tool filled the window. Measured from the local session tree
(last 30 days: 198 sessions, 285,520 messages, 157,615 tool results, 428M chars
of tool-result content):

| Tool | Share of tool output | Mean | p99 | Max |
|---|---|---|---|---|
| `read` | 46.0% | 5,587 | 28,317 | 51,275 |
| `bash` | 29.2% | 2,292 | 23,644 | 51,336 |
| `roadmap_update` | 5.5% | 1,625 | 7,717 | 20,037 |
| `bg_run` | 5.4% | 1,921 | 9,533 | 528,327 |
| `debug_ledger` | 2.9% | 3,236 | 50,021 | 123,660 |
| `docs_lookup` | 2.1% | 6,163 | 29,295 | 42,960 |

`read` + `bash` are 75.2% of the volume, the top six tools are 91%, and the top
10% of calls produce 49.9% of all characters. Resident (post-compaction) output
is dominated by `bash` (48.0%) and `read` (29.6%). Two live sessions showed
`toolResults` at 42% and 35% of the estimated context parts, with `bash` alone at
98.7%/99.1% of post-compaction tool output.

## 2. Issues and fixes

| # | Issue | Fix |
|---|---|---|
| 1 | No per-call bound on `read`/`bash` beyond pi core's 2000 lines / 50KB | `src/tool-output-bounds.js` caps `read` at 8,000 chars (`head`, with a `read offset=` continuation) and `bash` at 8,000 chars (`tail`, so errors and pi's truncation footer survive) |
| 2 | `roadmap_update` pretty-printed every mutation (26.6% of its output was indentation) | Mutations render as compact text lines; `details` keeps the full envelope |
| 3 | `debug_ledger` show/resolve printed every attempt, unbounded | Last 8 attempts by default (`attemptLimit` opt-in), 240-char field cap, explicit omission count |
| 4 | Injected open-thread summary grew with attempt text | Each `change` clipped to 200 chars |
| 5 | `bg_run`, `docs_lookup`, `ast_*`, `lsp`, `codegraph_context`, `memory_curator`, `memory_explorer`, `create_subagent`, `specialist_tasks`, `test_gap_planner` had no per-call cap | Same policy table (`tail` for logs/tests, `structured` JSON compaction otherwise) |
| 6 | The output compactor canary targeted seven low-volume tools and produced zero measured savings | Canary set is now the policy tool set; the hook rewrites through `boundToolResult` |
| 7 | Tool schemas cost 6,431 tokens per request | Measured, not trimmed (see §5) |

## 3. Design

- **`head`**: keep the start, cut on a line boundary, append
  `[… N chars omitted; <continuation>]`. Used where the remainder is retrievable
  by offset (`read`, `docs_lookup`, `debug_ledger`, `roadmap_update`).
- **`tail`**: keep the end, cut on a line boundary, prepend the omission marker.
  Used where failures and pi's own truncation footer live at the end (`bash`,
  `bg_run`, `test_runner`).
- **`structured`**: compact JSON payloads field-first with
  `src/result-rendering.js`, then fall back to `head` if still oversized.
- **Exemptions**: `verbose=true`, an explicit caller `maxChars`, results already
  inside a native render budget (`details.rendering.budgetTokens`), and any
  result carrying a non-text block (images) are never rewritten.
- No new on-disk transcript store is introduced. `read` continues from the file,
  `bash` re-runs, and structured tools keep full `details` plus their own
  `offset`/`limit`/`verbose` refinement paths.

## 4. Acceptance gates

- `tests/tool-output-bounds.test.js` pins head/tail/structured behavior,
  continuation offsets, exemptions and no-op cases.
- `tests/extension-load.test.js` proves the `tool_result` hook rewrites real
  oversized `read`/`bash` results, leaves `verbose` and nested codemode calls
  untouched, and still loads every extension with the same tool surface.
- `tests/tool-result-observer.test.js` proves `off`/`canary`/`all` attribution
  (disabled, outside-canary, compacted) and that telemetry stores counts only.
- `tests/debug-ledger.test.js` pins bounded show output, attempt numbering and
  summary clipping.
- `tests/roadmap-remediation.test.js` pins compact mutation text and the size
  bar (`resultChars`, `fullState === false`, bounded p99).
- `tests/productization-extensions.test.js` pins the compactor's policy import
  and the documented env keys.
- `npm run lint` and `npm run typecheck` pass.

## 5. Claim limits

- Savings are estimated from the measured corpus: an 8,000-char cap addresses
  about 20.9% of tool-output characters, 6,000 about 27.9%, and 4,000 about
  39.5%. These are synthetic-corpus estimates, not production measurements.
- Chars/4 estimates are not provider token counts; the live breakdown showed a
  negative unattributed residual, so part shares are approximate.
- Caps trade one large result for a possible follow-up call. The continuation
  marker makes that explicit; a model that needs the omitted text must ask for it.
- Duplicate-call dedupe (9,505 repeated calls, ~7.4% of corpus characters) is
  not implemented. Collapsing a repeated result to "same as before" would drop
  model-visible content with no retrieval path in the current turn, so it needs
  a retrievable transcript reference before it is safe; the compactor does not
  add one.
- Per-tool attribution in pi-dash (`src/bridge/context.ts`) is a separate
  repository change and remains a follow-up. This repo cannot make the
  dashboard name the offending tool until that bridge buckets results per tool.
- Tool-schema trimming is not implemented. The active schema is 6,431 tokens
  (~7% of an 86k-token window) and is already gated by the tool surface router;
  shortening descriptions or `promptGuidelines` would change tool-selection
  semantics for a small fixed saving. Recorded as a follow-up decision, not a
  silent omission.
