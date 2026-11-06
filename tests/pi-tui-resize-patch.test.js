import assert from "node:assert/strict";
import fs from "node:fs";

const patch = fs.readFileSync(new URL("../patches/pi-tui-0.74.1-local.patch", import.meta.url), "utf8");

assert(
  patch.includes("const renderVisibleViewport = () =>"),
  "pi-tui patch should add a resize-only viewport repaint helper",
);
assert(
  patch.includes("let visibleLines = newLines.slice(nextViewportTop, nextViewportTop + height)"),
  "resize repaint should default to drawing only the visible viewport, not the full chat history",
);
assert(
  patch.includes("setResizeRedrawProvider") && patch.includes("newLines.slice(requestedStart)"),
  "resize repaint should allow an embedding app to replay a longer suffix, such as the latest answer",
);
assert(
  patch.includes("newLines.length - requestedStart > height"),
  "custom resize replay should only run when the suffix is taller than the viewport",
);
assert(
  patch.includes("renderVisibleViewport();"),
  "terminal width/height changes should use viewport repaint instead of full history replay",
);
assert(
  patch.includes("keep existing scrollback"),
  "resize viewport repaint should avoid clearing scrollback while repainting the screen",
);
