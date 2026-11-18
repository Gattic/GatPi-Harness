# Motion choreography critique rubric

Score each dimension 0=fail, 1=incomplete, 2=acceptable and annotate an exact time or code location.

- Functional clarity: user recognizes the state and outcome without waiting for decoration.
- Attention hierarchy: the primary subject dominates; secondary motion is causal; ambient motion is optional.
- Timing: response is immediate, transitions finish promptly, stagger has a bounded budget.
- Continuity: path and easing remain consistent; interruptions, reversals and loops have no jumps.
- Platform: touch/keyboard and narrow screens do not hide information.
- Accessibility: reduced motion conveys the same semantics.
- Performance: measured frame time, layout reflow and CPU/GPU usage for target hardware.

Never substitute a heuristic duration for an observed usability finding.
