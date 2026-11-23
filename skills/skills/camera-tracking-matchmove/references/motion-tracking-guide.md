# Motion tracking field guide

Provenance: adapted from `skills/blender-video-editing/SKILL.md` of [EL4CTEO/blender-skills](https://github.com/EL4CTEO/blender-skills) at commit `1a1cc6c` (MIT, Copyright (c) 2026 EL4CTEO; notice in `../THIRD_PARTY_NOTICES.md`). Only the motion-tracking sections are kept here; the Video Sequencer sections live in `blender-cinematic-video-pipeline/references/vse-editing-guide.md`. Skill names and links were remapped to this pack; `scripts/` and `assets/` paths are relative to this skill's directory. Upstream targets Blender 5.2 LTS+ and verified its scripts on 5.3: read `procedural-3d-blender/references/version-compatibility.md` before relying on a 5.2+ API on an older build.

The execution model is in `procedural-3d-blender`. Rendering and compositing the tracked shot are in `lighting-render-optimization`.

## One call
```python
import track_camera; print(track_camera.run(clip="C:/shots/sh010.mp4", focal=35, sensor=36))  # live/MCP only
```

## Motion tracking (track_camera.py, live session)
- The Clip Editor operators need a window, so this borrows the largest area, runs, and restores it. In `-b` it raises. It detects features at the first and last frame, tracks both ways, deletes tracks shorter than `min_frames`, solves (auto keyframes, refines focal only if unknown), deletes tracks above `max_error` px and re-solves, then runs `setup_tracking_scene` (camera + Camera Solver constraint, background footage, frame range).
- Measured on a synthetic 40-frame dolly at 960×540: 56 tracks, **0.19 px** solve error, 35 mm focal kept exactly. Quality bar: < 0.3 px great, < 0.5 good, > 1 px slides.
- Give `focal`/`sensor` whenever known. The solver is far more stable than when refining the focal. Set the sensor before the focal (focal is stored in px).
- Nodal pans (camera only rotates): `tripod=True`. A normal solve fails without parallax.
- Orient the scene after solving (UI, Clip Editor context): select 3 floor tracks → `clip.set_plane(plane="FLOOR")`, 1 track → `clip.set_origin()`, 2 tracks a known distance apart → `clip.set_scale(distance=…)`. Otherwise scale and up are arbitrary.
- Other jobs: screen/sign replacement → `clip.create_plane_track()` on 4+ tracks of a planar surface. Shaky footage → 2D stabilization (`tracking.stabilization.use_2d_stabilization`, add tracks). Points for modeling → `clip.bundles_to_mesh()`.

## Shooting/footage tips that make solves work
Fast shutter (little motion blur), real parallax (move the camera, don't just pan), textured static surfaces at several depths, no rolling-shutter whip pans, and a lens grid shot to calibrate distortion when using wide lenses.
