"use strict";

// One session identity source for extensions. Recall, decisions and curation
// must attribute telemetry to the same hash, otherwise a curator save cannot
// resolve the shadow proposal produced by the runtime in that session.
const { createHash } = require("node:crypto");

function parentSessionId(ctx) {
  const explicit = ctx?.session?.id || ctx?.sessionId;
  if (explicit) return String(explicit);
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  if (sessionId) return String(sessionId);
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  if (sessionFile) return `session_${createHash("sha256").update(String(sessionFile)).digest("hex").slice(0, 12)}`;
  return "pi-session";
}

function sessionIdHash(ctx) {
  try { const id = parentSessionId(ctx); return id ? createHash("sha256").update(String(id)).digest("hex").slice(0, 16) : null; } catch { return null; }
}

module.exports = { parentSessionId, sessionIdHash };
