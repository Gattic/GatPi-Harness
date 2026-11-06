"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { publicRecord } = require("./subagent-lifecycle");

const FINAL_SUBAGENT_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const DEFAULT_MAX_FINAL_SUBAGENTS = 4;
const SESSION_CACHE = new Map();
const SESSION_METADATA_CACHE = new Map();
// records directory -> Map(record file name -> projected record), keyed by record and
// result stat signatures so an idle refresh does not reread unchanged subagent state.
const SUBAGENT_RECORD_CACHE = new Map();
const MAX_SESSION_CACHE_ENTRIES = 64;
const MAX_SESSION_METADATA_CACHE_ENTRIES = 4096;
const SESSION_READ_CHUNK_BYTES = 1024 * 1024;
const SESSION_METADATA_PREFIX_BYTES = 64 * 1024;

function canonical(file) {
  if (!file) return null;
  return path.resolve(String(file));
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function applySessionRow(value, row) {
  if (!row || typeof row !== "object") return;
  if (row.type === "session") {
    value.header = row;
    return;
  }
  if (!row.id) return;
  value.entries.push(row);
  if (row.type === "session_info") value.name = row.name;
}

function appendCompleteSessionRows(file, start, end, value) {
  if (end <= start) return start;
  let fd;
  let position = start;
  let parsedBytes = start;
  let fragments = [];
  let fragmentBytes = 0;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.allocUnsafe(Math.min(SESSION_READ_CHUNK_BYTES, end - start));
    while (position < end) {
      const requested = Math.min(buffer.length, end - position);
      const bytesRead = fs.readSync(fd, buffer, 0, requested, position);
      if (bytesRead <= 0) break;
      let lineStart = 0;
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] !== 10) continue;
        const tail = buffer.subarray(lineStart, i);
        let lineBuffer;
        if (fragments.length) {
          fragments.push(Buffer.from(tail));
          fragmentBytes += tail.length;
          lineBuffer = Buffer.concat(fragments, fragmentBytes);
        } else {
          lineBuffer = tail;
        }
        const line = lineBuffer.toString("utf8").trim();
        if (line) {
          try { applySessionRow(value, JSON.parse(line)); } catch { /* Ignore malformed complete rows. */ }
        }
        fragments = [];
        fragmentBytes = 0;
        lineStart = i + 1;
        parsedBytes = position + lineStart;
      }
      if (lineStart < bytesRead) {
        const fragment = Buffer.from(buffer.subarray(lineStart, bytesRead));
        fragments.push(fragment);
        fragmentBytes += fragment.length;
      }
      position += bytesRead;
    }
    if (fragments.length && position === end) {
      const line = Buffer.concat(fragments, fragmentBytes).toString("utf8").trim();
      if (line) {
        try {
          applySessionRow(value, JSON.parse(line));
          parsedBytes = end;
        } catch { /* Keep the last complete newline offset for a later append. */ }
      }
    }
  } catch {
    return parsedBytes;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return parsedBytes;
}

function readSession(file) {
  const resolved = canonical(file);
  if (!resolved) return { file: null, header: null, entries: [], name: undefined };
  let stat;
  try { stat = fs.statSync(resolved); } catch { return { file: resolved, header: null, entries: [], name: undefined }; }
  let cached = SESSION_CACHE.get(resolved);
  const sameFile = cached?.dev === stat.dev && cached?.ino === stat.ino;
  const unchanged = sameFile && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.parsedBytes === stat.size;
  if (unchanged) return cached.value;

  const replaced = !sameFile || stat.size < (cached?.size || 0) || (cached?.size === stat.size && cached?.mtimeMs !== stat.mtimeMs);
  if (!cached || replaced) {
    cached = {
      dev: stat.dev,
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
      size: 0,
      parsedBytes: 0,
      value: { file: resolved, header: null, entries: [], name: undefined },
    };
  }
  cached.parsedBytes = appendCompleteSessionRows(resolved, cached.parsedBytes, stat.size, cached.value);
  cached.dev = stat.dev;
  cached.ino = stat.ino;
  cached.mtimeMs = stat.mtimeMs;
  cached.size = stat.size;
  SESSION_CACHE.delete(resolved);
  SESSION_CACHE.set(resolved, cached);
  while (SESSION_CACHE.size > MAX_SESSION_CACHE_ENTRIES) SESSION_CACHE.delete(SESSION_CACHE.keys().next().value);
  return cached.value;
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content?.text || content?.content || "");
  return content.map((part) => {
    if (!part) return "";
    if (part.type === "thinking" || part.type === "reasoning") return "";
    if (part.type === "toolCall") {
      const args = JSON.stringify(part.arguments || {});
      return `→ ${part.name || "tool"}${args === "{}" ? "" : ` ${args}`}`;
    }
    return part.text || part.content || "";
  }).filter(Boolean).join("\n");
}

function textContentPreview(content, max = 256) {
  if (typeof content === "string") return content.slice(0, max);
  const parts = Array.isArray(content) ? content : [content];
  let preview = "";
  for (const part of parts) {
    if (!part || part.type === "thinking" || part.type === "reasoning") continue;
    const value = typeof part === "string" ? part : part.text || part.content || "";
    if (!value) continue;
    if (preview) preview += "\n";
    preview += String(value).slice(0, Math.max(0, max - preview.length));
    if (preview.length >= max) break;
  }
  return preview;
}

function entryText(entry) {
  if (!entry) return "";
  if (entry.type === "message") {
    const message = entry.message || {};
    const role = message.role === "user" ? "You" : message.role === "assistant" ? "Assistant" : message.role === "toolResult" ? `Tool · ${message.toolName || "result"}` : message.role || "Message";
    const text = textContent(message.content).trim();
    return text ? `${role}\n${text}` : "";
  }
  if (entry.type === "custom_message" && entry.display !== false) {
    const text = textContent(entry.content).trim();
    return text ? `${entry.customType || "Extension"}\n${text}` : "";
  }
  if (entry.type === "compaction") return `Compaction\n${entry.summary || ""}`.trim();
  if (entry.type === "branch_summary") return `Branch summary\n${entry.summary || ""}`.trim();
  return "";
}

function sessionLeaves(entries) {
  const parentIds = new Set(entries.map((entry) => entry?.parentId).filter(Boolean));
  return entries.filter((entry) => entry?.id && !parentIds.has(entry.id));
}

function branchEntries(entries, leafId) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const out = [];
  let current = leafId ? byId.get(leafId) : entries.at(-1);
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    out.push(current);
    current = current.parentId ? byId.get(current.parentId) : null;
  }
  return out.reverse();
}

function transcriptFromEntries(entries, leafId) {
  return branchEntries(entries, leafId).map(entryText).filter(Boolean);
}

function previewForLeaf(entries, leafId, max = 70) {
  const branch = branchEntries(entries, leafId);
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const text = textContent(entry.message.content).replace(/\s+/g, " ").trim();
    if (text) return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }
  return "alternate path";
}

function parseSessionMetadataPrefix(file, size) {
  let fd;
  try {
    const length = Math.min(size, SESSION_METADATA_PREFIX_BYTES);
    if (length <= 0) return { header: null, firstMessage: "", name: undefined };
    fd = fs.openSync(file, "r");
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
    const rows = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    let header = null;
    let firstMessage = "";
    let name;
    for (const line of rows) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row?.type === "session" && !header) header = row;
      else if (row?.type === "session_info") name = row.name;
      else if (!firstMessage && row?.type === "message" && row.message?.role === "user") {
        firstMessage = textContentPreview(row.message.content);
        break;
      }
    }
    return { header, firstMessage, name };
  } catch {
    return { header: null, firstMessage: "", name: undefined };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function sessionInfoFromFile(file) {
  const resolved = canonical(file);
  if (!resolved) return null;
  let stat;
  try { stat = fs.statSync(resolved); } catch {
    return {
      path: resolved,
      id: resolved,
      cwd: "",
      parentSessionPath: undefined,
      created: new Date(0),
      modified: new Date(0),
      firstMessage: "",
    };
  }
  let cached = SESSION_METADATA_CACHE.get(resolved);
  const sameFile = cached?.dev === stat.dev && cached?.ino === stat.ino;
  const unchanged = sameFile && cached?.size === stat.size && cached?.mtimeMs === stat.mtimeMs;
  const reusableAppend = sameFile && stat.size > (cached?.size || 0) && cached?.header && cached?.firstMessage;
  if (reusableAppend) {
    // Session headers and first messages are immutable; an append only changes recency.
    cached.size = stat.size;
    cached.mtimeMs = stat.mtimeMs;
  } else if (!unchanged) {
    const parsed = parseSessionMetadataPrefix(resolved, stat.size);
    cached = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ...parsed };
  }
  SESSION_METADATA_CACHE.delete(resolved);
  SESSION_METADATA_CACHE.set(resolved, cached);
  while (SESSION_METADATA_CACHE.size > MAX_SESSION_METADATA_CACHE_ENTRIES) {
    SESSION_METADATA_CACHE.delete(SESSION_METADATA_CACHE.keys().next().value);
  }
  const header = cached.header;
  return {
    path: resolved,
    id: header?.id || resolved,
    cwd: header?.cwd || "",
    name: cached.name,
    parentSessionPath: header?.parentSession ? canonical(header.parentSession) : undefined,
    created: header?.timestamp ? new Date(header.timestamp) : stat.birthtime || stat.ctime || new Date(0),
    modified: stat.mtime || new Date(0),
    firstMessage: cached.firstMessage,
  };
}

function expandHome(file) {
  if (file === "~") return os.homedir();
  if (file?.startsWith("~/")) return path.join(os.homedir(), file.slice(2));
  return file;
}

function defaultSessionDir(cwd) {
  const custom = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (custom) return path.resolve(expandHome(custom));
  const agentDir = path.resolve(expandHome(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")));
  const resolvedCwd = path.resolve(cwd || process.cwd());
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(agentDir, "sessions", safePath);
}

function listSessionMetadata({ cwd, currentSessionFile } = {}) {
  const dirs = new Set([defaultSessionDir(cwd)]);
  const currentPath = canonical(currentSessionFile);
  if (currentPath) dirs.add(path.dirname(currentPath));
  const files = new Set();
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) if (name.endsWith(".jsonl")) files.add(path.join(dir, name));
  }
  if (currentPath) files.add(currentPath);
  const resolvedCwd = canonical(cwd);
  return [...files]
    .map(sessionInfoFromFile)
    .filter(Boolean)
    .filter((info) => !resolvedCwd || !info.cwd || canonical(info.cwd) === resolvedCwd || canonical(info.path) === currentPath)
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

function sameFocusTargets(left = [], right = []) {
  if (left.length !== right.length) return false;
  const fields = ["key", "kind", "label", "detail", "sessionPath", "sessionId", "leafId", "current", "status", "final", "workspacePath", "sessionVersion", "resultVersion"];
  return left.every((target, index) => fields.every((field) => target?.[field] === right[index]?.[field]));
}

function connectedSessionFamily(sessions, currentFile) {
  const currentPath = canonical(currentFile);
  const byPath = new Map();
  for (const info of sessions || []) {
    const file = canonical(info?.path || info?.file);
    if (!file) continue;
    byPath.set(file, { ...info, path: file, parentSessionPath: canonical(info.parentSessionPath || info.parentSession) || undefined });
  }
  if (currentPath && !byPath.has(currentPath)) byPath.set(currentPath, sessionInfoFromFile(currentPath));
  if (!currentPath) return [];

  const family = new Set([currentPath]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [file, info] of byPath) {
      const parent = canonical(info.parentSessionPath);
      if ((family.has(file) && parent && !family.has(parent)) || (parent && family.has(parent) && !family.has(file))) {
        if (parent) family.add(parent);
        family.add(file);
        changed = true;
      }
    }
  }

  const rows = [...family].map((file) => byPath.get(file) || sessionInfoFromFile(file)).filter(Boolean);
  const depth = (info) => {
    let n = 0;
    let parent = canonical(info.parentSessionPath);
    const seen = new Set();
    while (parent && byPath.has(parent) && !seen.has(parent)) { seen.add(parent); n += 1; parent = canonical(byPath.get(parent).parentSessionPath); }
    return n;
  };
  return rows.sort((a, b) => depth(a) - depth(b) || new Date(a.created || 0) - new Date(b.created || 0));
}

function newestJsonl(dir) {
  const found = [];
  function walk(current, depth) {
    if (depth > 2) return;
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try { found.push({ file, mtime: fs.statSync(file).mtimeMs }); } catch {}
      }
    }
  }
  walk(dir, 0);
  return found.sort((a, b) => b.mtime - a.mtime)[0]?.file || null;
}

function fileVersion(file) {
  if (!file) return undefined;
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
}

function statSignature(stat) {
  return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` : undefined;
}

function loadSubagentRecord(cwd, recordFile, cached) {
  // Stat before reading so a replacement that races the read is seen as a change next refresh.
  const recordSignature = statSignature(fs.statSync(recordFile, { throwIfNoEntry: false }));
  if (!recordSignature) return undefined;
  if (cached?.recordSignature === recordSignature
    && (!cached.entry || statSignature(fs.statSync(cached.resultFile, { throwIfNoEntry: false })) === cached.resultSignature)) {
    return cached;
  }
  const record = readJson(recordFile);
  if (!record) return { recordSignature, entry: null };
  const resultFile = path.join(cwd, ".pi", "subagents", "results", `${record.id}.json`);
  const resultStat = fs.statSync(resultFile, { throwIfNoEntry: false });
  const result = readJson(resultFile);
  return {
    recordSignature,
    resultFile,
    resultSignature: statSignature(resultStat),
    parentSessionId: record.parentSessionId,
    entry: {
      ...publicRecord(record, result),
      resultVersion: resultStat ? `${resultStat.size}:${resultStat.mtimeMs}` : undefined,
      sessionFile: null,
      sessionVersion: undefined,
      workspacePath: null,
      explicitSessionFile: canonical(result?.diagnostics?.pi_session_file || record?.diagnostics?.pi_session_file),
      final: FINAL_SUBAGENT_STATUSES.has(record.status),
    },
  };
}

function isSubagentSession(cwd, subagent, sessionPath) {
  if (!sessionPath) return false;
  const rpcDir = canonical(path.join(cwd, ".pi", "subagents", "rpc-sessions", subagent.id));
  // Only the explicit session file or a file in this subagent's RPC directory can match,
  // so the other records need no filesystem access on each refresh.
  if (subagent.explicitSessionFile !== sessionPath && !sessionPath.startsWith(rpcDir + path.sep)) return false;
  const runtimeSessionFile = subagent.explicitSessionFile && fs.existsSync(subagent.explicitSessionFile)
    ? subagent.explicitSessionFile
    : newestJsonl(rpcDir);
  return canonical(runtimeSessionFile) === sessionPath;
}

function readSubagentRecords(cwd, parentSessionIds = []) {
  const ids = new Set((parentSessionIds || []).filter(Boolean).map(String));
  const recordsDir = path.join(cwd, ".pi", "subagents", "records");
  let names = [];
  try { names = fs.readdirSync(recordsDir).filter((name) => name.endsWith(".json")); } catch {}
  const previous = SUBAGENT_RECORD_CACHE.get(recordsDir);
  const current = new Map();
  for (const name of names) {
    const loaded = loadSubagentRecord(cwd, path.join(recordsDir, name), previous?.get(name));
    if (loaded) current.set(name, loaded);
  }
  SUBAGENT_RECORD_CACHE.set(recordsDir, current);
  return [...current.values()]
    .filter((cached) => cached.entry && (ids.size === 0 || ids.has(String(cached.parentSessionId))))
    .map((cached) => cached.entry)
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
}

function subagentRecency(record) {
  const parsed = Date.parse(record?.updatedAt || record?.finishedAt || record?.createdAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function selectVisibleSubagents(records = [], { maxFinalSubagents = DEFAULT_MAX_FINAL_SUBAGENTS, currentSubagentId } = {}) {
  const configuredLimit = Number(maxFinalSubagents);
  const limit = Number.isFinite(configuredLimit) ? Math.max(0, Math.floor(configuredLimit)) : DEFAULT_MAX_FINAL_SUBAGENTS;
  const finalByRecency = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => FINAL_SUBAGENT_STATUSES.has(record.status))
    .sort((a, b) => subagentRecency(b.record) - subagentRecency(a.record) || b.index - a.index)
    .map(({ record }) => record);
  let selectedFinal = finalByRecency.slice(0, limit);
  const currentFinal = finalByRecency.find((record) => record.id === currentSubagentId);
  if (currentFinal && !selectedFinal.some((record) => record.id === currentFinal.id)) {
    selectedFinal = limit > 0 ? [currentFinal, ...selectedFinal].slice(0, limit) : [currentFinal];
  }
  const selectedFinalIds = new Set(selectedFinal.map((record) => record.id));
  return records.filter((record) => !FINAL_SUBAGENT_STATUSES.has(record.status) || selectedFinalIds.has(record.id));
}

function sessionLabel(info, rootPath) {
  if (canonical(info.path) === rootPath) return "Main";
  return info.name || String(info.firstMessage || "Fork").replace(/\s+/g, " ").trim().slice(0, 28) || "Fork";
}

function buildFocusTargets({ cwd, sessions = [], currentSessionFile, currentSessionId, currentLeafId, currentSessionEntries, maxFinalSubagents = DEFAULT_MAX_FINAL_SUBAGENTS } = {}) {
  const currentPath = canonical(currentSessionFile);
  const projectCwd = cwd || process.cwd();
  const allSubagents = readSubagentRecords(projectCwd);
  const currentSubagent = allSubagents.find((record) => isSubagentSession(projectCwd, record, currentPath));
  const parentInfo = currentSubagent
    ? sessions.find((info) => String(info.id) === String(currentSubagent.parentSessionId)) || null
    : null;
  const familySessions = parentInfo && !sessions.some((info) => canonical(info.path) === canonical(parentInfo.path)) ? [...sessions, parentInfo] : sessions;
  const family = connectedSessionFamily(familySessions, parentInfo?.path || currentPath);
  if (!family.length && !currentPath) return [];
  const familyPaths = new Set(family.map((info) => canonical(info.path)));
  const root = family.find((info) => !info.parentSessionPath || !familyPaths.has(canonical(info.parentSessionPath))) || family[0];
  const rootPath = canonical(root?.path);
  const targets = [];

  for (const info of family) {
    const isCurrentSession = canonical(info.path) === currentPath;
    const parsed = isCurrentSession && Array.isArray(currentSessionEntries)
      ? {
          entries: currentSessionEntries,
          name: currentSessionEntries.filter((entry) => entry?.type === "session_info").at(-1)?.name,
        }
      : readSession(info.path);
    const leaves = sessionLeaves(parsed.entries);
    const canonicalLeaf = leaves.at(-1)?.id || parsed.entries.at(-1)?.id || null;
    const firstUser = parsed.entries.find((entry) => entry?.type === "message" && entry.message?.role === "user");
    const label = sessionLabel({
      ...info,
      name: info.name || parsed.name,
      firstMessage: info.firstMessage || (firstUser ? textContentPreview(firstUser.message.content) : ""),
    }, rootPath);
    targets.push({
      key: `session:${canonical(info.path)}`,
      kind: canonical(info.path) === rootPath ? "main" : "fork",
      label,
      sessionPath: canonical(info.path),
      sessionId: info.id || parsed.header?.id,
      leafId: canonicalLeaf,
      sessionVersion: fileVersion(info.path),
      current: canonical(info.path) === currentPath && (!currentLeafId || currentLeafId === canonicalLeaf),
      status: canonical(info.path) === currentPath ? "idle" : "saved",
      createdAt: info.created,
    });
    const currentEntry = canonical(info.path) === currentPath
      ? parsed.entries.find((entry) => entry.id === currentLeafId)
      : null;
    if (currentEntry && currentLeafId !== canonicalLeaf && !leaves.some((leaf) => leaf.id === currentLeafId)) {
      targets.push({
        key: `branch:${canonical(info.path)}:${currentLeafId}`,
        kind: "branch",
        label: `${label} · current point`,
        sessionPath: canonical(info.path),
        sessionId: info.id || parsed.header?.id,
        leafId: currentLeafId,
        current: true,
        status: "idle",
        createdAt: currentEntry.timestamp,
      });
    }
    for (const leaf of leaves) {
      if (!leaf?.id || leaf.id === canonicalLeaf) continue;
      targets.push({
        key: `branch:${canonical(info.path)}:${leaf.id}`,
        kind: "branch",
        label: `${label} · ${previewForLeaf(parsed.entries, leaf.id, 24)}`,
        sessionPath: canonical(info.path),
        sessionId: info.id || parsed.header?.id,
        leafId: leaf.id,
        current: canonical(info.path) === currentPath && currentLeafId === leaf.id,
        status: "saved",
        createdAt: leaf.timestamp,
      });
    }
  }

  const familyIds = family.map((info) => String(info.id)).filter(Boolean);
  if (!currentSubagent && currentSessionId && !familyIds.includes(String(currentSessionId))) familyIds.push(String(currentSessionId));
  const familySubagents = allSubagents.filter((record) => familyIds.includes(String(record.parentSessionId)));
  const visibleSubagents = selectVisibleSubagents(familySubagents, { maxFinalSubagents, currentSubagentId: currentSubagent?.id });
  for (const subagent of visibleSubagents) {
    targets.push({
      key: `subagent:${subagent.id}`,
      kind: "subagent",
      label: subagent.role || "worker",
      detail: [`task=${subagent.taskHash || "unavailable"}`, `attempt=${subagent.attempt || 1}`, `model=${subagent.diagnostics?.effectiveModel || subagent.diagnostics?.selectedModel || "unavailable"}`, `tools=${subagent.diagnostics?.toolCalls || 0}/${subagent.diagnostics?.toolResults || 0}`, `duration=${subagent.diagnostics?.totalDurationMs || 0}ms`, subagent.receiptId ? `receipt=${subagent.receiptId}` : ""].filter(Boolean).join(" · "),
      subagentId: subagent.id,
      workspacePath: subagent.workspacePath,
      parentSessionId: subagent.parentSessionId,
      sessionPath: subagent.sessionFile,
      leafId: null,
      sessionVersion: subagent.sessionVersion,
      resultVersion: subagent.resultVersion,
      current: isSubagentSession(projectCwd, subagent, currentPath),
      status: subagent.status,
      final: subagent.final,
      result: subagent.result,
      createdAt: subagent.createdAt,
    });
  }

  const rank = { main: 0, subagent: 1, fork: 2, branch: 3 };
  targets.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  return targets;
}

function transcriptForTarget(target) {
  if (!target) return ["No chat selected."];
  if (target.sessionPath) {
    const parsed = readSession(target.sessionPath);
    const transcript = transcriptFromEntries(parsed.entries, target.leafId || undefined);
    if (transcript.length) return transcript;
  }
  if (target.kind === "subagent") {
    const result = target.result || {};
    return [result.summary || (target.status === "running" ? "Subagent is working; Fleet transcript inspection is intentionally disabled." : "No bounded subagent summary was recorded."), target.detail || ""].filter(Boolean);
  }
  return ["This chat has no visible messages yet."];
}

function stepStripNavigation({ focused = false, direction, index = 0, targetCount = 0 } = {}) {
  const count = Math.max(0, Math.floor(Number(targetCount) || 0));
  const currentIndex = count ? Math.max(0, Math.min(Math.floor(Number(index) || 0), count - 1)) : 0;
  if (!count || !["up", "down"].includes(direction)) return { focused: false, index: currentIndex };
  if (!focused) return direction === "down" ? { focused: true, index: 0 } : { focused: false, index: currentIndex };
  if (direction === "down") return { focused: true, index: Math.min(count - 1, currentIndex + 1) };
  return currentIndex === 0 ? { focused: false, index: 0 } : { focused: true, index: currentIndex - 1 };
}

function stepFocusNavigation({ direction, index = 0, scroll = 0, maxScroll = 0, targetCount = 0 } = {}) {
  const count = Math.max(0, Math.floor(Number(targetCount) || 0));
  const currentIndex = count ? Math.max(0, Math.min(Math.floor(Number(index) || 0), count - 1)) : 0;
  const currentScroll = Math.max(0, Math.floor(Number(scroll) || 0));
  const end = Math.max(0, Math.floor(Number(maxScroll) || 0));
  if (!count || !["up", "down"].includes(direction)) return { index: currentIndex, scroll: currentScroll, followTail: currentScroll >= end, switched: false };

  if (direction === "down") {
    if (currentScroll < end) {
      const nextScroll = currentScroll + 1;
      return { index: currentIndex, scroll: nextScroll, followTail: nextScroll >= end, switched: false };
    }
    if (count === 1) return { index: currentIndex, scroll: currentScroll, followTail: true, switched: false };
    return { index: (currentIndex + 1) % count, scroll: 0, followTail: false, switched: true };
  }

  if (currentScroll > 0) return { index: currentIndex, scroll: currentScroll - 1, followTail: false, switched: false };
  if (count === 1) return { index: currentIndex, scroll: 0, followTail: false, switched: false };
  return { index: (currentIndex - 1 + count) % count, scroll: 0, followTail: true, switched: true };
}

function statusIcon(target, busy = false) {
  if (target.current && busy) return "◉";
  if (target.current) return "●";
  if (["running", "queued"].includes(target.status)) return "◉";
  if (target.status === "created") return "○";
  if (target.status === "succeeded") return "✓";
  if (["failed", "timed_out", "cancelled"].includes(target.status)) return "!";
  if (target.kind === "fork") return "◇";
  if (target.kind === "branch") return "⑂";
  return "○";
}

function tabLabel(target, index, { busy = false, focused = false, selectedIndex = -1 } = {}) {
  const working = target.current && busy ? " working" : "";
  const marker = focused && selectedIndex === index ? "▶" : "";
  return `${marker}[${index + 1} ${statusIcon(target, busy)} ${target.label}${working}]`;
}

function packTabRows(targets, width, options = {}) {
  const maxWidth = Math.max(20, Number(width) || 80);
  const maxRows = Math.max(2, Number(options.maxRows) || 3);
  if (options.focused && targets.length) {
    const index = Math.max(0, Math.min(Number(options.selectedIndex) || 0, targets.length - 1));
    return [
      `Chats · focused ${tabLabel(targets[index], index, { ...options, focused: true, selectedIndex: index })}`,
      "↑ previous/message · ↓ next · Enter inspect · Esc message",
    ].slice(0, maxRows);
  }
  const prefix = options.busy ? "Chats · working " : "Chats ";
  const hint = options.busy ? "↓ focus · F6 inspect · switch when idle" : "↓ focus · F6 inspect";
  const rows = [];
  let row = prefix;
  for (let i = 0; i < targets.length; i++) {
    const tab = tabLabel(targets[i], i, options);
    if (row.length > prefix.length && row.length + 1 + tab.length > maxWidth) { rows.push(row); row = "  "; }
    row += `${row.trim() ? " " : ""}${tab}`;
  }
  if (row.trim()) rows.push(row);
  if (!rows.length) rows.push(prefix.trim());
  if (rows.at(-1).length + 3 + hint.length <= maxWidth) rows[rows.length - 1] += ` · ${hint}`;
  else rows.push(hint);
  return rows.slice(0, maxRows);
}

module.exports = {
  FINAL_SUBAGENT_STATUSES,
  DEFAULT_MAX_FINAL_SUBAGENTS,
  readSession,
  textContent,
  entryText,
  sessionLeaves,
  branchEntries,
  transcriptFromEntries,
  connectedSessionFamily,
  listSessionMetadata,
  sameFocusTargets,
  readSubagentRecords,
  selectVisibleSubagents,
  buildFocusTargets,
  transcriptForTarget,
  stepStripNavigation,
  stepFocusNavigation,
  statusIcon,
  tabLabel,
  packTabRows,
};
