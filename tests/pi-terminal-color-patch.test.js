import assert from "node:assert/strict";
import fs from "node:fs";

const patch = fs.readFileSync(new URL("../patches/pi-coding-agent-0.74.1-local.patch", import.meta.url), "utf8");

assert(
  patch.includes("PI_COLOR_MODE") && patch.includes("COLORTERM=truecolor"),
  "global Pi patch should document explicit color-mode override and avoid trusting inherited COLORTERM in multiplexers",
);
assert(
  patch.includes('return term.includes("256color") ? "256color" : "ansi16";'),
  "global Pi patch should fall back to ANSI 16-color when screen/tmux does not advertise 256 colors",
);
assert(
  patch.includes("function fgAnsi16") && patch.includes('if (mode === "ansi16")'),
  "global Pi patch should emit ANSI 16-color foreground/background escapes when selected",
);
assert(
  patch.includes('type ColorMode = "truecolor" | "256color" | "ansi16"'),
  "global Pi patch should keep theme ColorMode declarations aligned with runtime modes",
);
