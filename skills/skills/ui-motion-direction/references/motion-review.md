# Functional motion review contract

1. Specify purpose for each transition: feedback, spatial orientation, change of state or nonessential decoration.
2. Encode states and events: `idle`, `pending`, `success`, `error`, `disabled`; interrupts must not leave ghost pending states.
3. Choreography: primary action first; supporting elements explain consequences. Multiple moving elements are not inherently better.
4. Set brand tokens: quick/standard/expressive durations, easing families and spatial direction. Heuristics like 80–120 ms for micro-feedback or 300–400 ms for dialogs are **starting hypotheses**; measure on actual devices.
5. A11y: `prefers-reduced-motion` must preserve meaning; never communicate errors only by shakes or color. Correct keyboard and focus transitions are required.
6. Visual QA: normal and quarter-speed recording, fast repeated input, interruptions/reversals, mobile width, keyboard, reduced motion; report artifacts tested.
7. Engineering QA: prevent layout thrashing, stale timers and automatic perpetual animations in background/offscreen contexts.

Upstream inspiration: https://github.com/LottieFiles/motion-design-skill
