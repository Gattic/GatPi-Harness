# Pipeline automation field guide

Provenance: adapted from `skills/blender-pipeline-automation/SKILL.md` of [EL4CTEO/blender-skills](https://github.com/EL4CTEO/blender-skills) at commit `1a1cc6c` (MIT, Copyright (c) 2026 EL4CTEO; notice in `../THIRD_PARTY_NOTICES.md`). Skill names and links were remapped to this pack; `scripts/` and `assets/` paths are relative to this skill's directory. Upstream targets Blender 5.2 LTS+ and verified its scripts on 5.3: read `version-compatibility.md` before relying on a 5.2+ API on an older build.

The execution model is in `procedural-3d-blender` (`run_in_blender.py` finds Blender and prints only the JSON results).

## Batch one-liners
```
blender -b -P scripts/batch_process.py -- --in "assets/**/*.fbx" --op convert --to glb --out export/
blender -b -P scripts/batch_process.py -- --in library/ --op report                      # inventory JSON lines
blender -b -P scripts/batch_process.py -- --in "src/*.blend" --op script \
    --script ../3d-asset-quality-gate/scripts/qa_check.py --kwargs '{"profile":"game"}'       # QA a whole library
blender -b -P scripts/batch_process.py -- --in src/ --op script --script ../realtime-asset-optimization/scripts/make_lods.py \
    --kwargs '{"rename":true}' --save-to processed/                                      # LODs for every file
```
Each file is streamed as one JSON line with `ok`, timing and results. Failures don't stop the batch, and the summary lists them. **Parallel**: start N processes with `--shard 0/N` … `--shard N-1/N` (Blender uses one core for Python, so processes scale with CPU/GPU count).

## Headless CLI essentials
| Flag | Meaning |
|---|---|
| `-b` | background, no UI. Put it **first** |
| `file.blend` | open before running scripts. Order matters: args run left to right |
| `-P script.py` / `--python-expr "..."` | run Python |
| `--python-exit-code 1` | non-zero exit if the script raises (CI) |
| `--factory-startup` | ignore user prefs/add-ons (reproducible). Bundled add-ons still load |
| `--addons rigify,io_scene_fbx` | enable specific add-ons |
| `-E CYCLES -o //out/#### -F PNG -s 1 -e 10 -a` / `-f 5` | render (`lighting-render-optimization`) |
| `--command extension build/validate/install-file` | extension tooling (`blender-extension-development`) |
| `-- --my args` | everything after `--` goes to the script (`sys.argv[sys.argv.index("--")+1:]`) |
| `--log "*"`, `--debug-python` | debugging. 5.0 changed the log format, so don't regex progress lines |
Environment variables: `BLENDER_USER_SCRIPTS`, `BLENDER_USER_EXTENSIONS`, `BLENDER_SYSTEM_PYTHON`. Use `OCIO` for custom color configs.

## bpy as a Python module
`pip install bpy==5.3.*` (or `5.2.*` for the LTS) (Python 3.13, matching the Blender release) gives `import bpy` in plain Python, which is handy for pytest/CI/web services. It has no UI and no GPU module by default, and it's large (~300 MB). Version-lock it with the Blender you target. The `bpy` wheel and the CLI behave the same for data API work.

## Library patterns
- **Append/link**: `bpy.data.libraries.load(path, link=...)` (see `procedural-3d-blender/references/bpy-patterns.md`). 5.2: `data_from.libraries` exposes nested library paths when loading.
- **Write a subset**: `bpy.data.libraries.write(path, {datablocks}, fake_user=True, path_remap="RELATIVE_ALL")` builds asset/library files from a session.
- **Find files**: `bpy.data.file_path_foreach(...)` (5.2 flags: `EXPAND_TOKENS` for UDIMs, `EXPAND_SEQUENCES`, `EXPAND_CACHES`), and `bpy.utils.blend_paths(absolute=True)` lists every external path.
- **Remap/relocate**: `bpy.ops.file.find_missing_files(directory=...)`, `make_paths_relative`, `pack_all`. Libraries: `lib.filepath = new; lib.reload()`.
- **Iterate every ID**: `bpy.data.all_ids` (5.2; order isn't stable in 5.3, so sort by name if output must be deterministic), and `bpy.data.orphans_purge(do_recursive=True)` for cleanup.

## Robustness rules
- One task per process where possible. Long Blender sessions leak (images, undo). `batch_process.py` reuses the process but resets with `read_factory_settings(use_empty=True)` / `open_mainfile`.
- Never write into the source folder by default. Use separate `--out`/`--save-to`, and write with `copy=True`.
- Make scripts idempotent: re-running replaces their own outputs (named prefixes, `exist_ok`).
- Log JSON, not prose: one object per file/job, so agents and CI can parse it cheaply.
- Pin the Blender version (5.2 LTS, or 5.3) for a project. Record `bpy.app.version_string` + hash (`bpy.app.build_hash`) in the outputs.
- Paths: `bpy.path.abspath("//x")` is relative to the **opened** .blend. In headless batches use absolute paths, or set them after `open_mainfile`.
- GPU in containers: Cycles CUDA/OptiX needs the NVIDIA container runtime. Otherwise use CPU. EEVEE needs a GPU/EGL even headless.

## CI recipe (GitHub Actions)
Download the Linux tarball (`https://download.blender.org/release/Blender5.3/blender-5.3.0-linux-x64.tar.xz`), cache it, then `blender -b --factory-startup --python-exit-code 1 -P tests/run_all.py`. This repo's `.github/workflows/ci.yml` is a working example.
