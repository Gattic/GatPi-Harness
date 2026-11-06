"use strict";

const crypto = require("node:crypto");
const { inflateSync } = require("node:zlib");
const MAX_ASSET_ATTEMPTS = 3;
const MAX_PREVIEW_BYTES = 393216;
const { VIEW_NAMES, VISUAL_CRITIQUE_SCHEMA } = require("./specialist-schemas");
const { validateJsonSchema } = require("./specialist-contracts");
const VIEW_SIZE = 384;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function validPng(bytes) {
  // The checker emits non-interlaced 8-bit RGBA, not arbitrary PNG profiles.
  // Validate the encoded image as well as its digest before sending it to a provider.
  const dataChunks = [];
  let offset = 8, dataEnded = false, paletteSeen = false, complete = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) return false;
    const length = bytes.readUInt32BE(offset), end = offset + length + 12;
    if (end > bytes.length) return false;
    const type = bytes.toString("latin1", offset + 4, offset + 8), data = bytes.subarray(offset + 8, end - 4);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return false;
    if (offset === 8 && type !== "IHDR") return false;
    if (dataChunks.length && type !== "IDAT") dataEnded = true;
    if (type === "IHDR") {
      if (offset !== 8 || length !== 13 || data[8] !== 8 || data[9] !== 6 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) return false;
    } else if (type === "IDAT") {
      if (dataEnded) return false;
      dataChunks.push(data);
    } else if (type === "IEND") {
      if (length !== 0 || !dataChunks.length || end !== bytes.length) return false;
      complete = true; break;
    } else if (type === "PLTE") {
      if (paletteSeen || dataChunks.length || length === 0 || length > 768 || length % 3) return false;
      paletteSeen = true;
    } else if (type[0] === type[0].toUpperCase()) return false;
    offset = end;
  }
  if (!complete) return false;
  const compressed = Buffer.concat(dataChunks), rowBytes = VIEW_SIZE * VIEW_NAMES.length * 4 + 1, expectedBytes = rowBytes * VIEW_SIZE;
  let decoded;
  try { decoded = inflateSync(compressed, { maxOutputLength: expectedBytes, info: true }); } catch { return false; }
  if (decoded.buffer.length !== expectedBytes || decoded.engine.bytesWritten !== compressed.length) return false;
  for (let row = 0; row < VIEW_SIZE; row++) if (decoded.buffer[row * rowBytes] > 4) return false;
  return true;
}
function validatePreview(preview) {
  if (!preview || preview.mimeType !== "image/png" || typeof preview.data !== "string" || preview.data.length > Math.ceil(MAX_PREVIEW_BYTES / 3) * 4) throw new Error("TASK_VISUAL_PREVIEW_INVALID");
  const bytes = Buffer.from(preview.data, "base64");
  if (bytes.length < 24 || bytes.length > MAX_PREVIEW_BYTES || bytes.toString("base64") !== preview.data || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || bytes.readUInt32BE(16) !== VIEW_SIZE * VIEW_NAMES.length || bytes.readUInt32BE(20) !== VIEW_SIZE || preview.digest !== `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}` || JSON.stringify(preview.views) !== JSON.stringify(VIEW_NAMES) || !validPng(bytes)) throw new Error("TASK_VISUAL_PREVIEW_INVALID");
  return { type: "image", mimeType: preview.mimeType, data: preview.data };
}
function validateCritique(critique, artifactDigest, previewDigest) {
  // Loaded lazily: role schemas also consume this data-only schema.
  const errors = validateJsonSchema(VISUAL_CRITIQUE_SCHEMA, critique);
  if (errors.length || critique.artifactDigest !== artifactDigest || critique.previewDigest !== previewDigest) return "invalid-or-stale-visual-critique";
  const descriptions = [...critique.observations.map(item => item.observation), ...critique.corrections.flatMap(item => [item.issue, item.action]), ...critique.limitations];
  if (descriptions.some(value => !value.trim())) return "invalid-or-stale-visual-critique";
  if (critique.verdict === "unable") return "visual-critic-unable-to-assess";
  if (new Set(critique.observations.map(item => item.view)).size !== VIEW_NAMES.length) return "incomplete-visual-coverage";
  if ((critique.verdict === "accept") !== (critique.corrections.length === 0)) return "inconsistent-visual-verdict";
  return null;
}
module.exports = { MAX_ASSET_ATTEMPTS, MAX_PREVIEW_BYTES, VIEW_NAMES, VIEW_SIZE, VISUAL_CRITIQUE_SCHEMA, validatePreview, validateCritique };
