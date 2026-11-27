/**
 * Pi event stream for the Antigravity ACP provider.
 *
 * Each Pi turn creates one ACP session, selects the requested model and
 * thought level, sends the current transcript as a text prompt, and maps the
 * server's message/thought chunks to Pi's stream events. The ACP server owns
 * and runs its tools, so its `tool_call`/`tool_call_update` notifications
 * become provider-executed `toolCall` blocks: Pi records each call and the
 * server's own outcome in the transcript without running it, and answers the
 * server's permission requests instead (`deps.permission`).
 *
 * A call is recorded under Pi's own tool name when the server's kind has one
 * (a shell command is `bash`, a file write is `write`), so the row reads like
 * any other Pi tool call. Output keeps the tail Pi's own tools keep and, when
 * the server sends more than that, the whole text goes to a file named in the
 * transcript; progress updates replace the row's output while the call runs.
 *
 * Usage is split in two: the prompt result's usage sums every internal model
 * call of the turn (billing), while `usage_update` notifications carry the
 * tokens currently in context. Pi records the latter as `contextTokens` so an
 * aggregate turn total is never mistaken for the request's context size.
 */

import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import {
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";

import type {
	AcpClientFileHandlers,
	AcpClientLike,
	AcpClientOptions,
	AcpInitializeResult,
	AcpMcpServer,
	AcpPermissionOutcome,
	AcpPermissionRequest,
	AcpPromptUsage,
	AcpQuestion,
	AcpReadTextFileRequest,
	AcpSessionUpdateNotification,
	AcpWriteTextFileRequest,
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
	permission?: (request: AcpPermissionRequest) => Promise<AcpPermissionOutcome>;
	/**
	 * Receives a question the server asked instead of a call Pi could judge. Pi
	 * cannot answer it while the turn streams, so it is declined and shown.
	 */
	onQuestion?: (question: AcpQuestion, cwd: string) => void;
	/** Serves the server's file callbacks; without them Pi advertises no fs capability. */
	fileHandlers?: AcpClientFileHandlers;
	/** Pi's MCP servers, which the server connects itself. */
	mcpServers?: AcpMcpServer[];
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
	/** Workspace paths each call touches, so Pi's own file work can be reported on that row. */
	private readonly toolPaths = new Map<string, string[]>();
	/** Latest output text of each call, replaced by every update the server sends. */
	private readonly toolOutput = new Map<string, string>();
	/** What Pi itself did for a call, such as the file it wrote on the server's behalf. */
	private readonly toolNotes = new Map<string, string[]>();
	private readonly toolErrors = new Map<string, boolean>();

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
		if (!id) return;
		const known = this.toolCalls.get(id);
		if (known !== undefined) {
			// A call reported again carries the arguments the server settled on.
			const existing = this.message.content[known];
			if (existing?.type === "toolCall") {
				const call = acpToolCall(update);
				existing.name = call.name;
				existing.arguments = call.arguments;
				this.toolPaths.set(id, acpToolPaths(update));
				this.stream.push({
					type: "toolcall_end",
					contentIndex: known,
					toolCall: existing,
					partial: this.message,
				} as never);
			}
			return;
		}
		this.closeOpen();
		this.ensureStarted();
		const index = this.message.content.length;
		const call = acpToolCall(update);
		const block = {
			type: "toolCall",
			id,
			name: call.name,
			arguments: call.arguments,
			providerExecuted: true,
		};
		this.message.content.push(block);
		this.toolCalls.set(id, index);
		this.toolPaths.set(id, acpToolPaths(update));
		this.stream.push({ type: "toolcall_start", contentIndex: index, partial: this.message } as never);
		this.stream.push({
			type: "toolcall_end",
			contentIndex: index,
			toolCall: block,
			partial: this.message,
		} as never);
	}

	/**
	 * Applies a `tool_call_update`: a call reported only by its update is recorded first, and every
	 * update replaces the row's output, so progress shows while the call runs and the terminal
	 * status settles it. Only a finished call persists output longer than the row shows.
	 */
	toolUpdate(update: Record<string, unknown>): void {
		if (this.terminal) return;
		const id = toolCallId(update);
		if (!id) return;
		if (!this.toolCalls.has(id)) this.toolCall(update);
		const index = this.toolCalls.get(id);
		if (index === undefined) return;
		const status = typeof update.status === "string" ? update.status : undefined;
		const finished = status === "completed" || status === "failed" || status === "cancelled";
		const output = acpToolOutput(update);
		if (output) this.toolOutput.set(id, displayToolOutput(output, finished));
		if (finished) this.toolErrors.set(id, acpToolFailed(update, status));
		if (output || finished) this.applyToolResult(id, index);
	}

	/**
	 * Records what Pi itself did on the server's behalf. The server asks Pi to read or write a file
	 * through `fs/read_text_file` and `fs/write_text_file` instead of touching it itself, so the
	 * work happens inside Pi and belongs on the row of the call that asked for it.
	 */
	recordFileOperation(operation: AcpFileOperation): void {
		if (this.terminal) return;
		const id = this.findCallForPath(operation.path);
		if (id === undefined) return;
		const index = this.toolCalls.get(id);
		if (index === undefined) return;
		const note =
			operation.type === "read"
				? `Pi read ${operation.lines} line${operation.lines === 1 ? "" : "s"} of ${operation.path}`
				: `Pi wrote ${operation.bytes} byte${operation.bytes === 1 ? "" : "s"} to ${operation.path}`;
		const notes = this.toolNotes.get(id) ?? [];
		notes.push(note);
		this.toolNotes.set(id, notes);
		this.applyToolResult(id, index);
	}

	/**
	 * Compose a call's result from what the server last reported and what Pi did for it, so a note
	 * added after the server's terminal update still reaches the row.
	 */
	private applyToolResult(id: string, index: number): void {
		const block = this.message.content[index];
		if (!block || block.type !== "toolCall") return;
		const parts = [this.toolOutput.get(id) ?? "", ...(this.toolNotes.get(id) ?? [])].filter(Boolean);
		block.providerResult = {
			content: parts.join("\n\n"),
			isError: this.toolErrors.get(id) === true,
		};
	}

	/** The call whose row should carry a file operation: the latest one naming that path. */
	private findCallForPath(path: string): string | undefined {
		let found: string | undefined;
		for (const [id, paths] of this.toolPaths) {
			if (paths.includes(path)) found = id;
		}
		return found;
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

/** A file Pi read or wrote on the server's behalf, reported on the row of the call that asked. */
export type AcpFileOperation =
	| { type: "read"; path: string; lines: number }
	| { type: "write"; path: string; bytes: number };

function toolCallId(update: Record<string, unknown>): string | undefined {
	return typeof update.toolCallId === "string" && update.toolCallId ? update.toolCallId : undefined;
}

/**
 * Pi's tool name and arguments for an ACP call. A kind Pi has a tool for keeps that tool's row and
 * renderer, so a shell command the server ran reads as an ordinary command; everything else stays
 * `acp_<kind>` with the server's own argument object.
 */
function acpToolCall(update: Record<string, unknown>): {
	name: string;
	arguments: Record<string, unknown>;
} {
	const kind = typeof update.kind === "string" ? update.kind.trim() : "";
	const raw = rawInput(update);
	if (kind === "execute") {
		const command = stringField(raw, ["CommandLine", "command_line", "command"]);
		if (command) {
			const cwd = stringField(raw, ["Cwd", "working_dir", "cwd"]);
			return { name: "bash", arguments: { command, ...(cwd ? { cwd } : {}) } };
		}
	}
	if (kind === "edit") {
		const diff = editDiff(update);
		if (diff) return { name: "write", arguments: { path: diff.path, content: diff.newText ?? "" } };
	}
	if (kind === "read") {
		const path = acpToolPaths(update)[0];
		if (path) return { name: "read", arguments: { path } };
	}
	return {
		name: `${ACP_TOOL_PREFIX}${kind || "tool"}`,
		arguments: raw ?? fallbackArguments(update),
	};
}

/** The server's own argument object, when it sent one. */
function rawInput(update: Record<string, unknown>): Record<string, unknown> | undefined {
	const raw = update.rawInput;
	return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

/** A call with no arguments still says what it was for. */
function fallbackArguments(update: Record<string, unknown>): Record<string, unknown> {
	const title = typeof update.title === "string" ? update.title.trim() : "";
	return title ? { title } : {};
}

/**
 * The workspace paths a call names, from its `locations` or its own argument fields. Pi reports its
 * file work on the row of the call that asked for it, so a read or write can be matched by path.
 */
function acpToolPaths(update: Record<string, unknown>): string[] {
	const paths: string[] = [];
	const locations = update.locations;
	if (Array.isArray(locations)) {
		for (const location of locations) {
			const path = location && typeof location === "object" ? (location as any).path : undefined;
			if (typeof path === "string" && path) paths.push(path);
		}
	}
	const raw = rawInput(update);
	const named = stringField(raw, ["TargetFile", "file_path", "AbsolutePath", "path"]);
	if (named && !paths.includes(named)) paths.push(named);
	return paths;
}

/** A file change the server described, with the text it added. */
function editDiff(update: Record<string, unknown>): { path: string; newText?: string } | undefined {
	const blocks = Array.isArray(update.content) ? update.content : [];
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const record = block as Record<string, unknown>;
		if (record.type !== "diff" || typeof record.path !== "string") continue;
		return {
			path: record.path,
			...(typeof record.newText === "string" ? { newText: record.newText } : {}),
		};
	}
	return undefined;
}

function stringField(source: Record<string, unknown> | undefined, keys: string[]): string | undefined {
	if (!source) return undefined;
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

/**
 * Text of a tool output: the server's `rawOutput`, else the update's content blocks.
 */
function acpToolOutput(update: Record<string, unknown>): string {
	return rawOutputText(update.rawOutput) || contentText(update.content);
}

/**
 * Bound an ACP tool output the way Pi's own tools do: keep the tail that carries the result, and
 * when the server sent more than Pi shows, write the whole text to a file the model can read.
 * Progress output is shown without the notice, so a running call does not spawn a file per update.
 */
function displayToolOutput(text: string, persist: boolean): string {
	const truncation = truncateTail(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) return text;
	if (!persist) return truncation.content;
	const fullOutputPath = writeOutputFile(text);
	const startLine = truncation.totalLines - truncation.outputLines + 1;
	const endLine = truncation.totalLines;
	if (truncation.lastLinePartial) {
		const lastLineBytes = Buffer.byteLength(text.slice(text.lastIndexOf("\n") + 1));
		return `${truncation.content}\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${formatSize(lastLineBytes)}). Full output: ${fullOutputPath}]`;
	}
	if (truncation.truncatedBy === "lines") {
		return `${truncation.content}\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${fullOutputPath}]`;
	}
	return `${truncation.content}\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${fullOutputPath}]`;
}

/** Tool output can carry private data, so only the user may read the file holding it. */
function writeOutputFile(text: string): string {
	const path = join(tmpdir(), `pi-acp-output-${randomBytes(8).toString("hex")}.log`);
	writeFileSync(path, text, { mode: 0o600, flag: "wx" });
	return path;
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

/** An ACP prompt block: text Pi wrote, or an image Pi was given. */
export type AcpPromptBlock =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export interface BuildPromptOptions {
	/** Pi's system prompt already reached the session through its metadata. */
	omitSystemPrompt?: boolean;
}

/** Images of a message, in the shape ACP takes; a provider that cannot see them gets none. */
function messageImages(message: any): Array<{ type: "image"; data: string; mimeType: string }> {
	if (!Array.isArray(message?.content)) return [];
	const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
	for (const block of message.content) {
		if (block?.type !== "image") continue;
		if (typeof block.data !== "string" || typeof block.mimeType !== "string") continue;
		images.push({ type: "image", data: block.data, mimeType: block.mimeType });
	}
	return images;
}

/** Convert Pi's transcript into ACP prompt blocks. */
function promptBlocks(messages: any[], instructions: string): AcpPromptBlock[] {
	const blocks: AcpPromptBlock[] = [];
	if (instructions) blocks.push({ type: "text", text: `System instructions:\n${instructions}` });
	for (const message of messages) {
		const text = messageText(message);
		const label =
			message.role === "user"
				? "User"
				: message.role === "assistant"
					? "Assistant"
					: message.role === "toolResult"
						? "Tool result"
						: String(message.role ?? "Message");
		if (text) blocks.push({ type: "text", text: `${label}:\n${text}` });
		blocks.push(...messageImages(message));
	}
	if (blocks.length === 0) blocks.push({ type: "text", text: "Continue." });
	return blocks;
}

export function buildPrompt(context: any, options: BuildPromptOptions = {}): AcpPromptBlock[] {
	const messages = Array.isArray(context?.messages) ? context.messages : [];
	return promptBlocks(messages, options.omitSystemPrompt ? "" : systemText(context?.systemPrompt));
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

/** Antigravity takes Pi's own system prompt as session metadata instead of prompt text. */
function supportsSystemPromptAppend(initialized: AcpInitializeResult): boolean {
	const capabilities = initialized?.agentCapabilities as Record<string, unknown> | undefined;
	const meta = capabilities?._meta as Record<string, unknown> | undefined;
	const antigravity = meta?.antigravity as Record<string, unknown> | undefined;
	const systemPrompt = antigravity?.systemPrompt as Record<string, unknown> | undefined;
	return systemPrompt?.append !== undefined;
}

/**
 * One live conversation: the server process and the session it holds for a workspace.
 *
 * The server keeps its own context for a session, so Pi keeps the process and the session alive
 * between turns and sends only the messages the session does not have yet. `delivered` holds a
 * fingerprint of every message the session knows, which tells a resumed turn what is new and
 * catches a transcript Pi rewrote (a compaction or a branch edit), where the server's context and
 * Pi's transcript no longer describe the same conversation.
 */
interface AcpConversation {
	key: string;
	client: AcpClientLike;
	sessionId: string;
	delivered: string[];
	/** Whether Pi's system prompt reached the session through its metadata. */
	systemPromptAppended: boolean;
	/** The stream events of the turn in flight; the client's callbacks report to it. */
	writer?: PiEventWriter;
	/** Whether this turn asked Pi a question it could not answer. */
	askedQuestion: boolean;
	/** Whether this turn had a permission request Pi declined. */
	refusedCall: boolean;
	inUse: boolean;
	idleTimer?: ReturnType<typeof setTimeout>;
}

/** Conversations a workspace keeps between Pi turns. */
const conversations = new Map<string, AcpConversation>();

/** Close an idle conversation; a Pi session that paused is likely to resume soon. */
const CONVERSATION_IDLE_MS = 10 * 60 * 1_000;

let exitHookRegistered = false;

function fingerprintMessage(message: unknown): string {
	return createHash("sha1").update(JSON.stringify(message) ?? "").digest("hex");
}

function contextMessages(context: unknown): any[] {
	const messages = (context as any)?.messages;
	return Array.isArray(messages) ? messages : [];
}

/** Whether Pi's transcript still starts with what the session was given. */
function prefixDelivered(messages: any[], delivered: string[]): boolean {
	if (messages.length < delivered.length) return false;
	for (let index = 0; index < delivered.length; index++) {
		if (fingerprintMessage(messages[index]) !== delivered[index]) return false;
	}
	return true;
}

/**
 * The messages a resumed session has not seen: everything after what it was given, minus the
 * assistant turn and tool results the server produced itself and still holds.
 */
function newMessages(messages: any[], deliveredCount: number): any[] {
	let start = deliveredCount;
	while (start < messages.length) {
		const role = messages[start]?.role;
		if (role !== "assistant" && role !== "toolResult") break;
		start++;
	}
	return messages.slice(start);
}

function closeConversation(conversation: AcpConversation): void {
	if (conversation.idleTimer) clearTimeout(conversation.idleTimer);
	conversation.idleTimer = undefined;
	if (conversations.get(conversation.key) === conversation) conversations.delete(conversation.key);
	void conversation.client.close().catch(() => undefined);
}

function releaseConversation(conversation: AcpConversation): void {
	conversation.inUse = false;
	conversation.writer = undefined;
	if (conversation.idleTimer) clearTimeout(conversation.idleTimer);
	conversation.idleTimer = setTimeout(() => {
		if (!conversation.inUse) closeConversation(conversation);
	}, CONVERSATION_IDLE_MS);
	conversation.idleTimer.unref?.();
}

/** A server left running after Pi exits would hold the account's session for no one. */
function registerExitHook(): void {
	if (exitHookRegistered) return;
	exitHookRegistered = true;
	process.once("exit", () => {
		for (const conversation of conversations.values()) void conversation.client.close();
	});
}

/** Close every conversation Pi keeps, for a caller that is done with the provider. */
export async function closeAcpConversations(): Promise<void> {
	const live = [...conversations.values()];
	conversations.clear();
	await Promise.all(live.map((conversation) => conversation.client.close().catch(() => undefined)));
}

/** Start the server and a fresh session for this workspace. */
async function openConversation(
	model: AntigravityAcpModel,
	context: unknown,
	options: AcpStreamOptions,
	deps: AcpStreamDeps,
	cwd: string,
	writer: PiEventWriter,
): Promise<AcpConversation> {
	const launch = await deps.resolveRuntime();
	const conversation = {
		key: cwd,
		delivered: [] as string[],
		systemPromptAppended: false,
		writer,
		askedQuestion: false,
		refusedCall: false,
		inUse: true,
	} as unknown as AcpConversation;
	// Pi serves the server's file callbacks, so what Pi did belongs on the call's row.
	const fileHandlers = deps.fileHandlers
		? {
				readTextFile: async (request: AcpReadTextFileRequest) => {
					const result = await deps.fileHandlers?.readTextFile(request);
					conversation.writer?.recordFileOperation({
						type: "read",
						path: request.path,
						lines: (result?.content ?? "").split("\n").length,
					});
					return result;
				},
				writeTextFile: async (request: AcpWriteTextFileRequest) => {
					await deps.fileHandlers?.writeTextFile(request);
					conversation.writer?.recordFileOperation({
						type: "write",
						path: request.path,
						bytes: Buffer.byteLength(request.content ?? ""),
					});
				},
			}
		: undefined;
	const client = deps.createClient({
		command: launch.command,
		args: launch.args,
		cwd,
		onUpdate: (notification) => {
			if (conversation.writer) handleUpdate(notification, conversation.writer, deps.onToolActivity);
		},
		// Pi's policy decides; the safe default without a gate is to deny.
		onPermission: async (request: AcpPermissionRequest) => {
			const outcome = await (deps.permission
				? deps.permission(request)
				: Promise.resolve<AcpPermissionOutcome>({
						response: { outcome: { outcome: "cancelled" as const } },
					}));
			if (outcome.question) {
				conversation.askedQuestion = true;
				deps.onQuestion?.(outcome.question, cwd);
			}
			if (outcome.response.outcome.outcome !== "selected") conversation.refusedCall = true;
			return outcome.response;
		},
		...(fileHandlers ? { fileHandlers } : {}),
		...(deps.mcpServers?.length ? { mcpServers: deps.mcpServers } : {}),
	});
	conversation.client = client;
	try {
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
		// Pi's system prompt is the server's instructions too: it belongs in the session
		// metadata, not in the prompt, when the server says it can take it.
		const instructions = systemText((context as any)?.systemPrompt);
		const appendSystemPrompt = Boolean(instructions) && supportsSystemPromptAppend(initialized);
		const session = await client.newSession(cwd, options.signal, {
			...(additionalDirectories ? { additionalDirectories } : {}),
			...(appendSystemPrompt
				? { meta: { antigravity: { systemPrompt: { append: instructions } } } }
				: {}),
		});
		conversation.sessionId = session.sessionId;
		conversation.systemPromptAppended = appendSystemPrompt;
		registerExitHook();
		return conversation;
	} catch (error) {
		await client.close().catch(() => undefined);
		throw error;
	}
}

export function createAcpStream(
	model: AntigravityAcpModel,
	context: unknown,
	options: AcpStreamOptions = {},
	deps: AcpStreamDeps,
): AssistantMessageEventStream {
	const writer = new PiEventWriter(model);
	const cwd = deps.cwd ?? options.cwd ?? process.cwd();
	// Claim the workspace's conversation now, so a concurrent turn gets its own process.
	const claimed = conversations.get(cwd);
	if (claimed && !claimed.inUse) claimed.inUse = true;
	const acquired = claimed && claimed.inUse ? claimed : undefined;
	(async () => {
		let conversation = acquired;
		try {
			const messages = contextMessages(context);
			let blocks: AcpPromptBlock[] | undefined;
			if (conversation) {
				if (!prefixDelivered(messages, conversation.delivered)) {
					// Pi's transcript no longer starts with what the session holds.
					closeConversation(conversation);
					conversation = undefined;
				}
			}
			if (conversation) {
				conversation.writer = writer;
				if (conversation.idleTimer) clearTimeout(conversation.idleTimer);
				conversation.idleTimer = undefined;
				blocks = promptBlocks(newMessages(messages, conversation.delivered.length), "");
			} else {
				conversation = await openConversation(model, context, options, deps, cwd, writer);
				conversations.set(cwd, conversation);
				blocks = buildPrompt(context, {
					omitSystemPrompt: conversation.systemPromptAppended,
				});
			}
			const level = thinkingLevel(options);
			await conversation.client.setModel(
				conversation.sessionId,
				acpModelId(model, level),
				options.signal,
			);
			const response = await conversation.client.prompt(
				conversation.sessionId,
				blocks,
				options.signal,
			);
			if (response.stopReason === "cancelled") {
				writer.setUsage(response.usage);
				if (!conversation.askedQuestion && !conversation.refusedCall) {
					throw new Error("Antigravity ACP cancelled the prompt");
				}
				// A refused call or an unanswered question ends the server's turn
				// rather than breaking it: the transcript shows why, and the person
				// answers in their next message. The session stopped mid-turn, so it
				// is rebuilt next turn instead of being reused.
				writer.done("stop");
				closeConversation(conversation);
				return;
			}
			writer.setUsage(response.usage);
			writer.done(mapStopReason(response.stopReason));
			// The session now knows every message Pi had, so the next turn sends only what follows.
			conversation.delivered = messages.map(fingerprintMessage);
			releaseConversation(conversation);
		} catch (error) {
			writer.fail(error, options.signal?.aborted === true);
			// A failed or cancelled turn leaves the session's context uncertain.
			if (conversation) closeConversation(conversation);
		}
	})();
	return writer.stream;
}
