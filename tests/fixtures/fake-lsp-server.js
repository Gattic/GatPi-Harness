#!/usr/bin/env node
"use strict";

let buffer = Buffer.alloc(0);
let currentUri = "file:///tmp/example.js";
function send(message) {
  const json = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}
function location(uri = currentUri) { return { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } }; }
function respond(message) {
  const { id, method, params } = message;
  if (method === "initialized" || method === "$/cancelRequest" || method === "exit" || method === "textDocument/didChange" || method === "textDocument/didClose") return;
  if (method === "textDocument/didOpen") {
    currentUri = params.textDocument.uri;
    send({ method: "textDocument/publishDiagnostics", params: { uri: currentUri, diagnostics: [{ range: location().range, severity: 2, code: "fake", message: "fake warning", source: "fake-lsp" }] } });
    return;
  }
  if (id == null) return;
  if (method === "initialize") return send({ id, result: { capabilities: { definitionProvider: true, referencesProvider: true, implementationProvider: true, hoverProvider: true, documentSymbolProvider: true, workspaceSymbolProvider: true, renameProvider: { prepareProvider: true }, codeActionProvider: true, callHierarchyProvider: true, typeHierarchyProvider: true }, serverInfo: { name: "fake-lsp", version: "1" } } });
  if (method === "shutdown") return send({ id, result: null });
  if (method === "test/delay") return setTimeout(() => send({ id, result: params.value }), Number(params.delay || 0));
  if (method === "test/timeout") return;
  if (method === "test/crash") return process.exit(23);
  if (method === "textDocument/definition") return send({ id, result: location(params.textDocument.uri) });
  if (method === "textDocument/references") return setTimeout(() => send({ id, result: [location(params.textDocument.uri)] }), 5);
  if (method === "textDocument/implementation") return send({ id, result: [location(params.textDocument.uri)] });
  if (method === "textDocument/hover") return send({ id, result: { contents: { kind: "markdown", value: "`fake: number`" }, range: location().range } });
  if (method === "textDocument/documentSymbol") return send({ id, result: [{ name: "foo", kind: 12, range: location().range, selectionRange: location().range }] });
  if (method === "workspace/symbol") return send({ id, result: [{ name: "foo", kind: 12, location: location() }] });
  if (method === "textDocument/prepareRename") return send({ id, result: { range: location().range, placeholder: "foo" } });
  if (method === "textDocument/rename") return send({ id, result: { changes: { [params.textDocument.uri]: [{ range: location().range, newText: params.newName }] } } });
  if (method === "textDocument/codeAction") return send({ id, result: [{ title: "Fake fix", kind: "quickfix", edit: { changes: {} } }] });
  if (method === "textDocument/prepareCallHierarchy" || method === "textDocument/prepareTypeHierarchy") return send({ id, result: [{ name: "foo", kind: 12, uri: currentUri, range: location().range, selectionRange: location().range }] });
  if (method === "callHierarchy/incomingCalls") return send({ id, result: [{ from: params.item, fromRanges: [location().range] }] });
  if (method === "callHierarchy/outgoingCalls") return send({ id, result: [{ to: params.item, fromRanges: [location().range] }] });
  if (method === "typeHierarchy/supertypes" || method === "typeHierarchy/subtypes") return send({ id, result: [params.item] });
  send({ id, error: { code: -32601, message: `unknown method ${method}` } });
}
function onData(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const match = buffer.slice(0, headerEnd).toString("ascii").match(/Content-Length:\s*(\d+)/i);
    if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }
    const length = Number(match[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const body = buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
    buffer = buffer.slice(headerEnd + 4 + length);
    respond(JSON.parse(body));
  }
}
process.stdin.on("data", onData);
process.stdin.on("end", () => process.exit(0));
