"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { projectIdentity } = require("./project-identity");
const { normalizeCandidate, validateCandidate, projectFolderName, noteFileForKind, noteFrontmatter, parseFrontmatter, sha256, normalizeKey, forbiddenReasons, VERIFICATION_STATES, VERIFICATION_RANK, MEMORY_KINDS, WRITABLE_KINDS } = require("./project-memory-schema");
const { ProjectMemoryDecisionStore, ensurePrivateDir } = require("./project-memory-decisions");
const { classifyProjectMemoryCandidate } = require("./project-memory-policy");

const ENTRY_PREFIX = "<!-- pi-memory-entry:";
const REVIEW_STATUSES = new Set(["requires-explicit-curator-review", "requires-explicit-curator"]);
const REVIEW_RESOLUTION_KIND = "review-resolution";
const REVIEW_RESOLUTION_STATUS = "resolved";
const ENTRY_SUFFIX = " -->";
const NOTE_TITLES = { current: "Current project memory", decision: "Decisions", constraint: "Constraints", risk: "Risks and TODOs", verification: "Verification", procedure: "Procedures", history: "History" };
function isInside(parent, child) { const rel = path.relative(parent, child); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); }
// A review request is identified by what produced it, not by its line number:
// the request key survives diagnostic log rotation and compaction.
function reviewRowKey(row = {}) {
  const kind = typeof row.kind === "string" ? row.kind : "unknown";
  const at = typeof row.at === "string" ? row.at : "";
  const source = row.sourceHash || row.promptHash || row.packetId || "";
  return `${kind}|${at}|${source}`;
}
// Diagnostics record metadata-only review requests. They are separate from the
// decision ledger's reviewBacklog, which only counts queued decisions, so the
// store reports them explicitly instead of letting status under-report them.
// Rows are append-only, so a request is settled by a later resolution row that
// names the same request key; nothing is ever rewritten or deleted.
function diagnosticReviewSummary(stateDir) {
  const file = path.join(stateDir, "diagnostics.jsonl");
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return { rows: 0, resolved: 0, unresolved: 0, byKind: {}, oldestAt: null, newestAt: null, oldestUnresolvedAt: null, newestUnresolvedAt: null }; }
  const byKind = {}; const unresolvedByKind = {}; const requests = new Map(); const resolutions = new Set();
  for (const line of text.split("\n")) {
    const trimmed = line.trim(); if (!trimmed) continue;
    let row; try { row = JSON.parse(trimmed); } catch { continue; }
    if (row.status === REVIEW_RESOLUTION_STATUS && row.resolves && typeof row.resolves.key === "string") { resolutions.add(row.resolves.key); continue; }
    if (!REVIEW_STATUSES.has(row.status)) continue;
    const key = reviewRowKey(row);
    if (requests.has(key)) continue;
    requests.set(key, row);
    const kind = typeof row.kind === "string" ? row.kind : "unknown";
    byKind[kind] = (byKind[kind] || 0) + 1;
  }
  let oldestAt = null; let newestAt = null; let oldestUnresolvedAt = null; let newestUnresolvedAt = null; let resolved = 0;
  for (const [key, row] of requests) {
    const at = typeof row.at === "string" ? row.at : null;
    if (at) { if (!oldestAt || at < oldestAt) oldestAt = at; if (!newestAt || at > newestAt) newestAt = at; }
    if (resolutions.has(key)) { resolved += 1; continue; }
    const kind = typeof row.kind === "string" ? row.kind : "unknown";
    unresolvedByKind[kind] = (unresolvedByKind[kind] || 0) + 1;
    if (at) { if (!oldestUnresolvedAt || at < oldestUnresolvedAt) oldestUnresolvedAt = at; if (!newestUnresolvedAt || at > newestUnresolvedAt) newestUnresolvedAt = at; }
  }
  const rows = requests.size;
  return { rows, resolved, unresolved: rows - resolved, byKind, unresolvedByKind, oldestAt, newestAt, oldestUnresolvedAt, newestUnresolvedAt };
}
function chmodSafe(file, mode) { try { fs.chmodSync(file, mode); } catch {} }
function ensureManagedDirectory(root, dir) {
  const absoluteRoot = path.resolve(root); const target = path.resolve(dir);
  if (!isInside(absoluteRoot, target)) throw new Error(`project-memory path escapes vault: ${target}`);
  fs.mkdirSync(absoluteRoot, { recursive: true });
  let current = absoluteRoot;
  const rel = path.relative(absoluteRoot, target);
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { const stat = fs.lstatSync(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe project-memory directory: ${current}`); }
    catch (error) { if (error?.code !== "ENOENT") throw error; fs.mkdirSync(current, { mode: 0o700 }); }
    chmodSafe(current, 0o700);
  }
}
function atomicWrite(file, text, root) {
  ensureManagedDirectory(root, path.dirname(file));
  try { const existing = fs.lstatSync(file); if (existing.isSymbolicLink() || !existing.isFile()) throw new Error(`unsafe project-memory note: ${file}`); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, String(text)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file); chmodSafe(file, 0o600);
}
function safeRead(file) { try { const stat = fs.lstatSync(file); if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`unsafe project-memory note: ${file}`); return fs.readFileSync(file, "utf8"); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
function entryMarker(entry) { return `${ENTRY_PREFIX}${JSON.stringify({ id: entry.id, candidateHash: entry.candidateHash, titleHash: entry.titleHash, verification: entry.verification, standing: entry.standing === true, sourceFingerprints: entry.sourceFingerprints, evidenceIds: entry.evidenceIds, expiresAt: entry.expiresAt, supersedes: entry.supersedes, contradicts: entry.contradicts, updatedAt: entry.updatedAt })}${ENTRY_SUFFIX}`; }
function renderEntry(entry) { return `${entryMarker(entry)}\n## ${entry.title}\n\n${entry.content.trim()}\n`; }
function parseEntries(text) {
  const { fields, body } = parseFrontmatter(text || "");
  const entries = [];
  const marker = new RegExp(String.raw`<!-- pi-memory-entry:(\{[^\n]+\}) -->\n## ([^\n]+)\n\n`, "g");
  const matches = [...body.matchAll(marker)];
  let malformedMarkers = 0;
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index]; const start = match.index + match[0].length; const end = index + 1 < matches.length ? matches[index + 1].index : body.length;
    let metadata; try { metadata = JSON.parse(match[1]); } catch { malformedMarkers++; continue; }
    entries.push({ ...metadata, title: match[2].trim(), content: body.slice(start, end).trim() });
  }
  const markerCount = body.split(ENTRY_PREFIX).length - 1;
  malformedMarkers += Math.max(0, markerCount - matches.length);
  return { fields, body, entries, malformedMarkers, managed: body.trim() === "" || body.includes(ENTRY_PREFIX) || fields.memory_schema === 1 || fields.memory_schema === "1" };
}
function validateManagedNote(identity, kind, parsed) {
  const issues = [];
  if (String(parsed.fields.memory_schema) !== "1") issues.push("schema-mismatch");
  if (parsed.fields.project_key !== identity.projectKey) issues.push("project-key-mismatch");
  if (parsed.fields.memory_kind !== kind) issues.push("memory-kind-mismatch");
  if (parsed.fields.content_hash !== sha256(parsed.body)) issues.push("content-hash-mismatch");
  if (parsed.malformedMarkers) issues.push("malformed-entry-marker");
  for (const entry of parsed.entries) {
    if (!VERIFICATION_STATES.includes(entry.verification)) issues.push("entry-verification-invalid");
    if (forbiddenReasons(`${entry.title}\n${entry.content}`).length) issues.push("entry-content-unsafe");
    if (kind === "current") continue;
    const candidate = normalizeCandidate({ kind, title: entry.title, content: entry.content, verification: entry.verification, standing: entry.standing === true, sourceFingerprints: entry.sourceFingerprints, evidenceIds: entry.evidenceIds, expiresAt: entry.expiresAt, supersedes: entry.supersedes, contradicts: entry.contradicts, updatedAt: entry.updatedAt });
    if (!validateCandidate(candidate).ok) issues.push("entry-invalid");
    if (entry.candidateHash !== candidate.candidateHash) issues.push("entry-candidate-hash-mismatch");
    if (entry.titleHash !== candidate.titleHash) issues.push("entry-title-hash-mismatch");
    if (entry.id !== `mem_${candidate.candidateHash.slice(0, 16)}`) issues.push("entry-id-mismatch");
  }
  return { ok: issues.length === 0, issues: [...new Set(issues)].sort() };
}
function noteVerification(entries) { if (!entries.length) return "unverified"; return [...entries].sort((a, b) => (VERIFICATION_RANK[a.verification] || 0) - (VERIFICATION_RANK[b.verification] || 0))[0].verification; }
function renderNote(identity, kind, entries, updatedAt) {
  const body = [`# ${NOTE_TITLES[kind] || kind}`, "", ...entries.map(renderEntry)].join("\n").trimEnd() + "\n";
  const contentHash = sha256(body);
  const sourceFingerprints = [...new Set(entries.flatMap((entry) => entry.sourceFingerprints || []))].sort().slice(0, 64);
  const evidenceIds = [...new Set(entries.flatMap((entry) => entry.evidenceIds || []))].sort().slice(0, 64);
  const supersedes = [...new Set(entries.flatMap((entry) => entry.supersedes || []))].sort().slice(0, 64);
  const header = noteFrontmatter({ projectKey: identity.projectKey, kind, updatedAt, contentHash, verification: noteVerification(entries), sourceFingerprints, evidenceIds, expiresAt: null, supersedes });
  return { text: `${header}${body}`, contentHash, body };
}
function sortEntries(entries) { return [...entries].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(a.id).localeCompare(String(b.id))); }
function withFileLock(file, fn) {
  ensurePrivateDir(path.dirname(file)); const started = Date.now(); let fd;
  while (fd === undefined) {
    try { fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600); fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`); fs.fsyncSync(fd); }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try { const stat = fs.lstatSync(file); if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`unsafe project-memory lock: ${file}`); const owner = JSON.parse(fs.readFileSync(file, "utf8")); try { process.kill(Number(owner.pid), 0); } catch (signalError) { if (signalError?.code === "ESRCH") stale = true; } if (!owner.pid && Date.now() - stat.mtimeMs > 30_000) stale = true; } catch (lockError) { if (/unsafe project-memory lock/.test(lockError?.message || "")) throw lockError; }
      if (stale) { try { fs.rmSync(file); } catch {} continue; }
      if (Date.now() - started > 2000) throw new Error(`project-memory lock timeout: ${path.basename(file)}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return fn(); } finally { try { fs.closeSync(fd); } catch {} try { fs.rmSync(file); } catch {} }
}

class ProjectMemoryStore {
  constructor({ cwd = process.cwd(), vault, writeEnabled = false, clock = () => new Date(), stateDir } = {}) {
    if (!vault) throw new Error("ProjectMemoryStore requires an explicit resolved vault path");
    this.cwd = cwd; this.vault = path.resolve(vault); this.writeEnabled = Boolean(writeEnabled); this.clock = clock; this.identity = projectIdentity(cwd);
    this.memoryRoot = path.join(this.vault, "Memory"); this.projectsRoot = path.join(this.memoryRoot, "Projects"); this.projectDir = path.join(this.projectsRoot, projectFolderName(this.identity));
    this.reviewDir = path.join(this.projectDir, "Reviews");
    this.decisions = new ProjectMemoryDecisionStore({ cwd, dir: stateDir || path.join(cwd, ".pi", "project-memory"), clock });
  }
  notePath(kind) { return path.join(this.projectDir, noteFileForKind(kind)); }
  readKind(kind) {
    if (!MEMORY_KINDS.includes(kind)) throw new Error(`invalid memory kind: ${kind}`);
    const file = this.notePath(kind); const text = safeRead(file);
    if (text == null) return { kind, file, exists: false, entries: [], fields: {}, revision: null, managed: true, integrity: { ok: true, issues: [] } };
    const parsed = parseEntries(text); const integrity = validateManagedNote(this.identity, kind, parsed);
    return { kind, file, exists: true, entries: integrity.ok ? parsed.entries : [], fields: parsed.fields, revision: sha256(text), managed: parsed.managed, integrity };
  }
  list({ kinds = WRITABLE_KINDS, includeExpired = false, limit = Infinity } = {}) {
    const now = Date.now(); const rows = [];
    for (const kind of kinds) for (const entry of this.readKind(kind).entries) {
      if (!includeExpired && entry.expiresAt && Date.parse(entry.expiresAt) < now) continue;
      rows.push({ ...entry, kind, source: { kind: "canonical-vault", note: path.relative(this.vault, this.notePath(kind)).replace(/\\/g, "/") } });
    }
    return sortEntries(rows).slice(0, Number.isFinite(limit) ? limit : rows.length);
  }
  decide(input) { return this.decisions.record({ projectKey: this.identity.projectKey, ...input }); }
  upsert(input = {}, options = {}) {
    const lock = path.join(this.decisions.dir, "locks", `${sha256(this.identity.projectKey).slice(0, 24)}.lock`);
    return withFileLock(lock, () => this._upsertUnlocked(input, options));
  }
  _upsertUnlocked(input = {}, options = {}) {
    const policy = classifyProjectMemoryCandidate({ ...input, updatedAt: input.updatedAt || this.clock() }, { explicit: Boolean(options.explicit), automatic: Boolean(options.automatic), operatorCapture: options.operatorCapture === true });
    const candidate = policy.candidate || normalizeCandidate(input, { now: this.clock() }); const validation = validateCandidate(candidate);
    const candidateHash = `sha256:${candidate.candidateHash}`;
    const reject = (reason) => ({ ok: false, outcome: "rejected", reason, candidate, decision: this.decide({ kind: candidate.kind, action: "rejected", reason, candidateHash, sourceFingerprints: candidate.sourceFingerprints, evidenceIds: candidate.evidenceIds, verification: candidate.verification }) });
    if (!validation.ok) return reject(validation.issues[0] || "invalid");
    if (policy.action === "reject") return reject(policy.reason);
    if (policy.action === "review" || policy.action === "shadow") return { ok: true, outcome: policy.action === "review" ? "review-queued" : "shadowed", reason: policy.reason, applied: false, candidateHash, decision: this.decide({ kind: candidate.kind, action: policy.action === "review" ? "review-queued" : "shadowed", reason: policy.reason, candidateHash, sourceFingerprints: candidate.sourceFingerprints, evidenceIds: candidate.evidenceIds, verification: candidate.verification }) };
    const notes = Object.fromEntries(MEMORY_KINDS.map((kind) => [kind, this.readKind(kind)])); const current = notes[candidate.kind];
    if (!current.managed) return reject("policy");
    if (Object.values(notes).some((note) => note.exists && !note.integrity.ok)) return reject("integrity");
    // Capture deduplication runs under the same project lock as the write, even
    // when concurrent sessions choose different titles for the same fact.
    const duplicate = current.entries.find((entry) => entry.candidateHash === candidate.candidateHash || (options.operatorCapture && normalizeKey(entry.content) === normalizeKey(candidate.content)));
    if (duplicate) return { ok: true, outcome: "deduped", entry: duplicate, revision: current.revision, decision: this.decide({ kind: candidate.kind, action: "deduped", reason: "duplicate", candidateHash, noteRevision: current.revision, sourceFingerprints: candidate.sourceFingerprints, evidenceIds: candidate.evidenceIds, verification: candidate.verification }) };
    if (options.operatorCapture && Object.entries(notes).filter(([kind]) => kind !== "current").reduce((sum, [, note]) => sum + note.entries.length, 0) >= 250) return reject("capture-capacity");
    const sameTitle = current.entries.find((entry) => entry.titleHash === candidate.titleHash);
    if (sameTitle && !options.forceSupersede && !(candidate.supersedes || []).includes(sameTitle.id)) {
      const decision = this.decide({ kind: candidate.kind, action: "review-queued", reason: "conflict", candidateHash, sourceFingerprints: candidate.sourceFingerprints, evidenceIds: candidate.evidenceIds, verification: candidate.verification });
      if (options.apply && this.writeEnabled) this.appendReview("Conflict Ledger.md", { title: candidate.title, kind: candidate.kind, candidateHash, existingId: sameTitle.id, verification: candidate.verification, at: candidate.updatedAt });
      return { ok: false, outcome: "review-queued", reason: "conflict", conflictWith: sameTitle.id, decision };
    }
    const entry = { ...candidate, id: `mem_${candidate.candidateHash.slice(0, 16)}` };
    let entries = current.entries;
    let action = "saved";
    if (sameTitle) { entry.supersedes = [...new Set([...(entry.supersedes || []), sameTitle.id])]; entries = entries.filter((row) => row.id !== sameTitle.id); action = "superseded"; }
    entries = sortEntries([entry, ...entries]);
    const rendered = renderNote(this.identity, candidate.kind, entries, candidate.updatedAt);
    const apply = Boolean(options.apply && this.writeEnabled);
    if (apply) { ensureManagedDirectory(this.vault, this.projectDir); atomicWrite(current.file, rendered.text, this.vault); }
    const decision = this.decide({ kind: candidate.kind, action: apply ? action : "shadowed", reason: apply ? (options.operatorCapture ? "operator-capture" : options.explicit ? "explicit-save" : "verified-durable") : "shadow-mode", candidateHash, noteRevision: apply ? rendered.contentHash : null, sourceFingerprints: candidate.sourceFingerprints, evidenceIds: candidate.evidenceIds, verification: candidate.verification });
    if (apply) this.compileCurrent({ apply: true });
    const outcome = apply ? (action === "saved" && policy.label === "saved-labeled" ? "saved-labeled" : action) : "shadowed";
    return { ok: true, outcome, applied: apply, entry, revision: rendered.contentHash, decision };
  }
  appendReview(fileName, input = {}) {
    ensureManagedDirectory(this.vault, this.reviewDir);
    const file = path.join(this.reviewDir, fileName);
    const previous = safeRead(file) || `# ${path.basename(fileName, ".md")}\n\n`;
    const safe = { projectKey: this.identity.projectKey, kind: input.kind || "history", titleHash: sha256(normalizeKey(input.title || "")), candidateHash: input.candidateHash || null, existingId: input.existingId || null, verification: input.verification || "unverified", at: input.at || new Date().toISOString() };
    atomicWrite(file, `${previous.trimEnd()}\n\n- ${JSON.stringify(safe)}\n`, this.vault);
    return { file: path.relative(this.vault, file).replace(/\\/g, "/"), hash: sha256(JSON.stringify(safe)) };
  }
  consider(input = {}, options = {}) {
    const policy = classifyProjectMemoryCandidate({ ...input, updatedAt: input.updatedAt || this.clock() }, { automatic: options.automatic === true }); const candidate = policy.candidate || normalizeCandidate(input, { now: this.clock() }); const validation = validateCandidate(candidate); const candidateHash = `sha256:${candidate.candidateHash}`;
    const rejectReason = !validation.ok ? validation.issues[0] : policy.action === "reject" ? policy.reason : null;
    if (rejectReason) return { ok: false, outcome: "rejected", reason: rejectReason, decision: this.decide({ kind: candidate.kind, action: "rejected", reason: rejectReason, candidateHash, verification: candidate.verification }) };
    if (options.automatic === true && policy.action === "save") return this.upsert(candidate, { apply: options.apply, explicit: false, automatic: true });
    const action = options.queueReview || policy.action === "review" ? "review-queued" : "shadowed"; const reason = action === "review-queued" ? policy.reason || "unverified" : "shadow-mode";
    const decision = this.decide({ kind: candidate.kind, action, reason, candidateHash, sourceFingerprints: candidate.sourceFingerprints, evidenceIds: candidate.evidenceIds, verification: candidate.verification });
    if (action === "review-queued" && options.apply && this.writeEnabled) this.appendReview("Review Queue.md", { title: candidate.title, kind: candidate.kind, candidateHash, verification: candidate.verification, at: candidate.updatedAt });
    return { ok: true, outcome: action, applied: false, decision };
  }
  setStanding({ entryId, standing = true } = {}, options = {}) {
    if (!(options.apply && options.explicit && this.writeEnabled)) return this._setStandingUnlocked({ entryId, standing }, { ...options, apply: false });
    const lock = path.join(this.decisions.dir, "locks", `${sha256(this.identity.projectKey).slice(0, 24)}.lock`);
    return withFileLock(lock, () => this._setStandingUnlocked({ entryId, standing }, options));
  }
  _setStandingUnlocked({ entryId, standing = true } = {}, options = {}) {
    if (!/^mem_[a-f0-9]{16}$/.test(String(entryId || ""))) return { ok: false, outcome: "rejected", reason: "invalid", entryId: entryId || null };
    const notes = Object.fromEntries(MEMORY_KINDS.map((kind) => [kind, this.readKind(kind)]));
    const invalid = Object.entries(notes).filter(([, note]) => note.exists && !note.integrity.ok);
    if (invalid.length) return { ok: false, outcome: "blocked", reason: "integrity", invalidKinds: invalid.map(([kind]) => kind) };
    let kind = null; let entry = null;
    for (const candidateKind of ["constraint", "procedure", "decision"]) {
      const found = notes[candidateKind].entries.find((row) => row.id === entryId);
      if (found) { kind = candidateKind; entry = found; break; }
    }
    if (!entry || !kind) return { ok: false, outcome: "rejected", reason: "policy", entryId };
    if (!["verified", "corroborated"].includes(entry.verification)) return { ok: false, outcome: "rejected", reason: "unverified", entryId };
    const target = standing === true;
    if (target && entry.expiresAt && Date.parse(entry.expiresAt) < new Date(this.clock()).getTime()) return { ok: false, outcome: "rejected", reason: "stale", entryId };
    const related = Object.values(notes).flatMap((note) => note.entries || []);
    const conflicted = (entry.contradicts || []).length > 0 || related.some((row) => row.id !== entry.id && ([...(row.supersedes || []), ...(row.contradicts || [])].includes(entry.id)));
    if (target && conflicted) return { ok: false, outcome: "rejected", reason: "conflict", entryId };
    if ((entry.standing === true) === target) return { ok: true, outcome: "deduped", applied: false, entry: { id: entry.id, kind, standing: target, verification: entry.verification }, revision: notes[kind].revision };
    const updatedAt = new Date(this.clock()).toISOString();
    const updated = { ...entry, standing: target, updatedAt };
    const entries = notes[kind].entries.map((row) => row.id === entry.id ? updated : row);
    const rendered = renderNote(this.identity, kind, sortEntries(entries), updatedAt);
    const apply = Boolean(options.apply && options.explicit && this.writeEnabled);
    if (!apply) return { ok: true, outcome: "preview", applied: false, entry: { id: entry.id, kind, standing: target, verification: entry.verification }, revision: rendered.contentHash, decision: null };
    atomicWrite(notes[kind].file, rendered.text, this.vault); this.compileCurrent({ apply: true });
    const decision = this.decide({ kind, action: target ? "pinned" : "unpinned", reason: "explicit-standing", candidateHash: `sha256:${entry.candidateHash}`, noteRevision: rendered.contentHash, sourceFingerprints: entry.sourceFingerprints, evidenceIds: entry.evidenceIds, verification: entry.verification });
    return { ok: true, outcome: target ? "pinned" : "unpinned", applied: true, entry: { id: entry.id, kind, standing: target, verification: entry.verification }, revision: rendered.contentHash, decision };
  }
  standingProjection({ limit = 12, maxChars = 1600 } = {}) {
    const notes = Object.fromEntries(MEMORY_KINDS.map((kind) => [kind, this.readKind(kind)]));
    const invalid = Object.entries(notes).filter(([, note]) => note.exists && !note.integrity.ok);
    if (invalid.length) return { schemaVersion: 1, projectKey: this.identity.projectKey, outcome: "blocked", reason: "integrity", items: [], invalidKinds: invalid.map(([kind]) => kind) };
    const now = new Date(this.clock()).getTime(); const kindRank = { constraint: 0, procedure: 1, decision: 2 };
    const allEntries = Object.values(notes).flatMap((note) => note.entries || []);
    const superseded = new Set(allEntries.flatMap((entry) => entry.supersedes || []));
    const contradicted = new Set(allEntries.flatMap((entry) => entry.contradicts || []));
    const rows = ["constraint", "procedure", "decision"].flatMap((kind) => notes[kind].entries.map((entry) => ({ ...entry, kind })))
      .filter((entry) => entry.standing === true && ["verified", "corroborated"].includes(entry.verification) && (!entry.expiresAt || Date.parse(entry.expiresAt) >= now) && !superseded.has(entry.id) && !contradicted.has(entry.id) && !(entry.contradicts || []).length)
      .sort((a, b) => kindRank[a.kind] - kindRank[b.kind] || String(a.title).localeCompare(String(b.title)) || String(a.id).localeCompare(String(b.id)));
    const items = []; let characters = 0;
    for (const entry of rows.slice(0, Math.max(0, Number(limit) || 0))) {
      const remaining = Math.max(0, Number(maxChars) - characters); if (remaining <= 0) break;
      const content = String(entry.content || "").slice(0, remaining); if (!content) continue;
      items.push({ id: entry.id, kind: entry.kind, title: entry.title, content, verification: entry.verification, updatedAt: entry.updatedAt, expiresAt: entry.expiresAt || null }); characters += content.length;
    }
    return { schemaVersion: 1, projectKey: this.identity.projectKey, outcome: "succeeded", items, candidates: rows.length, characters, truncated: items.length < rows.length };
  }
  compileCurrent({ apply = false, limit = 40 } = {}) {
    const notes = Object.fromEntries(MEMORY_KINDS.map((kind) => [kind, this.readKind(kind)])); const invalid = Object.entries(notes).filter(([, note]) => note.exists && !note.integrity.ok);
    if (invalid.length) return { kind: "current", entries: 0, revision: notes.current.revision, applied: false, outcome: "blocked", reason: "integrity", invalidKinds: invalid.map(([kind]) => kind), issues: [...new Set(invalid.flatMap(([, note]) => note.integrity.issues))].sort() };
    const rows = this.list({ kinds: WRITABLE_KINDS, includeExpired: false, limit: Infinity }).filter((entry) => ["verified", "corroborated"].includes(entry.verification));
    const selected = rows.sort((a, b) => (VERIFICATION_RANK[b.verification] || 0) - (VERIFICATION_RANK[a.verification] || 0) || String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit);
    const entries = selected.map((entry) => ({ ...entry, content: `[${entry.kind}; ${entry.verification}; source ${entry.source.note}] ${entry.content}` }));
    const rendered = renderNote(this.identity, "current", entries, new Date(this.clock()).toISOString()); const file = this.notePath("current");
    if (apply && this.writeEnabled) atomicWrite(file, rendered.text, this.vault);
    return { kind: "current", entries: entries.length, revision: rendered.contentHash, applied: Boolean(apply && this.writeEnabled), file: path.relative(this.vault, file).replace(/\\/g, "/") };
  }
  status() {
    const kinds = Object.fromEntries(MEMORY_KINDS.map((kind) => { const note = this.readKind(kind); return [kind, { exists: note.exists, entries: note.entries.length, revision: note.revision, managed: note.managed, integrity: note.integrity }]; }));
    return { schemaVersion: 1, projectKey: this.identity.projectKey, projectFolder: projectFolderName(this.identity), writeEnabled: this.writeEnabled, kinds, decisionState: this.decisions.status(), diagnosticReview: diagnosticReviewSummary(this.decisions.dir) };
  }
}

module.exports = { ENTRY_PREFIX, REVIEW_RESOLUTION_KIND, REVIEW_RESOLUTION_STATUS, ProjectMemoryStore, ensureManagedDirectory, atomicWrite, safeRead, parseEntries, validateManagedNote, renderEntry, renderNote, diagnosticReviewSummary, reviewRowKey };
