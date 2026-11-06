"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { projectIdentity } = require("../src/project-identity");
const { tmpFixture } = require("./helpers/tmp-fixture");

const a = tmpFixture("pi-ident-a-");
const bParent = tmpFixture("pi-ident-bparent-");
const b = path.join(bParent, path.basename(a));
fs.mkdirSync(b);

const ia = projectIdentity(a);
const ib = projectIdentity(b);
assert.equal(ia.name, ib.name, "same basename fixture should have same display name");
assert.notEqual(ia.root, ib.root, "fixtures should have distinct canonical roots");
assert.notEqual(ia.projectKey, ib.projectKey, "project keys include a root hash to prevent basename collisions");
assert.match(ia.projectKey, /^pi:[A-Za-z0-9._-]+:[a-f0-9]{12}$/);
assert.equal(ia.legacyProjectKey, `pi:${ia.name}`);
assert.equal(ia.isGit, false, "non-git directories are valid projects");

console.log("project identity tests passed");
