# Cognitive architecture compatibility facade

This document is retained for older links. The active design is now:

```text
model = reasoning engine
harness = cognitive runtime
```

Use `docs/reasoning-runtime.md` and `src/reasoning-runtime.js` for new work.

`src/cognitive-architecture.js` remains as a compatibility facade for older imports such as `ModelRegistry`, `CognitiveRole`, and `CognitiveCoordinator`. It preserves model metadata/routing helpers, but it no longer implements a hard-coded planner/executor/verifier cognition pipeline.

Legacy `CognitiveCoordinator.orchestrate()` now returns scaffold artifacts:

- explicit plan artifact
- task decomposition object
- reasoning checkpoint

Acceptance still requires verifier evidence. Reflection, model confidence, and verbose output are not proof.
