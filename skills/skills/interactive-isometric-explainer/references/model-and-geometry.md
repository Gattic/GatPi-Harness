# Truth-first isometric explanatory figure

## Model

Use one pure model `step(state, input, dt) -> next_state` (or a deterministic function of time) for all moving geometry and displayed numbers. Label units and any simplified analogies. Assert boundedness, monotonicity (where appropriate), conservation and endpoint behaviors with tests.

## Mechanical depiction

Define world coordinates before projection. Attach all purposeful parts to meaningful mounts or joints. Separate back-facing and front-facing segments when they overlap moving pieces; use depth sorting rather than arbitrary `z-index` tricks. Record true shapes to enable clearance checks instead of simplifying them for audit.

## UX

Use accessible SVG labels, keyboard-equivalent interactions and a static reduced-motion state. Verify with 390px viewport, full-size desktop, assembled and exploded poses, and 4x close-ups. All numbers, controls and geometry derive from one state model.

## Truth labels

Distinguish measured physical systems from illustrative metaphors. If an example shows imaginary equipment to explain a cache or queue, make the analogy clear.

Source: https://github.com/wheresryan22/anatomy
