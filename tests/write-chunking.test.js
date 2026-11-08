#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_SINGLE_PAYLOAD_LIMIT,
  normalizePayloadLimit,
  sectionedWriteRule,
  evaluateSinglePayload,
  appendFileSection,
} = require("../src/write-chunking.js");

// --- limit normalization -----------------------------------------------------
assert.equal(normalizePayloadLimit(undefined), DEFAULT_SINGLE_PAYLOAD_LIMIT);
assert.equal(normalizePayloadLimit(""), DEFAULT_SINGLE_PAYLOAD_LIMIT);
assert.equal(normalizePayloadLimit("   "), DEFAULT_SINGLE_PAYLOAD_LIMIT);
assert.equal(normalizePayloadLimit("nonsense"), DEFAULT_SINGLE_PAYLOAD_LIMIT);
assert.equal(normalizePayloadLimit(-1), DEFAULT_SINGLE_PAYLOAD_LIMIT);
assert.equal(normalizePayloadLimit("0"), 0, "zero is the explicit disable value");
assert.equal(normalizePayloadLimit("8192"), 8192);
assert.equal(normalizePayloadLimit(4096.9), 4096);

// --- shared rule wording -----------------------------------------------------
assert.equal(sectionedWriteRule(0), "", "no rule text when enforcement is disabled");
const rule = sectionedWriteRule(10);
assert.match(rule, /sections/);
assert.match(rule, /append_file/);
assert.match(rule, /within 10 characters/);

// --- payload evaluation ------------------------------------------------------
const overLimit = "x".repeat(11);
const atLimit = "x".repeat(10);

assert.deepEqual(evaluateSinglePayload({ toolName: "edit", input: { content: overLimit } }, { limit: 10 }), {
  ok: true,
  skipped: "tool",
}, "non-document tools are never inspected");
assert.deepEqual(evaluateSinglePayload({ toolName: "write", input: { path: "a.md" } }, { limit: 10 }), {
  ok: true,
  skipped: "content",
}, "a call without string content passes through to schema validation");

const allowed = evaluateSinglePayload({ toolName: "write", input: { path: "a.md", content: atLimit } }, { limit: 10 });
assert.equal(allowed.ok, true);
assert.equal(allowed.length, 10, "a payload exactly at the limit is allowed");

const blockedWrite = evaluateSinglePayload({ toolName: "write", input: { path: "plan.md", content: overLimit } }, { limit: 10 });
assert.equal(blockedWrite.blocked, true);
assert.equal(blockedWrite.length, 11);
assert.equal(blockedWrite.limit, 10);
assert.match(blockedWrite.reason, /11 characters/);
assert.match(blockedWrite.reason, /within 10 characters/);
assert.match(blockedWrite.reason, /append_file/);
assert.match(blockedWrite.reason, /Do not resend/);
assert(!blockedWrite.reason.includes("plan.md"), "the rejection names no file path");

const blockedAppend = evaluateSinglePayload({ toolName: "append_file", input: { path: "plan.md", content: overLimit } }, { limit: 10 });
assert.equal(blockedAppend.blocked, true, "appends are held to the same payload limit");

assert.equal(evaluateSinglePayload({ toolName: "write", input: { content: overLimit } }, { limit: 0 }).skipped, "disabled");

// --- sectioned append --------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-write-chunking-"));
try {
  const nested = path.join(root, "wiki", "subsystem-plans", "plan.md");
  const first = appendFileSection({ path: nested, content: "# Plan\n\n## Section 1", cwd: root });
  assert.equal(first.created, true, "append_file creates a missing file and its parents");
  assert.equal(first.path, nested);
  assert.equal(fs.readFileSync(nested, "utf8"), "# Plan\n\n## Section 1\n", "one trailing newline is added");

  const second = appendFileSection({ path: nested, content: "## Section 2", cwd: root });
  assert.equal(second.created, false);
  assert.equal(
    fs.readFileSync(nested, "utf8"),
    "# Plan\n\n## Section 1\n## Section 2\n",
    "an existing trailing newline is not duplicated",
  );

  const separated = path.join(root, "separated.md");
  fs.writeFileSync(separated, "no trailing newline", "utf8");
  appendFileSection({ path: separated, content: "next section", cwd: root });
  assert.equal(
    fs.readFileSync(separated, "utf8"),
    "no trailing newline\nnext section\n",
    "a missing separator newline is inserted before the appended section",
  );

  const emptyFile = path.join(root, "empty.md");
  fs.writeFileSync(emptyFile, "", "utf8");
  appendFileSection({ path: emptyFile, content: "first", cwd: root });
  assert.equal(fs.readFileSync(emptyFile, "utf8"), "first\n", "an empty file receives no leading separator");

  const absolute = path.join(root, "absolute.md");
  assert.equal(appendFileSection({ path: absolute, content: "body", cwd: "/" }).created, true, "absolute paths ignore cwd");

  assert.throws(() => appendFileSection({ path: nested, content: "", cwd: root }), /non-empty content/);
  assert.throws(() => appendFileSection({ path: "  ", content: "body", cwd: root }), /requires a path/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

// --- extension wiring --------------------------------------------------------
const source = fs.readFileSync("extensions/write-chunking/index.ts", "utf8");
assert.match(source, /name: "append_file"/);
assert.match(source, /pi\.on\("tool_call"/);
assert.match(source, /return \{ block: true, reason: decision\.reason \}/, "oversized payloads are blocked, not silently rewritten");
assert.match(source, /evaluateSinglePayload\(event, \{ limit \}\)/);
assert.match(source, /prepareLoadout/, "the write tool description carries the sectioned-write rule");
assert.match(source, /PI_WRITE_CHUNKING/);
assert.match(source, /PI_WRITE_CHUNK_LIMIT/);
assert.match(source, /instrumentExtensionCommands\(pi, \{ extension: "write-chunking" \}\)/, "the extension opts into metadata-only lifecycle telemetry");

console.log("write chunking tests passed");
