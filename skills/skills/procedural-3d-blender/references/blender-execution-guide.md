# Blender execution and API field guide

Provenance: adapted from `skills/blender-core/SKILL.md` of [EL4CTEO/blender-skills](https://github.com/EL4CTEO/blender-skills) at commit `1a1cc6c` (MIT, Copyright (c) 2026 EL4CTEO; notice in `../THIRD_PARTY_NOTICES.md`). Skill names and links were remapped to this pack; `scripts/` and `assets/` paths are relative to this skill's directory. Upstream targets Blender 5.2 LTS+ and verified its scripts on 5.3: read `version-compatibility.md` before relying on a 5.2+ API on an older build.

## Route to the owning skill
This skill owns running Blender, the bpy API rules, scene hygiene, Geometry Nodes and batch automation. Hand the deliverable itself to its owner:
| Deliverable | Skill |
|---|---|
| Units, collections, naming, linking, asset libraries; Geometry Nodes; batch/headless pipelines and file conversion | `procedural-3d-blender` (this skill) |
| Hard-surface modeling, bevels, booleans, normals; sculpting, multires, remesh | `3d-modeling-topology` |
| Retopology, UV unwrap, texel density | `retopology-uv-unwrap` |
| PBR materials, color spaces, texture sets; wear, grime, decals, trim sheets, texture painting | `pbr-material-lookdev` |
| Baking high→low maps (normal, AO, curvature, ...) and procedural-to-texture bakes | `texture-map-baking` |
| Body rigging, Rigify, weight painting; keyframes, actions, NLA, mocap retarget, loops, root motion | `rigging-animation-retarget` |
| Face rig, shape keys, ARKit, visemes | `facial-blendshape-rigging` |
| Garments, layered clothing, body poke-through | `character-garment-fitting` |
| Hair, fur, grooming, hair cards | `hair-groom-cards` |
| Poly budgets, LODs, draw calls, cleanup | `realtime-asset-optimization` |
| Export: glTF/FBX/USD to Roblox, Unity, Unreal, Godot, web | `game-engine-asset-export` |
| Cycles/EEVEE settings, compositor, batch render; lighting, HDRI, camera, turntable | `lighting-render-optimization` |
| Time of day, night, fog, mood; rain, snow, wet surfaces, puddles, lightning | `atmosphere-weather-lighting` |
| Toon/cel/anime shading, outlines, Line Art, Grease Pencil | `stylized-npr-rendering` |
| Terrain, biome scatter, modular kits | `environment-terrain-scatter` |
| Cloth, rigid body, fluids, GN physics | `physics-simulation-baking` |
| Gears, linkages, cams and other constrained mechanisms | `mechanical-animation-kinematics` |
| Rendered Blender movie, Video Sequencer edit | `blender-cinematic-video-pipeline` |
| Motion tracking, camera solve from footage | `camera-tracking-matchmove` |
| Writing add-ons / extensions | `blender-extension-development` |
| Checking a mesh/asset before delivery (always) | `3d-asset-quality-gate` |
| End-to-end playbooks (prop, character, Roblox, product shot) | `task-skill-router` (`references/3d-asset-playbooks.md`) |

## Execute
**Live (blender-mcp `execute_blender_code`)**: work in small steps and print only what you need. To call a skill script, import it:
```python
import sys, importlib; sys.path.insert(0, r"<skills_dir>/3d-asset-quality-gate/scripts")
import qa_check; importlib.reload(qa_check); print(qa_check.run(objects=["Chair"]))
```
Each MCP call runs in a **fresh namespace**: re-`import` in every call. That's cheap because modules stay cached in `sys.modules`. `reload` only after editing a script.
**Headless (any agent with a shell)**: this prints only the script's JSON (`@@JSON@@` lines):
```
python <skills_dir>/procedural-3d-blender/scripts/run_in_blender.py --blend in.blend <script.py> -- --objects Chair --save out.blend
python <skills_dir>/procedural-3d-blender/scripts/run_in_blender.py --expr "import bpy; print(len(bpy.data.objects))"
```
**Windows + Git Bash**: MSYS rewrites `//out.png` to `/out.png` (→ `C:\out.png`). Prefix with `MSYS_NO_PATHCONV=1` and pass skill paths as `$(cygpath -m ~/.claude/skills)/...` (or use PowerShell).
Raw form: `blender -b in.blend --factory-startup --python-exit-code 1 -P x.py -- args`. Every script here exposes `run(**kw) -> dict` and the same flags after `--`.
**First call in a session**: `scripts/env_report.py`, which returns the version, engines, GPU, add-ons, units, color management and scene counts.

## Rules
- **Data API over operators**: use `bpy.data`, `bmesh`, `mesh.attributes`, and `foreach_get/set` with numpy. Operators depend on context and selection, and many need a 3D View, which background mode doesn't have.
- If an operator is unavoidable: `with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob], selected_editable_objects=[ob]): bpy.ops...`. Check that the result is `{'FINISHED'}`.
- **Edit mode isolation**: `ob.data` isn't updated while in Edit Mode. Use `bmesh.from_edit_mesh` + `bmesh.update_edit_mesh`, or switch to OBJECT mode before reading.
- **Nodes**: find them by `type` (`n.type == "BSDF_PRINCIPLED"`), never by `name`, because names are localized. Sockets by English name or `identifier` are fine.
- **Enums**: read the valid values with `[i.identifier for i in T.bl_rna.properties[p].enum_items]`. Dynamic enums (`render.engine`, `view_transform`, `look`) under-report, so assign them inside `try/except TypeError` (the message lists the valid values).
- **Engines**: `BLENDER_EEVEE`, `CYCLES`, `BLENDER_WORKBENCH`. Cycles device: `scene.cycles.device = "GPU"` + preferences `compute_device_type`.
- **Evaluated data**: use `ob.evaluated_get(depsgraph)`, then `.to_mesh()`, then always `.to_mesh_clear()`. Call `view_layer.update()` before reading `matrix_world` after a change.
- **Freed data**: applying or removing a modifier, or removing an object or ID, frees it. Collect names first (`[m.name for m in ob.modifiers]`) and never touch the old Python reference afterward, because it returns garbage or crashes.
- **Never trust default names** ("Cube.001"). Keep object references, rename explicitly, and look objects up via `bpy.data.objects[name]`.
- **Scale**: 1 unit = 1 m. Apply rotation/scale (`transform_apply`) before bevels, modifiers with distances, rigging, physics, baking and export.
- **Paths**: `bpy.path.abspath("//textures/x.png")` resolves relative to the .blend. Save explicitly; use `save_as_mainfile(filepath=..., copy=True)` for backups.
- **Live sessions are the user's work**: never `read_factory_settings`, never delete data you didn't create, and save a backup copy before destructive batch edits.
- **GPU module in background**: call `gpu.init()` first (5.2+). `bgl` no longer exists.
- **Big meshes**: no per-vertex `bpy.ops`. Use numpy `foreach_get` (see bpy-patterns.md).

## 5.x API changes that break old tutorials/LLM memory
`action.fcurves` → channelbags · `scene.node_tree` → `scene.compositing_node_group` · `material.use_nodes` is deprecated (new materials already have nodes) · `mod["Socket_2"]` → `mod.properties.inputs.Socket_2.value` (5.2) · `BLENDER_EEVEE_NEXT` → `BLENDER_EEVEE` · Boolean `FAST` → `FLOAT` · bone layers → bone collections · `bl_info` add-ons → extensions (`blender_manifest.toml`) · `bpy.props` values are no longer dict-accessible (`scene["cycles"]`) · 5.3: compositor effects stack, glTF WebP options → compressed-image options, VSE `EXPAND` → `RIPPLE`. Full table: [api-changes-5x.md](api-changes-5x.md).

## Verify (required before saying "done")
1. Numbers, not adjectives: report tris, objects, materials, dimensions (`ob.dimensions`) and the output files written.
2. Geometry changed → run `3d-asset-quality-gate` `qa_check.py` (z-fighting, detached parts, non-manifold, flipped normals, scale).
3. Look at it: MCP `look` (`mode="angles"`, shading `material`/`wireframe`). Headless: `3d-asset-quality-gate/scripts/review_shots.py` renders contact sheets.
4. Re-read your own output: confirm that exported files exist and that their size is non-zero.

## References
- [api-changes-5x.md](api-changes-5x.md): 4.x→5.3 migration table. Load it when code fails with AttributeError/KeyError.
- [bpy-patterns.md](bpy-patterns.md): verified snippets for bmesh, attributes, numpy, temp_override, depsgraph, drivers, append/link, handlers and timers.
