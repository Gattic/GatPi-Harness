import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { createProjectIndex, profile, testImpact } = require(join(LIB_ROOT, "src", "project-intelligence.js"));
const { readJson, writeJson, registerOperationTool, notify } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

// project-profiler was merged into this extension; both wrap the same
// src/project-intelligence.js library. The env gates stay independent so
// existing configurations keep working.
const ENABLED = process.env.PI_PROJECT_INTELLIGENCE !== "0";
const PROFILER_ENABLED = process.env.PI_PROJECT_PROFILER !== "0";
const STATE_DIR = ".pi/project-intelligence";
const PROFILER_STATE_DIR = ".pi/project-profiler";

function formatIndex(index: any) { return [`Project intelligence ${index.fingerprint}`, `Languages: ${index.languages.map((l: any) => `${l.language}(${l.files})`).join(", ") || "unknown"}`, `Sources: ${index.sources.length}; tests: ${index.tests.length}; symbols: ${index.symbols.length}`, `Build graph: ${index.buildGraph?.fingerprint || "unavailable"}; providers: ${index.buildGraph?.providers?.map((p: any) => `${p.provider}:${p.available ? "ready" : "degraded"}`).join(", ") || "none"}`, `Verifier profiles: ${index.verifierProfiles.map((v: any) => `${v.profile}:${v.command}`).join("; ") || "none"}`, `Topologies: ${index.recommendedTopologies.join(", ")}`].join("\n"); }
function recommend(cwd: string) { const p = profile(cwd); return { detected: p.detected, verifierProfiles: p.verifierProfiles, topologies: p.topologies, safeCommands: p.safeCommands, privacy: p.privacy, dependencies: p.dependencies, symbols: p.symbols, buildGraph: p.buildGraph, generatedAt: p.generatedAt, fingerprint: p.fingerprint }; }
function writeConfig(cwd: string) { const p = profile(cwd); const file = join(cwd, ".pi", "project.json"); const existing = readJson(file, {}); writeJson(file, { ...existing, version: 1, generatedBy: "project-profiler", generatedAt: p.generatedAt, languages: p.detected.languages, verifierProfiles: p.verifierProfiles, recommendedTopologies: p.topologies, safeCommands: p.safeCommands, privacy: p.privacy, fingerprint: p.fingerprint }); writeJson(join(cwd, PROFILER_STATE_DIR, "latest-profile.json"), p); return { file, profile: p }; }
function formatProfile(p: any) { return [`Project profile: ${p.cwd}`, `Languages: ${p.detected.languageCounts?.map((l: any) => `${l.language}(${l.files})`).join(", ") || p.detected.languages.join(", ") || "unknown"}`, `Verifier profiles: ${p.verifierProfiles.map((v: any) => `${v.profile}:${v.command}`).join("; ") || "none discovered"}`, `Recommended topologies: ${p.topologies.join(", ")}`, `Safe commands: ${p.safeCommands.join("; ")}`].join("\n"); }

export default function projectIntelligence(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  if (ENABLED) {
    pi.registerCommand("project-index", { description: "Build/show deep project intelligence index", handler: async (_args: string, ctx: any) => { const index = createProjectIndex(ctx.cwd); writeJson(join(ctx.cwd, STATE_DIR, "latest-index.json"), index); notify(ctx, formatIndex(index), "info"); } });
    pi.registerCommand("project-symbols", { description: "Show discovered exported/functions/classes", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify(createProjectIndex(ctx.cwd).symbols.slice(0, 300), null, 2), "info") });
    pi.registerCommand("project-tests-map", { description: "Show changed-file to test impact map", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify(testImpact(ctx.cwd), null, 2), "info") });
    pi.registerCommand("project-deps", { description: "Show dependency manifests and scripts", handler: async (_args: string, ctx: any) => { const i = createProjectIndex(ctx.cwd); notify(ctx, JSON.stringify({ dependencies: i.dependencies, scripts: i.scripts, ci: i.ci }, null, 2), "info"); } });
    registerOperationTool(pi, {
      name: "project_intelligence",
      label: "Project intelligence",
      description: "Build a repo index with languages, symbols, tests, dependencies, CI, build-provider status/fingerprint, verifier profiles, topology recommendations, and explicit degraded-advisory optional-provider state.",
      parameters: Type.Object({ operation: Type.Optional(Type.Union([Type.Literal("index"), Type.Literal("profile"), Type.Literal("symbols"), Type.Literal("tests"), Type.Literal("deps")])), input: Type.Optional(Type.Any()) }),
      defaultOperation: "index",
      handlers: {
        index: (ctx: any, params: any) => createProjectIndex(ctx.cwd, params.input || {}),
        profile: (ctx: any) => profile(ctx.cwd),
        symbols: (ctx: any, params: any) => createProjectIndex(ctx.cwd, params.input || {}).symbols,
        tests: (ctx: any, params: any) => testImpact(ctx.cwd, params.input?.files, params.input || {}),
        deps: (ctx: any, params: any) => { const i = createProjectIndex(ctx.cwd, params.input || {}); return { dependencies: i.dependencies, scripts: i.scripts, ci: i.ci, buildGraph: i.buildGraph }; },
      },
    });
  }
  if (PROFILER_ENABLED) {
    pi.registerCommand("project-profile", { description: "Inspect this repo and show a Pi project profile", handler: async (_args: string, ctx: any) => notify(ctx, formatProfile(profile(ctx.cwd)), "info") });
    pi.registerCommand("project-init-pi", { description: "Write .pi/project.json from detected repo conventions", handler: async (_args: string, ctx: any) => { const r = writeConfig(ctx.cwd); notify(ctx, `Wrote ${r.file}`, "info"); } });
    pi.registerCommand("project-recommend", { description: "Show recommended verifiers/topologies/policies", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify(recommend(ctx.cwd), null, 2), "info") });
    pi.registerCommand("project-safe-commands", { description: "Show locally inferred safe commands", handler: async (_args: string, ctx: any) => notify(ctx, profile(ctx.cwd).safeCommands.join("\n") || "No safe commands inferred", "info") });
    pi.registerCommand("project-write-config", { description: "Alias for /project-init-pi", handler: async (_args: string, ctx: any) => { const r = writeConfig(ctx.cwd); notify(ctx, JSON.stringify({ file: r.file, topologies: r.profile.topologies, verifierProfiles: r.profile.verifierProfiles }, null, 2), "info"); } });
    registerOperationTool(pi, {
      name: "project_profiler",
      label: "Project profiler",
      description: "Profile a repository and recommend Pi verifier, topology, safety, and privacy configuration.",
      parameters: Type.Object({ operation: Type.Optional(Type.Union([Type.Literal("profile"), Type.Literal("recommend"), Type.Literal("safeCommands"), Type.Literal("writeConfig")])), input: Type.Optional(Type.Any()) }),
      defaultOperation: "profile",
      handlers: {
        profile: (ctx: any) => profile(ctx.cwd),
        recommend: (ctx: any) => recommend(ctx.cwd),
        safeCommands: (ctx: any) => ({ safeCommands: profile(ctx.cwd).safeCommands }),
        writeConfig: (ctx: any) => writeConfig(ctx.cwd),
      },
    });
  }
}
