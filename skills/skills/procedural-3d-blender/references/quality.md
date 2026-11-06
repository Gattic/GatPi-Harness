# Blender procedural asset QA contract

**Scope:** Blender 4.x product-display demo (see `../scripts/build_product_stage.py`). Requires installed Blender; `python` alone cannot import `bpy`.

```bash
blender --background --python skills/procedural-3d-blender/scripts/build_product_stage.py -- --output /tmp/stage.blend --render /tmp/stage.png --radius 1.5 --height 0.24 --samples 32
```

Before accepting the asset: confirm all object transforms and physical dimensions in meters; expected mesh and light names; no object from an unrelated collection was destroyed; native `.blend` opens; render is correct RGBA PNG with expected pixels; camera framing and contact shadow look plausible at native resolution; all modifiers/materials behave under a fresh reopen. Inspect the image, not only the script exit code.

The example creates a neutral primitive as a stand-in. It is **not** a real product model and must never be passed off as a photographed SKU. For actual jobs, substitute geometry only from supplied CAD/mesh or user-approved product design, then repeat scale, shading, export and rights QA.

If the rendering engine cannot initialize on the target machine, the script is **NOT TESTED** there even if it passed Python syntax checks elsewhere.
