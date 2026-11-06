import assert from "node:assert/strict";
import fs from "node:fs";

const patch = [
  "../patches/pi-coding-agent-0.74.1-local.patch",
  "../patches/pi-coding-agent-0.74.1-history-upgrade.patch",
]
  .map((path) => fs.readFileSync(new URL(path, import.meta.url), "utf8"))
  .join("\n");

assert(
  patch.includes("currentHistory = Array.isArray(this.editor.history)"),
  "global Pi patch should preserve editor prompt history when reload swaps editor components",
);
assert(
  patch.includes("rebuildEditorPromptHistoryFromBranch(branchEntries = this.sessionManager.getBranch(), options = {})"),
  "global Pi patch should rebuild prompt history from the full active session branch when chat is rebuilt",
);
assert(
  patch.includes('message.role === "bashExecution"') && patch.includes('message.excludeFromContext ? "!!" : "!"'),
  "global Pi patch should restore shell command prompt history, including !! excluded commands",
);
assert(
  patch.includes("addPromptHistoryTextsFromRepoSessions") && patch.includes("getBranchEntriesFromLoadedEntries") && patch.includes("loadEntriesFromFile"),
  "global Pi patch should rebuild editor prompt history from prior repo sessions using full branch entries",
);
assert(
  patch.includes("renderInitialMessages({ preservePromptHistory: true })"),
  "global Pi patch should preserve in-memory prompt history across reload/session switches",
);
