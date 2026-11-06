"use strict";

const path = require("node:path");
const crypto = require("node:crypto");
const { LspClient } = require("./lsp-client.js");
const { serverRegistry } = require("./lsp-server-registry.js");

function configurationHash(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value || "default")).digest("hex").slice(0, 16); }
function sessionKey({ root, server, language, configuration }) { return [path.resolve(root), server.id, language, configurationHash(configuration)].join("::"); }
function classifyFailure(error) {
  const code = error?.code;
  if (code === "LSP_TIMEOUT") return { code: "timeout", retryable: true, message: error.message };
  if (code === "ABORT_ERR" || error?.name === "AbortError") return { code: "cancelled", retryable: true, message: error.message };
  if (code === "LSP_PROCESS_EXIT") return { code: "server_crash", retryable: true, message: error.message, exit: error.exit };
  if (code === "ENOENT") return { code: "server_missing", retryable: false, message: error.message };
  return { code: "lsp_error", retryable: false, message: String(error?.message || error) };
}
class LspSessionManager {
  constructor(options = {}) {
    this.registry = options.registry || serverRegistry(options.env, options.registryOptions);
    this.Client = options.Client || LspClient;
    this.clientOptions = options.clientOptions || {};
    this.sessions = new Map();
    this.timeoutMs = Number(options.timeoutMs || 30000);
  }
  serverFor(language, preferredId) {
    const candidates = this.registry.candidates(language);
    if (preferredId) return candidates.find((candidate) => candidate.id === preferredId && candidate.executable?.found !== false) || null;
    return this.registry.forLanguage(language);
  }
  peek(input) {
    const server = input.server || this.serverFor(input.language, input.serverId);
    if (!server) return null;
    return this.sessions.get(sessionKey({ ...input, server })) || null;
  }
  async get(input, options = {}) {
    const root = path.resolve(input.root);
    const server = input.server || this.serverFor(input.language, input.serverId);
    if (!server) return null;
    const key = sessionKey({ ...input, root, server });
    let session = this.sessions.get(key);
    if (session?.client?.exit) { this.sessions.delete(key); session = null; }
    if (!session) {
      const client = new this.Client({ command: server.command, args: server.args, cwd: root, timeoutMs: options.timeoutMs || this.timeoutMs, ...this.clientOptions });
      session = { key, root, language: input.language, configurationHash: configurationHash(input.configuration), server, client, capabilities: {}, startedAt: null, restartCount: Number(input.restartCount || 0) };
      this.sessions.set(key, session);
      client.on?.("exit", () => { session.exited = true; });
    }
    if (!session.client.initialized) {
      session.startedAt = new Date().toISOString();
      try {
        const initialized = await session.client.initialize({ timeoutMs: options.timeoutMs || this.timeoutMs, signal: options.signal, initializationOptions: input.initializationOptions });
        session.capabilities = initialized?.capabilities || {};
        session.serverInfo = initialized?.serverInfo || null;
      } catch (error) {
        session.degradation = classifyFailure(error);
        throw error;
      }
    }
    return session;
  }
  async request(input, method, params, options = {}) {
    const session = await this.get(input, options);
    if (!session) return { available: false, degradation: { code: "server_unavailable", message: `No language server available for ${input.language}`, retryable: false } };
    try {
      const result = await session.client.request(method, params, { timeoutMs: options.timeoutMs || this.timeoutMs, signal: options.signal });
      return { available: true, result, session };
    } catch (error) {
      const degradation = classifyFailure(error);
      session.degradation = degradation;
      if (degradation.code === "server_crash") this.sessions.delete(session.key);
      return { available: true, error, degradation, session };
    }
  }
  async closeAll(options = {}) {
    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.client.shutdown(options)));
    return { closed: sessions.length };
  }
  status() {
    return { registry: this.registry.status(), sessions: Array.from(this.sessions.values()).map((session) => ({ key: session.key, root: session.root, language: session.language, server: session.server.id, configurationHash: session.configurationHash, capabilities: session.capabilities, degradation: session.degradation || null, client: session.client.status() })) };
  }
}

module.exports = { LspSessionManager, sessionKey, configurationHash, classifyFailure };
