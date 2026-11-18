# Comparable agent animation benchmark

1. Freeze exactly one brief, including output target, constraints, candidate assets, external download policy, evaluation rubric, tool access and maximum budget.
2. Create separate OS/container workspaces and restrict filesystem mounts/network scope; a prompt telling the model not to peek is **not isolation**.
3. Freeze renderer/FFmpeg versions, GPU access, token pricing assumptions and evaluation methods; disclose any unavoidable asymmetry.
4. Collect time-stamped, permission-scoped run logs from each agent; do not access user-private logs without permission.
5. If fairness is required, do not give some contestants additional revision feedback, privileged reference images or another contestant's outputs.
6. Validate both outputs with the same decoder/quality procedure and blinded visual review; report raw observations separate from subjective preferences.
7. If a run is contaminated or telemetry incomplete, label it noncomparable instead of asserting a winner.

The motivating gist contains an unverified anecdote about cross-run copying. This protocol addresses the general risk; it does not treat that anecdote as established fact.
