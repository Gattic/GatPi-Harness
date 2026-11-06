# ComfyUI workflow engineering: execution contract

ComfyUI distinguishes a **UI workflow graph** (editor layout and links) from the API-ready **prompt graph** (node IDs to `class_type` and typed `inputs`). Do not submit the UI graph to the execution endpoint without conversion and schema validation. Exact supported node classes and input sockets vary by version, checkpoints and installed custom nodes.

## Read-only preflight

1. Verify the intended ComfyUI server is local or authorized, and capture its version, hardware and installed custom-node set.
2. Inspect `GET /object_info` to enumerate actual available classes and their input contracts; never hallucinate a node ID/class.
3. Inspect known model file location, licenses and checkpoint hashes; do not automatically pull arbitrary URLs into model paths.
4. Build a candidate API prompt graph with unique string node IDs and all required input values. For a `VAE Decode` class, for example, the inputs must match the reported `/object_info` schema for this installation, not a copied example from an unrelated build.
5. Check reachable output/save nodes and ensure graph has no unresolved links or accidental cycles.
6. Preserve seed, sampler settings, model/version, dimensions, precision, scheduler and extension manifest in an execution record.

## Authorized execution

A commonly supported ComfyUI server API uses `POST /prompt` to enqueue a prompt graph; task monitoring may use `/ws` or `/history/{prompt_id}`, with output view/download through `/view`. **Confirm installed version and API behavior first**. Validate server response before polling; timeout and retry with a clear maximum and cancellation plan. Do not claim an accepted queue ID means the generated artifact exists. Inspect actual output files, dimensions, color mode and expected metadata.

## Common failure classes

- **Missing node/checkpoint:** report exact class/model name and installed inventory; no dummy substitute without approval.
- **Incompatible tensors:** verify latent/channel shape, batch size, precision and VAE/model family.
- **OOM:** reduce dimensions/batch or use supported offload/tiled operations while preserving quality budget.
- **Nondeterminism:** seed alone may not guarantee identical outputs across GPU kernels and software versions; record environment.
- **Output looks wrong despite valid JSON:** use visual inspection against the prompt brief, not graph syntax alone.

Prefer least-risk read-only inventory before any paid downloads, generation or changes to external services. Store source/media consent and model licensing separately from graph technical validity.
