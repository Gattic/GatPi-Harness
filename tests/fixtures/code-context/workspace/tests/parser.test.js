const assert = require("node:assert/strict");
assert.equal(require("../src/parser").parse(" x "), "x");
