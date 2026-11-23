# Extension development field guide

Provenance: adapted from `skills/blender-addon-development/SKILL.md` of [EL4CTEO/blender-skills](https://github.com/EL4CTEO/blender-skills) at commit `1a1cc6c` (MIT, Copyright (c) 2026 EL4CTEO; notice in `../THIRD_PARTY_NOTICES.md`). Skill names and links were remapped to this pack; `scripts/` and `assets/` paths are relative to this skill's directory. Upstream targets Blender 5.2 LTS+ and verified its scripts on 5.3: read `procedural-3d-blender/references/version-compatibility.md` before relying on a 5.2+ API on an older build.

The execution model is in `procedural-3d-blender`. Start from `assets/addon_template/` (validated, built, and registered in CI): `blender_manifest.toml`, `__init__.py`, `operators.py`, `ui.py`.

## Procedure
1. Copy the template, then set `id` (lowercase_underscores, permanent), `name`, `tagline` (no trailing period, ≤ 64 chars), `maintainer`, `version` (semver), `license` (SPDX, GPL-3.0-or-later for code using bpy), and `blender_version_min = "4.2.0"` or higher if you use newer APIs (e.g. `"5.2.0"` for the GN `properties.inputs` API).
2. Write classes with the prefix convention `MYTOOL_OT_x` (operator), `_PT_` (panel), `_MT_` (menu), `_PG_` (property group), `_AP_` (preferences), `_UL_` (UI list). `bl_idname` for operators is `my_tool.verb_noun`.
3. Validate and build:
   ```
   blender --command extension validate ./my_tool
   blender --command extension build --source-dir ./my_tool --output-dir ./dist
   blender --command extension install-file -r user_default -e ./dist/my_tool-1.0.0.zip
   ```
4. Test headless: register the package in-process, call operators with `temp_override`, and assert on data (see `tests/test_addon.py` in this repo).

## Rules (extension-era, 5.x)
- **Relative imports only** (`from . import ops`). The package name is decided by Blender, so preferences use `bl_idname = __package__`.
- No `bl_info` (it's ignored for extensions). Everything goes in the manifest.
- **No network or file access at import/register time.** Declare `[permissions]` (`files`, `network`, `clipboard`, `camera`, `microphone`) with a reason. Check `bpy.app.online_access` before any network call.
- **Third-party Python packages**: ship `.whl` files in `./wheels/` and list them under `wheels = [...]`. Never `pip install` at runtime. Platform-specific wheels require `platforms = [...]`.
- **Properties (5.0+)**: `bpy.props` values are attributes, not dict entries (`scene["my_prop"]` no longer reaches them). For read-only props use `options={'READ_ONLY'}`. `get_transform`/`set_transform` adapt values while keeping storage. Register with `PointerProperty(type=PG)` on an ID type, and `del` it on unregister.
- **Operators**: `bl_options={"REGISTER","UNDO"}` for undo plus a redo panel. `poll()` guards the context. Return `{"FINISHED"}`/`{"CANCELLED"}`. `self.report({"WARNING"}, msg)` for user feedback. Don't call other operators in loops if a data API exists.
- **UI**: `layout.use_property_split = True` gives modern alignment. Panels in the N-panel use `bl_region_type="UI"` + `bl_category`. Append menu entries with `VIEW3D_MT_*.append(func)` and remove them on unregister.
- **Unregister** everything in reverse order (classes, props, menus, handlers, timers, keymaps, draw handlers). Leaks break reloading.
- **Drawing** (overlays): `gpu` module + `gpu_extras.batch`. `bgl` was removed in 5.0. Textures come from `gpu.texture.from_image(img)`. For scene-linear images use `draw_texture_2d(..., is_scene_linear_with_rec709_srgb_target=True)`.
- **Long tasks**: a modal operator with a timer (`wm.event_timer_add`), or `bpy.app.timers.register` with chunked work. Never block the UI for seconds.
- **Handlers**: decorate persistent ones with `@bpy.app.handlers.persistent`. Keep them cheap (they run every frame/depsgraph update).
- **Keymaps**: add them to `wm.keyconfigs.addon`, store `(km, kmi)` pairs, and remove them on unregister.
- **Translations / i18n**: `bpy.app.translations.register(__package__, dict)`.

## Publishing (extensions.blender.org)
The Blender ID account uploads the built zip. Requirements: a valid manifest, a GPL-compatible license, no obfuscated code, no bundled binaries without source, and permissions declared. Screenshots/README go on the website listing. Update with a higher `version`.

## Gotchas
- `context.scene` inside a draw function can be `None` in some editors. Guard it.
- Storing Blender data references (`bpy.types.ID`) in Python globals crashes after undo or file load. Store names or `session_uid`, and look them up again.
- `bpy.utils.register_class` fails if annotations use `=` instead of `:` for properties.
- 5.0 made several bundled modules private (`rna_info`, `bl_ui_utils`...). Don't import them.
- 5.1 no longer loads the user site-packages by default. Bundle wheels instead of relying on user installs.
- 5.2: `PreferencesFilePaths.active_asset_library` indices are offset (the "All"/"Essentials" entries come first). `UILayout.template_palette(color=)` is removed. New: `UILayout.link`, `UILayout.textbox`, `bpy.data.all_ids`, `Window.screenshot`.
- 5.3: `bpy.data.all_ids` order is an implementation detail. New: `UILayout.label_multiline()`, `auto_keymap=` on `invoke_popup`/`popover`, `window_manager.undo_stack` (read-only), `constraints.new(type, name=)`, `KDTree(n, dimensions=2)`, `gpu.types.GPUStorageBuf`, and bundled `OpenEXR`/`opentimelineio` modules. Vulkan is the default GPU backend on Windows/Linux, so test `gpu` drawing there.
