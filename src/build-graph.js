"use strict";

const crypto = require("node:crypto");
const { createBuildFact, createProviderStatus, stableStringify } = require("./code-context-contracts.js");

const RELATIONS = Object.freeze(["owned-by-target", "depends-on", "produces", "generates", "tests", "compiled-with", "included-in"]);
const QUERY_RELATIONS = Object.freeze({ owner: ["owned-by-target"], deps: ["depends-on"], rdeps: ["depends-on"], actions: ["compiled-with", "included-in", "generates"], artifacts: ["produces"], configurations: ["compiled-with"] });
function hash(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex"); }
function normalizeEntity(value) { return String(value || "").replace(/\\/g, "/").replace(/^\.\//, ""); }
class BuildGraph {
  constructor(options = {}) { this.repository = options.repository || process.cwd(); this.revision = options.revision || "unknown"; this.facts = new Map(); this.statuses = new Map(); }
  addFact(input = {}) {
    const predicate = String(input.predicate || "");
    if (!RELATIONS.includes(predicate)) throw new Error(`Unsupported build relation: ${predicate}`);
    const fact = createBuildFact({ ...input, subject: normalizeEntity(input.subject), object: normalizeEntity(input.object), configuration: input.configuration || "default", revision: input.revision || this.revision, provider: input.provider || "build-graph", freshness: input.freshness || "fresh", gatingSafe: input.gatingSafe !== false });
    fact.repository = this.repository;
    fact.confidence = Number.isFinite(Number(input.confidence)) ? Math.max(0, Math.min(1, Number(input.confidence))) : 1;
    if (input.metadata) fact.metadata = input.metadata;
    fact.contentHash ||= hash({ subject: fact.subject, predicate: fact.predicate, object: fact.object, configuration: fact.configuration, provider: fact.provider });
    fact.id = `build_${hash({ repository: this.repository, revision: fact.revision, configuration: fact.configuration, provider: fact.provider, subject: fact.subject, predicate: fact.predicate, object: fact.object, contentHash: fact.contentHash }).slice(0, 24)}`;
    this.facts.set(fact.id, fact);
    return fact;
  }
  addFacts(facts) { return (facts || []).map((fact) => this.addFact(fact)); }
  setProviderStatus(input) { const status = createProviderStatus(input); this.statuses.set(status.provider, status); return status; }
  providerStatuses() { return Array.from(this.statuses.values()).sort((a, b) => a.provider.localeCompare(b.provider)); }
  allFacts(filters = {}) {
    return Array.from(this.facts.values()).filter((fact) => !filters.configuration || fact.configuration === filters.configuration).filter((fact) => !filters.provider || fact.provider === filters.provider).sort((a, b) => a.configuration.localeCompare(b.configuration) || a.subject.localeCompare(b.subject) || a.predicate.localeCompare(b.predicate) || a.object.localeCompare(b.object) || a.id.localeCompare(b.id));
  }
  query(input = {}) {
    const entities = new Set((input.entities || [input.entity]).filter(Boolean).map(normalizeEntity));
    const requested = QUERY_RELATIONS[input.relation] || (input.relation ? [input.relation] : RELATIONS);
    const reverse = input.relation === "rdeps" || input.reverse === true;
    const maxDepth = Math.max(1, Math.min(10, Number(input.maximumDepth || input.depth || 1)));
    const maximumResults = Math.max(1, Math.min(1000, Number(input.maximumResults || input.limit || 100)));
    const facts = this.allFacts({ configuration: input.configuration });
    const results = [];
    const visited = new Set(entities);
    let frontier = Array.from(entities);
    for (let depth = 0; depth < maxDepth && frontier.length && results.length < maximumResults; depth++) {
      const next = [];
      for (const fact of facts) {
        if (!requested.includes(fact.predicate)) continue;
        const matched = reverse ? frontier.includes(fact.object) : frontier.includes(fact.subject);
        if (!matched) continue;
        results.push({ ...fact, depth });
        const destination = reverse ? fact.subject : fact.object;
        if (!visited.has(destination)) { visited.add(destination); next.push(destination); }
        if (results.length >= maximumResults) break;
      }
      frontier = Array.from(new Set(next)).sort();
    }
    return { repository: this.repository, revision: this.revision, relation: input.relation || "all", configuration: input.configuration || null, entities: Array.from(entities).sort(), facts: results, providerStatuses: this.providerStatuses(), fingerprint: this.fingerprint(), truncated: results.length >= maximumResults };
  }
  cardsForPath(file, configuration) {
    const normalized = normalizeEntity(file);
    const related = this.allFacts({ configuration }).filter((fact) => fact.subject === normalized || fact.object === normalized);
    return related.map((fact) => ({ provider: fact.provider, id: fact.id, symbolId: fact.subject, path: fact.path || (fact.subject.includes("/") ? fact.subject : file), signature: `${fact.subject} --${fact.predicate}--> ${fact.object} [${fact.configuration}]`, freshness: fact.freshness, degradation: fact.degradation, gatingSafe: fact.gatingSafe, buildRelevance: 1, configuration: fact.configuration, provenance: fact.provenance }));
  }
  fingerprint() { return hash({ facts: this.allFacts(), statuses: this.providerStatuses() }).slice(0, 24); }
  toJSON() { return { schemaVersion: 1, repository: this.repository, revision: this.revision, fingerprint: this.fingerprint(), providerStatuses: this.providerStatuses(), facts: this.allFacts() }; }
  static fromJSON(value = {}) { const graph = new BuildGraph({ repository: value.repository, revision: value.revision }); for (const status of value.providerStatuses || []) graph.setProviderStatus(status); graph.addFacts(value.facts || []); return graph; }
}

function loadBuildGraph(root, options = {}) {
  const { loadCompilationDatabases } = require("./build-graph-compile-commands.js");
  const { loadCmakeFileApi } = require("./build-graph-cmake-file-api.js");
  const { pinnedBuildFacts } = require("./build-runner.js");
  const { workingTreeRevision, revisionId } = require("./code-context-revision.js");
  const revision = options.revision || revisionId(workingTreeRevision(root, { configuration: options.configuration }));
  const graph = new BuildGraph({ repository: root, revision });
  const compile = loadCompilationDatabases(root, options);
  const cmake = loadCmakeFileApi(root, options);
  const pinned = pinnedBuildFacts(root);
  for (const result of [compile, cmake, pinned]) {
    graph.setProviderStatus({ provider: result.provider, backend: result.provider, available: result.available !== false, freshness: result.degradation ? "unknown" : "fresh", degradation: result.degradation, gatingSafe: !result.degradation, capabilities: result.capabilities || [] });
    graph.addFacts((result.facts || []).map((fact) => ({ ...fact, revision })));
  }
  return { graph, providers: { compile, cmake, pinned }, fingerprint: graph.fingerprint() };
}

module.exports = { RELATIONS, QUERY_RELATIONS, BuildGraph, normalizeEntity, loadBuildGraph };
