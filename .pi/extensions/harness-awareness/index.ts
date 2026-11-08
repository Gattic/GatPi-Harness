import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { notify } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

// Session mining showed harness value flows through model tools, and tools
// only get used when the model knows when to reach for them (the Obsidian
// extension proved the awareness-prompt mechanism). One compact block for the
// workflow tool families; disable with PI_HARNESS_AWARE=0.
const ENABLED = process.env.PI_HARNESS_AWARE !== "0";

// The task router removes optional groups from the default surface until a
// prompt needs them. Awareness that names a tool the model does not have is
// worse than silence: the model reads it as stale harness state and improvises
// around the missing tool. Each entry is advertised only when every tool it
// names is active, and activation itself is named once.
const AWARENESS = [
  {
    tools: ["build_project", "test_project"],
    text: "- build_project / test_project: build and run project tests (pinned .pi/project.json or detected CMake/npm; long timeouts; native crashes auto-capture a gdb backtrace). Use instead of typing cmake/npm/test-binary commands.",
  },
  {
    tools: ["bg_run"],
    text: "- bg_run: run long commands (full builds, suites, servers) as detached background jobs and poll status/logs on later turns instead of blocking or timing out.",
  },
  {
    tools: ["debug_ledger", "fix_recall", "safe_try", "evidence_inbox"],
    text: "- Bug hunts: open a debug_ledger thread first and check fix_recall for similar past errors; safe_try checkpoint before risky attempts (revert on 'worse'); record every attempt verdict; evidence_inbox lists fresh screenshots/logs/profiles to reference.",
  },
  {
    tools: ["run_deck"],
    text: "- Long-running runs (training, downloads, pretokenization): run_deck launch/attach registers the run once; run_deck status answers 'how is the run doing' (alive, log vitals like step/loss/val/tok_s/skips/nan, GPU) in ONE call instead of ls -td/tail/grep/nvidia-smi compounds; run_deck watch waits for a short bounded milestone.",
  },
  {
    tools: ["run_monitor"],
    text: "- Periodic observation: run_monitor watches an existing bg_run/run_deck target and notifies on literal milestone match, settlement, timeout, or error; terminal edges run scripts/run-monitor-check.js, so script-backed checks never start a model turn. Use it instead of automation_loop merely to babysit one process.",
  },
  {
    tools: ["experiment_ledger"],
    text: "- Experiment arcs (pre-registered gates, A/B arms, ship bars): experiment_ledger open records hypothesis+bars BEFORE running; record every gate verdict (pass/fail/null-result) with GPU-hours; check open experiments before launching runs so settled gates are not re-run.",
  },
  {
    tools: ["automation_loop"],
    text: "- Ralph-style automation: /loop (automation_loop start) repeats the same task prompt across settled turns with bounded iterations, exact completion promises or evidence-backed completion, checkpoint history, stall detection, and pause/resume/stop controls.",
  },
  {
    tools: ["repo_context"],
    text: "- repo_context: one call for branch/changes/commits/docs digest instead of separate git status/diff/log and doc re-reads.",
  },
  {
    tools: ["project_scope"],
    text: "- project_scope: read another in-scope project directory's .pi state inventory, bounded diagnostic logs, and one bounded state file; declare directories with PI_HARNESS_PROJECT_DIRS or /policy-approve-directory.",
  },
  {
    tools: ["commit_plan"],
    text: "- commit_plan: when asked to commit, plan logical groups, refine messages, apply per group.",
  },
];

const ACTIVATION_HINT = "More optional harness tools (debug ledger, fix recall, safe try, evidence inbox, run deck, run monitor, experiment ledger, automation loop, commit plan, delegation/topology, memory/vault, codegraph, semgrep, evidence, CI, queue, extension governance) activate when a request matches their task or by name with activate_tools({ tools: [names] }); activate_tools with no arguments lists them with current state and blockers.";

const HELP_TEXT = `${AWARENESS.map((entry) => entry.text).join("\n")}\n\n${ACTIVATION_HINT}\n\nHuman commands: /build /test /bg /bg-status /run-status /runs /run-launch /run-attach /monitor-start /monitor-status /monitors /exp-open /exp-gate /exp-list /loop /loop-status /loop-pause /loop-resume /loop-stop /debug-open /debug-list /fix-recall /try /try-revert /repo-context /project-scope /commit-plan /subagent-fanout /evidence /harness-metrics`;

/** The awareness block for the tools actually declared in this session. */
export function awarenessPrompt(activeNames: readonly string[]) {
  const active = new Set(activeNames);
  const bullets = AWARENESS.filter((entry) => entry.tools.every((tool) => active.has(tool))).map((entry) => entry.text);
  const lines = bullets.length ? ["Harness workflow tools active in this session; prefer them over hand-typed shell rituals:", ...bullets] : [];
  // Activation only exists where the router registered it; a restricted child
  // session must not be told to call a tool it does not have.
  if (active.has("activate_tools")) lines.push(ACTIVATION_HINT);
  return lines.join("\n");
}

export default function harnessAwareness(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  if (!ENABLED) return;
  pi.on("before_agent_start" as any, async (event: any) => {
    const active = pi.getActiveTools?.();
    if (!Array.isArray(active)) return;
    const awareness = awarenessPrompt(active);
    if (!awareness) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${awareness}` };
  });
  pi.registerCommand("harness-help", { description: "Show the harness workflow tool cheat sheet", handler: async (_args: string, ctx: any) => notify(ctx, HELP_TEXT, "info") });
}
