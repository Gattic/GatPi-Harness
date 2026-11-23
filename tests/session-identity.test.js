"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parentSessionId, sessionIdHash } = require("../src/session-identity.js");

test("parentSessionId prefers explicit session ids over manager state", () => {
  assert.equal(parentSessionId({ session: { id: "explicit" }, sessionManager: { getSessionId: () => "manager" } }), "explicit");
  assert.equal(parentSessionId({ sessionId: "ctx-id", sessionManager: { getSessionId: () => "manager" } }), "ctx-id");
  assert.equal(parentSessionId({ sessionManager: { getSessionId: () => "manager" } }), "manager");
});

test("parentSessionId derives a stable fallback from the session file", () => {
  const derived = parentSessionId({ sessionManager: { getSessionFile: () => "/tmp/session.jsonl" } });
  assert.match(derived, /^session_[a-f0-9]{12}$/);
  assert.equal(parentSessionId({ sessionManager: { getSessionFile: () => "/tmp/session.jsonl" } }), derived);
  assert.equal(parentSessionId({}), "pi-session");
});

test("sessionIdHash is deterministic 16-hex for the same session", () => {
  const ctx = { sessionManager: { getSessionId: () => "memory-intent-test" } };
  const first = sessionIdHash(ctx);
  assert.match(first, /^[a-f0-9]{16}$/);
  assert.equal(sessionIdHash(ctx), first);
  assert.notEqual(sessionIdHash({ sessionManager: { getSessionId: () => "another-session" } }), first);
});
