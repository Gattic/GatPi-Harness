# Isometric geometry audit evidence ladder

1. **Static source**: syntax, viewBox, units, transforms, ID uniqueness, external references.
2. **Projection**: consistent azimuth/elevation and world-to-screen transform; test projected anchor points.
3. **2D bounds**: intersections are only possible overlap flags. They cannot prove 3D collisions.
4. **3D shapes**: use exact shape/mesh intersection and clearance methods when available; sample temporal extrema, not just regular frame intervals.
5. **Painter order**: where surfaces intersect in projection, ensure the actual nearer surface draws over the farther one; split geometry for interleaved assemblies.
6. **Line quality**: identify abrupt, unanchored terminals, clipped strokes, disconnected pipe ends and visible curves at 4x.
7. **Motion**: sample idle, controls, hover, apart and partial explode sequences; test both themes, WebGL fallback and reduced motion.
8. **Report**: each finding has part ID, world coordinates, screenshot, pose/time, risk, reproduction and patch.

Zero detected potential overlaps in axis-aligned screen bounds is not a proof that a complex mechanism has correct geometry. Some overlaps are physically necessary.
