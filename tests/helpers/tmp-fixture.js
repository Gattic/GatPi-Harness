"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const created = new Set();
let registered = false;

function removeCreated() {
  for (const directory of created) {
    // Teardown must never change a test's outcome, so a removal that fails
    // (locked, unreadable or otherwise undeletable content) is left for the
    // retention sweep instead of throwing out of the exit handler.
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {}
  }
  created.clear();
}

/**
 * Create a temporary fixture directory that is removed when the test process exits.
 *
 * Test files run as standalone scripts and through `node --test`, so a process exit
 * hook is the only place that always runs after a fixture's test, including when an
 * assertion throws before an explicit teardown would. Removal is best effort: a
 * fixture a test already deleted is skipped (`force`), and a hard-killed process
 * leaves its directories for the retention sweep instead of hiding the crash.
 */
function tmpFixture(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (!registered) {
    registered = true;
    process.on("exit", removeCreated);
  }
  created.add(directory);
  return directory;
}

module.exports = { tmpFixture };
