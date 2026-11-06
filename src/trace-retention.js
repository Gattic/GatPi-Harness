"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { withStorageLock, hardenPrivateFile } = require("./file-integration-storage");
const { readDebugProtected } = require("./state-retention");
const { inspectTracePrivacy } = require("./runtime-cleanup");

const TRACE_FILE = /^[A-Za-z0-9_-]+\.jsonl(?:\.\d+\.\d+)?$/;
function traceProjectPrefix(cwd) { return `${crypto.createHash("sha256").update(fs.realpathSync(cwd)).digest("hex")}--`; }
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; }
}
function settled(file, size) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const bytes = Math.min(size, 4096); const buffer = Buffer.alloc(bytes);
    fs.readSync(fd, buffer, 0, bytes, size - bytes);
    const last = buffer.toString("utf8").trim().split("\n").at(-1);
    try { return JSON.parse(last).name === "session_shutdown"; } catch { return false; }
  } finally { fs.closeSync(fd); }
}
// Retention that only fires once the store is already at the byte cap leaves no
// room for the next session, so the store sits pinned at the ceiling forever.
// Prune down to a target below the cap instead, and report the cap separately.
const DEFAULT_HEADROOM_RATIO = 0.25;
function headroomTarget(maxTotalBytes, headroomRatio = DEFAULT_HEADROOM_RATIO) {
  const ratio = Number(headroomRatio);
  const bounded = Number.isFinite(ratio) && ratio >= 0 && ratio < 1 ? ratio : DEFAULT_HEADROOM_RATIO;
  return Math.floor(maxTotalBytes * (1 - bounded));
}
function retainTraceFiles(root, { cwd = process.cwd(), maxTotalBytes = 128 * 1024 * 1024, headroomRatio = DEFAULT_HEADROOM_RATIO, maxFiles = 200, maxAgeDays = 14, graceMs = 86400000, protectedFiles = [], now = Date.now(), apply = false } = {}) {
  if (!fs.existsSync(root)) return { files: 0, bytes: 0, removedFiles: 0, removedBytes: 0, overBudget: false, targetBytes: headroomTarget(maxTotalBytes, headroomRatio), headroomRatio: Number(headroomRatio), candidates: [] };
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("unsafe trace directory");
  const collect = () => {
    const names = fs.readdirSync(root); const active = new Set(); let unknownOwner = false;
    for (const name of names.filter((name) => /^\.active-[A-Za-z0-9_-]+\.json$/.test(name))) {
      const file = path.join(root, name); let stat;
      try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) { unknownOwner = true; continue; }
      let owner;
      try { owner = JSON.parse(fs.readFileSync(file, "utf8")); } catch { unknownOwner = true; continue; }
      if (!/^[A-Za-z0-9_-]+\.jsonl$/.test(owner.file || "") || !Number.isInteger(owner.pid) || owner.pid <= 0) { unknownOwner = true; continue; }
      if (alive(owner.pid)) active.add(owner.file);
      else if (apply) fs.unlinkSync(file);
    }
    const projectPrefix = traceProjectPrefix(cwd);
    const protectedNames = new Set([...readDebugProtected(cwd), ...protectedFiles].map((ref) => path.basename(ref)));
    const entries = names.filter((name) => TRACE_FILE.test(name)).flatMap((name) => {
      const file = path.join(root, name); let stat;
      try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink()) return [];
      if (apply && (stat.mode & 0o777) !== 0o600) hardenPrivateFile(file);
      const unrotated = name.endsWith(".jsonl");
      const pinned = protectedNames.has(name) || fs.existsSync(`${file}.keep`);
      // Local debug references cannot authorize deleting foreign-project or
      // unattributed history. Ownership survives both closure and rotation.
      const owned = name.startsWith(projectPrefix);
      const grace = unrotated && now - stat.mtimeMs < graceMs && !settled(file, stat.size);
      return [{ name, file, stat, protected: !owned || pinned || (unrotated && (active.has(name) || unknownOwner || grace)) }];
    }).sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs || a.name.localeCompare(b.name));
    let bytes = entries.reduce((sum, row) => sum + row.stat.size, 0); let files = entries.length;
    const initialBytes = bytes; const candidates = []; let reviewRequiredFiles = 0;
    const targetBytes = headroomTarget(maxTotalBytes, headroomRatio);
    // Headroom only applies once the store has actually crossed its cap. A store
    // that is under the cap keeps all of its history; when it goes over, it is
    // pruned all the way down to the target so the next session has room instead
    // of landing back at the ceiling immediately.
    let trimming = false;
    for (const row of entries) {
      const expired = now - row.stat.mtimeMs > maxAgeDays * 86400000;
      if (!expired) {
        if (!trimming) {
          if (files <= maxFiles && bytes <= maxTotalBytes) continue;
          trimming = true;
        }
        if (files <= maxFiles && bytes <= targetBytes) continue;
      }
      if (row.protected) continue;
      if (inspectTracePrivacy(row.file, { fullScan: true })?.classification !== "metadata-only") { row.protected = true; reviewRequiredFiles++; continue; }
      if (apply) {
        let current;
        try { current = fs.lstatSync(row.file); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
        if (!current.isFile() || current.isSymbolicLink() || current.ino !== row.stat.ino || current.dev !== row.stat.dev || current.size !== row.stat.size || current.mtimeMs !== row.stat.mtimeMs) continue;
        fs.unlinkSync(row.file);
      }
      candidates.push({ name: row.name, bytes: row.stat.size }); files--; bytes -= row.stat.size;
    }
    if (apply) fs.chmodSync(root, 0o700);
    return { files, bytes, removedFiles: apply ? candidates.length : 0, removedBytes: apply ? initialBytes - bytes : 0, protectedFiles: entries.filter((row) => row.protected).length, overBudget: files > maxFiles || bytes > maxTotalBytes, targetBytes, headroomRatio: Number(headroomRatio), unknownOwner, reviewRequiredFiles, candidates };
  };
  return apply ? withStorageLock(path.join(root, ".retention"), collect) : collect();
}
module.exports = { TRACE_FILE, DEFAULT_HEADROOM_RATIO, headroomTarget, retainTraceFiles, traceProjectPrefix };
