import assert from "node:assert/strict";
import fs from "node:fs";

const patch = fs.readFileSync(new URL("../patches/pi-tui-0.74.1-local.patch", import.meta.url), "utf8");

assert(
  patch.includes("this.positionCursorForHistoryNavigation(direction);"),
  "pi-tui patch should reposition the cursor after loading a history entry",
);
assert(
  patch.includes("positionCursorForHistoryNavigation(direction)") && patch.includes("if (direction < 0)"),
  "history cursor positioning should distinguish older/up navigation from newer/down navigation",
);
assert(
  patch.includes("this.state.cursorLine = 0;") && patch.includes("this.setCursorCol(0);"),
  "up/older history navigation should place the cursor at the start of the prompt",
);
assert(
  patch.includes("this.state.cursorLine = Math.max(0, this.state.lines.length - 1);") &&
    patch.includes("this.setCursorCol(currentLine.length);"),
  "down/newer history navigation should place the cursor at the end of the prompt",
);
