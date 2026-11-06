"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { deflateSync } = require("node:zlib");
const { digest } = require("../src/subagent-task-contracts");
const { validatePreview, VIEW_NAMES, VIEW_SIZE, MAX_PREVIEW_BYTES } = require("../src/specialist-vision");
const { BLENDER_RECEIPT_BYTES } = require("../src/subagent-tasks");

const fixture = fs.readFileSync(path.join(__dirname, "fixtures/specialist-contact-sheet.png"));
const signature = fixture.subarray(0, 8), header = fixture.subarray(16, 29);
const rowBytes = VIEW_SIZE * VIEW_NAMES.length * 4 + 1, decodedBytes = rowBytes * VIEW_SIZE;
function chunk(type, data = Buffer.alloc(0)) {
  const encoded = Buffer.alloc(data.length + 12);
  encoded.writeUInt32BE(data.length); encoded.write(type, 4, "ascii"); data.copy(encoded, 8);
  let crc = 0xffffffff;
  for (const byte of encoded.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  encoded.writeUInt32BE((crc ^ 0xffffffff) >>> 0, encoded.length - 4);
  return encoded;
}
const png = (...chunks) => Buffer.concat([signature, chunk("IHDR", header), ...chunks, chunk("IEND")]);
const preview = bytes => ({ mimeType: "image/png", data: bytes.toString("base64"), digest: digest(bytes), views: VIEW_NAMES });
const reject = (bytes, label) => assert.throws(() => validatePreview(preview(bytes)), /TASK_VISUAL_PREVIEW_INVALID/, label);
const raw = Buffer.alloc(decodedBytes);
for (let row = 0; row < VIEW_SIZE; row++) raw[row * rowBytes] = row % 5;
const compressed = deflateSync(raw), half = Math.floor(compressed.length / 2);

test("checker PNGs accept full image data, all row filters and consecutive IDAT chunks", () => {
  for (const bytes of [fixture, png(chunk("IDAT", compressed)), png(chunk("sRGB", Buffer.from([0])), chunk("IDAT", compressed.subarray(0, half)), chunk("IDAT", compressed.subarray(half)))]) {
    assert.deepEqual(validatePreview(preview(bytes)), { type: "image", mimeType: "image/png", data: bytes.toString("base64") });
  }
});

test("reject header-only, truncated and trailing PNG data even with a matching digest", () => {
  for (const [label, bytes] of [
    ["24-byte header with dimensions but no image", fixture.subarray(0, 24)],
    ["truncated IDAT", fixture.subarray(0, 60)],
    ["missing IEND", fixture.subarray(0, -12)],
    ["partial IEND", fixture.subarray(0, -1)],
    ["bytes after IEND", Buffer.concat([fixture, Buffer.from([0])])],
  ]) reject(bytes, label);
});

test("reject invalid PNG chunk framing, order and checksums", () => {
  const badCrc = Buffer.from(fixture); badCrc[badCrc.length - 1] ^= 1;
  const oversizedChunk = Buffer.from(fixture); oversizedChunk.writeUInt32BE(0xffffffff, 33);
  for (const [label, bytes] of [
    ["wrong CRC", badCrc], ["out-of-bounds chunk length", oversizedChunk],
    ["duplicate IHDR", png(chunk("IHDR", header), chunk("IDAT", compressed))],
    ["unknown critical chunk", png(chunk("ABCD"), chunk("IDAT", compressed))],
    ["invalid chunk name", png(chunk("1BAD"), chunk("IDAT", compressed))],
    ["invalid reserved type bit", png(chunk("abca"), chunk("IDAT", compressed))],
    ["nonconsecutive IDAT", png(chunk("IDAT", compressed.subarray(0, half)), chunk("tEXt", Buffer.from("note\0fixture")), chunk("IDAT", compressed.subarray(half)))],
    ["missing IDAT", png()],
    ["nonempty IEND", Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", compressed), chunk("IEND", Buffer.from([0]))])],
  ]) reject(bytes, label);
});

test("reject malformed compressed data, scanlines and decompression beyond the fixed image size", () => {
  const badFilter = Buffer.from(raw); badFilter[rowBytes] = 5;
  const badZlibChecksum = Buffer.from(compressed); badZlibChecksum[badZlibChecksum.length - 1] ^= 1;
  for (const [label, data] of [
    ["invalid deflate stream", Buffer.from("not compressed")],
    ["truncated deflate stream", compressed.subarray(0, -1)],
    ["wrong zlib checksum", badZlibChecksum],
    ["trailing compressed bytes", Buffer.concat([compressed, Buffer.from([0])])],
    ["concatenated zlib streams", Buffer.concat([compressed, compressed])],
    ["short scanline data", deflateSync(raw.subarray(0, -1))],
    ["overlong scanline data", deflateSync(Buffer.alloc(decodedBytes + 1))],
    ["invalid row filter", deflateSync(badFilter)],
  ]) reject(png(chunk("IDAT", data)), label);
});

test("require the checker's non-interlaced 8-bit RGBA profile and valid IHDR fields", () => {
  for (const [offset, value] of [[8, 16], [9, 0], [10, 1], [11, 1], [12, 1]]) {
    const invalid = Buffer.from(header); invalid[offset] = value;
    reject(Buffer.concat([signature, chunk("IHDR", invalid), chunk("IDAT", compressed), chunk("IEND")]), `IHDR field ${offset}`);
  }
  reject(Buffer.concat([signature, chunk("IHDR", header.subarray(0, -1)), chunk("IDAT", compressed), chunk("IEND")]), "short IHDR");
});

test("a blender-asset acceptance receipt holds two encoded contact sheets", () => {
  // The executable and acceptance receipts both carry the preview the critic
  // reviews; a 256 KiB budget silently aborted verification once the sheet grew.
  const encoded = Math.ceil(MAX_PREVIEW_BYTES / 3) * 4;
  assert.ok(2 * encoded + 65536 <= BLENDER_RECEIPT_BYTES, `${2 * encoded + 65536} > ${BLENDER_RECEIPT_BYTES}`);
});
