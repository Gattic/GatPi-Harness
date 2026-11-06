import assert from "node:assert/strict";
import fs from "node:fs";

const patch = fs.readFileSync(new URL("../patches/pi-coding-agent-0.74.1-local.patch", import.meta.url), "utf8");

assert(
  patch.includes('{ name: "clear", description: "Start a new session (alias for /new)" }'),
  "global Pi patch should register /clear as a built-in slash command alias for /new",
);
assert(
  patch.includes('if (text === "/new" || text === "/clear")'),
  "global Pi patch should route /clear through the /new session handler",
);
assert(
  patch.includes('{ name: "exit", description: `Quit ${APP_NAME} (alias for /quit)` }'),
  "global Pi patch should register /exit as a built-in slash command alias for /quit",
);
assert(
  patch.includes('if (text === "/quit" || text === "/exit")'),
  "global Pi patch should route /exit through the /quit shutdown handler",
);
