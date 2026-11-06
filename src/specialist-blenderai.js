"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { runtimeBinding } = require("./specialist-runtime");

function blenderAiBinding(pin, cwd) {
  const { runtimeRoot } = runtimeBinding(pin, { cwd });
  for (const file of ["__init__.py", "integration_boundary.py", "blender_tools.py", "safety.py"]) {
    if (!fs.statSync(path.join(runtimeRoot, file)).isFile()) throw new Error("SPECIALIST_BLENDERAI_PACKAGE_INVALID");
  }
  return { addonRoot: runtimeRoot };
}
function blenderAiScript(file, outputs) {
  return `import sys, json, pathlib, struct, bpy
sys.dont_write_bytecode = True
sys.path.insert(0, '/blenderai')
from blender_mcp_assistant import integration_boundary, blender_tools
recipe = json.loads(pathlib.Path(${JSON.stringify(`/workspace/${file}`)}).read_text())
assert isinstance(recipe, dict) and set(recipe) <= {'source', 'calls'}, 'invalid-dispatch-recipe'
source = recipe.get('source')
if source:
 p = pathlib.Path('/workspace', source)
 assert not pathlib.Path(source).is_absolute() and '..' not in pathlib.Path(source).parts and p.suffix == '.blend' and str(p.resolve()).startswith('/workspace/'), 'invalid-source-path'
 bpy.ops.wm.open_mainfile(filepath=str(p), load_ui=False, use_scripts=False)
else:
 bpy.ops.wm.read_factory_settings(use_empty=True)
settings = blender_tools.get_settings()
# Only this disposable, networkless process is configured for unattended writes.
# Canonical dispatch still performs preflight, destructive confirmation and logging.
settings.require_write_confirmation = False
settings.enable_python_execution = False
settings.allow_file_output = False
settings.allow_ui_screenshots = False
settings.allow_background_blend_inspection = False
calls = recipe.get('calls')
assert isinstance(calls, list) and len(calls) <= 128, 'invalid-dispatch-calls'
results = []
for call in calls:
 assert isinstance(call, dict) and set(call) <= {'name', 'arguments'} and isinstance(call.get('name'), str), 'invalid-dispatch-call'
 arguments = call.get('arguments', {})
 assert isinstance(arguments, dict), 'invalid-dispatch-arguments'
 result = integration_boundary.dispatch_tool(call['name'], arguments)
 assert result.get('ok') is True and not result.get('requires_confirmation'), json.dumps(result)
 results.append({'name': call['name'], 'result': result})
bpy.context.scene.frame_set(bpy.context.scene.frame_start)
for name in ${JSON.stringify(outputs)}:
 p = pathlib.Path('/output', name)
 p.parent.mkdir(parents=True, exist_ok=True)
 if p.suffix == '.blend':
  bpy.ops.wm.save_as_mainfile(filepath=str(p), compress=True)
 elif p.suffix == '.glb':
  bpy.ops.export_scene.gltf(filepath=str(p), export_format='GLB', export_yup=True, export_animations=True)
  # Keep standard meters/Y-up coordinates; declare the native source convention.
  units = {1.0: 'meters', 0.01: 'centimeters', 0.001: 'millimeters'}.get(round(bpy.context.scene.unit_settings.scale_length, 8))
  assert units, 'unsupported-source-units'
  original = p.read_bytes()
  length, kind = struct.unpack_from('<II', original, 12)
  assert kind == 0x4E4F534A, 'invalid-export-json'
  document = json.loads(original[20:20 + length])
  document['asset'].setdefault('extras', {}).update(sourceUnits=units, sourceAxes='Z-up')
  encoded = json.dumps(document, separators=(',', ':')).encode()
  encoded += b' ' * (-len(encoded) % 4)
  tail = original[20 + length:]
  p.write_bytes(struct.pack('<IIIII', 0x46546C67, 2, 20 + len(encoded) + len(tail), len(encoded), kind) + encoded + tail)
 elif p.suffix == '.json':
  p.write_text(json.dumps({'calls': results, 'manifest': integration_boundary.build_internal_manifest() if not calls else None}))
 else:
  raise ValueError('unsupported-dispatch-output')
`;
}
module.exports = { blenderAiBinding, blenderAiScript };
