import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

const { GoalStore } = require("./goal-store.js");
const { GoalRunner, pendingPromptHasBranchOutput } = require("./goal-runner.js");
const { AutomationLoopStore } = require("../../../src/automation-loop.js");
const { ExecutionOutcomeAdapter, GoalControllerAdapter, GoalEvidenceAdapter, HermesAdvisoryAdapter } = require("../../../src/integration-boundary.js");
const { writeFile } = require("node:fs/promises");

const EXECUTION_OUTCOME_CAPTURE = process.env.PI_EXECUTION_OUTCOME_CAPTURE !== "0";
const GOAL_OUTCOME_PRODUCER_VERSION = "goal-extension-2026-09-03.3";

type GoalState = {
	schemaVersion?: number;
	id: string;
	goal: string;
	status: "running" | "completed" | "blocked" | "failed" | "cancelled";
	iteration: number;
	maxIterations: number;
	observations: string[];
	history?: Array<Record<string, unknown>>;
	createdAt: string;
	updatedAt: string;
};

function parseGoalArgs(args: string): { task: string; maxIterations?: number; approvedTopologyIds: string[] } {
	const raw = args.trim();
	const maxMatch = raw.match(/(?:^|\s)--max(?:-iterations)?=(\d+)(?:\s|$)/);
	const maxIterations = maxMatch ? Math.max(1, Math.min(500, Number(maxMatch[1]))) : undefined;
	const approvedTopologyIds = [...raw.matchAll(/(?:^|\s)--allow-topology=([A-Za-z0-9][A-Za-z0-9._:-]{0,159})(?=\s|$)/g)].map((match) => match[1]);
	const task = raw
		.replace(/(?:^|\s)--max(?:-iterations)?=\d+(?=\s|$)/g, " ")
		.replace(/(?:^|\s)--allow-topology=[A-Za-z0-9][A-Za-z0-9._:-]{0,159}(?=\s|$)/g, " ")
		.trim();
	return { task, maxIterations, approvedTopologyIds: [...new Set(approvedTopologyIds)] };
}

function recent(state: GoalState | undefined, count = 5): string[] {
	if (!state) return ["No goal state found."];
	return (state.observations || []).slice(-count).flatMap((entry, index) => [index ? "" : "Recent observations:", entry]);
}

function formatStatus(state: GoalState | undefined): string[] {
	if (!state) return ["No active or recent goal."];
	return [
		`Goal: ${state.goal}`,
		`ID: ${state.id}`,
		`Status: ${state.status}`,
		`Iteration: ${state.iteration}/${state.maxIterations}`,
		`Trace correlation: ${(state as any).traceCorrelationId ?? "none"}`,
		`Completion evidence IDs: ${((state as any).completionEvidenceIds || []).join(", ") || "none"}`,
		`Approved mutation-capable topologies: ${((state as any).actionAuthority?.approvedTopologyIds || []).join(", ") || "none"}`,
		`Created: ${state.createdAt}`,
		`Updated: ${state.updatedAt}`,
		"",
		...recent(state, 5),
	];
}

async function showLines(ctx: ExtensionCommandContext, widget: string, lines: string[]) {
	if (ctx.hasUI) ctx.ui.setWidget(widget, lines);
	else console.log(lines.join("\n"));
}

function projectKey(cwd: string): string {
	let raw = cwd;
	try {
		raw = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim() || cwd;
	} catch {}
	const resolved = path.resolve(raw || cwd || process.cwd());
	let root = resolved;
	try { root = realpathSync.native(resolved); } catch { try { root = realpathSync(resolved); } catch {} }
	const name = (path.basename(root) || "repo").replace(/[^a-zA-Z0-9._-]/g, "_");
	const rootHash = createHash("sha256").update(root).digest("hex").slice(0, 12);
	return `pi:${name}:${rootHash}`;
}

function parseDurationMs(value: string): number | undefined {
	const match = value.match(/^(\d+)([smhd])$/i);
	if (!match) return undefined;
	const n = Number(match[1]);
	const unit = match[2].toLowerCase();
	return n * (unit === "s" ? 1000 : unit === "m" ? 60000 : unit === "h" ? 3600000 : 86400000);
}

function parseArchiveArgs(args: string): { statuses?: string[]; olderThanMs?: number } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const statuses = parts.filter((part) => ["completed", "blocked", "failed", "cancelled"].includes(part));
	const older = parts.find((part) => part.startsWith("--older-than="))?.split("=")[1];
	return { statuses: statuses.length ? statuses : undefined, olderThanMs: older ? parseDurationMs(older) : undefined };
}

function parseKeep(args: string): number {
	const match = args.match(/(?:^|\s)--keep=(\d+)/);
	return match ? Math.max(0, Math.min(1000, Number(match[1]))) : 20;
}

function formatCompactHistory(state: GoalState, count: number): string[] {
	const history = state.history || [];
	if (!history.length) return (state.observations || []).slice(-count);
	return history.slice(-count).map((record: any) => {
		const prompt = record.action?.prompt ? ` prompt=${String(record.action.prompt).replace(/\s+/g, " ").slice(0, 120)}` : "";
		const check = record.completionCheck ? ` check=${String(record.completionCheck).replace(/\s+/g, " ").slice(0, 120)}` : "";
		return `#${record.iteration} ${record.status}${record.executed ? " executed" : ""}${prompt}${check}`;
	});
}

function exportGoal(state: GoalState, format: string): string {
	if (format === "json") return JSON.stringify(state, null, 2) + "\n";
	return [
		`# Goal ${state.id}`,
		"",
		`- Status: ${state.status}`,
		`- Iteration: ${state.iteration}/${state.maxIterations}`,
		`- Trace correlation: ${(state as any).traceCorrelationId ?? "none"}`,
		`- Created: ${state.createdAt}`,
		`- Updated: ${state.updatedAt}`,
		"",
		"## Goal",
		"",
		state.goal,
		"",
		"## History",
		"",
		...(state.history?.length ? state.history.map((record) => "```json\n" + JSON.stringify(record, null, 2) + "\n```") : ["(no structured history)"]),
		"",
		"## Observations",
		"",
		...(state.observations || []).map((entry) => "```text\n" + entry + "\n```"),
	].join("\n");
}

export default function (pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
	let store: any;
	let runner: any;
	let outcomes: any;
	let goalController: any;
	let goalEvidence: any;

	function ensure(ctx: { cwd: string }) {
		if (!store || store.cwd !== ctx.cwd) {
			store = new GoalStore({ cwd: ctx.cwd });
			outcomes = new ExecutionOutcomeAdapter({ cwd: ctx.cwd, enabled: EXECUTION_OUTCOME_CAPTURE });
			goalController = new GoalControllerAdapter({ enabled: true });
			goalEvidence = new GoalEvidenceAdapter({ cwd: ctx.cwd, enabled: true });
			runner = new GoalRunner({
				store,
				hermes: new HermesAdvisoryAdapter({ cwd: ctx.cwd, authority: { canonicalPromotionAllowed: false, automaticMutationAllowed: false } }),
				controllerAdapter: goalController,
				evidenceAdapter: goalEvidence,
				sendUserMessage: pi.sendUserMessage?.bind(pi),
				onFinalized: async (state: GoalState) => {
					const packet = outcomes.buildGoalSettlement(state, { projectKey: projectKey(ctx.cwd), producerVersion: GOAL_OUTCOME_PRODUCER_VERSION });
					if (packet) outcomes.save(packet);
				},
			});
		}
		return { store, runner, outcomes, goalController, goalEvidence };
	}

	function autoResumeEnabled(): boolean {
		return process.env.PI_GOAL_AUTO_RESUME !== "0";
	}

	pi.on("session_shutdown", async () => {
		if (runner?.running) await runner.stop().catch(() => undefined);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!autoResumeEnabled()) return;
		const services = ensure(ctx);
		if (services.runner.running) return;
		const active = await services.store.getActive();
		if (!active || !pendingPromptHasBranchOutput(active, ctx)) return;
		setTimeout(() => {
			services.runner.resume(ctx).catch((error: unknown) => {
				const msg = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(`Goal auto-resume failed: ${msg}`, "warning");
				else console.error(`Goal auto-resume failed: ${msg}`);
			});
		}, 0);
	});

	pi.registerCommand("goal", {
		description: "Start an autonomous goal run: /goal <task> [--max=50] [--allow-topology=<id>]",
		handler: async (args, ctx) => {
			const { task, maxIterations, approvedTopologyIds } = parseGoalArgs(args || "");
			if (!task) {
				const msg = "Usage: /goal <task> [--max=50] [--allow-topology=<id>]";
				if (ctx.hasUI) ctx.ui.notify(msg, "warning");
				else console.error(msg);
				return;
			}
			const sid = String(ctx.sessionManager?.getSessionId?.() || ctx.sessionManager?.getSessionFile?.() || "ephemeral");
			const openLoop = new AutomationLoopStore({ cwd: ctx.cwd }).current(sid);
			if (openLoop) {
				const msg = `Automation loop ${openLoop.id} is already ${openLoop.status}. Use /loop-stop before starting /goal.`;
				if (ctx.hasUI) ctx.ui.notify(msg, "warning");
				else console.error(msg);
				return;
			}
			const services = ensure(ctx);
			const active = await services.store.getActive();
			if (active || services.runner.running) {
				const msg = `A goal is already active: ${active?.goal ?? "in-memory run"}. Use /goal-stop first.`;
				if (ctx.hasUI) ctx.ui.notify(msg, "warning");
				else console.error(msg);
				return;
			}
			try {
				if (maxIterations === 1) {
					const warn = "Note: --max=1 allows one controller decision; completion commonly requires /goal-resume or --max=2+ after evidence is gathered.";
					if (ctx.hasUI) ctx.ui.notify(warn, "warning");
					else console.error(warn);
				}
				if (ctx.hasUI) ctx.ui.notify(`Running goal: ${task}`, "info");
				const state = await services.runner.start(task, ctx, { maxIterations, approvedTopologyIds });
				const msg = `Goal ${state.id} ${state.status}: ${state.goal}`;
				if (ctx.hasUI) ctx.ui.notify(msg, state.status === "completed" ? "info" : "warning");
				else console.log(msg);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(`Goal start failed: ${msg}`, "warning");
				else console.error(`Goal start failed: ${msg}`);
			}
		},
	});

	pi.registerCommand("goal-status", {
		description: "Show the active goal status and recent observations",
		handler: async (_args, ctx) => {
			const services = ensure(ctx);
			const state = (await services.store.getActive()) || (await services.store.getMostRecent());
			await showLines(ctx, "goal-status", formatStatus(state));
		},
	});

	pi.registerCommand("goal-stop", {
		description: "Cancel the active autonomous goal run",
		handler: async (_args, ctx) => {
			const services = ensure(ctx);
			const stopped = await services.runner.stop();
			const msg = stopped ? `Cancelled goal ${stopped.id}` : "No active goal to cancel.";
			if (ctx.hasUI) ctx.ui.notify(msg, stopped ? "info" : "warning");
			else console.log(msg);
		},
	});

	pi.registerCommand("goal-resume", {
		description: "Resume the most recent unfinished goal",
		handler: async (_args, ctx) => {
			const services = ensure(ctx);
			try {
				const state = await services.runner.resume(ctx);
				const msg = state ? `Goal ${state.id} ${state.status}: ${state.goal}` : "No unfinished goal found.";
				if (ctx.hasUI) ctx.ui.notify(msg, state?.status === "completed" ? "info" : "warning");
				else console.log(msg);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(`Goal resume failed: ${msg}`, "warning");
				else console.error(`Goal resume failed: ${msg}`);
			}
		},
	});

	pi.registerCommand("goal-plan", {
		description: "Ask Hermes for the first goal decision without executing it: /goal-plan <task>",
		handler: async (args, ctx) => {
			const { task, maxIterations, approvedTopologyIds } = parseGoalArgs(args || "");
			if (!task) return showLines(ctx, "goal-plan", ["Usage: /goal-plan <task> [--max=50] [--allow-topology=<id>]"]);
			const services = ensure(ctx);
			const now = new Date().toISOString();
			const preview = { id: "goal_plan_preview", goal: task, status: "running", iteration: 0, maxIterations: maxIterations || 50, actionAuthority: { approvedTopologyIds, source: approvedTopologyIds.length ? "current-user-command" : "none" }, observations: [], history: [], createdAt: now, updatedAt: now };
			try {
				const { decision } = await services.runner.askHermesDecision(preview);
				const authority = decision.action?.kind === "run_topology" ? services.goalController.authority(decision.action.topologyId, preview) : { allowed: true, reasonCode: "non-topology-action", mutationCapable: false, mutationApproved: true };
				await showLines(ctx, "goal-plan", ["Goal plan preview (not executed)", "", "Typed action:", JSON.stringify(decision, null, 2), "", "Authority:", JSON.stringify(authority, null, 2)]);
			} catch (error) {
				await showLines(ctx, "goal-plan", ["Goal plan failed", error instanceof Error ? error.message : String(error)]);
			}
		},
	});

	pi.registerCommand("goal-metrics", {
		description: "Show autonomous goal metrics",
		handler: async (_args, ctx) => {
			const services = ensure(ctx);
			const metrics = await services.store.getMetrics();
			await showLines(ctx, "goal-metrics", [
				"Goal metrics",
				`Total goals: ${metrics.total}`,
				`Active store goals: ${metrics.activeStore}`,
				`Archived goals: ${metrics.archived}`,
				`By status: ${JSON.stringify(metrics.byStatus)}`,
				`Average iterations: ${metrics.averageIterations.toFixed(2)}`,
				`Action kinds: ${JSON.stringify(metrics.actionKinds)}`,
				`Dispatch mismatches: ${metrics.dispatchMismatches}`,
				`Proof rejections: ${JSON.stringify(metrics.proofRejections)}`,
				`Extra controller turns: ${metrics.extraControllerTurns}`,
				`Action latency ms: ${JSON.stringify(metrics.actionLatencyMs)}`,
				"Common blocked reasons:",
				...(metrics.commonBlockedReasons.length ? metrics.commonBlockedReasons.map((entry: any) => `- ${entry.count}× ${entry.reason}`) : ["(none)"]),
			]);
		},
	});

	pi.registerCommand("goal-doctor", {
		description: "Show autonomous goal diagnostics",
		handler: async (_args, ctx) => {
			const services = ensure(ctx);
			const active = await services.store.getActive();
			const recent = await services.store.getMostRecent();
			const metrics = await services.store.getMetrics();
			await showLines(ctx, "goal-doctor", [
				"Goal runner diagnostics",
				`Hermes: ${await services.runner.hermes.version().catch((error: Error) => `unavailable (${error.message})`)}`,
				`Project key: ${projectKey(ctx.cwd)}`,
				`Store file: ${services.store.file}`,
				`Archive file: ${services.store.archiveFile}`,
				`Active goal: ${active ? `${active.id} (${active.status}) ${active.goal}` : "none"}`,
				`Most recent goal: ${recent ? `${recent.id} (${recent.status}) ${recent.goal}` : "none"}`,
				`Runner in memory: ${services.runner.running ? "running" : "idle"}`,
				"Hermes authority: typed, off-path advisory controller; no memory ownership or final-summary sync",
				"Decision schema: goal-decision-v3 (strict Hermes-authored prompts)",
				"Completion evidence IDs required: yes",
				`Hermes provider ready: ${services.runner.hermes.status().providerReady ? "yes" : "no"}`,
				`Trace enabled: ${services.runner.trace ? "yes" : "no"}`,
				`Trace correlation: ${services.runner.trace?.correlationId ?? "none"}`,
				`Safety policy: ${process.env.PI_GOAL_ALLOW_UNSAFE === "1" ? "unsafe actions allowed by env" : "blocking rm -rf/sudo/download pipes/package installs/recursive chmod and write-like actions outside repo"}`,
				`Metrics: total=${metrics.total}, completed=${metrics.byStatus.completed || 0}, blocked=${metrics.byStatus.blocked || 0}, failed=${metrics.byStatus.failed || 0}, cancelled=${metrics.byStatus.cancelled || 0}, avgIterations=${metrics.averageIterations.toFixed(2)}, dispatchMismatch=${metrics.dispatchMismatches}, extraControllerTurns=${metrics.extraControllerTurns}`,
				`Last parse error: ${services.runner.lastParseError ? JSON.stringify(services.runner.lastParseError) : "none"}`, 
			]);
		},
	});

	pi.registerCommand("goal-clear", {
		description: "Archive and clear final goals: /goal-clear [--all]",
		handler: async (args, ctx) => {
			const services = ensure(ctx);
			const result = args.trim() === "--all" ? await services.store.clearAll() : await services.store.archiveFinalStatuses();
			const msg = `Archived ${result.archived} goal(s) to ${result.archiveFile}; ${result.remaining} active/unfinished goal(s) remain.`;
			if (ctx.hasUI) ctx.ui.notify(msg, "info");
			else console.log(msg);
		},
	});

	pi.registerCommand("goal-archive", {
		description: "Archive final goals: /goal-archive [completed|blocked|failed|cancelled] [--older-than=7d]",
		handler: async (args, ctx) => {
			const services = ensure(ctx);
			const parsed = parseArchiveArgs(args || "");
			const result = await services.store.archiveFinalStatuses(parsed.statuses, { olderThanMs: parsed.olderThanMs });
			const lines = [`Archived ${result.archived} final goal(s).`, `Archive file: ${result.archiveFile}`, `Remaining goals: ${result.remaining}`];
			await showLines(ctx, "goal-archive", lines);
		},
	});

	pi.registerCommand("goal-prune", {
		description: "Archive older final goals while keeping recent N: /goal-prune [--keep=20]",
		handler: async (args, ctx) => {
			const services = ensure(ctx);
			const result = await services.store.pruneFinalGoals(parseKeep(args || ""));
			await showLines(ctx, "goal-prune", [`Archived ${result.archived} old final goal(s).`, `Archive file: ${result.archiveFile}`, `Remaining goals: ${result.remaining}`]);
		},
	});

	pi.registerCommand("goal-export", {
		description: "Export the active/recent goal as markdown or JSON: /goal-export [json|md] [file]",
		handler: async (args, ctx) => {
			const services = ensure(ctx);
			const state = (await services.store.getActive()) || (await services.store.getMostRecent());
			if (!state) return showLines(ctx, "goal-export", ["No goal to export."]);
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const format = parts[0] === "json" ? "json" : "md";
			const out = exportGoal(state, format);
			const file = parts.find((part) => part.includes("/") || part.endsWith(".md") || part.endsWith(".json"));
			if (file) {
				const target = path.resolve(ctx.cwd, file);
				await writeFile(target, out, "utf8");
				return showLines(ctx, "goal-export", [`Exported goal ${state.id} to ${target}`]);
			}
			await showLines(ctx, "goal-export", out.split("\n"));
		},
	});

	pi.registerCommand("goal-trace", {
		description: "Show recent trace events for the active/recent goal, including persisted trace events",
		handler: async (args, ctx) => {
			const services = ensure(ctx);
			const state = (await services.store.getActive()) || (await services.store.getMostRecent());
			const wanted = args.trim() || (state as any)?.traceCorrelationId;
			const allEvents = services.runner.trace?.events?.() ?? services.runner.trace?.recent?.(100) ?? [];
			const events = allEvents.filter((event: any) => {
				if (state && event.payload?.id === state.id) return true;
				if (wanted && (event.correlation_id === wanted || String(event.correlation_id || "").startsWith(wanted))) return true;
				return !state && !wanted;
			}).slice(-100);
			await showLines(ctx, "goal-trace", events.length ? events.map((event: any) => JSON.stringify(event, null, 2)) : ["No goal trace events found in memory or persisted goal trace file."]);
		},
	});

	pi.registerCommand("goal-log", {
		description: "Show recent autonomous goal loop history: /goal-log [count] [--compact|--json]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const count = Math.max(1, Math.min(50, Number(parts.find((part) => /^\d+$/.test(part))) || 10));
			const compact = parts.includes("--compact");
			const json = parts.includes("--json");
			const services = ensure(ctx);
			const state = (await services.store.getActive()) || (await services.store.getMostRecent());
			let lines: string[];
			if (!state) lines = ["No goal history found."];
			else if (json) lines = [JSON.stringify({ ...state, history: state.history?.slice(-count), observations: state.observations?.slice(-count) }, null, 2)];
			else lines = [
				`Goal log for ${state.id}: ${state.goal}`,
				`Status: ${state.status}`,
				`Iterations: ${state.iteration}/${state.maxIterations}`,
				`Trace correlation: ${(state as any).traceCorrelationId ?? "none"}`,
				"",
				...(compact
					? formatCompactHistory(state, count)
					: state.history?.length
						? state.history.slice(-count).map((record: unknown) => JSON.stringify(record, null, 2))
						: (state.observations || []).slice(-count)),
			];
			await showLines(ctx, "goal-log", lines);
		},
	});
}
