import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { resolveBuildConfig, runBuild, runTests, formatRunProgress, formatRunResult } = require(join(LIB_ROOT, "src", "build-runner.js"));
const { notify, setTurnExitCode } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

// Session mining: cmake --build hand-typed 858x/month, test binaries
// 1,043x/month, 35 default-timeout kills, 61 uncaptured SIGABRTs. One-token
// build/test with build-length timeouts, memory-aware native parallelism,
// project build-script support, and automatic crash backtraces.
const ENABLED = process.env.PI_BUILD_RUNNER !== "0";

export default function buildRunner(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi, { extension: "build-runner", outcomePolicies: { build_project: "domain-negative", test_project: "domain-negative" } }) as ExtensionAPI;
  if (!ENABLED) return;
  pi.registerCommand("build", { description: "Build the project (pinned .pi/project.json or detected cmake/npm): /build [target] [--configure]", handler: async (args: string, ctx: any) => {
    const configure = /--configure/.test(args || "");
    const target = String(args || "").replace(/--configure/g, "").trim() || undefined;
    const result = await runBuild(ctx.cwd, { target, ...(configure ? { configure: true } : {}) });
    if (!result.ok) setTurnExitCode(ctx);
    notify(ctx, formatRunResult(result), result.ok ? "info" : "warning");
  }});
  pi.registerCommand("test", { description: "Run project tests with optional filter (pinned or detected binaries; auto-backtrace on native crash): /test [filter]", handler: async (args: string, ctx: any) => {
    const result = await runTests(ctx.cwd, { filter: String(args || "").trim() || undefined });
    if (!result.ok) setTurnExitCode(ctx);
    notify(ctx, formatRunResult(result), result.ok ? "info" : "warning");
  }});
  pi.registerCommand("build-config", { description: "Show resolved build/test configuration and its source", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify(resolveBuildConfig(ctx.cwd), null, 2), "info") });
  pi.registerTool({
    name: "build_project",
    label: "Build project",
    description: "Build the current project using its pinned/detected build command or project build script. Builds share user-wide admission, a RAM safe-start check, and owned-group RSS monitoring; native builds also get a finite CPU/repo-size-aware job cap.",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "Optional build target defined by the current repository" })),
      configure: Type.Optional(Type.Boolean({ description: "Run the detected configure/build script first; canonical full-build scripts replace a duplicate direct full build" })),
      configureArgs: Type.Optional(Type.Array(Type.String(), { description: "Explicit repository-specific script arguments. Omit to use .pi/project.json configure.args/configure.argsByTarget or the script's own defaults." })),
    }),
    async execute(_id: string, params: any, signal: any, onUpdate: any, ctx: any) {
      const result = await runBuild(ctx.cwd, {
        target: params.target,
        configure: params.configure,
        configureArgs: params.configureArgs,
        signal,
        onProgress: onUpdate ? (progress: any) => onUpdate({
          content: [{ type: "text", text: formatRunProgress(progress) }],
          details: {
            status: progress.status,
            phase: progress.phase,
            elapsedMs: progress.elapsedMs,
            stdoutTail: progress.stdoutTail,
            stderrTail: progress.stderrTail,
          },
        }) : undefined,
      });
      return { content: [{ type: "text", text: formatRunResult(result) }], details: result };
    },
  });
  pi.registerTool({
    name: "test_project",
    label: "Run project tests",
    description: "Run the project's test binaries/commands under shared worker/RSS guardrails with an optional subsystem filter; native crashes (SIGABRT) automatically capture a gdb backtrace. Prefer this over hand-typing test binary paths.",
    parameters: Type.Object({ filter: Type.Optional(Type.String({ description: "Test filter, e.g. ragdoll or joints" })), backtrace: Type.Optional(Type.Boolean({ description: "Capture gdb backtrace on crash (default true)" })) }),
    async execute(_id: string, params: any, signal: any, onUpdate: any, ctx: any) {
      const result = await runTests(ctx.cwd, {
        filter: params.filter,
        backtrace: params.backtrace,
        signal,
        onProgress: onUpdate ? (progress: any) => onUpdate({
          content: [{ type: "text", text: formatRunProgress(progress) }],
          details: {
            status: progress.status,
            phase: progress.phase,
            elapsedMs: progress.elapsedMs,
            stdoutTail: progress.stdoutTail,
            stderrTail: progress.stderrTail,
          },
        }) : undefined,
      });
      return { content: [{ type: "text", text: formatRunResult(result) }], details: result };
    },
  });
}
