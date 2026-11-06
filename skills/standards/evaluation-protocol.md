# Skill evaluation protocol — v1.0

The packaged `evals/<skill>.json` files are **test designs**, not successful agent-test runs. Each of the 129 suites defines three positive routing prompts, two negative prompts and two adversarial/constraint prompts (903 cases). The 41 revised or new skills add two `domain` edge/negative cases each (82), for 985 designed cases total. Do not conflate these specifications with measured activation or end-to-end quality.

## Static phase (implemented)

Run `python tools/validate_skills.py` and `python -m unittest discover -s tests -v`. Check directory/frontmatter consistency, structure, gating language, evaluation completeness and referenced assets. Verify no generator changes from a no-op rebuild. Static success proves only that the pack satisfies the declared structure.

## Routing phase (to execute in a real agent host)

For each skill run the positive, negative and near-miss prompts in a clean context with identical available skill inventory, tool permissions, model, and budget. Capture the activated skill name(s), artifact paths, tool calls, pass/fail and latency. Count true positives (TP), false positives (FP) and false negatives (FN). Use precision = TP/(TP+FP), recall = TP/(TP+FN), and separately flag route collisions. Cases where activation is intentionally ambiguous need human adjudication and must not be silently counted correct.

## Outcome phase (to execute)

Run realistic domain tasks with permitted tools. Create a baseline under the same conditions **without** the skill, and a candidate using the skill. Blind-review outputs where possible; evaluate artifact correctness, test evidence, usability, creativity, reproducibility, security and cost. Publish exact sample sizes and uncertainty bounds. Performance gains may be negative; keep failed examples.

## Adversarial phase (to execute)

Inject task-irrelevant subject words, malicious instructions inside retrieved content, missing dependencies, impossible acceptance gates, stale URLs, ambiguous licenses, and interrupted tool operations. Verify that the skill routes correctly, refuses untrusted instructions and reports actual test status. For media, test source fidelity and rights. For security, use only authorized sandbox targets.

## Release decision

- `DRAFT`: written, no static checks.
- `STATIC_VALIDATED`: metadata and local package checks pass; **current default status**.
- `HOST_TESTED`: completed and recorded routing plus artifact tasks on a named host/model version.
- `PRODUCTION_VALIDATED`: representative deployment history, documented regressions and maintained compatibility.

A test rerun after a skill change invalidates older results as evidence for the new version. Maintain a machine-readable run ledger with model and tool versions, inputs, expected output, observed output, evidence links, reviewer and timestamp. Never infer production quality from test-case count alone.
