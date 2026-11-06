import assert from "node:assert/strict";
import fs from "node:fs";

const codingAgentPatch = fs.readFileSync(new URL("../patches/pi-coding-agent-0.74.1-local.patch", import.meta.url), "utf8");
const tuiPatch = fs.readFileSync(new URL("../patches/pi-tui-0.74.1-local.patch", import.meta.url), "utf8");
const tuiUpgradePatch = fs.readFileSync(new URL("../patches/pi-tui-0.74.1-idle-answer-resize.patch", import.meta.url), "utf8");
const applyScript = fs.readFileSync(new URL("../scripts/apply-pi-global-patches.sh", import.meta.url), "utf8");

assert(
  codingAgentPatch.includes("this.ui.setResizeRedrawProvider?.((context) => this.getIdleLatestAssistantResizeRedrawStart(context))"),
  "interactive mode should install an idle latest-answer resize redraw provider",
);
assert(
  codingAgentPatch.includes("isActivelyOutputtingForResizeRedraw") &&
    codingAgentPatch.includes("this.session.isStreaming") &&
    codingAgentPatch.includes("this.session.isBashRunning") &&
    codingAgentPatch.includes("this.session.isCompacting"),
  "latest-answer resize replay should be disabled while Pi is actively outputting",
);
assert(
  codingAgentPatch.includes("child instanceof AssistantMessageComponent") &&
    codingAgentPatch.includes("assistantMessageHasVisibleAnswer") &&
    codingAgentPatch.includes("content.type === \"text\""),
  "resize replay should anchor to the latest visible assistant answer",
);
assert(
  codingAgentPatch.includes("context.lines.length - start <= context.height"),
  "interactive mode should keep normal viewport repaint when the answer already fits",
);
assert(
  tuiPatch.includes("visibleLines = newLines.slice(requestedStart)"),
  "pi-tui should replay the requested suffix so the full latest answer stays contiguous in scrollback",
);
assert(
  tuiUpgradePatch.includes("index 626889d..0272ad0") &&
    tuiUpgradePatch.includes("visibleLines = newLines.slice(requestedStart)"),
  "incremental pi-tui patch should upgrade installs that already had the earlier resize hunk",
);
assert(
  applyScript.includes("pi-tui-$EXPECTED_VERSION-idle-answer-resize.patch") &&
    applyScript.includes("old-local-to-current upgrade hunk"),
  "global patch script should fall back to the incremental resize upgrade when the old hunk is already applied",
);
