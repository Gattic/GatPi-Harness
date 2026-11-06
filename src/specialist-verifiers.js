"use strict";

const fs = require("node:fs");
const { confinedFile, executable, runContained, blenderRuntimeBinding } = require("./specialist-primitives");
const { capabilityStatus } = require("./specialist-capabilities");
const { digest } = require("./specialist-contracts");
const { validateJsonSchema } = require("./specialist-contracts");
const { ASSET_BUDGET_SCHEMA, DOSSIER_SCHEMA } = require("./specialist-schemas");

function verifyDossier({ dossier }) {
  const failures = [];
  if (validateJsonSchema(DOSSIER_SCHEMA, dossier).length) return { ok: false, exitCode: 1, stderr: "Invalid structured dossier" };
  const groups = Object.fromEntries(["claims", "assumptions", "evidenceRefs", "limitations", "proofObligations"].map(name => [name, new Set(dossier[name].map(entry => entry.id))]));
  for (const [name, ids] of Object.entries(groups)) if (ids.size !== dossier[name].length) failures.push(`duplicate-${name}-id`);
  for (const claim of dossier.claims) {
    if (["observed", "inferred"].includes(claim.status) && !claim.evidenceIds.length) failures.push(`unsupported-claim:${claim.id}`);
    for (const [field, group] of [["assumptionIds", "assumptions"], ["evidenceIds", "evidenceRefs"], ["limitationIds", "limitations"], ["proofObligationIds", "proofObligations"]]) {
      if (claim[field].some(id => !groups[group].has(id))) failures.push(`dangling-${field}:${claim.id}`);
    }
    if (claim.status === "machine-checked") failures.push(`untrusted-proof-claim:${claim.id}`);
    if (claim.status === "conjecture" && !claim.proofObligationIds.length) failures.push(`missing-proof-obligation:${claim.id}`);
  }
  for (const evidence of dossier.evidenceRefs) if (!evidence.source?.trim() || !evidence.locator?.trim() || !evidence.observation?.trim()) failures.push(`incomplete-evidence:${evidence.id}`);
  return { ok: failures.length === 0, exitCode: failures.length ? 1 : 0, stdout: "Checks structural evidence consistency only; not mathematical truth or source authenticity.", stderr: failures.join("\n") };
}
function bezoutVerifier(target) {
  if (target?.kind !== "bezout-gcd" || ![target.a, target.b, target.gcd].every(value => typeof value === "string" && /^[1-9][0-9]{0,255}$/.test(value))) throw new Error("invalid bounded positive-integer Bezout target");
  const pinned = Object.freeze({ ...target });
  return { kind: "integration", capability: "mathematical-certificate", configuration: { targetDigest: digest(pinned), target: pinned }, run: ({ dossier }) => {
    const certificate = dossier?.certificate;
    if (certificate?.kind !== "bezout-gcd" || certificate.targetDigest !== digest(pinned) || ![certificate.u, certificate.v].every(value => typeof value === "string" && /^-?[0-9]{1,256}$/.test(value))) return { ok: false, exitCode: 1, stderr: "missing, malformed or wrong-target certificate" };
    const a = BigInt(pinned.a), b = BigInt(pinned.b), g = BigInt(pinned.gcd), u = BigInt(certificate.u), v = BigInt(certificate.v);
    const ok = a % g === 0n && b % g === 0n && u * a + v * b === g;
    return { ok, exitCode: ok ? 0 : 1, stdout: ok ? `Exact divisibility and Bezout identity establish gcd(${pinned.a}, ${pinned.b}) = ${pinned.gcd}. No other dossier claim is certified.` : "", stderr: ok ? "" : "Certificate fails divisibility or the exact Bezout identity." };
  } };
}
function verifyGlbBuffer(buffer, budget) {
  const fail = reason => ({ ok: false, exitCode: 1, stderr: reason });
  if (validateJsonSchema(ASSET_BUDGET_SCHEMA, budget).length) return fail("asset-budget-required");
  const { maxBytes, maxVertices, maxTriangles, maxMaterials, maxBones, units, axes } = budget;
  if (buffer.length > maxBytes || buffer.length < 20) return fail("asset-byte-budget-or-header");
  if (buffer.readUInt32LE(0) !== 0x46546c67 || buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== buffer.length) return fail("invalid-glb-header");
  let offset = 12, document, binary;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) return fail("truncated-glb-chunk");
    const size = buffer.readUInt32LE(offset), kind = buffer.readUInt32LE(offset + 4); offset += 8;
    if (size % 4 || offset + size > buffer.length) return fail("invalid-glb-chunk-size");
    if (kind === 0x4e4f534a && !document && offset === 20) {
      try { document = JSON.parse(buffer.subarray(offset, offset + size).toString("utf8")); } catch { return fail("invalid-glb-json"); }
    } else if (kind === 0x004e4942 && document && !binary) binary = buffer.subarray(offset, offset + size);
    else return fail("unsupported-or-duplicate-glb-chunk");
    offset += size;
  }
  if (document?.asset?.version !== "2.0" || !binary || document.buffers?.length !== 1 || document.buffers[0].uri || document.buffers[0].byteLength > binary.length) return fail("invalid-or-external-glb-buffer");
  if (document.images?.some(image => image.uri) || document.extensionsRequired?.length) return fail("external-or-unsupported-glb-resource");
  // GLB coordinates are meters/Y-up. The producer must record the requested
  // source convention separately; these extras are declarations, not a proof.
  if (document.asset.extras?.sourceUnits !== units || document.asset.extras?.sourceAxes !== axes) return fail("asset-convention-mismatch");
  if ((document.materials?.length || 0) > maxMaterials || (document.skins || []).reduce((sum, skin) => sum + (skin.joints?.length || 0), 0) > maxBones) return fail("asset-material-or-rig-budget");
  let vertices = 0, triangles = 0, primitives = 0;
  for (const mesh of document.meshes || []) for (const primitive of mesh.primitives || []) {
    primitives++;
    const accessor = document.accessors?.[primitive.attributes?.POSITION], view = document.bufferViews?.[accessor?.bufferView];
    if (!accessor || accessor.type !== "VEC3" || accessor.componentType !== 5126 || accessor.sparse || !Number.isSafeInteger(accessor.count) || accessor.count <= 0 || !view || view.buffer !== 0) return fail("unsupported-position-accessor");
    const start = (view.byteOffset || 0) + (accessor.byteOffset || 0), stride = view.byteStride || 12;
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(stride) || stride < 12 || stride % 4 || start + (accessor.count - 1) * stride + 12 > (view.byteOffset || 0) + view.byteLength || start + (accessor.count - 1) * stride + 12 > binary.length) return fail("position-buffer-out-of-bounds");
    if ((primitive.mode ?? 4) !== 4) return fail("unsupported-primitive-mode");
    let indexCount = accessor.count;
    if (primitive.indices != null) {
      const indices = document.accessors?.[primitive.indices], indexView = document.bufferViews?.[indices?.bufferView];
      const size = { 5121: 1, 5123: 2, 5125: 4 }[indices?.componentType];
      if (!indices || indices.type !== "SCALAR" || indices.sparse || !size || !indexView || indexView.buffer !== 0 || indexView.byteStride || !Number.isSafeInteger(indices.count) || indices.count < 1 || indices.count > maxTriangles * 3) return fail("invalid-index-accessor");
      const begin = (indexView.byteOffset || 0) + (indices.byteOffset || 0);
      if (!Number.isSafeInteger(begin) || begin < 0 || !Number.isSafeInteger(indexView.byteLength) || begin + indices.count * size > (indexView.byteOffset || 0) + indexView.byteLength || begin + indices.count * size > binary.length) return fail("index-buffer-out-of-bounds");
      for (let i = 0; i < indices.count; i++) if (binary.readUIntLE(begin + i * size, size) >= accessor.count) return fail("index-out-of-range");
      indexCount = indices.count;
    }
    if (indexCount % 3 || (triangles += indexCount / 3) > maxTriangles) return fail("asset-triangle-budget-or-topology");
    vertices += accessor.count;
    if (vertices > maxVertices) return fail("asset-vertex-budget");
    for (let i = 0; i < accessor.count; i++) for (let axis = 0; axis < 3; axis++) if (!Number.isFinite(binary.readFloatLE(start + i * stride + axis * 4))) return fail("nonfinite-geometry");
  }
  if (!primitives) return fail("empty-geometry");
  return { ok: true, exitCode: 0, stdout: JSON.stringify({ bytes: buffer.length, vertices, triangles, primitives, digest: digest(buffer), checks: "GLB container, bounded finite positions and declared conventions; not manifoldness, editability or visual quality" }) };
}
function glbVerifier(relative, budget) {
  if (validateJsonSchema(ASSET_BUDGET_SCHEMA, budget).length) throw new Error("ASSET_VERIFIER_BUDGET_INVALID");
  budget = Object.freeze({ ...budget });
  return { kind: "integration", configuration: { relative, budget }, run: ({ cwd }) => {
    const file = confinedFile(cwd, relative);
    if (fs.statSync(file).size > budget.maxBytes) return { ok: false, exitCode: 1, stderr: "asset-byte-budget" };
    return verifyGlbBuffer(fs.readFileSync(file), budget);
  } };
}
function staticElfVerifier({ target, sha256, roundTripSection = null }) {
  if (roundTripSection !== null && !/^[.A-Za-z_][.A-Za-z0-9_-]{0,63}$/.test(roundTripSection)) throw new Error("STATIC_ELF_SECTION_INVALID");
  return { kind: "integration", capability: "static-elf", command: "readelf", configuration: { target, sha256, roundTripSection }, run: async ({ cwd, dossier, signal }) => {
    const file = confinedFile(cwd, target);
    if (fs.statSync(file).size > 16 * 1024 * 1024) return { ok: false, exitCode: 1, stderr: "target-too-large" };
    const targetBytes = fs.readFileSync(file);
    if (digest(targetBytes) !== `sha256:${sha256}`) return { ok: false, exitCode: 1, stderr: "target-hash-mismatch" };
    const structure = verifyDossier({ dossier });
    if (!structure.ok) return structure;
    const checked = await runContained({ cwd, command: "readelf", args: ["--wide", "--file-header", "--section-headers", "--symbols", "--", `/workspace/${target}`], readZones: [target], writable: false, signal });
    if (!checked.ok) return checked;
    const lines = checked.stdout.split("\n");
    if (!dossier.evidenceRefs.length || dossier.evidenceRefs.some(evidence => {
      const locator = /^readelf:line:([1-9][0-9]{0,5})$/.exec(evidence.locator);
      return evidence.source !== target || !locator || lines[Number(locator[1]) - 1]?.trim() !== evidence.observation.trim();
    })) return { ok: false, exitCode: 1, stderr: "target observation or line locator is not supported by the independent static inspection" };
    if (roundTripSection !== null) {
      const rows = lines.map(line => /^\s*\[\s*\d+\]\s+(\S+)\s+(\S+)\s+([a-f0-9]+)\s+([a-f0-9]+)\s+([a-f0-9]+)\b/i.exec(line)).filter(row => row?.[1] === roundTripSection);
      if (rows.length !== 1 || rows[0][2] !== "PROGBITS") return { ok: false, exitCode: 1, stderr: "round-trip-section-missing-or-unsupported" };
      const [, , , address, offsetHex, sizeHex] = rows[0], offset = parseInt(offsetHex, 16), bytes = parseInt(sizeHex, 16);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 4096 || offset + bytes > targetBytes.length) return { ok: false, exitCode: 1, stderr: "round-trip-section-out-of-bounds" };
      const dump = await runContained({ cwd, command: "readelf", args: ["--wide", `--hex-dump=${roundTripSection}`, "--", `/workspace/${target}`], readZones: [target], writable: false, signal });
      if (!dump.ok) return dump;
      const chunks = []; let decodedBytes = 0;
      for (const line of dump.stdout.split("\n")) {
        const row = /^\s*0x([a-f0-9]+)\s+(.*)$/i.exec(line);
        if (!row) continue;
        const hex = row[2].slice(0, 35).replace(/\s/g, "");
        if (!/^(?:[a-f0-9]{2}){1,16}$/i.test(hex) || BigInt(`0x${row[1]}`) !== BigInt(`0x${address}`) + BigInt(decodedBytes)) return { ok: false, exitCode: 1, stderr: "round-trip-dump-invalid" };
        const chunk = Buffer.from(hex, "hex"); chunks.push(chunk); decodedBytes += chunk.length;
      }
      const decoded = Buffer.concat(chunks);
      if (decodedBytes !== bytes || !decoded.equals(targetBytes.subarray(offset, offset + bytes))) return { ok: false, exitCode: 1, stderr: "round-trip-byte-mismatch" };
      checked.roundTrip = { section: roundTripSection, offset, bytes, digest: digest(decoded), targetDigest: `sha256:${sha256}` };
      checked.stdout += `\nPI_STATIC_ROUND_TRIP:${JSON.stringify(checked.roundTrip)}`;
    }
    if (digest(fs.readFileSync(file)) !== `sha256:${sha256}`) return { ok: false, exitCode: 1, stderr: "target-changed-during-inspection" };
    return checked;
  } };
}
function blenderVerifier({ glb, native, budget, runtime = null, blenderAi = null, animation = null }) {
  const { MAX_PREVIEW_BYTES, VIEW_NAMES, VIEW_SIZE, validatePreview } = require("./specialist-vision");
  const structural = glbVerifier(glb, budget);
  budget = structural.configuration.budget;
  runtime = runtime && Object.freeze({ root: runtime.root, executable: runtime.executable, sha256: runtime.sha256 });
  const command = runtime ? blenderRuntimeBinding(runtime).command : null;
  if (blenderAi) { blenderAi = Object.freeze({ root: blenderAi.root, sha256: blenderAi.sha256 }); require("./specialist-blenderai").blenderAiBinding(blenderAi); }
  if (animation) {
    if (typeof animation.object !== "string" || !animation.object || animation.object.length > 120 || !Array.isArray(animation.frames) || animation.frames.length < 2 || animation.frames.length > 8 || animation.frames.some(frame => !Number.isInteger(frame) || frame < 0 || frame > 100000) || new Set(animation.frames).size !== animation.frames.length) throw new Error("SPECIALIST_ANIMATION_CONTRACT_INVALID");
    animation = Object.freeze({ object: animation.object, frames: Object.freeze([...animation.frames]) });
  }
  return { kind: "integration", capability: "blender-asset", command, configuration: Object.freeze({ glb, native, budget, runtime, blenderAi, animation }), run: async ({ cwd, signal }) => {
    const binding = blenderRuntimeBinding(runtime, { cwd });
    const structure = await structural.run({ cwd });
    if (!structure.ok) return structure;
    const nativeFile = confinedFile(cwd, native);
    if (fs.statSync(nativeFile).size > budget.maxBytes) return { ok: false, exitCode: 1, stderr: "native-asset-byte-budget" };
    const config = Buffer.from(JSON.stringify({ ...budget, animation, viewSize: VIEW_SIZE, viewNames: VIEW_NAMES, maxPreviewBytes: MAX_PREVIEW_BYTES, glb: `/workspace/${glb}`, native: `/workspace/${native}`, scale: { meters: 1, centimeters: 0.01, millimeters: 0.001 }[budget.units] })).toString("base64");
    const script = `import bpy, math, json, base64, hashlib, sys
from mathutils import Vector
cfg=json.loads(base64.b64decode('${config}'))
try:
    bpy.ops.import_scene.gltf.get_rna_type()
    bpy.context.scene.render.engine='CYCLES'
except Exception:
    print('PI_ASSET_CHECK:'+json.dumps({'unavailable':'bundled-gltf-importer-or-cpu-renderer'}))
    sys.exit(78)
def geometry(scale):
    meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
    count=0;triangles=0;points=set();depsgraph=bpy.context.evaluated_depsgraph_get()
    assert len(bpy.data.materials)<=cfg['maxMaterials'], 'material-budget'
    assert sum(len(a.bones) for a in bpy.data.armatures)<=cfg['maxBones'], 'bone-budget'
    images=[image for image in bpy.data.images if image.source!='VIEWER']
    assert all(image.source=='GENERATED' or image.packed_file for image in images), 'unpacked-external-image'
    assert sum(image.size[0]*image.size[1] for image in images)<=cfg['maxTexturePixels'], 'texture-pixel-budget'
    for obj in meshes:
        evaluated=obj.evaluated_get(depsgraph);mesh=evaluated.to_mesh()
        try:
            count+=len(mesh.vertices);mesh.calc_loop_triangles();triangles+=len(mesh.loop_triangles)
            assert triangles<=cfg['maxTriangles'], 'triangle-budget'
            assert count<=cfg['maxVertices'], 'vertex-budget'
            for v in mesh.vertices:
                point=obj.matrix_world @ v.co
                assert all(math.isfinite(x) for x in point), 'nonfinite-native-geometry'
                points.add(tuple(round(float(x)*scale,4) for x in point))
        finally:
            evaluated.to_mesh_clear()
    assert count>0, 'empty-geometry'
    return meshes,count,points,{'triangles':triangles,'materials':len(bpy.data.materials),'texturePixels':sum(image.size[0]*image.size[1] for image in images),'bones':sum(len(a.bones) for a in bpy.data.armatures)}
def motion_samples(scale):
    if not cfg['animation']: return []
    obj=bpy.data.objects.get(cfg['animation']['object'])
    assert obj is not None, 'animation-object-missing'
    samples=[]; scene=bpy.context.scene; original_frame=scene.frame_current
    for frame in cfg['animation']['frames']:
        scene.frame_set(frame)
        matrix=obj.matrix_world.copy()
        for i in range(3): matrix[i][3]*=scale
        samples.append([float(v) for row in matrix for v in row])
    scene.frame_set(original_frame)
    assert all(math.isfinite(v) for sample in samples for v in sample), 'nonfinite-animation'
    assert any(abs(a-b)>0.00001 for sample in samples[1:] for a,b in zip(samples[0],sample)), 'animation-has-no-motion'
    return samples
bpy.ops.wm.open_mainfile(filepath=cfg['native'],load_ui=False,use_scripts=False)
native_motion=motion_samples(cfg['scale'])
assert abs(bpy.context.scene.unit_settings.scale_length-cfg['scale'])<1e-8, 'native-unit-mismatch'
meshes,native_count,native_points,native_metrics=geometry(cfg['scale'])
original=meshes[0].location.copy()
meshes[0].location.x+=0.001
meshes[0].location=original
bpy.ops.wm.save_as_mainfile(filepath='/tmp/editability.blend',compress=True)
bpy.ops.wm.open_mainfile(filepath='/tmp/editability.blend',load_ui=False,use_scripts=False)
assert geometry(cfg['scale'])[2]==native_points, 'native-round-trip-mismatch'
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=cfg['glb'])
meshes,export_count,export_points,export_metrics=geometry(1)
export_motion=motion_samples(1)
assert all(abs(a-b)<0.001 for x,y in zip(native_motion,export_motion) for a,b in zip(x,y)), 'animation-round-trip-mismatch'
assert native_points==export_points, 'export-unit-axis-or-geometry-mismatch'
scene=bpy.context.scene
low=Vector([min(p[i] for p in export_points) for i in range(3)])
high=Vector([max(p[i] for p in export_points) for i in range(3)])
center=(low+high)/2
radius=max((high-low).length,0.01)
camera=bpy.data.objects.new('verification-camera',bpy.data.cameras.new('verification-camera'))
scene.collection.objects.link(camera)
camera.location=center+Vector((1.5,-2,1.5))*radius
camera.rotation_euler=(center-camera.location).to_track_quat('-Z','Y').to_euler()
camera.data.clip_start=max(radius/1000,0.000001)
camera.data.clip_end=radius*100+100
scene.camera=camera
world=bpy.data.worlds.new('verification-world')
world.node_tree.nodes['Background'].inputs['Color'].default_value=(0.62,0.64,0.68,1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value=1.0
scene.world=world
# A world-only preview is flat: the critic cannot read ears, eyes, hocks or
# strand relief from unlit geometry, so add a directional key and fill.
for name,energy,rotation in (('verification-key',4.0,(0.95,0.0,0.65)),('verification-fill',1.6,(1.05,0.0,-2.2))):
    light=bpy.data.objects.new(name,bpy.data.lights.new(name,'SUN'))
    light.data.energy=energy;light.data.angle=0.35;light.rotation_euler=rotation
    scene.collection.objects.link(light)
scene.render.engine='CYCLES';scene.cycles.device='CPU';scene.cycles.samples=24;scene.cycles.seed=0
size=cfg['viewSize'];width=size*len(cfg['viewNames'])
scene.render.resolution_x=size;scene.render.resolution_y=size;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA';scene.render.film_transparent=True
sheet_pixels=[0.0]*(width*size*4)
# Canonical front/rear/top views of the subject, framed so the whole bounding
# box fills the panel. A three-quarter view at 3x the radius shrinks the dog to
# a small oblique blob, which the vision critic then reads as an unreadable
# capsule regardless of the geometry.
# Orthographic framing: a perspective fit of a long-bodied subject either
# crops the near paw or shrinks the silhouette to a small blob, which is what
# made the critic read every candidate as an unreadable capsule.
camera.data.type='ORTHO'
coverage=[]
for index,direction in enumerate([(0,1,0.18),(0,-1,0.18),(0,0.0001,1)]):
    aim=Vector(direction).normalized()
    up=Vector((0,1,0)) if abs(aim.z)>0.9 else Vector((0,0,1))
    forward=-aim
    right=forward.cross(up).normalized()
    true_up=right.cross(forward)
    span_x=max(abs((Vector((x,y,z))-center).dot(right)) for x in (low.x,high.x) for y in (low.y,high.y) for z in (low.z,high.z))
    span_y=max(abs((Vector((x,y,z))-center).dot(true_up)) for x in (low.x,high.x) for y in (low.y,high.y) for z in (low.z,high.z))
    camera.data.ortho_scale=2*max(span_x,span_y)*1.06
    camera.location=center+aim*radius*2
    camera.rotation_euler=(center-camera.location).to_track_quat('-Z','Y').to_euler()
    scene.render.filepath='/tmp/asset-view.png'
    bpy.ops.render.render(write_still=True)
    # Headless Render Result may have no pixels; inspect the saved view.
    image=bpy.data.images.load('/tmp/asset-view.png',check_existing=False)
    pixels=image.pixels[:]
    assert tuple(image.size)==(size,size) and len(pixels)==size*size*4, 'invalid-preview-dimensions'
    assert any(alpha>0 for alpha in pixels[3::4]), 'empty-render'
    coverage.append(round(sum(1 for alpha in pixels[3::4] if alpha>0.5)/(size*size),3))
    for y in range(size):
        for x in range(size):
            source=(y*size+x)*4;dest=(y*width+index*size+x)*4;alpha=pixels[source+3]
            sheet_pixels[dest:dest+4]=[pixels[source+c]*alpha+0.18*(1-alpha) for c in range(3)]+[1.0]
    bpy.data.images.remove(image)
sheet=bpy.data.images.new('verification-contact-sheet',width=width,height=size,alpha=True)
sheet.pixels[:]=sheet_pixels
sheet.filepath_raw='/tmp/asset-preview.png';sheet.file_format='PNG';sheet.save()
with open('/tmp/asset-preview.png','rb') as file: preview=file.read(cfg['maxPreviewBytes']+1)
assert 0<len(preview)<=cfg['maxPreviewBytes'], 'preview-byte-budget'
print('PI_ASSET_CHECK:'+json.dumps({'nativeVertices':native_count,'exportVertices':export_count,'nativeMetrics':native_metrics,'exportMetrics':export_metrics,'editableRoundTrip':True,'animationSamples':len(export_motion),'previewCoverage':min(coverage),'previewDigest':'sha256:'+hashlib.sha256(preview).hexdigest(),'preview':base64.b64encode(preview).decode()}))
`;
    const checked = await runContained({ cwd, ...binding, args: ["--background", "--factory-startup", "--disable-autoexec", "--threads", "1", "--python-exit-code", "1", "--python-expr", script], readZones: [glb, native], writable: false, timeoutMs: 60000, maxOutputBytes: 1048576, signal });
    blenderRuntimeBinding(runtime, { cwd });
    const marker = checked.stdout?.split("\n").filter(line => line.startsWith("PI_ASSET_CHECK:")).at(-1);
    if (!marker) return { ...checked, ok: false, stderr: `${checked.stderr || ""}\nmissing-native-validation-receipt` };
    const result = JSON.parse(marker.slice("PI_ASSET_CHECK:".length));
    if (result.unavailable) return { ...checked, ok: false, termination: "blender-capability-unavailable", stderr: result.unavailable };
    if (!checked.ok) return checked;
    const preview = { mimeType: "image/png", data: result.preview, digest: result.previewDigest, views: VIEW_NAMES };
    try { validatePreview(preview); } catch { return { ok: false, exitCode: 1, stderr: "invalid-native-preview" }; }
    delete result.preview;
    return { ok: true, exitCode: 0, stdout: JSON.stringify(result), preview };
  } };
}
function domainCapabilities({ blenderRuntime } = {}) {
  const modeling = capabilityStatus({ settings: { prerequisites: ["bwrap", "blender"], containment: "bwrap", blenderRuntime } });
  return {
    diagnostics: { operations: require("./specialist-diagnostics").diagnosticCapabilities(), scope: "explicit hash-pinned workload execution only; tool discovery is not a successful collection or independently verified performance claim" },
    mathematicalResearch: { available: true, scope: "informal evidence dossier; formal-proof acceptance requires a separately pinned checker" },
    mathematicalCertificates: { available: true, scope: "exact positive-integer Bezout gcd certificates only, bound to the declared target" },
    formalProof: { available: false, reason: "reviewed-lean-policy-required", scope: "Exact pinned target proposition, independent Lean kernel replay and declared standard-axiom allowlist; pinned runtime imports only", installingProbe: false },
    reaReverseEngineering: { available: false, reason: "reviewed-rea-policy-required", scope: "Authorized pinned ELF static observations via REA, independently reproduced by pinned objdump/readelf; never target execution", installingProbe: false },
    staticReverseEngineering: { available: Boolean(executable("readelf") && executable("bwrap")), scope: "authorized hash-pinned ELF inspection; never target execution" },
    modeling: { ...modeling, scope: "tool discovery only; independent native round-trip, GLB import, geometry and CPU-render checks are required; human visual feedback is non-blocking" },
  };
}
module.exports = { verifyDossier, bezoutVerifier, verifyGlbBuffer, glbVerifier, staticElfVerifier, blenderVerifier, domainCapabilities };
