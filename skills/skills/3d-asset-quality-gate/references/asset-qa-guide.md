# Asset QA field guide

Provenance: adapted from `skills/blender-asset-qa/SKILL.md` of [EL4CTEO/blender-skills](https://github.com/EL4CTEO/blender-skills) at commit `1a1cc6c` (MIT, Copyright (c) 2026 EL4CTEO; notice in `../THIRD_PARTY_NOTICES.md`). Skill names and links were remapped to this pack; `scripts/` and `assets/` paths are relative to this skill's directory. Upstream targets Blender 5.2 LTS+ and verified its scripts on 5.3: read `procedural-3d-blender/references/version-compatibility.md` before relying on a 5.2+ API on an older build.

Never assume a generated or edited mesh is correct. Check it with numbers, then look at it.

## Procedure
1. **Automated check**, passing one asset's objects together:
   `scripts/qa_check.py -- --objects Body Head Hat --profile game`
   Profiles: `game` (default), `render` (lenient), `print` (watertight required), `roblox` (20k tris/mesh, watertight, no n-gons, ≤4 influences).
2. **Fix every `errors` entry** (table below), then re-run until `"pass": true`. Each warning must be either fixed or explicitly accepted, with the reason reported to the user.
3. **Visual check, always**:
   - Live: MCP `look` with `mode="angles"` on the targets, once in `material`/`solid` shading and once in `wireframe`. Use `xray` for internals.
   - Headless: `scripts/review_shots.py -- --objects ... --mode random` (one color per object, which makes detached pieces obvious), then `--mode wire` for topology. Open the returned PNG.
4. Report: tris per object, issues fixed, and remaining accepted warnings.

## What each finding means → fix
| Finding | Cause | Fix |
|---|---|---|
| `zfighting` A<->B | two surfaces facing the same way within `--eps` (1 mm) that overlap | delete the hidden duplicate, or offset ≥ 2–5 mm along the normal, or boolean/merge them |
| `back_to_back` | faces touching with opposite normals (boxes glued face-to-face) | delete the hidden faces (wasted tris, bake artifacts) |
| `floating` | island/object not touching any other part within `--tol` | move it to make contact (snap), bridge it, or join and merge. If floating is intended (sparks, UI), check it separately |
| `enclosed` | part fully inside another, not touching (eyes, internal mechanics) | usually fine. Confirm it's intended |
| `inside_out_islands` | closed part with normals pointing in | `mesh.normals_make_consistent(inside=False)` on that part |
| `inconsistent_normals_edges` | neighbouring faces wound in opposite directions | recalc normals; if it persists, look for non-manifold seams |
| `nonmanifold_edges` / `wire_edges` | >2 faces per edge, or stray edges | dissolve/delete the extra faces; `delete_loose` |
| `boundary_edges` | open holes (bad for print/Roblox/bakes) | fill (`fill_holes`/`edge_face_add`) or cap |
| `degenerate_faces` / `zero_length_edges` | collapsed geometry | `dissolve_degenerate(threshold=1e-4)` |
| `duplicate_verts` | unwelded seams | `remove_doubles(threshold=1e-4)` (Merge by Distance); check UV seams after |
| `ngons` | faces with >4 sides | triangulate/quadrangulate locally; n-gons are fine only on flat hard-surface faces that never deform |
| unapplied/negative scale | object transform | `transform_apply(rotation=True, scale=True)`; negative scale flips normals on export |
| `uv_maps: 0` / zero-area UV / overlap | missing or bad unwrap | `retopology-uv-unwrap` |
| unweighted / >4 influences | skinning | `rigging-animation-retarget` (`rig_check.py`) |
| `ground_z` ≠ 0 | asset floats or sinks | move the origin to the bottom and set z = 0 (props) |
| faces on empty/missing slot | material removed or index out of range | assign a material; engines show grey/magenta |
| `feeds [...] but is sRGB` | normal/roughness/metal/AO map tagged as color | `image.colorspace_settings.is_data = True` (Non-Color) |
| missing texture file | broken path, unpacked | relink (`procedural-3d-blender` path cleanup) or pack |
| unused slot / Non-Color base color | leftovers, wrong tag | remove the slot; base color and emission are sRGB |

## Manual checks the script can't fully judge
- **Silhouette and proportions** at the target camera distance. Compare with references and real-world size (`ob.dimensions`).
- **Shading artifacts**: smoothing on hard edges (needs sharp edges/weighted normals), and pinching at poles on curved surfaces.
- **Intersections that look wrong** (a leg clipping a seat), even though they're "attached".
- **Interior/hidden geometry** that wastes tris (use `xray`).
- **Deformation**: pose the rig at extremes (elbow 140°, knee 150°, shoulder raised) and look for collapsing volume.
- **Material assignment**: slots and color spaces are checked automatically. Still look at whether each part got the *intended* material.

## Tuning
- `--eps` is the z-fight distance. Raise it to 0.005 for large environment scenes, and lower it to 0.0002 for tiny jewelry.
- `--tol` is the contact tolerance for detached parts. Raise it for chunky kitbash.
- `--no-modifiers` checks the base mesh. By default the evaluated (modifier) result is checked, which is what gets exported.
- Above `--max-tris` (300k), the z-fight and floating checks are skipped. Check high-poly sources per part instead.
