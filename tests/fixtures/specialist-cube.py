"""Provider-free Blender fixture; run only through the contained domain adapter.

API references: Blender 4.5 bpy.ops.mesh.primitive_cube_add and
bpy.ops.export_scene.gltf (docs.blender.org/api/4.5/).
"""
import json
import os
import pathlib
import struct

import bpy

output = pathlib.Path(os.environ["PI_ASSET_OUTPUT_DIR"], "assets")
output.mkdir(parents=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.unit_settings.scale_length = 1.0
bpy.ops.mesh.primitive_cube_add(size=2.0, location=(0, 0, 0), scale=(1, 1, 1))
bpy.ops.wm.save_as_mainfile(filepath=str(output / "cube.blend"), compress=True)
bpy.ops.export_scene.gltf(
    filepath=str(output / "cube.glb"), export_format="GLB",
    export_yup=True, export_animations=False,
)

# Record the source convention without changing the standard GLB coordinate system.
glb = output / "cube.glb"
original = glb.read_bytes()
length, kind = struct.unpack_from("<II", original, 12)
assert kind == 0x4E4F534A
document = json.loads(original[20:20 + length])
document["asset"]["extras"] = {"sourceUnits": "meters", "sourceAxes": "Z-up"}
encoded = json.dumps(document, separators=(",", ":")).encode()
encoded += b" " * (-len(encoded) % 4)
tail = original[20 + length:]
header = struct.pack("<III", 0x46546C67, 2, 20 + len(encoded) + len(tail))
glb.write_bytes(header + struct.pack("<II", len(encoded), kind) + encoded + tail)
