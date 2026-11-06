import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { createTestRunner, parseCliArgs, formatSize, normalizeTestRunnerParams } = require(join(LIB_ROOT, "src", "test-runner.js"));

// Env knobs are parsed in src/test-runner.js: process.env.PI_TEST_RUNNER process.env.PI_TEST_RUNNER_TIMEOUT_MS process.env.PI_TEST_RUNNER_MAX_BUFFER process.env.PI_TEST_RUNNER_MAX_LINES process.env.PI_TEST_RUNNER_MAX_BYTES process.env.PI_TEST_RUNNER_MAX_COMMANDS process.env.PI_TEST_RUNNER_ALLOW_CUSTOM
const runner = createTestRunner();
const ENABLED = runner.config.enabled;
const OUTPUT_MAX_LINES = runner.config.outputMaxLines;
const OUTPUT_MAX_BYTES = runner.config.outputMaxBytes;

type ToolContext = { cwd: string; ui?: any };
const Operation = Type.Optional(Type.String({ description: "Operation: status, listProfiles, infer, run, or rerunFailures. Case, snake_case, and kebab-case variants are accepted; profiles/list and rerun are aliases." }));
const Profile = Type.Optional(Type.String({ description: "Profile: quick, changed, full, live, unit, integration, lint, or typecheck. focused/all/tests are accepted aliases; live is opt-in and requires configured providers." }));

async function notify(ctx: any, promise: Promise<any>) {
  try {
    const result = await promise;
    const text = result.content?.[0]?.text || JSON.stringify(result.details, null, 2);
    ctx.ui.notify(text, "info");
  } catch (e: any) {
    ctx.ui.notify(String(e?.message || e), "error");
  }
}

export default function testRunnerExtension(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi, { extension: "test-runner", outcomePolicies: { test_runner: { run: "domain-negative", rerunFailures: "domain-negative" } } }) as ExtensionAPI;
  if (!ENABLED) return;

  pi.registerCommand("test-runner-status", { description: "Show inferred test-runner status and profiles", handler: async (args: string, ctx: any) => notify(ctx, runner.status(ctx, parseCliArgs(args).opts)) });
  pi.registerCommand("test-runner-profiles", { description: "List inferred test profiles and commands", handler: async (args: string, ctx: any) => notify(ctx, runner.listProfiles(ctx, parseCliArgs(args).opts)) });
  pi.registerCommand("test-runner-infer", { description: "Infer selected test commands: /test-runner-infer [--profile changed] [files...]", handler: async (args: string, ctx: any) => { const parsed = parseCliArgs(args); await notify(ctx, runner.infer(ctx, { ...parsed.opts, files: parsed.positional })); } });
  pi.registerCommand("test-runner-run", { description: "Run inferred tests: /test-runner-run [--profile changed|quick|full|live] [--coverage] [files...]", handler: async (args: string, ctx: any) => { const parsed = parseCliArgs(args); await notify(ctx, runner.run(ctx, { ...parsed.opts, files: parsed.positional })); } });
  pi.registerCommand("test-runner-rerun-failures", { description: "Rerun previously failing test-runner commands", handler: async (args: string, ctx: any) => notify(ctx, runner.rerunFailures(ctx, parseCliArgs(args).opts)) });

  pi.registerTool({
    name: "test_runner",
    label: "Test runner",
    outputSchema: require("../../../src/pi-extension-kit.js").TOOL_OUTPUT_SCHEMAS.test_runner,
    description: `Infer and run repository-defined tests with structured succeeded/failed/not-applicable outcomes, captured command evidence, failure hints, and latest-failure reruns. Empty inference or no prior failures is not-applicable, never a tool error. Output is truncated to ${OUTPUT_MAX_LINES} lines or ${formatSize(OUTPUT_MAX_BYTES)}.`,
    promptSnippet: "Infer and run focused project tests with structured pass/fail evidence",
    promptGuidelines: ["Use test_runner infer before running tests when selecting a focused verifier for changed files.", "Treat outcome=not-applicable as no repository-defined command for that request, not as a passing verification or tool failure.", "Use test_runner run after code edits before claiming behavior is verified.", "Use test_runner rerunFailures after fixing a failing test command."],
    parameters: Type.Object({ operation: Operation, profile: Profile, path: Type.Optional(Type.String({ description: "Project path. Defaults to the current Pi working directory and must stay inside cwd." })), files: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "One changed/target file or an array of files for focused test inference." })), commandId: Type.Optional(Type.String({ description: "Run a specific inferred command id or command line from listProfiles/infer output. Call operation=infer first." })), command: Type.Optional(Type.String({ description: "Custom command; rejected unless PI_TEST_RUNNER_ALLOW_CUSTOM=1. Prefer commandId from infer." })), timeoutMs: Type.Optional(Type.Number({ description: "Per-command timeout in milliseconds." })), stopOnFailure: Type.Optional(Type.Boolean({ description: "Stop after first failing command. Defaults to true." })), coverage: Type.Optional(Type.Boolean({ description: "Explicit V8 coverage capture for direct Node tests only; bounded, revision/configuration-qualified source/test evidence. Off by default." })), configuration: Type.Optional(Type.String()), input: Type.Optional(Type.Any()) }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: ToolContext) {
      const p = normalizeTestRunnerParams(params);
      const op = p.operation;
      if (op === "status") return runner.status(ctx, p);
      if (op === "listProfiles") return runner.listProfiles(ctx, p);
      if (op === "infer") return runner.infer(ctx, p);
      if (op === "run") return runner.run(ctx, p, signal);
      if (op === "rerunFailures") return runner.rerunFailures(ctx, p, signal);
      throw new Error(`Unknown test_runner operation: ${op}`);
    },
  });
}
