/**
 * Pi event stream for the Antigravity ACP provider.
 *
 * Each Pi turn creates one ACP session, selects the requested model and
 * thought level, sends the current transcript as a text prompt, and maps the
 * server's message/thought chunks to Pi's stream events. The ACP server owns
 * its tools; this provider deliberately does not surface tool calls to Pi.
 */

import {
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";

import type {
	AcpClientLike,
	AcpClientOptions,
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

export interface AcpStreamDeps {
	resolveRuntime: () => Promise<RuntimeLaunch>;
	createClient: (options: AcpClientOptions) => AcpClientLike;
	hasAuth?: () => boolean;
	cwd?: string;
}

type StopReason = "stop" | "length" | "toolUse";

class PiEventWriter {
	readonly stream: AssistantMessageEventStream;
	readonly message: any;
	private readonly cost: AntigravityAcpModel["cost"];
	private open: { kind: "text" | "thinking"; index: number } | undefined;
	private started = false;
	private terminal = false;

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
			cost: {
				input: inputCost,
				output: outputCost,
				cacheRead: cacheReadCost,
				cacheWrite: cacheWriteCost,
				total: inputCost + outputCost + cacheReadCost + cacheWriteCost,
			},
		};
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
): void {
	const update = notification?.update;
	if (!update) return;
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
				onUpdate: (notification) => handleUpdate(notification, writer),
				onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
			});
			await client.initialize(options.signal);
			if (deps.hasAuth && !deps.hasAuth()) {
				throw new Error(
					"Google Antigravity ACP is not authenticated. Run /login for google-antigravity-acp.",
				);
			}
			const session = await client.newSession(cwd, options.signal);
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
