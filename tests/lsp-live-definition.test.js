#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLspAdapter } = require("../src/lsp-adapter.js");
const { serverRegistry } = require("../src/lsp-server-registry.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const fixtures = [
  {
    server: "clangd", language: "cpp", file: "main.cpp", line: 3, column: 10,
    target: "math.hpp", targetLine: 2, targetColumn: 12,
    files: {
      "math.hpp": "#pragma once\ninline int doubled(int value) { return value * 2; }\n",
      "main.cpp": '#include "math.hpp"\nint main() {\n  return doubled(21);\n}\n',
    },
  },
  {
    server: "pyright", language: "python", file: "main.py", line: 3, column: 10,
    target: "helper.py", targetLine: 1, targetColumn: 5,
    files: {
      "helper.py": "def doubled(value: int) -> int:\n    return value * 2\n",
      "main.py": "from helper import doubled\n\nanswer = doubled(21)\n",
    },
  },
];

function waitForExit(client) {
  return client.status().running ? once(client, "exit", { signal: AbortSignal.timeout(5000) }) : Promise.resolve();
}

async function withFixture(spec, visit) {
  const space = fs.statfsSync(os.tmpdir());
  assert.ok(space.bavail * space.bsize >= 64 * 1024 * 1024, "temporary fixtures need free space for server caches");
  const adapter = createLspAdapter({ live: true, timeoutMs: 15000 });
  const root = tmpFixture(`pi-lsp-live-${spec.server}-`);
  const fixture = { root, adapter, clients: [], cleanup: null };
  try {
    for (const [file, text] of Object.entries(spec.files)) fs.writeFileSync(path.join(root, file), text);
    if (spec.language === "cpp") {
      // No compiler process or system headers are needed for this local-header lookup.
      fs.writeFileSync(path.join(root, "compile_commands.json"), JSON.stringify([{
        directory: root,
        file: path.join(root, spec.file),
        arguments: ["clang++", "-std=c++20", "-I", root, "-c", path.join(root, spec.file)],
      }]));
    }
    await visit(fixture);
  } finally {
    fixture.clients = [...adapter.sessionManager.sessions.values()].map(session => session.client);
    // closeAll can settle immediately after SIGTERM; wait for exit before removing files.
    const exits = fixture.clients.map(waitForExit);
    try {
      await Promise.all([
        adapter.closeAll().then(result => { fixture.cleanup = result; }),
        ...exits,
      ]);
    } catch (error) {
      // A cleanup deadline fails the test, but must not orphan its owned servers.
      await Promise.all(fixture.clients.filter(client => client.status().running).map(client => {
        const exited = waitForExit(client);
        client.process.kill("SIGKILL");
        return exited;
      }));
      throw error;
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
}

async function assertLiveDefinition(spec, { root, adapter }) {
  const ctx = { cwd: root };
  const status = (await adapter.status(ctx)).details;
  assert.deepEqual(status.sessions, [], "a fresh adapter must not reuse a prior server session");
  assert.equal(status.servers.find(server => server.id === spec.server)?.found, true);
  assert.equal(status.liveCapabilitiesAvailable, true);

  const { details } = await adapter.definition(ctx, {
    file: spec.file, line: spec.line, column: spec.column,
    language: spec.language, symbol: "doubled", timeoutMs: 15000,
  });
  const diagnostics = JSON.stringify({ degradation: details.degradation, liveDegradation: details.liveDegradation });
  assert.equal(details.backend, "live-lsp", diagnostics);
  assert.equal(details.server, spec.server);
  assert.equal(details.degradation, null, diagnostics);
  assert.equal(details.liveDegradation, undefined, "a lexical result after a failed live request is not success");
  assert.equal(details.freshness, "fresh");
  assert.equal(details.gatingSafe, true);
  assert.equal(details.advisory, false);
  assert.ok(details.definitions.some(definition =>
    definition.file === spec.target &&
    definition.range.startLine === spec.targetLine &&
    definition.range.startColumn === spec.targetColumn &&
    definition.backend === "live-lsp" && definition.gatingSafe === true
  ), `expected a semantic definition in ${spec.target}:${spec.targetLine}:${spec.targetColumn}`);
  for (const [file, text] of Object.entries(spec.files)) assert.equal(fs.readFileSync(path.join(root, file), "utf8"), text, "definition lookup is read-only");
}

function assertReleased(fixture) {
  assert.equal(fs.existsSync(fixture.root), false, "owned fixture directory must be removed");
  assert.deepEqual(fixture.adapter.sessionManager.status().sessions, [], "session registry must be empty");
  assert.equal(fixture.clients.length, 1, "exactly one real server session was exercised");
  assert.equal(fixture.cleanup.closed, 1);
  assert.equal(fixture.cleanup.fallbackWorkersClosed, 0);
  for (const client of fixture.clients) {
    const status = client.status();
    assert.equal(status.running, false, "cleanup must terminate the server, not just clear its registry entry");
    assert.ok(status.exit, "server process exit must be observed");
    assert.equal(status.pending, 0, "no JSON-RPC requests may remain pending");
  }
}

for (const spec of fixtures) {
  // Absence is an explicit skip; an installed but broken provider must fail.
  const found = serverRegistry().status().find(server => server.id === spec.server)?.found;
  const options = { timeout: 45000, skip: found ? false : `${spec.server} is not installed; live integration not applicable` };
  test(`${spec.server}: fresh-adapter cross-file definition uses live LSP and releases resources`, options, async () => {
    let fixture;
    await withFixture(spec, async current => {
      fixture = current;
      await assertLiveDefinition(spec, current);
    });
    assertReleased(fixture);
  });

  test(`${spec.server}: fixtures and sessions are released when the lookup consumer throws`, options, async () => {
    let fixture;
    const failure = new Error("intentional post-lookup failure");
    await assert.rejects(withFixture(spec, async current => {
      fixture = current;
      await assertLiveDefinition(spec, current);
      throw failure;
    }), error => error === failure);
    assertReleased(fixture);
  });
}
