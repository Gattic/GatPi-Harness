# Blender version compatibility for the bundled guides and scripts

The Blender guides and scripts in this pack come from EL4CTEO/blender-skills, which targets
**Blender 5.2 LTS+** and verified its scripts on **5.3**. This pack re-ran them on **Blender 5.1.2**
(build `ec6e62d40fa9`, Python 3.13.9, Linux x64, `--factory-startup`, background mode except the
tracking test) and patched what failed there. Nothing here was run on 5.2 or 5.3 by this pack.

Always record `bpy.app.version_string` first (`scripts/env_report.py`), then read the matching column.

## Status vocabulary

| Label | Meaning |
|---|---|
| **Measured 5.1.2** | Observed in this pack's run on the build above |
| **Upstream 5.2 / 5.3** | Stated and tested upstream on that version; not re-run here |

A row that is only "Upstream" is **NOT TESTED** by this pack. Report it that way.

## Bundled test suite on 5.1.2

`tests/blender/run_all.py`: 80 tests (79 from upstream, 1 for this pack's own demo script),
**79 passed, 0 failed, 1 skipped**. The skip is `test_simulation::test_gn_cloth_52_asset` (the
node-based Cloth Dynamics asset file is not shipped before 5.2). Unmodified upstream scripts scored
68 passed / 11 failed of 79 on the same build; the differences are the compatibility changes below.

## What differs before 5.2 (Measured 5.1.2)

| Area | 5.2+ (Upstream) | 5.1.2 (Measured) | How the bundled scripts handle it |
|---|---|---|---|
| Geometry Nodes modifier inputs | `mod.properties.inputs.<id>.value`, `.type = "ATTRIBUTE"`, `.attribute_name` | `NodesModifier` has no `properties`; inputs are ID properties: `mod["Socket_2"]`, `mod["Socket_2_use_attribute"]`, `mod["Socket_2_attribute_name"]` | `set_gn_input()` in `scripts/_bpyx.py` uses whichever exists. Used by `gn_builder.py`, `scatter.py`, `groom.py`, `sim_setup.py`, `precipitation.py`, `surface_weather.py` |
| Menu (enum) modifier inputs | assign the item name | stored as the item's integer | `set_gn_input()` maps the name through `id_properties_ui(...)["items"]` |
| Assigning an int to a float input | accepted | retypes the ID property | `set_gn_input()` casts to the existing type |
| glTF meshopt compression | `export_meshopt_compression_enable` | keyword unrecognized by the exporter | `export_asset.py` drops preset options the exporter does not declare and returns them in `omitted_options` plus a warning. The `web` preset on 5.1.2 writes WebP textures without meshopt |
| Node-based dynamics | `geometry_nodes_dynamics_assets.blend` (Cloth Dynamics, Hair Dynamics, Collider) | file not shipped; `GeometryNodeXPBDSolver` absent | `sim_setup.py --gn-cloth` raises a clear error. Use classic cloth |
| Hair node assets | surface read from the Curves object; Add Empty Hair adds Capture Rest Geometry and Hair Dynamics | Generate Hair Curves yields 0 curves unless its `Surface` object input is set; Add Empty Hair adds a `Surface Deform` modifier and no dynamics | `groom.py` passes the surface explicitly before 5.2. The returned `modifiers` list differs by version |
| `gpu` in background | call `gpu.init()` first | `gpu.init` does not exist | do not call it before 5.2 |

## Present or absent on 5.1.2 (Measured)

Present: slotted actions (no `action.fcurves`), `scene.compositing_node_group` (no `scene.node_tree`),
new materials already have a node tree, `image_settings.media_type`, engine id `BLENDER_EEVEE`,
Boolean solvers `FLOAT`/`EXACT`/`MANIFOLD`, `brush.sculpt_brush_type` and `brush.stroke_method`,
sky types `SINGLE_SCATTERING`/`MULTIPLE_SCATTERING`/`PREETHAM`/`HOSEK_WILKIE`, Principled
`Diffuse Roughness` and `Thin Film Thickness`, Repeat / For Each Element zones, closures and bundles,
SDF grid nodes, `GeometryNodeFieldToList`, glTF `export_gpu_instances`, `wm.collection_export_all`,
and the `imbuf` module (`new`, `load`, `load_from_buffer`, `write`).

Absent (so the guides' 5.2 notes apply): `bpy.data.all_ids`, Principled `Thin Wall`,
`render.use_texture_cache`, `brush.mesh_automasking_settings` (the older `use_automasking_*`
properties are still there).

Absent (so the guides' 5.3 notes apply): `scene.compositor_effects`, `mesh.primitive_quad_sphere_add`,
built-in LoopTools operators (`mesh.relax_edge_loops`, `mesh.space_edge_loops_evenly`),
`anim.rotation_mode_convert`, `constraints.new(type, name=)`, `KDTree(n, dimensions=2)`,
`UILayout.label_multiline`, `wm.otio_import`, `wm.spz_import`, Principled
`Transmission Dispersion Scale`, glTF `export_image_add_compressed_images`, `collection_center_mode`
and `export_pointclouds`. On 5.1.2 the glTF exporter still uses `export_image_add_webp`,
`export_image_webp_fallback` and `at_collection_center`, and the sequencer overlap modes are
`EXPAND`/`OVERWRITE`/`SHUFFLE`.

One correction to the bundled texturing reference: `imbuf` is not new in 5.2. Only the additions it
lists (`with_buffer`, `quality`/`compress`) are unverified here.

## Tool names used by the guides

The guides were written for upstream's Blender MCP server and name its tools: `look` (viewport
capture with `mode="angles"` or `mode="frames"`), `execute_blender_code`, `generate_3d`,
`import_asset`, `search_assets` and `world_bounding_box`. Use whatever the running host exposes
and never assume a tool exists:

- Pi harness Blender MCP: `mcp__blender__execute_blender_code`, `mcp__blender__get_objects_summary`,
  `mcp__blender__get_object_detail_summary`, `mcp__blender__render_viewport_to_path` and
  `mcp__blender__render_thumbnail_to_path`. There is no `look`, `generate_3d` or asset-search tool.
- No MCP server: run scripts headless with `scripts/run_in_blender.py`, and replace every `look`
  step with `3d-asset-quality-gate/scripts/review_shots.py`, then open the image it returns.

## Rules for agents

1. Guard version-specific calls: `hasattr(mod, "properties")`, `"Thin Wall" in node.inputs`,
   `op.get_rna_type().properties.keys()`. Feature checks beat version comparisons.
2. Every other row marked (5.2) or listed under "5.3 changes" in `api-changes-5x.md` is
   **Upstream** only. Probe it on the running build before relying on it.
3. Engine-side behavior (Unreal, Unity, Godot, Roblox, three.js) described in any guide was not
   exercised by this pack on any Blender version.
4. To re-run the suite on another build:
   `blender -b --factory-startup --python-exit-code 1 -P tests/blender/run_all.py`
   from the pack root, then update this file with the measured result.
