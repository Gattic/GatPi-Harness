"""In-Blender test runner for the bundled Blender scripts.

Discovers tests/blender/test_*.py and runs each test_* on a fresh empty scene.
Adapted from tests/run_all.py of EL4CTEO/blender-skills (MIT, Copyright (c) 2026 EL4CTEO):
the pack root and skill directories follow the Skill Foundry layout, and tests that need a
newer Blender than the one running are reported as SKIP with the required version.

Usage: SKILL_FOUNDRY_BLENDER=/path/to/blender python -m unittest discover -s tests -p 'test_blender_bundle.py' -v
       (direct: blender -b --factory-startup --python-exit-code 1 -P tests/blender/run_all.py -- [name-filter])
Prefer the unittest wrapper: it points TMPDIR and BLENDER_USER_RESOURCES at a scratch directory.
Run directly, the tests leave their outputs in the temp directory, the windowed tracking test
writes quit.blend there, and Blender creates its user config directory.
"""
import importlib.util
import os
import pathlib
import sys
import tempfile
import time
import traceback

import bpy

sys.dont_write_bytecode = True  # the skill directories are installed by digest: leave no __pycache__ behind
HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
# fixtures.py imports the shared helper directly; every skill copy is byte-identical.
sys.path.insert(0, str(ROOT / "skills" / "procedural-3d-blender" / "scripts"))

# Features that do not exist before the listed Blender version. Everything else runs on 5.1.
REQUIRES = {
    "test_simulation::test_gn_cloth_52_asset": ((5, 2), "node-based Cloth Dynamics asset"),
}


def skill_module(skill, script):
    """Import skills/<skill>/scripts/<script>.py fresh (tests call run() directly)."""
    path = ROOT / "skills" / skill / "scripts" / f"{script}.py"
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location(f"{skill}.{script}", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def fresh():
    bpy.ops.wm.read_factory_settings(use_empty=True)


TMP = pathlib.Path(tempfile.mkdtemp(prefix="bas_tests_"))


class Skip(Exception):
    pass


def requires_gpu():
    """Skip when BAS_SKIP_GPU=1 (CI runners without GPU/EGL: EEVEE, Workbench renders)."""
    if os.environ.get("BAS_SKIP_GPU") == "1":
        raise Skip("needs GPU context")


def main():
    flt = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv and sys.argv[-1] != "--" else ""
    passed, failed, skipped = 0, [], 0
    for f in sorted(HERE.glob("test_*.py")):
        spec = importlib.util.spec_from_file_location(f.stem, f)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        for name in sorted(n for n in dir(mod) if n.startswith("test_")):
            full = f"{f.stem}::{name}"
            if flt and flt not in full:
                continue
            minimum, feature = REQUIRES.get(full, ((0, 0), ""))
            if bpy.app.version[:2] < minimum:
                skipped += 1
                print(f"SKIP {full} (requires Blender {minimum[0]}.{minimum[1]}+ for {feature}; "
                      f"running {bpy.app.version_string})")
                continue
            fresh()
            t = time.time()
            try:
                getattr(mod, name)()
                passed += 1
                print(f"PASS {full} ({time.time() - t:.1f}s)")
            except Exception as e:
                if type(e).__name__ == "Skip":  # tests import run_all as a 2nd module: match by name
                    skipped += 1
                    print(f"SKIP {full} ({e})")
                    continue
                failed.append(full)
                print(f"FAIL {full}\n{traceback.format_exc(limit=4)}")
    print(f"\n{passed} passed, {len(failed)} failed, {skipped} skipped")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
