"use strict";
const assert = require("node:assert/strict");

const { parsePlanItems, buildFanout } = require("../src/plan-fanout.js");

const plan = `# Renderer cleanup plan

## Phase 1: shaders
- [ ] Unify PBR uniforms in \`src/render/pbr.cpp\` and \`src/render/uniforms.h\`
- [x] Delete legacy blinn-phong path
- [ ] Fix skinned-instance normals in \`src/render/skinning.cpp\` and \`src/render/uniforms.h\`

## Phase 2: tests
1. Add golden-image test for grass rendering in \`tests/render/\`
`;

const items = parsePlanItems(plan);
assert.equal(items.length, 3, "completed checklist items are skipped");
assert.equal(items[0].phase, "Phase 1: shaders");
assert.deepEqual(items[0].files, ["src/render/pbr.cpp", "src/render/uniforms.h"]);
assert.equal(items[2].phase, "Phase 2: tests");
assert.match(items[2].text, /golden-image/);

const fanout = buildFanout("/repo", plan, { planFile: "plans/renderer.md" });
assert.equal(fanout.workers.length, 3);
const w1 = fanout.workers[0];
assert.match(w1.task, /plans\/renderer\.md/);
assert.match(w1.task, /Unify PBR uniforms/);
assert.equal(w1.roleId, "coder");
assert.equal(w1.workspacePolicy, "isolated-worktree");
assert.equal(w1.mutationPolicy, "proposed-patch");
assert.equal(w1.mergePolicy, "proposed_patch");
assert(w1.budget.maxModelCalls > 0 && w1.budget.maxToolCalls > 0);
assert.match(w1.task, /src\/render\/skinning\.cpp/, "conflict zone lists files owned by other workers");
assert.match(w1.task, /verif/i, "workers must verify and report evidence");
assert(!/you are not alone/i.test(w1.task), "obsolete cosmetic worker-role wording is removed");
// Shared files across items are flagged and serialized through dependencies.
assert.ok(w1.conflicts.includes("src/render/uniforms.h"), "overlapping file is a conflict");
assert.ok(fanout.workers[1].dependencies.includes(w1.id), "later overlapping workers depend on the earlier worker");
assert.equal(fanout.concurrency, 2);
assert(fanout.waves.length >= 2);

// maxAgents caps the fan-out and reports what was dropped.
const capped = buildFanout("/repo", plan, { maxAgents: 2 });
assert.equal(capped.workers.length, 2);
assert.equal(capped.dropped.length, 1);
assert.equal(capped.maxWorkers, 2);

// Plans with no parseable items produce guidance instead of workers.
const emptyFanout = buildFanout("/repo", "just prose, no checklist");
assert.equal(emptyFanout.workers.length, 0);
assert.match(emptyFanout.guidance, /no plan items/i);

console.log("plan-fanout tests passed");
