# Experiment gate lifecycle contract

Provenance: adapted from the pi-harness `experiment-gate-lifecycle` skill
(`skills/experiment-gate-lifecycle/SKILL.md` at commit `5f25692`), archived during the
Skill Foundry migration and restored as a local addition. The workflow below is
otherwise unchanged; only its frontmatter (including `enableSkillCommands`,
`disable-model-invocation`) was dropped to fit the bundle standard. The legacy skill
was explicit-command-only; the bundle standard has no such switch, so it is now
model-routable through the narrow triggers in its description. The archived
`research-framework-design` reference now points to its bundle owners, and the
boundary names `experiment-design-analysis` for statistical design.

Turn an uncertain idea into a bounded, falsifiable experiment without losing bars, failed arms, null results, costs, or decision history.

## Boundary

This skill manages experimental semantics; use `experiment-design-analysis` for estimands, power and randomization. Use `long-run` for process management alone and `evidence-led-research` or `quantitative-modeling` when the task is still framework invention rather than testing an existing hypothesis.

## Hard rules

- Inspect open `experiment_ledger` records before launching anything.
- Pre-register the hypothesis, arms, pass bars, kill criteria, and cost bound before the first run.
- Do not weaken bars after observing results.
- Link every material run and gate verdict to the experiment record.
- Record PASS, FAIL, and NULL-RESULT. Negative evidence prevents settled questions from being rerun unchanged.
- Separate implementation failure, measurement failure, and hypothesis failure.
- Use managed run tools; never babysit with shell sleep/tail loops.
- A long-running process settling is not a successful experiment. Judge only against the registered gate.
- Close with an explicit ship, no-go, or shelved decision.

## Workflow

### 1. Resolve experiment state

Determine whether this is:

- **new:** no matching experiment exists;
- **continuation:** an open record exists and the requested arm matches it;
- **reframe:** prior evidence invalidates the current formulation;
- **settled:** the question already has a decisive gate and must not be rerun unchanged.

For continuation, preserve the registered bars and arm definitions exactly. For reframe, open a new experiment only when the hypothesis or decisive mechanism materially changes; link the prior decision in the note.

### 2. Pre-register

Use `experiment_ledger open` with:

- one-sentence falsifiable hypothesis;
- exact arms/configurations;
- deterministic or cheap gates before expensive gates;
- numerical pass bars and kill criteria;
- allowed cost/time/resource envelope;
- final ship gate.

If a meaningful pass bar cannot be written, the experiment is not ready.

### 3. Establish validity gates

Before measuring the hypothesis, prove the experiment can answer it:

1. implementation/build parity;
2. units, fixtures, schema, or accounting validity;
3. deterministic seed/input parity where applicable;
4. baseline reproducibility;
5. privacy, policy, and mutation boundaries.

A validity failure is not a hypothesis result. Fix the experiment surface once, record the failed validity gate, and rerun only that gate.

### 4. Launch managed runs

Choose the manager by work type:

- `run_deck` for training, downloads, generation, pretokenization, recurring metrics, or externally attached runs;
- `bg_run` for builds, suites, servers, and long one-shot commands;
- `run_monitor` only when the user requests periodic observation or completion notification.

Register once. Retain run IDs and log paths. Never launch duplicate arms because status was not checked first.

### 5. Record each gate

For every gate call `experiment_ledger gate` with:

- gate label;
- pass/fail/null-result/partial verdict;
- measured numbers against the registered bar;
- run ID and commit when available;
- GPU-hours or other material cost;
- concise interpretation.

A NULL-RESULT means the experiment ran validly but did not distinguish the hypothesis, or the evidence cannot support a directional claim. It is not a soft pass.

### 6. Decide

Classify poor results:

- **implementation failure:** code or invariants are broken;
- **measurement failure:** metrics, baseline, data, or accounting are invalid;
- **hypothesis failure:** implementation and measurement are valid, but bars fail;
- **null result:** valid evidence does not distinguish the claim.

Permit one repair rerun for an implementation or measurement failure. Do not tune a failed hypothesis without opening a materially changed arm or reframe.

### 7. Close

Use `experiment_ledger close`:

- `ship` only when every ship gate passes;
- `no-go` when decisive evidence rejects the direction;
- `shelved` when evidence is incomplete and no bounded next experiment is justified.

Bind or cite final evidence and state what must not be retried unchanged.

## Output contract

```text
Experiment: <id>
State: new | continuation | reframe | settled
Hypothesis: <claim>
Gate: <label>
Bars: <registered bars>
Run: <managed run id>
Metrics: <measured vs bar>
Verdict: PASS | FAIL | NULL-RESULT | PARTIAL
Cost: <time/GPU-hours/calls>
Decision: continue | ship | no-go | shelved
Next bounded action: <one action or none>
```

## Anti-patterns

- Launching before pre-registration
- Treating invalid plumbing as evidence against the hypothesis
- Reporting only successful arms
- Repeating a null or failed arm unchanged
- Tuning before the central mechanism shows signal
- Closing from process exit status rather than gate metrics
