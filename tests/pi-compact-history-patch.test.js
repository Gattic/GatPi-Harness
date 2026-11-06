import assert from "node:assert/strict";
import fs from "node:fs";

const patch = [
  "../patches/pi-coding-agent-0.74.1-local.patch",
  "../patches/pi-coding-agent-0.74.1-history-upgrade.patch",
]
  .map((path) => fs.readFileSync(new URL(path, import.meta.url), "utf8"))
  .join("\n");

assert(
  patch.includes("rebuildEditorPromptHistoryFromBranch(branchEntries = this.sessionManager.getBranch(), options = {})"),
  "prompt history rebuild should use the full active branch, not compacted LLM context",
);
assert(
  patch.includes("preserveCurrent") && patch.includes("previousHistory.slice().reverse()") && patch.includes("rememberPromptHistoryText"),
  "chat rebuilds should preserve non-persisted in-memory prompt history while restoring deduplicated full branch history",
);
assert(
  patch.includes("-                    this.chatContainer.clear();\n-                    this.rebuildChatFromMessages();") &&
    patch.includes("Compaction changes the LLM context, but it should not erase") &&
    patch.includes("Keep existing chat components and append a compaction marker."),
  "compaction completion should preserve visible chat history instead of clearing/rebuilding compacted context",
);
assert(
  patch.includes('message.role === "bashExecution"') && patch.includes('return `${message.excludeFromContext ? "!!" : "!"}${message.command}`;'),
  "prompt history rebuild should preserve ! and !! bash commands",
);
assert(
  patch.includes("getDisplayMessagesFromBranchEntries") &&
    patch.includes("full active branch for visible chat history") &&
    patch.includes("compacted context separately for the model"),
  "visible chat rebuild should use full active branch while keeping model context compacted",
);
assert(
  patch.includes("addPromptHistoryTextsFromRepoSessions") && patch.includes(".sort((a, b) => a.mtime - b.mtime)"),
  "prompt history should include prior repo sessions in chronological order before active branch prompts",
);
assert(
  patch.includes("_scheduleCompactionContinuation(reason)") &&
    patch.includes("_handleCompactionContinuationFailure(reason, error)") &&
    patch.includes("Continue the interrupted task from the compacted conversation summary above.") &&
    patch.includes("Context overflow recovery") &&
    patch.includes("+                this._scheduleCompactionContinuation(reason);") &&
    !patch.includes("+                    this.agent.continue().catch(() => { });"),
  "post-compaction auto-continuation should not silently swallow continue failures and should fallback for overflow retries",
);
