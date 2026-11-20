"use strict";
const assert = require("node:assert/strict");
const { ProjectMemoryIndex } = require("../src/project-memory-index");

const now = Date.parse("2026-11-19T00:00:00Z");
const entry = (root, id, kind, title, content, ageMs, extra = {}) => ({ root, id, kind, title, content, verification: "verified", updatedAt: new Date(now - ageMs).toISOString(), ...extra });
const entries = [
  entry("root-a", "a-constraint", "constraint", "Project constraint", "Project constraint belongs only to root A.", 9000),
  entry("root-a", "a-cache-rule", "procedure", "Cache rule", "Constraint on project cache is advisory.", 0),
  entry("root-b", "b-constraint", "constraint", "Project constraint", "Project constraint belongs only to root B.", 0),
  entry(undefined, "unattributed-constraint", "constraint", "Project constraint", "Project constraint with no root attribution.", 1000),
];
const index = new ProjectMemoryIndex({ entries, now: () => now });
const ids = (result) => result.items.map((row) => row.id);

// An unscoped search sees every root. That contamination is exactly what a scoped
// search must remove, so the fixture below can detect a regression instead of passing
// because no competing entry exists.
assert.deepEqual(ids(index.search("project constraint", { limit: 5 })).sort(), ["a-cache-rule", "a-constraint", "b-constraint", "unattributed-constraint"]);

const scoped = index.search("project constraint", { limit: 5, root: "root-a" });
assert.deepEqual(ids(scoped).sort(), ["a-cache-rule", "a-constraint"]);
assert.equal(scoped.candidates, 2, "candidate count reflects the scope, not the whole corpus");
assert.ok(scoped.items.every((row) => row.root === "root-a"));

// An entry with no attribution is never assumed to belong to a requested scope.
assert.equal(ids(index.search("project constraint", { limit: 5, root: "root-a" })).includes("unattributed-constraint"), false);

// Scoping must not change ranking inside a root: another root's identically named
// entry must neither displace nor reorder the scoped results.
assert.equal(ids(scoped)[0], "a-constraint", "the exact title phrase still ranks first inside the scope");
assert.deepEqual(ids(index.search("project constraint", { limit: 5, root: "root-a" })), ids(scoped));

// Scope combines with the existing filters instead of replacing them.
assert.deepEqual(ids(index.search("project constraint", { limit: 5, root: "root-a", kinds: ["constraint"] })), ["a-constraint"]);
assert.deepEqual(ids(index.search("project constraint", { limit: 5, root: "root-b", kinds: ["constraint"] })), ["b-constraint"]);

// A scope that matches nothing returns an empty, well-formed envelope.
const empty = index.search("project constraint", { limit: 5, root: "root-c" });
assert.deepEqual(empty.items, []);
assert.equal(empty.candidates, 0);
assert.equal(typeof empty.durationMs, "number");

// Expiry and exclusion still apply under a scope, and a supersession inside one root
// must not remove another root's entry.
const excluded = new ProjectMemoryIndex({ now: () => now, entries: [
  entry("root-a", "a-old", "constraint", "Project constraint", "Project constraint superseded by a newer claim.", 9000),
  entry("root-a", "a-new", "constraint", "Project constraint", "Project constraint replacement.", 1000, { supersedes: ["a-old"] }),
  entry("root-b", "b-old", "constraint", "Project constraint", "Project constraint in another root.", 9000),
] });
assert.deepEqual(ids(excluded.search("project constraint", { limit: 5, root: "root-a" })), ["a-new"]);
assert.deepEqual(ids(excluded.search("project constraint", { limit: 5, root: "root-b" })), ["b-old"]);

console.log("project memory index scope tests passed");
