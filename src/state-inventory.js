"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");

const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_OVERLAP_CHARS = 512;

function finiteLimit(value, fallback = Infinity) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function sortedUniqueRoots(roots = []) {
  return [...new Set((roots || []).map((root) => path.resolve(String(root))))].sort();
}

function reasonCounter(rows = []) {
  const out = {};
  for (const row of rows) out[row.reason] = (out[row.reason] || 0) + 1;
  return out;
}

/**
 * Complete metadata walk. It never follows symlinks and never drops a regular
 * file because of size. Content budgets belong to scanTextInventory instead.
 */
function inventoryState(roots = [], options = {}) {
  const rootList = sortedUniqueRoots(roots);
  const files = [];
  const skippedEntries = [];
  const errors = [];
  let directories = 0;
  let discoveredBytes = 0;

  function walk(current, root) {
    let names;
    try { names = fs.readdirSync(current).sort(); }
    catch (error) { errors.push({ root, path: current, reason: "read-directory", code: error?.code || "UNKNOWN" }); return; }
    directories++;
    for (const name of names) {
      const item = path.join(current, name);
      let stat;
      try { stat = fs.lstatSync(item); }
      catch (error) { errors.push({ root, path: item, reason: "stat", code: error?.code || "UNKNOWN" }); continue; }
      if (stat.isSymbolicLink()) { skippedEntries.push({ root, path: item, reason: "symlink", bytes: stat.size }); continue; }
      if (stat.isDirectory()) { walk(item, root); continue; }
      if (!stat.isFile()) { skippedEntries.push({ root, path: item, reason: "non-regular", bytes: stat.size }); continue; }
      if (typeof options.includeFile === "function" && !options.includeFile(item, stat, root)) {
        skippedEntries.push({ root, path: item, reason: "filter", bytes: stat.size });
        continue;
      }
      const row = { root, path: item, bytes: stat.size, mode: stat.mode & 0o777, mtimeMs: stat.mtimeMs };
      files.push(row);
      discoveredBytes += stat.size;
    }
  }

  for (const root of rootList) {
    let stat;
    try { stat = fs.lstatSync(root); }
    catch (error) { errors.push({ root, path: root, reason: "root-stat", code: error?.code || "UNKNOWN" }); continue; }
    if (stat.isSymbolicLink()) { skippedEntries.push({ root, path: root, reason: "root-symlink", bytes: stat.size }); continue; }
    if (stat.isFile()) {
      if (!options.includeFile || options.includeFile(root, stat, root)) {
        files.push({ root, path: root, bytes: stat.size, mode: stat.mode & 0o777, mtimeMs: stat.mtimeMs });
        discoveredBytes += stat.size;
      } else skippedEntries.push({ root, path: root, reason: "filter", bytes: stat.size });
    } else if (stat.isDirectory()) walk(root, root);
    else skippedEntries.push({ root, path: root, reason: "root-non-regular", bytes: stat.size });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    schemaVersion: 1,
    roots: rootList,
    files,
    skippedEntries,
    errors,
    summary: {
      roots: rootList.length,
      directories,
      discoveredFiles: files.length,
      discoveredBytes,
      skippedEntries: skippedEntries.length,
      metadataErrors: errors.length,
      skippedReasons: reasonCounter(skippedEntries),
      complete: errors.length === 0,
    },
  };
}

function countNewlines(text) { return (String(text).match(/\n/g) || []).length; }

/** Stream UTF-8 text with a bounded overlap so regular expressions can match
 * across chunk boundaries. Callers deduplicate by absolute character offset. */
function scanTextFile(file, onChunk, options = {}) {
  const chunkBytes = Math.max(1024, finiteLimit(options.chunkBytes, DEFAULT_CHUNK_BYTES));
  const overlapChars = Math.max(0, finiteLimit(options.overlapChars, DEFAULT_OVERLAP_CHARS));
  const deadlineAt = Number.isFinite(options.deadlineAt) ? Number(options.deadlineAt) : Infinity;
  const buffer = Buffer.allocUnsafe(chunkBytes);
  const decoder = new StringDecoder("utf8");
  let fd;
  let carry = "";
  let processedChars = 0;
  let processedLines = 0;
  let bytesRead = 0;
  let chunks = 0;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) return { ok: false, reason: "non-regular", bytesRead, chunks };
    while (true) {
      if (Date.now() > deadlineAt) return { ok: false, reason: "deadline", bytesRead, chunks };
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      bytesRead += read;
      const piece = decoder.write(buffer.subarray(0, read));
      const text = carry + piece;
      const startChar = processedChars - carry.length;
      const lineAtStart = Math.max(0, processedLines - countNewlines(carry));
      onChunk({ text, startChar, lineAtStart, final: false });
      chunks++;
      processedChars += piece.length;
      processedLines += countNewlines(piece);
      carry = overlapChars ? text.slice(-overlapChars) : "";
    }
    const tail = decoder.end();
    if (tail) {
      const text = carry + tail;
      onChunk({ text, startChar: processedChars - carry.length, lineAtStart: Math.max(0, processedLines - countNewlines(carry)), final: true });
      processedChars += tail.length;
      processedLines += countNewlines(tail);
      chunks++;
    }
    return { ok: true, reason: null, bytesRead, chunks, characters: processedChars, lines: processedLines + 1 };
  } catch (error) {
    return { ok: false, reason: "read-error", code: error?.code || "UNKNOWN", bytesRead, chunks };
  } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

/**
 * Scan every inventoried file unless an explicit count/byte/deadline budget is
 * reached. Every discovered regular file is accounted as scanned, skipped, or
 * errored; incomplete scans can never look complete.
 */
function scanTextInventory(inventory, visitor, options = {}) {
  const maxFiles = finiteLimit(options.maxFiles, Infinity);
  const maxBytes = finiteLimit(options.maxBytes, Infinity);
  const deadlineAt = Number.isFinite(options.deadlineMs) && Number(options.deadlineMs) > 0 ? Date.now() + Number(options.deadlineMs) : Infinity;
  const scanned = [];
  const skipped = [];
  const errors = [];
  let scannedBytes = 0;

  for (const file of inventory.files || []) {
    if (scanned.length >= maxFiles) { skipped.push({ ...file, reason: "file-limit" }); continue; }
    if (scannedBytes + file.bytes > maxBytes) { skipped.push({ ...file, reason: "byte-limit" }); continue; }
    if (Date.now() > deadlineAt) { skipped.push({ ...file, reason: "deadline" }); continue; }
    let visitResult;
    try {
      visitResult = visitor(file, { deadlineAt, scanTextFile });
    } catch (error) {
      errors.push({ ...file, reason: "visitor-error", code: error?.code || "UNKNOWN" });
      continue;
    }
    if (visitResult?.ok === false) {
      const target = visitResult.reason === "deadline" ? skipped : errors;
      target.push({ ...file, reason: visitResult.reason || "scan-error", code: visitResult.code });
      continue;
    }
    scanned.push({ ...file, bytesRead: visitResult?.bytesRead ?? file.bytes });
    scannedBytes += file.bytes;
  }

  const discoveredFiles = inventory.files?.length || 0;
  const accountedFiles = scanned.length + skipped.length + errors.length;
  const summary = {
    discoveredFiles,
    discoveredBytes: inventory.summary?.discoveredBytes || 0,
    scannedFiles: scanned.length,
    scannedBytes,
    skippedFiles: skipped.length,
    erroredFiles: errors.length,
    accountedFiles,
    skippedReasons: reasonCounter(skipped),
    errorReasons: reasonCounter(errors),
    identityHolds: discoveredFiles === accountedFiles,
    complete: Boolean(inventory.summary?.complete !== false && discoveredFiles === accountedFiles && skipped.length === 0 && errors.length === 0),
  };
  return { schemaVersion: 1, scanned, skipped, errors, summary };
}

module.exports = { DEFAULT_CHUNK_BYTES, DEFAULT_OVERLAP_CHARS, inventoryState, scanTextFile, scanTextInventory };
