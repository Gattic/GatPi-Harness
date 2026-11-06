"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { BuildGraph } = require("./build-graph.js");

function keyId(key) { return crypto.createHash("sha256").update(typeof key === "string" ? key : JSON.stringify(key)).digest("hex").slice(0, 24); }
class MemoryBuildGraphStore {
  constructor() { this.values = new Map(); }
  write(key, graph) { const value = graph instanceof BuildGraph ? graph.toJSON() : graph; this.values.set(keyId(key), JSON.parse(JSON.stringify(value))); return { key: keyId(key), fingerprint: value.fingerprint }; }
  read(key) { const value = this.values.get(keyId(key)); return value ? BuildGraph.fromJSON(JSON.parse(JSON.stringify(value))) : null; }
  list() { return Array.from(this.values.entries()).map(([key, value]) => ({ key, fingerprint: value.fingerprint, repository: value.repository, revision: value.revision })).sort((a, b) => a.key.localeCompare(b.key)); }
  remove(key) { return this.values.delete(keyId(key)); }
}
class FileBuildGraphStore {
  constructor(root) { this.root = path.resolve(root || path.join(process.cwd(), ".pi", "code-context", "build-graph")); }
  file(key) { return path.join(this.root, `${keyId(key)}.json`); }
  write(key, graph) {
    const file = this.file(key);
    const value = graph instanceof BuildGraph ? graph.toJSON() : graph;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return { key: keyId(key), file, fingerprint: value.fingerprint };
  }
  read(key) { try { return BuildGraph.fromJSON(JSON.parse(fs.readFileSync(this.file(key), "utf8"))); } catch { return null; } }
  list() {
    try { return fs.readdirSync(this.root).filter((name) => name.endsWith(".json")).sort().map((name) => { try { const value = JSON.parse(fs.readFileSync(path.join(this.root, name), "utf8")); return { key: name.slice(0, -5), fingerprint: value.fingerprint, repository: value.repository, revision: value.revision }; } catch { return null; } }).filter(Boolean); } catch { return []; }
  }
  remove(key) { try { fs.unlinkSync(this.file(key)); return true; } catch { return false; } }
}

module.exports = { keyId, MemoryBuildGraphStore, FileBuildGraphStore };
