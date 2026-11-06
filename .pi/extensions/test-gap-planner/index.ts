import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, basename, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { testImpact } = require(join(LIB_ROOT, "src", "project-intelligence.js"));
const { notify, writeJson } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

const ENABLED = process.env.PI_TEST_GAP_PLANNER !== "0";
const STATE_DIR = ".pi/test-gap-planner";
function plan(cwd: string, inputFiles?: string[]) { return testImpact(cwd, inputFiles); }
function skeleton(cwd: string, file: string) { const ext = extname(file); const stem = basename(file).replace(/\.[^.]+$/, ""); const dir = "tests"; const target = ext === ".py" ? `${dir}/test_${stem}.py` : `${dir}/${stem}.test.js`; const body = ext === ".py" ? `def test_${stem.replace(/\W+/g, "_")}_behavior():\n    # TODO: exercise ${file}\n    assert True\n` : `const assert = require("node:assert/strict");\n\ntest("${stem} behavior", () => {\n  // TODO: exercise ${file}\n  assert.equal(true, true);\n});\n`; return { target, body, exists: existsSync(join(cwd, target)) }; }
function format(p: any) { return [`Test gap plan: files=${p.summary.files} gaps=${p.summary.gaps} highRisk=${p.summary.highRisk}`, `changedFiles: ${p.changedFiles.join(", ") || "none"}`, ...p.gaps.map((g: any) => `${g.gap ? "GAP" : "ok "} risk=${g.risk.score} ${g.file} -> ${g.recommendation}`), `Commands: ${p.recommendedCommands.join("; ") || "none"}`].join("\n"); }

export default function testGapPlanner(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  if (!ENABLED) return;
  pi.registerCommand("test-gaps", { description: "Show test gaps for changed files", handler: async (_args: string, ctx: any) => { const p = plan(ctx.cwd); writeJson(join(ctx.cwd, STATE_DIR, "latest-plan.json"), p); notify(ctx, format(p), p.summary.gaps ? "warning" : "info"); } });
  pi.registerCommand("test-plan", { description: "Show JSON test plan for changed files", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify(plan(ctx.cwd), null, 2), "info") });
  pi.registerCommand("test-impact", { description: "Show changed files, mapped tests, and risk", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify(plan(ctx.cwd).gaps, null, 2), "info") });
  pi.registerCommand("test-generate-skeletons", { description: "Preview test skeletons for gap files; pass --write to create", handler: async (args: string, ctx: any) => { const p = plan(ctx.cwd); const write = /--write|--apply|--yes/.test(args || ""); const skels = p.gaps.filter((g: any) => g.gap).map((g: any) => skeleton(ctx.cwd, g.file)); if (write) for (const s of skels) if (!s.exists) { mkdirSync(dirname(join(ctx.cwd, s.target)), { recursive: true }); writeFileSync(join(ctx.cwd, s.target), s.body); } notify(ctx, JSON.stringify({ write, skeletons: skels.map((s: any) => ({ target: s.target, exists: s.exists, body: write ? undefined : s.body })) }, null, 2), write ? "warning" : "info"); } });
  pi.registerCommand("test-risk", { description: "Summarize verification risk for changed files", handler: async (_args: string, ctx: any) => { const p = plan(ctx.cwd); notify(ctx, JSON.stringify({ summary: p.summary, highRisk: p.gaps.filter((g: any) => g.risk.score >= 4) }, null, 2), p.summary.highRisk ? "warning" : "info"); } });
  pi.registerTool({ name: "test_gap_planner", label: "Test gap planner", description: "Analyze changed files, preserve source-specific lexical/CodeGraph test provenance, identify verification gaps, and preview test skeletons.", parameters: Type.Object({ operation: Type.Optional(Type.Union([Type.Literal("gaps"), Type.Literal("plan"), Type.Literal("impact"), Type.Literal("skeletons"), Type.Literal("risk")])), files: Type.Optional(Type.Array(Type.String())), input: Type.Optional(Type.Any()) }), async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) { const p = plan(ctx.cwd, params.files); const op = params.operation || "plan"; const details = op === "risk" ? { summary: p.summary, highRisk: p.gaps.filter((g: any) => g.risk.score >= 4) } : op === "skeletons" ? p.gaps.filter((g: any) => g.gap).map((g: any) => skeleton(ctx.cwd, g.file)) : op === "impact" ? p.gaps : p; return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details }; } });
}
