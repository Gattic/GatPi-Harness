"use strict";

// Regression: in tall windows (sidecar-style), a resize while the active
// buffer is shorter than the viewport must keep content bottom-anchored next
// to the editor. The patched renderVisibleViewport used to paint short
// buffers from the top row, blanking the lower half of the window and wiping
// visible history ("chat blocked while updating" report, 2026-07-10).
// Drives the active built pi-tui with a fake terminal and emulates the ANSI
// output; supports both the linked source monorepo and a published install.

const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

let tuiPath = null;
try {
  const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  const globalPackage = path.join(globalRoot, "@earendil-works", "pi-coding-agent");
  if (fs.existsSync(globalPackage)) {
    const packageRoot = fs.realpathSync(globalPackage);
    const candidates = [
      path.join(packageRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "tui-main-screen.js"),
      path.resolve(packageRoot, "..", "tui", "dist", "tui-main-screen.js"),
    ];
    tuiPath = candidates.find((candidate) => fs.existsSync(candidate)) || null;
  }
} catch {}
if (!tuiPath) {
  console.log("pi-tui viewport anchor tests skipped (active built pi-tui not found)");
  process.exit(0);
}

function emulate(data, rows) {
  let screen = Array.from({ length: rows }, () => "");
  let row = 0;
  let col = 0;
  const clampRow = () => Math.min(Math.max(row, 0), rows - 1);
  const put = (text) => {
    const r = clampRow();
    const line = screen[r] || "";
    screen[r] = (line.length < col ? line + " ".repeat(col - line.length) : line).slice(0, col) + text + line.slice(col + text.length);
    col += text.length;
  };
  let i = 0;
  while (i < data.length) {
    const ch = data[i];
    if (ch === "\x1b") {
      const csi = data.slice(i, i + 32).match(/^\x1b\[([0-9;?]*)([A-Za-z])/);
      if (csi) {
        const [full, arg, cmd] = csi;
        const n = Number((arg || "").replace(/[?;].*/, "")) || 1;
        if (cmd === "J" && (arg === "2" || arg === "3")) screen = Array.from({ length: rows }, () => "");
        else if (cmd === "H") { row = 0; col = 0; }
        else if (cmd === "A") row = Math.max(0, row - n);
        else if (cmd === "B") row = Math.min(rows - 1, row + n);
        else if (cmd === "G") col = n - 1;
        else if (cmd === "K") { const r = clampRow(); screen[r] = arg === "2" ? "" : screen[r].slice(0, col); }
        i += full.length; continue;
      }
      const osc = data.slice(i).match(/^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/);
      if (osc) { i += osc[0].length; continue; }
      i += 2; continue;
    }
    if (ch === "\r") { col = 0; i++; continue; }
    if (ch === "\n") { row++; if (row >= rows) { screen.shift(); screen.push(""); row = rows - 1; } i++; continue; }
    const nextCtl = data.slice(i).search(/[\x1b\r\n]/);
    const text = nextCtl === -1 ? data.slice(i) : data.slice(i, i + nextCtl);
    put(text); i += text.length;
  }
  return screen;
}

(async () => {
  const { TuiMainScreen } = await import(tuiPath);
  const ROWS = 46;
  let out = "";
  const term = { columns: 80, rows: ROWS, write: (chunk) => { out += chunk; }, start: () => {}, stop: () => {}, hideCursor: () => {}, showCursor: () => {} };
  const chatLines = [];
  const chat = { render: () => [...chatLines], handleInput: () => {} };
  const editor = { render: () => ["== editor ==", "> input"], handleInput: () => {} };
  const tui = new TuiMainScreen(term, false);
  tui.addChild(chat);
  tui.addChild(editor);
  tui.start();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  for (let i = 1; i <= 10; i++) chatLines.push(`chat line ${i}`);
  tui.requestRender();
  await settle();

  // Resize while the active buffer (12 lines) is far shorter than the window.
  term.rows = 45; tui.requestRender(); await settle();
  term.rows = ROWS; tui.requestRender(); await settle();

  let screen = emulate(out, ROWS);
  let lastContent = -1;
  screen.forEach((line, idx) => { if (line.trim()) lastContent = idx; });
  assert.equal(screen[lastContent].includes("input") || screen[lastContent].includes("editor"), true, "editor is the last visible content");
  assert.ok(lastContent >= ROWS - 3, `short active buffer must stay bottom-anchored after resize (last content row ${lastContent} of ${ROWS})`);

  // Streaming continues after the resize: appends must keep bottom anchoring
  // and stay consistent (no cursor drift painting into the middle).
  for (let i = 11; i <= 16; i++) { chatLines.push(`chat line ${i}`); tui.requestRender(); await settle(); }
  screen = emulate(out, ROWS);
  lastContent = -1;
  screen.forEach((line, idx) => { if (line.trim()) lastContent = idx; });
  assert.ok(lastContent >= ROWS - 3, `appended content stays bottom-anchored (last content row ${lastContent})`);
  assert.ok(screen.some((line) => line.includes("chat line 16")), "latest streamed line is visible");
  assert.equal(screen.filter((line) => line.includes("chat line 16")).length, 1, "no duplicated rows from cursor drift");

  tui.stop();
  console.log("pi-tui viewport anchor tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
