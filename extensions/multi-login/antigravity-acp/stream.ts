/**
 * Pi event stream for the Antigravity ACP provider.
 *
 * Each Pi turn creates one ACP session, selects the requested model and
 * thought level, sends the current transcript as a text prompt, and maps the
 * server's message/thought chunks to Pi's stream events. The ACP server owns
 * and runs its tools, so its `tool_call`/`tool_call_update` notifications
 * become provider-executed `toolCall` blocks (`acp_<kind>`): Pi records each
 * call and the server's own outcome in the transcript without running it, and
 * answers the server's permission requests instead (`deps.permission`).
 *
 * Usage is split in two: the prompt result's usage sums every internal model
 * call of the turn (billing), while `usage_update` notifications carry the
 * tokens currently in context. Pi records the latter as `contextTokens` so an
 * aggregate turn total is never mistaken for the request's context size.
 */

import {
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";

import type {
	AcpClientLike,
	AcpClientOptions,
	AcpInitializeResult,
	AcpPermissionRequest,
	AcpPermissionResponse,
	AcpPromptUsage,
	AcpSessionUpdateNotification,
} from "./acp";
import { type AntigravityAcpModel, acpModelId, thinkingLevel } from "./models";
import type { RuntimeLaunch } from "./runtime";

export interface AcpStreamOptions {
	signal?: AbortSignal;
	apiKey?: string;
	thinking?: { enabled?: boolean; level?: string };
	reasoning?: string;
	cwd?: string;
	sessionId?: string;
	[key: string]: unknown;
}

export interface AcpToolActivity {
	toolCallId?: string;
	kind?: string;
	title?: string;
	status?: string;
}

export interface AcpStreamDeps {
	resolveRuntime: () => Promise<RuntimeLaunch>;
	createClient: (options: AcpClientOptions) => AcpClientLike;
	hasAuth?: () => boolean;
	cwd?: string;
	/** Answers the server's permission requests; without one every request is cancelled. */
	permission?: (request: AcpPermissionRequest) => Promise<AcpPermissionResponse>;
	/** Additional workspace directories for the session (Pi's project scope). */
	additionalDirectories?: string[];
	/** Reports server-side tool activity so Pi can show what the ACP agent is doing. */
	onToolActivity?: (activity: AcpToolActivity) => void;
}

type StopReason = "stop" | "length" | "toolUse";

class PiEventWriter {
	readonly stream: AssistantMessageEventStream;
	readonly message: any;
	private readonly cost: AntigravityAcpModel["cost"];
	private open: { kind: "text" | "thinking"; index: number } | undefined;
	private started = false;
	private terminal = false;
	/** Context occupancy reported by the server for its last model call. */
	private contextTokens: number | null = null;
	/** Content index of each ACP call, so a later update finds the block it describes. */
	private readonly toolCalls = new Map<string, number>();

	constructor(model: AntigravityAcpModel) {
		this.stream = createAssistantMessageEventStream();
		this.cost = model.cost;
		this.message = {
			role: "assistant",
			content: [] as unknown[],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				contextTokens: null,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};
	}

	text(delta: string): void {
		if (!delta || this.terminal) return;
		const index = this.ensureOpen("text");
		const block = this.message.content[index];
		if (!block || block.type !== "text") throw new Error("Pi text block invariant failed");
		block.text += delta;
		this.stream.push({
			type: "text_delta",
			contentIndex: index,
			delta,
			partial: this.message,
		} as never);
	}

	thinking(delta: string): void {
		if (!delta || this.terminal) return;
		const index = this.ensureOpen("thinking");
		const block = this.message.content[index];
		if (!block || block.type !== "thinking") throw new Error("Pi thinking block invariant failed");
		block.thinking += delta;
		this.stream.push({
			type: "thinking_delta",
			contentIndex: index,
			delta,
			partial: this.message,
		} as never);
	}

	/**
	 * Records a tool call the ACP server is running. The block is marked provider-executed, so Pi
	 * shows it without running it: the server owns its tools, and its own outcome becomes the
	 * result Pi records for the call.
	 */
	toolCall(update: Record<string, unknown>): void {
		if (this.terminal) return;
		const id = toolCallId(update);
		if (!id || this.toolCalls.has(id)) return;
		this.closeOpen();
		this.ensureStarted();
		const index = this.message.content.length;
		const block = {
			type: "toolCall",
			id,
			name: acpToolName(update),
			arguments: acpToolArguments(update),
			providerExecuted: true,
		};
		this.message.content.push(block);
		this.toolCalls.set(id, index);
		this.stream.push({ type: "toolcall_start", contentIndex: index, partial: this.message } as never);
		this.stream.push({
			type: "toolcall_end",
			contentIndex: index,
			toolCall: block,
			partial: this.message,
		} as never);
	}

	/**
	 * Applies a `tool_call_update`: a call reported only by its update is recorded first, and a
	 * terminal status becomes the call's result. Progress updates are left to the footer, because
	 * the transcript records the call once and its outcome once.
	 */
	toolUpdate(update: Record<string, unknown>): void {
		if (this.terminal) return;
		const id = toolCallId(update);
		if (!id) return;
		if (!this.toolCalls.has(id)) this.toolCall(update);
		const status = typeof update.status === "string" ? update.status : undefined;
		if (status !== "completed" && status !== "failed" && status !== "cancelled") return;
		const index = this.toolCalls.get(id);
		if (index === undefined) return;
		const block = this.message.content[index];
		if (!block || block.type !== "toolCall") return;
		block.providerResult = {
			content: acpToolOutput(update),
			isError: acpToolFailed(update, status),
		};
	}

	setUsage(usage: AcpPromptUsage | undefined): void {
		if (!usage) return;
		const input = usage.inputTokens ?? 0;
		const output = usage.outputTokens ?? 0;
		const cacheRead = usage.cachedReadTokens ?? 0;
		const cacheWrite = usage.cachedWriteTokens ?? 0;
		const rates = this.cost;
		const inputCost = (input * rates.input) / 1_000_000;
		const outputCost = (output * rates.output) / 1_000_000;
		const cacheReadCost = (cacheRead * rates.cacheRead) / 1_000_000;
		const cacheWriteCost = (cacheWrite * rates.cacheWrite) / 1_000_000;
		this.message.usage = {
			input,
			output,
			cacheRead,
			cacheWrite,
			totalTokens:
				usage.totalTokens ?? input + output + cacheRead + cacheWrite + (usage.thoughtTokens ?? 0),
			contextTokens: this.contextTokens,
			cost: {
				input: inputCost,
				output: outputCost,
				cacheRead: cacheReadCost,
				cacheWrite: cacheWriteCost,
				total: inputCost + outputCost + cacheReadCost + cacheWriteCost,
			},
		};
	}

	/**
	 * Records the tokens the server last had in context. The prompt result's usage
	 * aggregates every internal model call of the turn, so only this figure may be
	 * read as Pi's context size; `null` means the server reported none.
	 */
	setContextTokens(used: number | null): void {
		this.contextTokens = used;
		this.message.usage.contextTokens = used;
	}

	done(reason: StopReason): void {
		if (this.terminal) return;
		this.ensureStarted();
		if (this.message.content.length === 0) this.ensureOpen("text");
		this.closeOpen();
		this.terminal = true;
		this.message.stopReason = reason;
		this.stream.push({ type: "done", reason, message: this.message } as never);
		this.stream.end();
	}

	fail(cause: unknown, aborted = false): void {
		if (this.terminal) return;
		this.closeOpen();
		this.terminal = true;
		this.message.stopReason = aborted ? "aborted" : "error";
		this.message.errorMessage = cause instanceof Error ? cause.message : String(cause);
		this.stream.push({
			type: "error",
			reason: aborted ? "aborted" : "error",
			error: this.message,
		} as never);
		this.stream.end();
	}

	private ensureStarted(): void {
		if (this.started) return;
		this.started = true;
		this.stream.push({ type: "start", partial: this.message } as never);
	}

	private ensureOpen(kind: "text" | "thinking"): number {
		if (this.open?.kind === kind) return this.open.index;
		this.closeOpen();
		this.ensureStarted();
		const index = this.message.content.length;
		if (kind === "text") {
			this.message.content.push({ type: "text", text: "" });
			this.stream.push({ type: "text_start", contentIndex: index, partial: this.message } as never);
		} else {
			this.message.content.push({ type: "thinking", thinking: "" });
			this.stream.push({
				type: "thinking_start",
				contentIndex: index,
				partial: this.message,
			} as never);
		}
		this.open = { kind, index };
		return index;
	}

	private closeOpen(): void {
		if (!this.open) return;
		const { kind, index } = this.open;
		this.open = undefined;
		const block = this.message.content[index];
		if (kind === "text" && block?.type === "text") {
			this.stream.push({
				type: "text_end",
				contentIndex: index,
				content: block.text,
				partial: this.message,
			} as never);
		} else if (kind === "thinking" && block?.type === "thinking") {
			this.stream.push({
				type: "thinking_end",
				contentIndex: index,
				content: block.thinking,
				partial: this.message,
			} as never);
		}
	}
}

function handleUpdate(
	notification: AcpSessionUpdateNotification,
	writer: PiEventWriter,
	onToolActivity?: (activity: AcpToolActivity) => void,
): void {
	const update = notification?.update;
	if (!update) return;
	if (update.sessionUpdate === "usage_update") {
		const used = update.used;
		writer.setContextTokens(
			typeof used === "number" && Number.isFinite(used) && used >= 0 ? used : null,
		);
		return;
	}
	if (update.sessionUpdate === "tool_call") {
		writer.toolCall(update);
		if (onToolActivity) onToolActivity(activityOf(update));
		return;
	}
	if (update.sessionUpdate === "tool_call_update") {
		writer.toolUpdate(update);
		if (onToolActivity) onToolActivity(activityOf(update));
		return;
	}
	if (update.sessionUpdate === "agent_message_chunk") {
		const content = update.content;
		const text =
			typeof content === "string"
				? content
				: content?.type === "text"
					? content.text
					: undefined;
		if (text) writer.text(text);
	} else if (update.sessionUpdate === "agent_thought_chunk") {
		const content = update.content;
		const text =
			typeof content === "string"
				? content
				: content?.type === "text"
					? content.text
					: undefined;
		if (text) writer.thinking(text);
	}
}

/** ACP tool kinds are the server's vocabulary; the prefix keeps them apart from Pi's own tools. */
const ACP_TOOL_PREFIX = "acp_";

/** ACP tool output can be large; keep the recorded result bounded like Pi's own tool output. */
const TOOL_OUTPUT_LIMIT = 8000;

function toolCallId(update: Record<string, unknown>): string | undefined {
	return typeof update.toolCallId === "string" && update.toolCallId ? update.toolCallId : undefined;
}

function acpToolName(update: Record<string, unknown>): string {
	const kind = typeof update.kind === "string" ? update.kind.trim() : "";
	return `${ACP_TOOL_PREFIX}${kind || "tool"}`;
}

function acpToolArguments(update: Record<string, unknown>): Record<string, unknown> {
	const raw = update.rawInput;
	if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
	const title = typeof update.title === "string" ? update.title.trim() : "";
	return title ? { title } : {};
}

/**
 * Text of a tool output: the server's `rawOutput`, else the update's content blocks.
 */
function acpToolOutput(update: Record<string, unknown>): string {
	const output = rawOutputText(update.rawOutput) || contentText(update.content);
	return output.length > TOOL_OUTPUT_LIMIT ? `${output.slice(0, TOOL_OUTPUT_LIMIT - 1)}…` : output;
}

/**
 * `rawOutput` is a plain string for some servers and a structured object for others: Antigravity
 * reports a shell result as `{exitCode, combinedOutput, formatted_output, ...}`.
 */
function rawOutputText(raw: unknown): string {
	if (typeof raw === "string") return raw;
	if (!raw || typeof raw !== "object") return "";
	const record = raw as Record<string, unknown>;
	for (const key of ["combinedOutput", "formatted_output", "output", "stdout"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return "";
}

/** Text of an update's content blocks, which ACP nests one level below the block. */
function contentText(content: unknown): string {
	const blocks = Array.isArray(content) ? content : content === undefined ? [] : [content];
	return blocks
		.map((block: any) => {
			if (typeof block === "string") return block;
			if (typeof block?.text === "string") return block.text;
			if (typeof block?.content?.text === "string") return block.content.text;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

/**
 * A call failed when the server says so, or when the shell it ran exited non-zero: Pi's own bash
 * rows treat a non-zero exit the same way.
 */
function acpToolFailed(update: Record<string, unknown>, status: string): boolean {
	if (status === "failed" || status === "cancelled") return true;
	const raw = update.rawOutput;
	if (!raw || typeof raw !== "object") return false;
	const record = raw as Record<string, unknown>;
	const exitCode = Number(record.exitCode ?? record.exit_code);
	return Number.isFinite(exitCode) && exitCode !== 0;
}

/** What the footer shows while the ACP server runs a tool. */
function activityOf(update: Record<string, unknown>): AcpToolActivity {
	const rawInput = update.rawInput as { CommandLine?: unknown } | undefined;
	const title =
		typeof update.title === "string"
			? update.title
			: typeof rawInput?.CommandLine === "string"
				? rawInput.CommandLine
				: undefined;
	return {
		...(typeof update.toolCallId === "string" ? { toolCallId: update.toolCallId } : {}),
		...(typeof update.kind === "string" ? { kind: update.kind } : {}),
		...(title ? { title } : {}),
		...(typeof update.status === "string" ? { status: update.status } : {}),
	};
}

function systemText(systemPrompt: unknown): string {
	if (typeof systemPrompt === "string") return systemPrompt;
	if (Array.isArray(systemPrompt)) {
		return systemPrompt
			.map((block) => (block && typeof block === "object" && typeof block.text === "string" ? block.text : ""))
			.filter(Boolean)
			.join("\n");
	}
	if (systemPrompt && typeof systemPrompt === "object" && typeof (systemPrompt as any).text === "string") {
		return (systemPrompt as any).text;
	}
	return "";
}

function blockText(block: any): string {
	if (!block || typeof block !== "object") return "";
	if (typeof block.text === "string") return block.text;
	if (typeof block.thinking === "string") return block.thinking;
	if (block.type === "toolCall") {
		return `[tool ${String(block.name ?? "call")}] ${JSON.stringify(block.arguments ?? {})}`;
	}
	return "";
}

function messageText(message: any): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content.map(blockText).filter(Boolean).join("\n");
	}
	if (typeof message.text === "string") return message.text;
	return "";
}

/** Convert Pi's transcript into ACP text prompt blocks. */
export function buildPrompt(context: any): Array<{ type: "text"; text: string }> {
	const blocks: Array<{ type: "text"; text: string }> = [];
	const instructions = systemText(context?.systemPrompt);
	if (instructions) blocks.push({ type: "text", text: `System instructions:\n${instructions}` });
	const messages = Array.isArray(context?.messages) ? context.messages : [];
	for (const message of messages) {
		const text = messageText(message);
		if (!text) continue;
		const label =
			message.role === "user"
				? "User"
				: message.role === "assistant"
					? "Assistant"
					: message.role === "toolResult"
						? "Tool result"
						: String(message.role ?? "Message");
		blocks.push({ type: "text", text: `${label}:\n${text}` });
	}
	if (blocks.length === 0) blocks.push({ type: "text", text: "Continue." });
	return blocks;
}

function mapStopReason(reason: string): StopReason {
	if (reason === "max_tokens" || reason === "max_turn_requests") return "length";
	return "stop";
}

/** The server advertises `session/new` extra-directory support under agentCapabilities. */
function supportsAdditionalDirectories(initialized: AcpInitializeResult): boolean {
	const capabilities = initialized?.agentCapabilities as Record<string, unknown> | undefined;
	const session = capabilities?.sessionCapabilities as Record<string, unknown> | undefined;
	return session?.additionalDirectories !== undefined;
}

export function createAcpStream(
	model: AntigravityAcpModel,
	context: unknown,
	options: AcpStreamOptions = {},
	deps: AcpStreamDeps,
): AssistantMessageEventStream {
	const writer = new PiEventWriter(model);
	(async () => {
		let client: AcpClientLike | undefined;
		try {
			const launch = await deps.resolveRuntime();
			const cwd = deps.cwd ?? options.cwd ?? process.cwd();
			client = deps.createClient({
				command: launch.command,
				args: launch.args,
				cwd,
				onUpdate: (notification) => handleUpdate(notification, writer, deps.onToolActivity),
				// Pi's policy decides; the safe default without a gate is to deny.
				onPermission:
					deps.permission ?? (async () => ({ outcome: { outcome: "cancelled" as const } })),
			});
			const initialized = await client.initialize(options.signal);
			if (deps.hasAuth && !deps.hasAuth()) {
				throw new Error(
					"Google Antigravity ACP is not authenticated. Run /login for google-antigravity-acp.",
				);
			}
			// Pi hands the server exactly the workspace Pi itself is allowed to use.
			const additionalDirectories =
				supportsAdditionalDirectories(initialized) && deps.additionalDirectories?.length
					? deps.additionalDirectories
					: undefined;
			const session = await client.newSession(cwd, options.signal, additionalDirectories);
			const level = thinkingLevel(options);
			await client.setModel(session.sessionId, acpModelId(model, level), options.signal);
			const response = await client.prompt(
				session.sessionId,
				buildPrompt(context),
				options.signal,
			);
			if (response.stopReason === "cancelled") {
				throw new Error("Antigravity ACP cancelled the prompt");
			}
			writer.setUsage(response.usage);
			writer.done(mapStopReason(response.stopReason));
		} catch (error) {
			writer.fail(error, options.signal?.aborted === true);
		} finally {
			await client?.close().catch(() => undefined);
		}
	})();
	return writer.stream;
}
