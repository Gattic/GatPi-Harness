# EL4CTEO/blender-skills — source review and integration record

Date: 2026-11-23. Scope: one upstream repository, reviewed from a complete clone and integrated
into this pack. Machine-readable file ledger: `research/blender-skills-provenance.json`.

## Source

| Field | Value |
|---|---|
| Repository | https://github.com/EL4CTEO/blender-skills |
| Revision | `1a1cc6c49312f9f370aae86f52b7b907f29c94f6` — "Release 1.3.3: edge-case fixes from stress testing (#15)", 2026-11-21 |
| License | MIT, Copyright (c) 2026 EL4CTEO (repository `LICENSE`) |
| Inspection | Shallow clone of that commit; every tracked file enumerated. Unlike the source-level reviews in `repository-review.md`, this one is exhaustive for the pinned commit |
| Stated target | Blender 5.2 LTS+, "verified on 5.3" |

Contents at that commit: 28 `SKILL.md` files, 15 reference documents, 42 scripts plus one shared
helper (`shared/_bpyx.py`, copied into each skill), one add-on template (4 files), 26 test modules
(79 test functions) with a fixture module and an in-Blender runner, four repository tools, two
installers, a Claude plugin manifest, a CI workflow, agent instruction files and comparison media.

## Trust handling

The repository was treated as untrusted data. Its `AGENTS.md`, `CLAUDE.md`, installers and plugin
manifests were read as documents and never followed or executed. Scripts were read before any was
run, and were then run only inside a pinned, locally installed Blender with `--factory-startup`.

Script review of `skills/*/scripts`, `shared/` and `tests/` (text search plus reading):

| Concern | Finding |
|---|---|
| Network access | None |
| `eval` / `exec` | None in skill scripts. `tests/test_core.py` executes the fenced Python blocks of the reference documents, which is the test's purpose |
| Process spawning | `run_in_blender.py` launches Blender. `tests/test_addon.py` runs Blender's `extension validate` and `extension build`; `tests/test_video.py` starts a windowed Blender for the tracking test |
| File deletion | None in skill scripts. `tests/test_addon.py` removes and recreates its own package copy under the test temp directory |
| Session reset | `batch_process.py` calls `open_mainfile` and `read_factory_settings`: it must run in its own background process (stated in `procedural-3d-blender`) |
| Preferences | Changed in the running session only; no script saves user preferences. `lightning.py` sets the keyframe interpolation preference to `LINEAR` while keying and restores it. `rigify_build.py` enables the bundled Rigify add-on non-persistently. `render_batch.py` and `bake_maps.py` set the Cycles compute device type and enable GPU devices to pick a render device. In a live session these stay in effect until Blender closes |
| Writes | Only to caller-supplied output paths (renders, bakes, exports, `--save`) and to data inside the open `.blend` |

Two side effects were observed when the upstream suite was run directly rather than through this
pack's wrapper: the windowed tracking test writes `quit.blend` to the system temp directory, and
Blender creates an empty `config` directory in the user's Blender profile. `tests/test_blender_bundle.py`
now points `TMPDIR` and `BLENDER_USER_RESOURCES` at a scratch directory, which was confirmed to
redirect both.

## Measured behavior on the harness-pinned Blender

Blender 5.1.2 (build `ec6e62d40fa9`, Python 3.13.9, Linux x64), one laptop, one run each.

| Tree | Passed | Failed | Skipped |
|---|---:|---:|---:|
| Upstream, unmodified | 68 | 11 | 0 |
| This pack (79 upstream tests plus 1 original) | 79 | 0 | 1 |

The eleven upstream failures had four causes, all version differences rather than defects in
upstream's stated target: the 5.2 Geometry Nodes modifier-input API (8 tests, of which the two
hair tests also needed the pre-5.2 surface input), the glTF meshopt exporter option (1), the 5.2
dynamics asset file (1) and one documentation snippet using the 5.2 API. The remaining skip is the node-based cloth test, which needs an asset file Blender ships only
from 5.2. Details and the fixes are in
`skills/procedural-3d-blender/references/version-compatibility.md`.

Not measured by this pack: anything on Blender 5.2 or 5.3, any engine import (Unreal, Unity, Godot,
Roblox, three.js), render quality, and upstream's published with/without-skills comparison. Numeric
tables in the references (light values, PBR values, platform budgets, Roblox limits) are upstream's
statements and are labeled as guidance in the skills that use them.

## Coverage decisions

The pack rule is one owner per deliverable and no broad duplicates, so upstream skills were merged
into existing owners where one existed and added only where the pack had a real gap.

| Upstream skill(s) | Pack skill | Decision |
|---|---|---|
| `blender-core`, `blender-scene-setup`, `blender-geometry-nodes`, `blender-pipeline-automation` | `procedural-3d-blender` | Existing skill revised to 2.0.0 |
| `blender-hardsurface-modeling`, `blender-sculpting` | `3d-modeling-topology` | Existing skill revised to 2.0.0 |
| `blender-pbr-materials`, `blender-texturing` | `pbr-material-lookdev` | Existing skill revised to 2.0.0 |
| `blender-rendering`, `blender-lighting-lookdev` | `lighting-render-optimization` | Existing skill revised to 2.0.0 |
| `blender-character-rigging`, `blender-animation` | `rigging-animation-retarget` | Existing skill revised to 2.0.0 |
| `blender-video-editing` (sequencer part) | `blender-cinematic-video-pipeline` | Existing skill revised to 1.1.0 |
| `blender-workflow-recipes` | `task-skill-router` | Playbooks added as a reference; revised to 1.3.0 |
| `blender-asset-qa` | `3d-asset-quality-gate` | New |
| `blender-retopology-uv` | `retopology-uv-unwrap` | New |
| `blender-texture-baking` | `texture-map-baking` | New |
| `blender-game-optimization` | `realtime-asset-optimization` | New |
| `blender-export-pipelines` | `game-engine-asset-export` | New |
| `blender-facial-shapekeys` | `facial-blendshape-rigging` | New |
| `blender-clothing` | `character-garment-fitting` | New |
| `blender-hair-grooming` | `hair-groom-cards` | New |
| `blender-stylized-npr` | `stylized-npr-rendering` | New |
| `blender-environment-kits` | `environment-terrain-scatter` | New |
| `blender-time-of-day`, `blender-weather-fx` | `atmosphere-weather-lighting` | New (one owner for atmosphere) |
| `blender-simulation` | `physics-simulation-baking` | New |
| `blender-addon-development` | `blender-extension-development` | New (engineering) |
| `blender-video-editing` (tracking part) | `camera-tracking-matchmove` | New |

## What was taken and how

- **Entrypoints are original.** Every `SKILL.md` is generated from this pack's `catalog.json`
  entry: activation boundary, staged workflow, proof boundaries, acceptance gate and failure
  handling were written for this pack. Upstream frontmatter descriptions are not used for routing.
- **Upstream skill bodies became reference guides** under each owner's `references/`, with a
  provenance line, skill names remapped to pack names and links rebased. One guide was split
  between two owners and one routing table was rewritten.
- **References, scripts, the add-on template and the tests were copied**, with names remapped and
  the compatibility changes listed in the ledger (`changes` per file, `change_tags` for meaning).
- **Each skill directory carries `THIRD_PARTY_NOTICES.md`** with the MIT notice and its file list,
  because skills are installed one directory at a time.

Not taken: the installers and plugin manifests (this pack has its own installer), upstream's
validator, trigger checker and shared-helper sync tool (replaced by `tools/validate_skills.py` and
`tools/check_blender_bundle.py`), the CI workflow, the README, changelog and agent instruction
files, and the comparison media.

## Limitations

- One Blender build and one machine. A passing run is evidence for that build only.
- The designed evaluation suites for the new and revised skills are, like every suite in this pack,
  **DESIGNED_NOT_EXECUTED**: no routing or outcome evaluation was run against a model.
- Sculpt brushwork, shape-key sculpting, hero grooming and motion tracking need a live session or a
  human; the skills say so and do not claim otherwise.
- Upstream moves quickly (four releases between 2026-11-13 and 2026-11-21). Re-review
  and re-run the suite before taking a newer revision; do not pull changes unreviewed.
