# Shared world projection and shader integration

A single module owns camera azimuth, elevation, orthographic scale, viewport, device-pixel ratio and animation clock. Convert both SVG shapes and WebGL fragments from common world-space anchors, not manually measured screen coordinates.

For effects that cross between back and front structures, use correct masks/stencil/depth compositing; test before/after resizing and at motion extrema. Capture a fallback with WebGL disabled and ensure core meaning and input still work. Test color management and shader discontinuities in both light/dark themes; a single beautiful keyframe is insufficient.

Source: https://github.com/wheresryan22/anatomy
