# Verification baseline: known pre-existing failures

`scripts/check-all.sh` runs every deterministic test file. This page records
failures that exist on `main` for reasons unrelated to the current change, so a
run is not reported as a regression.

**Baseline as of 2026-11-24: clean — 340/340 deterministic test files pass.**

Before calling a failure a regression, reproduce it on the parent commit. An
entry that is not listed here is a regression until proven otherwise that way.

## Resolved entries

Kept as a record of the two failures that were on `main` through `f2bc123`, so a
reader of older logs knows they were understood rather than forgotten. Both were
fixed by making the tests independent of ambient state and of the calendar.

### `tests/extension-load.test.js` — pi-queue tool-surface assertion

The failure at `tests/extension-load.test.js:1035` (`deepStrictEqual`, actual
`['extensions/pi-queue: Every session start wraps local under the API its models
use, so no runtime is left unwrapped']`, expected `[]`) came from ambient
configuration, not from the extension. `extensions/pi-queue` reads
`PI_QUEUE_PROVIDER` when it is invoked, and a machine that exports
`PI_QUEUE_PROVIDER=sparky0` made the test's `local`/`anthropic` fixture models
match nothing, so no provider was registered. The test now pins
`PI_QUEUE_PROVIDER=local` (saving and restoring the previous value) alongside the
queue env it already controlled.

### `tests/memory-readiness.test.js` — test #3, readiness day count

`scripts/memory-readiness.js` derives its window from the current clock, but the
fixture dated its records with a literal `2026-11-23T10:00:00Z`. That made
`earliest` drift one day per calendar day (`'2026-11-30'` vs the expected
`'2026-11-29'`), and would have dropped every count to zero once the records aged
out of the 14-day window. The fixture is now dated relative to `now`, and the
floor assertion pins the derivation (`window.end + daysRemaining`, in the
future) instead of a literal date.

## Updating this page

Add an entry when a failure is shown to predate the change under test, with the
test name, the assertion and the root cause. Remove it in the same change that
fixes it, and re-run `scripts/check-all.sh` to confirm the baseline is clean.
