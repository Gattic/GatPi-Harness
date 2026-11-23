# Video Sequencer editing field guide

Provenance: adapted from `skills/blender-video-editing/SKILL.md` of [EL4CTEO/blender-skills](https://github.com/EL4CTEO/blender-skills) at commit `1a1cc6c` (MIT, Copyright (c) 2026 EL4CTEO; notice in `../THIRD_PARTY_NOTICES.md`). The motion-tracking sections moved to `camera-tracking-matchmove/references/motion-tracking-guide.md`. Skill names and links were remapped to this pack; `scripts/` and `assets/` paths are relative to this skill's directory. Upstream targets Blender 5.2 LTS+ and verified its scripts on 5.3: read `procedural-3d-blender/references/version-compatibility.md` before relying on a 5.2+ API on an older build.

The execution model is in `procedural-3d-blender`. Rendering the 3D shots and the compositor (5.0 API) are in `lighting-render-optimization`.

## One call each
```
scripts/vse_edit.py -- --clips //renders/sh010/ //renders/sh020/ //logo.png --crossfade 12 --title "Project" --audio //music.wav --out //edit.mp4 --render
scripts/vse_edit.py -- --clips a.mp4 b.mp4 c.mp4 --crossfade 0 --fps 24 --out //review/f_#### --render   # hard cuts to PNG
```

## vse_edit.py
- Builds into its own `Edit` scene (`--scene`), so 3D scenes stay untouched. Clips go on alternating channels 1/2, crossfades (`CROSS`) on 3, the title on 4, clip audio on 6/7 (movies get their sound strip), and music on 8 (trimmed to the edit with a `--audio-fade` volume fade-out).
- A clip may be a movie, a still (`--still-seconds`), a folder of frames, or a `####` pattern. Each crossfade overlaps the previous clip by `--crossfade` frames, so the edit gets shorter by that much per cut. Re-running replaces the previous edit.
- Sets **view transform Standard**: footage must pass through untouched (measured: AgX turned pure red into 0.86/0.23/0.13). Grade on purpose with strip modifiers instead.
- Output: `.mp4/.mov/.mkv` = H.264 (CRF high, preset good) + AAC 192k stereo. Any other path = PNG frames. 5.0+ needs `image_settings.media_type = "VIDEO"` **before** `file_format = "FFMPEG"`. It reports the file size, and the test decodes it back (frame count, size).

## Editing rules pros follow
- **Match the frame rate first** (`--fps` = the footage/render rate). Mixed rates drift audio. Re-render or retime (`SPEED` effect) instead.
- Heavy footage: build proxies (`strip.use_proxy = True`, 25/50%, `sequencer.rebuild_proxy`). 5.2 builds only proxies (no `.blen_tc` timecode files anymore).
- Per-strip color: `strip.colorspace_settings.name` (sRGB for 8-bit video, Linear Rec.709 for EXR renders). A dedicated edit scene keeps 3D color settings out of the edit.
- 5.2 API: `strips.new_movie(..., stream=N)` / `new_sound(stream=N)` pick a stream from multi-track files. `strip.connections` lists connected strips. New effect type `COMPOSITOR` (a node-tree effect). Text strips have Subtitles / Main Title / Corner Title presets in the UI. Timing uses `left_handle`/`right_handle`/`duration` (5.1 names). Strip keyframes live on the **scene's** action.
- 5.3: overlap mode `EXPAND` → `RIPPLE` (`tool_settings.sequencer_tool_settings.overlap_mode`). Strips are no longer clamped to their content by default (`preferences.edit.clamp_strips_by_default`). Scene strips follow their scene's frame range. OpenTimelineIO: `wm.otio_import` / `wm.otio_export`.

## Gotchas
- `bpy.ops.render.render(animation=True)` renders the sequencer only when `scene.render.use_sequencer` is on and the strips are in the **scene being rendered**. The script renders its own edit scene.
- Removing a clip also removes its effect strips. Collect names before deleting in loops.
- Image sequences must be contiguous. Missing frames show as black.
