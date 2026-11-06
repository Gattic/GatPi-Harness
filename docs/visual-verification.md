# Visual Verification Provider

Visual Verification is a first-class optional provider family behind Verification Center. It compares configured, exact-identity visual cases while keeping captured bodies out of durable evidence and telemetry.

## Provider policy

Configured visual cases are advisory by default. Explicitly requiring the provider makes readiness a fail-closed gate:

```json
{
  "requiredProviders": ["visual"],
  "visual": { "caseIds": ["rollout-center-compact"] }
}
```

No configured/applicable case is `not-applicable`. A missing optional backend is degraded advisory. A missing required backend, stale baseline, malformed artifact, comparison mismatch, or baseline mutation blocks verification.

Verification Center cannot create or update baselines.

## Configuration

Visual cases are pinned in `.pi/project.json`:

```json
{
  "visualVerification": {
    "schemaVersion": 1,
    "baselineManifest": "tests/visual-baselines/manifest.json",
    "cases": [
      {
        "caseId": "rollout-center-compact",
        "kind": "tui-frame",
        "profiles": ["changed", "full"],
        "sources": ["src/rollout-center-view.js"],
        "capture": {
          "module": "tests/visual-fixtures/rollout-center.js",
          "export": "capture",
          "input": { "width": 40 }
        },
        "baselineId": "rollout-center-compact-v1",
        "thresholds": { "maxChangedLines": 0 }
      }
    ]
  }
}
```

Runtime tool input may select configured case IDs and supply Evidence Inbox `artifactRef` values. It cannot supply commands, modules, unrestricted paths, or baseline locations.

## Backends

- `tui-frame`: always-local deterministic frame hashing and line-hash comparison.
- `image`: optional ImageMagick exact/fuzzed pixel comparison.
- `graphviz`: optional constrained DOT capture, Graphviz rendering, and ImageMagick comparison.
- `external-manifest`: a tracked command with a schema-v1 private output manifest.
- `browser`: readiness-only until a local Playwright package/browser is installed and execution is separately authorized.

All subprocesses use argument arrays, closed stdin, bounded output and timeouts, and no shell.

## TUI canonicalization

The configured capture module is automatically included in source identity even if omitted from `sources`. TUI captures are normalized to NFC, SGR styling is removed, and each line is padded to the configured width. Tabs, OSC/hyperlinks, cursor controls, non-SGR escape sequences, control characters, oversized frames, and over-width lines are rejected.

Baselines store whole-frame and ordered line hashes, dimensions, provider/config/source identity, and approval metadata. They do not store frame lines.

## Artifacts and privacy

Generated screenshots, Graphviz renders, request manifests, and comparison intermediates live in a private OS temporary directory and are deleted in `finally`. Visual evidence stores only:

- opaque artifact references;
- SHA-256 digests;
- media type, bytes, and dimensions;
- provider/adapter/runtime version;
- source and capture-configuration fingerprints;
- baseline identity;
- thresholds and bounded metrics.

It never stores image bodies, frame lines, DOM or accessibility trees, selectors, URLs, command output, transcripts, or reasoning. Existing baseline binaries remain owned by their configured project/external store and are not copied into evidence.

## External manifest protocol

Configured commands receive:

```text
PI_VISUAL_REQUEST_FILE
PI_VISUAL_OUTPUT_MANIFEST
PI_VISUAL_OUTPUT_DIR
```

The case must declare a safe, exact `capture.providerVersion`; changing it makes the baseline stale. The output manifest must be schema v1 and reference one confined, non-symlink, ImageMagick-readable image file. Extra paths and malformed manifests are rejected. Raw stdout/stderr is discarded after mapping to a fixed error code.

## Baseline administration

Baseline updates are an explicit, separate mutation:

```text
node scripts/manage-visual-baselines.js preview <case-id>
node scripts/manage-visual-baselines.js apply <case-id> \
  --yes --approval-ref=<safe-id>
```

For Evidence Inbox image input add `--artifact-ref=<artifactRef>`. Preview writes nothing. Apply can write only the configured baseline artifact and manifest entry and does not commit or publish. Verification hashes the baseline manifest before and after execution and fails if it changes.

Disable all visual verification with `PI_VISUAL_VERIFICATION=0`. Override optional binaries with `PI_VISUAL_IMAGEMAGICK_BIN` and `PI_VISUAL_GRAPHVIZ_BIN`.
