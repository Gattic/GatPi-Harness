import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { createPiIntegrationBoundary, MemoryJsonStorage, NullSink } = require(join(LIB_ROOT, "src", "integration-boundary.js"));
const { renderRolloutCenterFrame, filteredCapabilities } = require(join(LIB_ROOT, "src", "rollout-center-view.js"));
const { notify } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

const ENABLED = process.env.PI_ROLLOUT_CENTER !== "0";
const FILTERS = ["all", "attention", "stale"];

function createAdapter(cwd: string) {
  const disabled = { enabled: false };
  return createPiIntegrationBoundary({
    storage: new MemoryJsonStorage(), sink: new NullSink(),
    trace: disabled, memory: disabled, stateInventory: disabled, memoryState: disabled, memorySafety: disabled,
    sessionSearch: disabled, memoryMaintenance: disabled, retention: disabled, statePermissions: disabled,
    projectMemory: disabled, executionOutcomes: disabled, hermes: disabled, goalController: disabled, goalEvidence: disabled,
    learning: disabled, context: disabled, anchoring: disabled, verification: disabled, visualVerification: disabled,
    entropy: disabled, reasoning: disabled, orchestration: disabled, branching: disabled, subagents: disabled,
    skills: disabled, skillIntake: disabled, provenance: disabled, compounding: disabled, topologies: disabled,
    rolloutCenter: { enabled: true, cwd },
  }).rolloutCenter;
}

class RolloutCenterComponent {
  private selectedIndex = 0;
  private filterIndex = 0;
  private mode = "summary";
  private snapshot: any;

  constructor(private tui: TUI, private theme: Theme, private done: () => void, private adapter: any) {
    this.snapshot = adapter.snapshot();
  }

  handleInput(data: string): void {
    const visible = this.filteredCount();
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.done(); return; }
    if (matchesKey(data, "up") || matchesKey(data, "k")) this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    else if (matchesKey(data, "down") || matchesKey(data, "j")) this.selectedIndex = Math.min(Math.max(0, visible - 1), this.selectedIndex + 1);
    else if (matchesKey(data, "return") || matchesKey(data, "right")) this.mode = "detail";
    else if (matchesKey(data, "left")) this.mode = "summary";
    else if (matchesKey(data, "p")) this.mode = this.mode === "provenance" ? "detail" : "provenance";
    else if (matchesKey(data, "tab")) { this.filterIndex = (this.filterIndex + 1) % FILTERS.length; this.selectedIndex = 0; }
    else if (matchesKey(data, "r")) { this.snapshot = this.adapter.snapshot(); this.selectedIndex = 0; }
    this.tui.requestRender();
  }

  private filteredCount(): number {
    const filter = FILTERS[this.filterIndex];
    if (filter === "all") return this.snapshot.capabilities.length;
    if (filter === "attention") return this.snapshot.capabilities.filter((item: any) => ["degraded", "blocked", "unknown"].includes(item.technicalReadiness.status) || ["failed", "insufficient-data", "null-result", "stale"].includes(item.fieldProof.status)).length;
    return this.snapshot.capabilities.filter((item: any) => item.provenance.some((row: any) => String(row.freshness).startsWith("stale"))).length;
  }

  render(width: number): string[] {
    const lines = renderRolloutCenterFrame(this.snapshot, { selectedIndex: this.selectedIndex, filter: FILTERS[this.filterIndex], mode: this.mode }, width);
    return lines.map((line: string, index: number) => {
      if (index === 0 || index === lines.length - 1) return this.theme.fg("border", line);
      if (line.startsWith("|>")) return this.theme.fg("accent", line);
      if (/FAIL|BLOCKED|STALE|NULL|INSUFFICIENT/.test(line)) return this.theme.fg("warning", line);
      return line;
    });
  }

  invalidate(): void {}
  dispose(): void {}
}

export default function rolloutCenter(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  if (!ENABLED) return;
  pi.registerCommand("rollout-center", {
    description: "Open the read-only unified evidence and rollout center",
    handler: async (args: string, ctx: ExtensionContext) => {
      const adapter = createAdapter(ctx.cwd);
      const requestedFilter = String(args || "").trim();
      const filter = FILTERS.includes(requestedFilter) ? requestedFilter : "all";
      if (!ctx.hasUI) {
        const snapshot = adapter.snapshot();
        notify(ctx, JSON.stringify({ ...snapshot, capabilities: filteredCapabilities(snapshot, filter) }, null, 2), "info");
        return;
      }
      await ctx.ui.custom<void>((tui: TUI, theme: Theme, _keybindings: any, done: () => void) => new RolloutCenterComponent(tui, theme, done, adapter), {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%", minWidth: 32, maxHeight: 30 },
      });
    },
  });
}
