# Entropy monitoring and session stability

`src/entropy-monitor.js` implements a deterministic, persistence-backed subsystem for detecting cognitive drift, runaway sessions, context corruption, recursive failure loops and long-session coherence decay.

## Architecture

The subsystem is event-driven:

1. `EntropyMonitor.observe(event)` normalizes session, tool, patch, verifier, context, branch, plan and assumption events.
2. `ContradictionDetector` records assumptions, plans, architecture statements and objectives, then emits explicit conflict evidence.
3. `RecursiveFailureDetector` computes retry-loop, repeated-signature, cyclic-planning and unstable-patch signals over a bounded window.
4. `EntropyMetrics` normalizes ten primary entropy metrics to `[0, 1]`, combines them with documented weights, and derives session health scores.
5. `StabilizationEngine` recommends context compaction, session branching, failing-agent isolation, volatile-memory reset and reasoning-chain pruning.
6. `ContextSanitizer` prunes stale context, isolates speculative/contradicted blocks and removes redundancy.
7. `MetricsPersistence` writes append-only JSONL events/snapshots plus aggregate long-term stats.
8. `EntropyDashboard` renders ASCII timelines, retry heatmaps and a standalone HTML dashboard.

## Primary metrics

| Metric | Meaning |
| --- | --- |
| `contextGrowthRate` | Recent token growth per minute, normalized against a 3000 token/minute stability budget. |
| `retryDepth` | Max retry/attempt depth in the window normalized by depth 8. |
| `contradictionFrequency` | Contradiction evidence density in the event window. |
| `patchInstability` | Failed, rejected or rolled-back patches divided by patches. |
| `patchReversionFrequency` | A/B/A patch hash reversions and explicit revert events divided by patches. |
| `hallucinatedToolCalls` | Unknown/unavailable tool calls divided by tool calls. |
| `verifierFailureDensity` | Failed verifier/test events divided by verifier/test events. |
| `semanticDrift` | `1 - cosine(anchor objective, recent session text)`. |
| `branchDivergence` | Mean pairwise text/file distance between active branches. |
| `tokenInefficiency` | Tokens consumed per progress event against a configurable stability budget. |

`recursiveFailureScore` and `duplicationPressure` are secondary signals used by health scoring and stabilization.

## Health scores

Scores are continuous and inspectable:

- `entropyScore`: weighted sum of normalized entropy metrics.
- `stabilityScore`: inverse entropy adjusted for rising entropy derivative and recursive-loop pressure.
- `coherenceScore`: inverse contradiction, drift, branch divergence and duplicate-objective pressure.
- `confidenceScore`: inverse verifier failure, retry depth, patch instability, contradiction and hallucinated-tool pressure.

All scores are clamped to `[0, 1]`; higher stability/coherence/confidence is better, higher entropy is worse.

## Contradiction detection

The detector identifies:

- conflicting assumptions via opposite polarity over overlapping subjects,
- conflicting plans via opposing actions such as add/remove or use/avoid,
- architectural inconsistency when architecture/invariant statements conflict,
- duplicated objectives via high semantic similarity.

Each contradiction includes IDs, severity, the two source statements and an explanation.

## Auto-stabilization actions

Recommended actions are evidence-based:

- `compact_context` for context/token entropy,
- `branch_session` for semantic drift or branch divergence,
- `isolate_failing_agents` for verifier failure density or recursive loops,
- `reset_volatile_memory` for patch instability/reversion,
- `request_failure_analysis` for retry-loop signatures; this requests explicit verifier-backed failure artifacts instead of pruning or inspecting private reasoning.

Actions are recommendations; the harness can choose to apply them automatically or require operator confirmation.

## Usage

```js
const { EntropyMonitor } = require('./src/entropy-monitor');

const monitor = new EntropyMonitor({
  allowedTools: ['read', 'bash', 'edit', 'write'],
  persistenceOptions: { dir: '.pi/entropy' },
});

const snapshot = monitor.observe({ type: 'objective', text: 'Fix flaky verifier' });
monitor.observe({ type: 'patch', ok: false, status: 'rollback', retryDepth: 2 });
monitor.observe({ type: 'verifier', verifier: 'unit', ok: false });

console.log(snapshot.metrics.entropyScore);
console.log(monitor.dashboards().ascii.entropy);
```

## Validation

```bash
node tests/entropy-monitor.test.js
node examples/entropy-monitor-example.js
node scripts/simulate-entropy-monitor.js
```
