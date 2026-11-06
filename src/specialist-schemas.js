"use strict";

// Data-only specialist schemas shared by diagnostics, role contracts, result
// schemas, vision and verifiers. Keeping them in a leaf module removes the
// previous schemas -> specialist-roles -> diagnostics -> tools cycles.

const DIAGNOSTIC_OPERATIONS = Object.freeze({
  "gdb-backtrace": { tools: ["gdb"], purpose: "Native crashes: batch GDB, all-thread backtraces; build with debug symbols first." },
  "valgrind-memcheck": { tools: ["valgrind"], purpose: "Valgrind Memcheck for native invalid accesses, uninitialized values and leaks; not a timing benchmark." },
  "valgrind-callgrind": { tools: ["valgrind", "callgrind_annotate"], purpose: "Valgrind Callgrind for native instruction/cache costs and call paths; simulated costs, not wall time." },
  "valgrind-massif": { tools: ["valgrind", "ms_print"], purpose: "Valgrind Massif for native heap growth and allocation peaks; includes instrumentation overhead." },
  "nsys-profile": { tools: ["nsys"], purpose: "Nsight Systems CPU/NVTX timelines and, with explicit NVIDIA device grants, CUDA activity." },
  "perf-stat": { tools: ["perf"], purpose: "Linux CPU counters for this workload only; kernel perf permissions may block collection." },
  "strace-summary": { tools: ["strace"], purpose: "Syscall counts/time for suspected I/O or syscall overhead; no payload tracing." },
  "time-profile": { tools: ["time"], purpose: "Low-overhead elapsed/user/system time, peak RSS and resource usage baseline." },
  "python-cprofile": { tools: ["python3"], purpose: "Python function/cumulative CPU cost; deterministic instrumentation changes timing." },
  "node-cpu-profile": { tools: ["node"], purpose: "Node/V8 sampled CPU hotspots; idle/native/I/O time needs separate interpretation." },
});
const PROFILE_OPERATIONS = Object.keys(DIAGNOSTIC_OPERATIONS).filter(name => name !== "gdb-backtrace");
const GPU_DEVICE = /^\/dev\/nvidia(?:[0-9]+|ctl|-uvm|-uvm-tools)$/;
const diagnosticText = { type: "string", minLength: 1, maxLength: 2000 };
const pin = { type: "string", pattern: "^[a-f0-9]{64}$", minLength: 64, maxLength: 64 };
const EXECUTION_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["authorization", "target", "sha256", "args", "operations", "timeoutMs"],
  properties: {
    authorization: diagnosticText, target: diagnosticText, sha256: pin,
    args: { type: "array", maxItems: 32, items: { type: "string", maxLength: 1000 } },
    operations: { type: "array", minItems: 1, maxItems: 10, items: { enum: Object.keys(DIAGNOSTIC_OPERATIONS) } },
    timeoutMs: { type: "integer", minimum: 1, maximum: 120000 },
    nsysRuntime: { type: "object", additionalProperties: false, required: ["root", "executable", "sha256"], properties: { root: diagnosticText, executable: diagnosticText, sha256: pin } },
    gpuDevices: { type: "array", maxItems: 8, items: { type: "string", pattern: GPU_DEVICE.source } },
  },
};
function diagnosticInputSchema(required = false) {
  return { type: "object", additionalProperties: false, required: required ? ["execution"] : [], properties: { execution: EXECUTION_SCHEMA } };
}

const text = { type: "string", minLength: 1, maxLength: 2000 };
const strings = { type: "array", maxItems: 32, items: text };
const object = (required, properties) => ({ type: "object", additionalProperties: false, required, properties });
const positiveInteger = { type: "string", minLength: 1, maxLength: 256, pattern: "^[1-9][0-9]*$" };
const BEZOUT_TARGET_SCHEMA = object(["kind", "a", "b", "gcd"], { kind: { enum: ["bezout-gcd"] }, a: positiveInteger, b: positiveInteger, gcd: positiveInteger });
const ASSET_BUDGET_SCHEMA = object(["units", "axes", "maxVertices", "maxTriangles", "maxMaterials", "maxTexturePixels", "maxBones", "maxBytes"], { units: { enum: ["meters", "centimeters", "millimeters"] }, axes: { enum: ["Z-up", "Y-up"] }, maxVertices: { type: "integer", minimum: 1, maximum: 1000000 }, maxTriangles: { type: "integer", minimum: 1, maximum: 2000000 }, maxMaterials: { type: "integer", minimum: 0, maximum: 256 }, maxTexturePixels: { type: "integer", minimum: 0, maximum: 16777216 }, maxBones: { type: "integer", minimum: 0, maximum: 256 }, maxBytes: { type: "integer", minimum: 1, maximum: 16777216 } });
const leanName = { type: "string", minLength: 1, maxLength: 120, pattern: "^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)*$" };
const LEAN_TARGET_SCHEMA = object(["path", "sha256", "declaration", "candidateDeclaration", "imports", "allowedAxioms"], { path: text, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, declaration: leanName, candidateDeclaration: leanName, imports: { type: "array", minItems: 1, maxItems: 8, items: leanName }, allowedAxioms: { type: "array", maxItems: 3, items: { enum: ["propext", "Classical.choice", "Quot.sound"] } } });
const DOMAIN_INPUT_SCHEMAS = {
  "mathematical-researcher": object(["question", "definitions", "assumptions", "proofMode"], { question: text, definitions: strings, assumptions: strings, proofMode: { enum: ["informal", "certificate", "lean"] }, certificateTarget: BEZOUT_TARGET_SCHEMA, leanTarget: LEAN_TARGET_SCHEMA }),
  "reverse-engineer": object(["target", "sha256", "authorization", "technique"], { target: text, sha256: { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }, authorization: text, technique: { enum: ["static"] }, reaOperation: { enum: ["file_headers", "section_headers", "symbols", "relocations"] } }),
  "3d-modeler": object(["brief", "format", ...ASSET_BUDGET_SCHEMA.required], { brief: text, format: { enum: ["glb"] }, ...ASSET_BUDGET_SCHEMA.properties }),
};
const statements = { type: "array", maxItems: 32, items: object(["id", "statement"], { id: text, statement: text }) };
const DOSSIER_SCHEMA = object(["assumptions", "claims", "limitations", "evidenceRefs", "proofObligations"], {
  assumptions: statements,
  leanProof: object(["targetDigest", "source"], { targetDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" }, source: { type: "string", minLength: 1, maxLength: 32768 } }),
  certificate: object(["kind", "targetDigest", "u", "v"], { kind: { enum: ["bezout-gcd"] }, targetDigest: text, u: { type: "string", minLength: 1, maxLength: 257, pattern: "^-?[0-9]+$" }, v: { type: "string", minLength: 1, maxLength: 257, pattern: "^-?[0-9]+$" } }),
  claims: { type: "array", minItems: 1, maxItems: 32, items: object(["id", "statement", "assumptionIds", "evidenceIds", "limitationIds", "proofObligationIds", "status"], { id: text, statement: text, assumptionIds: strings, evidenceIds: strings, limitationIds: strings, proofObligationIds: strings, status: { enum: ["observed", "inferred", "conjecture", "machine-checked"] } }) },
  limitations: statements, proofObligations: statements,
  evidenceRefs: { type: "array", minItems: 1, maxItems: 32, items: object(["id", "source", "locator", "observation"], { id: text, source: text, locator: text, observation: text }) },
});

const VIEW_NAMES = Object.freeze(["front", "rear", "top"]);
const visualText = { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" };
const visualHash = { type: "string", pattern: "^sha256:[a-f0-9]{64}$" };
const visualObject = (required, properties) => ({ type: "object", additionalProperties: false, required, properties });
const VISUAL_CRITIQUE_SCHEMA = visualObject(["artifactDigest", "previewDigest", "verdict", "observations", "corrections", "limitations"], {
  artifactDigest: visualHash, previewDigest: visualHash, verdict: { enum: ["accept", "revise", "unable"] },
  observations: { type: "array", maxItems: 3, items: visualObject(["view", "observation"], { view: { enum: VIEW_NAMES }, observation: visualText }) },
  corrections: { type: "array", maxItems: 6, items: visualObject(["view", "issue", "action"], { view: { enum: VIEW_NAMES }, issue: visualText, action: visualText }) },
  limitations: { type: "array", maxItems: 4, items: visualText },
});

module.exports = {
  DIAGNOSTIC_OPERATIONS,
  PROFILE_OPERATIONS,
  GPU_DEVICE,
  EXECUTION_SCHEMA,
  diagnosticInputSchema,
  BEZOUT_TARGET_SCHEMA,
  ASSET_BUDGET_SCHEMA,
  LEAN_TARGET_SCHEMA,
  DOMAIN_INPUT_SCHEMAS,
  DOSSIER_SCHEMA,
  VIEW_NAMES,
  VISUAL_CRITIQUE_SCHEMA,
};
