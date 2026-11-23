"""Skill Foundry test for the pack's own product-stage demo (not derived from upstream)."""
import runpy
import sys

import bpy
import fixtures as fx
from run_all import ROOT, TMP


def test_product_stage_renders_alone_and_keeps_unrelated_objects():
    fx.cube("Unrelated", size=2.0)  # stands in for the default startup cube, which covers the stage
    seen = []

    def record(*_):
        seen.append(bpy.data.objects["Unrelated"].hide_render)

    out = TMP / "stage"
    argv = sys.argv
    sys.argv = ["blender", "--", "--output", str(out / "stage.blend"), "--render", str(out / "stage.png"),
                "--samples", "1", "--resolution", "128"]
    bpy.app.handlers.render_pre.append(record)
    try:
        runpy.run_path(str(ROOT / "skills/procedural-3d-blender/scripts/build_product_stage.py"), run_name="__main__")
    finally:
        sys.argv = argv
        bpy.app.handlers.render_pre.remove(record)
    assert seen == [True], seen  # hidden while the stage renders
    assert not bpy.data.objects["Unrelated"].hide_render  # and restored, never deleted
    assert len(bpy.data.collections["SkillFoundry_Procedural_Stage"].objects) == 9
    assert (out / "stage.blend").is_file() and (out / "stage.png").stat().st_size > 0
