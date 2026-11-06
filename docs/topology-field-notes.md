# Topology Field Notes

## External repo smoke: `~/dev/test-repo`

Date: 2026-05-20

Purpose: use the topology engine on low-risk workflows outside the `pi-harness` repo and observe friction through Pi's live command path.

### Setup

Created `~/dev/test-repo` with:

- `README.md`
- `index.js`
- `.pi/topologies/low-risk-workflows.json`

Configured two low-risk tool-node topologies:

1. `test-repo-doc-inspection`
   - researcher `read README.md`
   - researcher `find .`
2. `test-repo-review-verify`
   - reviewer `git diff --stat`
   - verifier `node index.js`

### Pi command path exercised

Ran Pi from `~/dev/test-repo` using the project cognitive extension:

```text
/topology-list
/topology-run test-repo-doc-inspection inspect README and file list
/topology-run test-repo-review-verify review diff and run node smoke
/topology-runs
/topology-show-run latest
/topology-metrics
/topology-doctor
```

Observed successful runs:

- `test-repo-doc-inspection`: succeeded, used read/find tool nodes
- `test-repo-review-verify`: succeeded, `node index.js` returned `test-repo ok`

Diagnostics reported:

- external repo storage root: `~/dev/test-repo/.pi/cognitive-automation`
- 2 loaded topologies
- metrics for both runs
- shell safety policy enabled

### Friction found and fixed

1. **External repo library resolution**
   - Friction: the cognitive extension originally loaded `src/*` from the current working directory, which fails in repos that do not contain `pi-harness` libraries.
   - Fix: resolve library imports from the extension installation root (`LIB_ROOT`) while keeping storage/config relative to the target repo cwd.

2. **Config-only workflows needed deterministic tool nodes**
   - Friction: JSON topologies could define roles and edges but had no way to invoke simple deterministic tools without custom JS handlers or subagents.
   - Fix: added `node.tool` / `node.args` support in `TopologyExecutionEngine`, still gated by per-role/per-node tool permissions.

## 2026-05-21 workflow extension field note

A non-destructive external-repo style validation pass should exercise the new workflow pack with a temporary or throwaway repo:

```text
/project-profile
/project-init-pi
/topology-recommend failing ci
/test-gaps
/policy-check rm -rf .
/perf-profile
/ci-status
```

Expected behavior: commands must be advisory/local-first, tolerate missing GitHub CLI or missing trace data, avoid deleting memory/runtime state, and keep cwd-sensitive storage under the target repo `.pi/` while loading extension libraries from the pi-harness install root.

Validation smoke completed against a temporary git repo with `package.json`, `.github/workflows/ci.yml`, `src/`, and `tests/`: each new workflow extension loaded from absolute pi-harness extension paths in `pi -p --no-extensions -e ... 'say only ok'` while cwd was the external repo.

### Remaining friction / future consideration

- Tool-node output is JSON-stringified into `content`, which is reliable but verbose in TUI notifications. Resolved later by the Output Compactor extension (`.pi/extensions/output-compactor/`), which auto-compacts verbose tool JSON.
- External repo topologies must be created manually under `.pi/topologies`; `/topology-template` helps. `run_topology` now owns recipe administration: `/topology-recipes` lists built-ins and `/topology-install <recipe-id>` installs a validated packet into `.pi/topologies/`.

### Validation

After fixes:

```bash
scripts/check-all.sh
PI_CHECK_TUI=1 scripts/check-all.sh
```

Both passed in `pi-harness`.
