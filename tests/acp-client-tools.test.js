"use strict";

// The ACP file callbacks Pi serves itself: `fs/read_text_file` and
// `fs/write_text_file`. The server's `client_view_file`, `client_create_file`
// and `client_edit_file` tools come back to these handlers, so every call has to
// pass Pi's policy before a file is touched.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createAcpPermissionGate } = require("../src/acp-permission-gate");
const { createAcpClientFileHandlers } = require("../src/acp-client-tools");
const { tmpFixture } = require("./helpers/tmp-fixture");

const cwd = tmpFixture("pi-acp-client-tools-");
const outside = tmpFixture("pi-acp-client-tools-outside-");
fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
fs.writeFileSync(path.join(cwd, "src", "app.js"), "one\ntwo\nthree\nfour\n");
fs.writeFileSync(path.join(outside, "notes.txt"), "outside\n");

const decisions = [];
const gate = createAcpPermissionGate({
  cwd,
  mode: "block",
  policy: {},
  onDecision: (decision) => decisions.push(decision),
});
const handlers = createAcpClientFileHandlers({ gate, cwd });

async function main() {
  // --- reads ---------------------------------------------------------------
  {
    const response = await handlers.readTextFile({ sessionId: "s", path: path.join(cwd, "src", "app.js") });
    assert.equal(response.content, "one\ntwo\nthree\nfour\n");
    assert.equal(decisions.at(-1).toolName, "read", "a read is decided as Pi's read tool");
    assert.equal(decisions.at(-1).allow, true);

    const sliced = await handlers.readTextFile({
      sessionId: "s",
      path: path.join(cwd, "src", "app.js"),
      line: 2,
      limit: 2,
    });
    assert.equal(sliced.content, "two\nthree", "line is 1-based and limit counts lines from it");

    const relative = await handlers.readTextFile({ sessionId: "s", path: "src/app.js" });
    assert.equal(relative.content.startsWith("one"), true, "a relative path resolves against the session cwd");

    // Reads are not write-gated: Pi's own read tool can read outside the project.
    const elsewhere = await handlers.readTextFile({ sessionId: "s", path: path.join(outside, "notes.txt") });
    assert.equal(elsewhere.content, "outside\n");
    assert.equal(decisions.at(-1).allow, true);
  }

  // --- writes --------------------------------------------------------------
  {
    const target = path.join(cwd, "src", "nested", "new.js");
    await handlers.writeTextFile({ sessionId: "s", path: target, content: "created\n" });
    assert.equal(fs.readFileSync(target, "utf8"), "created\n", "parent directories are created");

    await handlers.writeTextFile({ sessionId: "s", path: target, content: "replaced\n" });
    assert.equal(fs.readFileSync(target, "utf8"), "replaced\n", "the callback replaces the whole file");
    assert.equal(decisions.at(-1).toolName, "write");
    assert.equal(decisions.at(-1).allow, true);
  }

  // --- a write outside the project is refused with the approval key --------
  {
    const target = path.join(outside, "blocked.txt");
    await assert.rejects(
      handlers.writeTextFile({ sessionId: "s", path: target, content: "nope\n" }),
      (error) => {
        assert.match(error.message, /acp-permission block write/u);
        assert.match(error.message, /Approve once with: \/policy-approve /u);
        assert.match(error.message, /outside repo/u);
        return true;
      },
    );
    assert.equal(fs.existsSync(target), false, "a refused write leaves no file");
    assert.equal(decisions.at(-1).allow, false);
  }

  // --- a request without a path cannot be judged ---------------------------
  {
    await assert.rejects(
      handlers.readTextFile({ sessionId: "s", path: "" }),
      /carries no path/u,
    );
    await assert.rejects(
      handlers.writeTextFile({ sessionId: "s", path: path.join(cwd, "src", "x.js"), content: undefined }),
      /carries no content/u,
    );
  }

  // --- approval mode reports the key instead of refusing silently ----------
  {
    const approvalGate = createAcpPermissionGate({ cwd, mode: "approval", policy: {} });
    const approvalHandlers = createAcpClientFileHandlers({ gate: approvalGate, cwd });
    await assert.rejects(
      approvalHandlers.writeTextFile({
        sessionId: "s",
        path: path.join(outside, "approval.txt"),
        content: "nope\n",
      }),
      (error) => {
        assert.match(error.message, /acp-permission approval-required write/u);
        assert.match(error.message, /\/policy-approve /u);
        return true;
      },
    );
  }

  // --- handlers refuse to run without Pi's gate ----------------------------
  {
    const ungated = createAcpClientFileHandlers({ cwd });
    await assert.rejects(
      ungated.writeTextFile({ sessionId: "s", path: path.join(cwd, "src", "x.js"), content: "x\n" }),
      /need Pi's policy gate/u,
    );
  }

  console.log("acp-client-tools tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
