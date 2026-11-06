import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { buildRepoContext, formatRepoContext } = require(join(LIB_ROOT, "src", "repo-context.js"));
const { notify, createContextInjector } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

// Session mining: every session re-ran the same opening ritual (git status
// x180, git diff x290, CLAUDE.md re-reads x75). Inject that context once at
// session start, locally and fast, in any repo.
const ENABLED = process.env.PI_REPO_CONTEXT !== "0";
const INJECT = process.env.PI_REPO_CONTEXT_INJECT !== "0";

export default function repoContext(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  if (!ENABLED) return;
  const injection = createContextInjector({ customType: "repo-context", maxChars: process.env.PI_REPO_CONTEXT_INJECT_MAX_CHARS });

  pi.on("session_start", () => injection.reset());
  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    if (!INJECT) return;
    let text = "";
    try { text = formatRepoContext(buildRepoContext(ctx.cwd)); } catch { return; }
    return injection.inject(text);
  });

  pi.registerCommand("repo-context", { description: "Show the compact repo context pack (branch, changes, recent commits, docs digest)", handler: async (_args: string, ctx: any) => notify(ctx, formatRepoContext(buildRepoContext(ctx.cwd)), "info") });
  pi.registerTool({
    name: "repo_context",
    label: "Repo context",
    description: "Return a compact, current snapshot of the repo: branch, changed files, recent commits, top-level layout, and CLAUDE.md/AGENTS.md digest. Prefer this single call over separately running git status/diff/log and re-reading docs at session start.",
    parameters: Type.Object({}),
    async execute(_id: string, _params: any, _signal: any, _update: any, ctx: any) {
      const details = buildRepoContext(ctx.cwd);
      return { content: [{ type: "text", text: formatRepoContext(details) }], details };
    },
  });
}
