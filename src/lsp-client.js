"use strict";

const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

function abortError(message = "LSP request aborted") { const error = new Error(message); error.name = "AbortError"; error.code = "ABORT_ERR"; return error; }
function rpcError(error, method) { const out = new Error(error?.message || `LSP request failed: ${method}`); out.code = error?.code || "LSP_ERROR"; out.data = error?.data; return out; }
class LspClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.command = options.command;
    this.args = options.args || [];
    this.cwd = options.cwd || process.cwd();
    this.env = options.env || process.env;
    this.spawn = options.spawn || spawn;
    this.defaultTimeoutMs = Math.max(100, Number(options.timeoutMs || 30000));
    this.maxStderrBytes = Math.max(1024, Number(options.maxStderrBytes || 64 * 1024));
    this.process = null;
    this.buffer = Buffer.alloc(0);
    this.stderr = "";
    this.pending = new Map();
    this.nextId = 1;
    this.capabilities = {};
    this.serverInfo = null;
    this.initialized = false;
    this.stopped = false;
    this.exit = null;
    this.diagnostics = new Map();
    this.documents = new Map();
  }
  start() {
    if (this.process && !this.exit) return this;
    if (!this.command) throw new Error("LSP command is required");
    this.stopped = false;
    this.exit = null;
    this.buffer = Buffer.alloc(0);
    const child = this.spawn(this.command, this.args, { cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.process = child;
    child.stdout.on("data", (chunk) => this._onData(chunk));
    child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${String(chunk)}`.slice(-this.maxStderrBytes); this.emit("stderr", String(chunk)); });
    child.on("error", (error) => this._onExit(null, null, error));
    child.on("exit", (code, signal) => this._onExit(code, signal));
    return this;
  }
  _write(message) {
    if (!this.process || this.exit || !this.process.stdin.writable) throw new Error("LSP process is not running");
    const json = JSON.stringify({ jsonrpc: "2.0", ...message });
    this.process.stdin.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
  }
  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd).toString("ascii");
      const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
      if (!match) { this.buffer = this.buffer.slice(headerEnd + 4); continue; }
      const length = Number(match[1]);
      if (this.buffer.length < headerEnd + 4 + length) return;
      const body = this.buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
      this.buffer = this.buffer.slice(headerEnd + 4 + length);
      try { this._onMessage(JSON.parse(body)); } catch (error) { this.emit("protocolError", error); }
    }
  }
  _onMessage(message) {
    if (message.id != null && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.cleanup?.();
      if (message.error) pending.reject(rpcError(message.error, pending.method)); else pending.resolve(message.result);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      this.diagnostics.set(message.params?.uri, message.params?.diagnostics || []);
      this.emit("diagnostics", message.params || {});
    }
    if (message.id != null && message.method) {
      this._write({ id: message.id, error: { code: -32601, message: `Client method not supported: ${message.method}` } });
      return;
    }
    this.emit("notification", message.method, message.params);
  }
  _onExit(code, signal, error) {
    if (this.exit) return;
    this.exit = { code, signal, error: error ? String(error?.message || error) : null, stderr: this.stderr };
    this.initialized = false;
    const failure = new Error(error?.message || `LSP process exited (${code ?? signal ?? "unknown"})`);
    failure.code = "LSP_PROCESS_EXIT";
    failure.exit = this.exit;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.cleanup?.(); pending.reject(failure); }
    this.pending.clear();
    this.emit("exit", this.exit);
  }
  request(method, params, options = {}) {
    this.start();
    const id = this.nextId++;
    const timeoutMs = Math.max(1, Number(options.timeoutMs || this.defaultTimeoutMs));
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) return reject(abortError());
      const cancel = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        cleanup();
        try { this._write({ method: "$/cancelRequest", params: { id } }); } catch {}
        reject(abortError());
      };
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        cleanup();
        try { this._write({ method: "$/cancelRequest", params: { id } }); } catch {}
        const error = new Error(`LSP request timed out after ${timeoutMs}ms: ${method}`);
        error.code = "LSP_TIMEOUT";
        reject(error);
      }, timeoutMs);
      const cleanup = () => options.signal?.removeEventListener("abort", cancel);
      options.signal?.addEventListener("abort", cancel, { once: true });
      this.pending.set(id, { method, resolve, reject, timer, cleanup });
      try { this._write({ id, method, params }); } catch (error) { clearTimeout(timer); cleanup(); this.pending.delete(id); reject(error); }
    });
  }
  notify(method, params) { this.start(); this._write({ method, params }); }
  async initialize(options = {}) {
    if (this.initialized) return { capabilities: this.capabilities, serverInfo: this.serverInfo };
    const result = await this.request("initialize", {
      processId: process.pid,
      clientInfo: { name: "pi-harness", version: "1" },
      rootUri: options.rootUri || pathToFileURL(this.cwd).href,
      workspaceFolders: options.workspaceFolders || [{ uri: options.rootUri || pathToFileURL(this.cwd).href, name: options.rootName || "workspace" }],
      capabilities: options.capabilities || { workspace: { workspaceEdit: { documentChanges: true } }, textDocument: { definition: { linkSupport: true }, rename: { prepareSupport: true }, publishDiagnostics: {} } },
      initializationOptions: options.initializationOptions,
    }, options);
    this.capabilities = result?.capabilities || {};
    this.serverInfo = result?.serverInfo || null;
    this.notify("initialized", {});
    this.initialized = true;
    return result;
  }
  openDocument({ uri, languageId, version = 1, text }) {
    this.documents.set(uri, { languageId, version, text });
    this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version, text } });
  }
  changeDocument({ uri, version, text }) {
    const current = this.documents.get(uri) || {};
    const next = { ...current, version: version || Number(current.version || 0) + 1, text };
    this.documents.set(uri, next);
    this.notify("textDocument/didChange", { textDocument: { uri, version: next.version }, contentChanges: [{ text }] });
  }
  closeDocument(uri) { if (this.documents.delete(uri)) this.notify("textDocument/didClose", { textDocument: { uri } }); }
  async shutdown(options = {}) {
    if (!this.process || this.exit) return;
    this.stopped = true;
    try { if (this.initialized) await this.request("shutdown", null, { timeoutMs: options.timeoutMs || 1500 }); } catch {}
    try { this.notify("exit", undefined); } catch {}
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { this.process?.kill("SIGTERM"); } catch {} resolve(); }, options.graceMs || 250);
      this.process?.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  status() { return { command: this.command, args: this.args, cwd: this.cwd, running: Boolean(this.process && !this.exit), initialized: this.initialized, capabilities: this.capabilities, serverInfo: this.serverInfo, pending: this.pending.size, diagnostics: this.diagnostics.size, stderr: this.stderr, exit: this.exit }; }
}

module.exports = { LspClient, abortError, rpcError };
