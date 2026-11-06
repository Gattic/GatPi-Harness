# Cognitive Memory Architecture

`src/cognitive-memory.js` implements a structured cognitive substrate for the harness. It is not a vector database wrapper: every memory entry has typed state, provenance, verification, confidence, usage frequency, links, and observable scoring decisions.

## Four independent memories

| Type | Stores | Retrieval bias | Decay / compaction |
| --- | --- | --- | --- |
| Episodic | debugging attempts, failures, retries, experiments, sessions, execution history | recency, failures, symbolic task focus | short half-life; stale debugging/speculative attempts are compacted or forgotten |
| Semantic | architecture, APIs, invariants, project structure, dependencies, conventions | semantic match, verification, architecture weight | long half-life; deduplicates and preserves high-confidence invariants |
| Procedural | deployment, testing, builds, migrations, playbooks | symbolic workflow filters, usage, verification | medium half-life; old low-score workflows are summarized |
| Strategic | priorities, philosophy, maintainability, performance, security, long-term goals | verification, confidence, architecture/strategy weight | longest half-life; compacted conservatively |

## Consolidation

`consolidate({ force })` performs:

- semantic deduplication with winner selection by verification, confidence, usage, and provenance;
- contradiction resolution, pruning weaker contradicted memories or flagging ties for review;
- invariant extraction from repeated verified episodic evidence into semantic memory;
- cross-memory linking: episodic -> semantic, semantic -> procedural, strategic -> semantic;
- per-type compaction according to each memory policy.

Every consolidation action is returned as a decision object and appended to the audit log.

## Retrieval engine

`retrieve(query, options)` supports hybrid retrieval:

- lexical semantic scoring;
- symbolic filtering by `tags`, `symbols`, and `paths`;
- dependency focus weighting;
- recency/access weighting;
- architecture weighting;
- type-specific score policies.

The returned `observations` explain why each memory was selected, its factor scores, candidate count, and recursive lineage.

Insertion deduplicates exact normalized content within each memory type before adding an entry; the retained entry merges tags, symbols, paths, confidence, verification, and provenance without growing the hot set. Automatic prompt-time recall further limits types to semantic, procedural, and strategic memory and excludes `verification-adapter`, `anchoring-adapter`, and `pi-message` provenance. These records remain inspectable through explicit recall but cannot re-enter the automatic hot context.

## Forgetting

`forget()` removes or prunes:

- stale debugging data;
- decayed speculative memories;
- contradicted memories;
- memories below their type-specific threshold.

## Persistence

Use `save(file)` and `CognitiveMemory.load(file)` for JSON persistence. The file contains entries, links, recent audit events, provenance, verification state, and consolidation timestamps.

## Minimal usage

```js
const { CognitiveMemory } = require('./src/cognitive-memory');
const memory = new CognitiveMemory();

memory.remember({
  type: 'semantic',
  title: 'Hermes advisory invariant',
  content: 'Provider advice must stay typed, explicit, off-path, privacy-safe, and unable to mutate canonical state.',
  tags: ['architecture', 'invariant'],
  confidence: 0.95,
  verification: 'verified',
  provenance: { source: 'user' }
});

memory.consolidate({ force: true });
const result = memory.retrieve('off-path advisory architecture', { architectureFocus: 1 });
console.log(result.observations.included);
```

## Lifecycle visibility without a second authority

`src/memory-maintenance.js` observes bounded metadata from typed cognitive records, canonical project-memory decisions, Evidence Binder, retention, and managed-permission policy. It emits stable preview candidates and new/persistent/resolved accounting, but never calls `forget()`, `consolidate()`, retention apply, permission apply, or a canonical-memory writer.

`src/provenance-graph.js` connects source-owned metadata through normalized typed edges such as `supports`, `produced`, `derived-from`, `captured-as`, `informed`, `accepted`, `rejected`, `supersedes`, and `conflicts`. Nodes retain only IDs, exact-version/hash facts, status, timestamps, and provider identity. Records remain authoritative in their original stores. Dangling lineage, conflicting support, rejected/superseded decisions, and incomplete exact-version skill provenance are diagnostics, not automated repair authority.

## Canonical durable-memory readiness

Obsidian project notes remain canonical; cognitive entries and compiled caches are projections. `resolveVaultSelection()` supplies one project/vault identity to every durable-memory surface. Filesystem readiness, rollout-authorized reads, rollout-authorized explicit writes, Hermes curation proof, and automatic-behavior authority remain separate facts. Ambiguous discovery fails closed, full vault paths remain runtime-only, and a writable vault cannot promote the scorecard-capped rollout.

## Retention bounds

Both append-only cognitive stores have an owner and a bound. `CognitiveMemory.save()` collapses exact duplicates (case- and punctuation-insensitive content per type) and enforces per-type caps — episodic 5000, procedural 3000, semantic 1000, strategic 300 — while preserving every `verified` entry even when it alone exceeds a cap. Caps sit above steady-state volume, so they bound future growth rather than delete live history.

`ReasoningRuntime.pruneAutomatedVerification()` bounds automated verifier evidence (default 120) and automated executor actions (default 2000); `AUTOMATED_RETENTION` in `src/reasoning-runtime.js` is the single source for those defaults, and `PI_REASONING_AUTO_PRUNE_AUTOMATED_KEEP` / `PI_REASONING_AUTO_PRUNE_ACTIONS_KEEP` override them. The reasoning extension auto-prunes when either store crosses its threshold (`PI_REASONING_AUTO_PRUNE_AUTOMATED_MAX` 240, `PI_REASONING_AUTO_PRUNE_ACTIONS_MAX` 2500). Non-automated artifacts are never pruned.

Apply the bounds once with backups:

```bash
node scripts/maintain-memory-stores.js            # preview both stores
node scripts/maintain-memory-stores.js --apply    # back up privately, then rewrite
```

The script reads `.pi/cognitive-automation/cognitive-memory.json` and `reasoning-runtime.json` from the current project, copies each file to `.pi/memory-maintenance/backups/<timestamp>/` at `0600` before rewriting, and writes a metadata-only receipt at `.pi/memory-maintenance/latest.json`. Canonical vault notes and session files are never touched. Run `--apply` only while no Pi process owns the stores; a live process rewrites them from its in-memory copy on the next persist.

Run:

```bash
node tests/cognitive-memory.test.js
node tests/cognitive-memory-retention.test.js
node tests/reasoning-runtime-retention.test.js
node tests/memory-store-maintenance-script.test.js
node examples/cognitive-memory-example.js
node tests/project-memory-readiness-consistency.test.js
node tests/memory-maintenance.test.js
node tests/provenance-graph.test.js
```
