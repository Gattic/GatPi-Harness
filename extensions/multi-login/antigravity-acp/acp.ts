/**
 * Dependency-free ACP JSON-RPC client for the official Antigravity ACP server.
 *
 * The server speaks newline-delimited JSON-RPC over stdio. This client covers
 * the provider's needs: initialize, authenticate, create a session, select the
 * model/thought level, prompt, and surface `session/update` notifications.
 * Permission requests default to cancellation.
 *
 * The server runs its own shell and file tools inside its runtime. Two surfaces
 * let it reach Pi instead: the `mcpServers` of `session/new` hand it MCP servers
 * to connect itself, and the `fs/read_text_file`/`fs/write_text_file` client
 * capabilities make its `client_view_file`/`client_create_file`/`client_edit_file`
 * tools read and write through Pi. Pi advertises those capabilities only when
 * it has handlers for them, and the handlers decide every call with Pi's own
 * policy before touching a file. `terminal/*` stays unadvertised: the server
 * runs commands in its own sandbox and never asks the client to run one.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { splitEffortSuffix, type AcpModelInfo } from "./models";

export interface AcpInitializeResult {
	protocolVersion: number;
	agentInfo?: { name: string; version: string };
	authMethods?: Array<{ id: string; name: string; description?: string }>;
	agentCapabilities?: Record<string, unknown>;
}

export interface AcpConfigOptionChoice {
	value: string;
	name: string;
}

export interface AcpConfigOption {
	id: string;
	name: string;
	category?: string;
	type?: string;
	currentValue?: string;
	options?: AcpConfigOptionChoice[];
}

export interface AcpSessionNewResult {
	sessionId: string;
	models?: {
		currentModelId?: string;
		availableModels?: AcpModelInfo[];
	} | null;
	configOptions?: AcpConfigOption[];
	modes?: unknown;
	_meta?: unknown;
}

/** What a client may add to `session/new` beyond the workspace it is offering. */
export interface AcpNewSessionOptions {
	/** Workspace directories Pi grants beyond the session cwd. */
	additionalDirectories?: string[];
	/** Provider metadata the server reads, such as Antigravity's system-prompt append. */
	meta?: Record<string, unknown>;
}

export interface AcpPromptUsage {
	inputTokens?: number;
	outputTokens?: number;
	cachedReadTokens?: number;
	cachedWriteTokens?: number;
	thoughtTokens?: number;
	totalTokens?: number;
}

export interface AcpPromptResponse {
	stopReason: string;
	usage?: AcpPromptUsage;
}

export interface AcpSessionUpdateNotification {
	sessionId: string;
	update: {
		sessionUpdate: string;
		content?: { type?: string; text?: string; data?: string; mimeType?: string };
		[key: string]: unknown;
	};
}

export interface AcpEnvVariable {
	name: string;
	value: string;
}

export interface AcpHttpHeader {
	name: string;
	value: string;
}

/**
 * A stdio MCP server as ACP v1 spells it. The v1 union has no `type` tag on this
 * variant: the entry is recognised by `command`, while HTTP/SSE entries carry
 * `type`. Extra keys are ignored by the server's schema, so nothing is invented
 * here that the protocol does not define.
 */
export interface AcpMcpServerStdio {
	name: string;
	command: string;
	args: string[];
	env: AcpEnvVariable[];
}

export interface AcpMcpServerHttp {
	type: "http";
	name: string;
	url: string;
	headers: AcpHttpHeader[];
}

export type AcpMcpServer = AcpMcpServerStdio | AcpMcpServerHttp;

export interface AcpReadTextFileRequest {
	sessionId: string;
	/** Absolute path to the file to read. */
	path: string;
	/** 1-based line to start at. */
	line?: number;
	/** Maximum number of lines to read. */
	limit?: number;
}

export interface AcpWriteTextFileRequest {
	sessionId: string;
	/** Absolute path to the file to write. */
	path: string;
	/** Complete replacement content. */
	content: string;
}

/**
 * Pi's side of the ACP file callbacks. Advertising a capability without its
 * handler would invite requests Pi cannot answer, so the two handlers are
 * declared together and the capabilities follow their presence.
 */
export interface AcpClientFileHandlers {
	readTextFile(request: AcpReadTextFileRequest): Promise<{ content: string }>;
	writeTextFile(request: AcpWriteTextFileRequest): Promise<void>;
}

export interface AcpPermissionRequest {
	sessionId: string;
	toolCall?: unknown;
	options?: Array<{ optionId: string; name?: string; kind?: string }>;
}

export type AcpPermissionResponse =
	| { outcome: { outcome: "selected"; optionId: string } }
	| { outcome: { outcome: "cancelled" } };

/**
 * Something the server asks the person instead of asking permission for an
 * action: a workspace-trust prompt, a plan approval, a free-form question.
 * Pi cannot render a dialog while the server waits inside a streaming turn, so
 * the request is declined and the question is shown in the transcript.
 */
export interface AcpQuestion {
	text: string;
	kind: string;
	/** The question is a workspace-trust decision, which Pi's own trust answers. */
	trust: boolean;
	options: Array<{ id: string; name: string }>;
}

/** Pi's answer to one permission request, plus what it could not decide. */
export interface AcpPermissionOutcome {
	response: AcpPermissionResponse;
	question?: AcpQuestion;
}

export interface AcpClientOptions {
	command: string;
	args?: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	onUpdate?: (notification: AcpSessionUpdateNotification) => void | Promise<void>;
	onPermission?: (request: AcpPermissionRequest) => Promise<AcpPermissionResponse>;
	/** MCP servers the server connects itself, sent with `session/new`. */
	mcpServers?: AcpMcpServer[];
	/** Serves `fs/read_text_file` and `fs/write_text_file`; absent, neither is advertised. */
	fileHandlers?: AcpClientFileHandlers;
	onStderr?: (line: string) => void;
	initializeTimeoutMs?: number;
	operationTimeoutMs?: number;
	promptTimeoutMs?: number;
	maxFrameBytes?: number;
}

export interface AcpClientLike {
	initialize(signal?: AbortSignal): Promise<AcpInitializeResult>;
	authenticate(methodId: string, signal?: AbortSignal): Promise<void>;
	newSession(cwd: string, signal?: AbortSignal, options?: AcpNewSessionOptions): Promise<AcpSessionNewResult>;
	setModel(sessionId: string, modelId: string, signal?: AbortSignal): Promise<void>;
	prompt(sessionId: string, prompt: unknown[], signal?: AbortSignal): Promise<AcpPromptResponse>;
	close(): Promise<void>;
}

type JsonRpcId = number | string;

interface PendingRequest {
	method: string;
	resolve(value: unknown): void;
	reject(error: Error): void;
}

interface JsonRpcErrorObject {
	code: number;
	message: string;
	data?: unknown;
}

export class AcpRpcError extends Error {
	readonly code: number;
	readonly data?: unknown;

	constructor(error: JsonRpcErrorObject) {
		super(error.message || `ACP RPC error (${error.code})`);
		this.name = "AcpRpcError";
		this.code = error.code;
		this.data = error.data;
	}
}

export class AcpAbortError extends Error {
	constructor() {
		super("ACP request aborted");
		this.name = "AbortError";
	}
}

/**
 * A request passed its deadline. Prompt deadlines are opt-in: an ACP turn lasts
 * as long as the server needs, and the server sends nothing at all while a
 * background command runs, so an arbitrary deadline can only fail a turn that is
 * still working. The user's abort is the control for a turn that never returns.
 */
export class AcpTimeoutError extends Error {
	readonly method: string;
	readonly timeoutMs: number;

	constructor(method: string, timeoutMs: number, detail: string) {
		super(`ACP ${method} timed out after ${timeoutMs}ms${detail ? `; ${detail}` : ""}`);
		this.name = "TimeoutError";
		this.method = method;
		this.timeoutMs = timeoutMs;
	}
}

const DEFAULT_INITIALIZE_TIMEOUT_MS = 120_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

// The server is a Python bundle that prints SyntaxWarnings about its own
// sources. They have nothing to do with the failure and otherwise bury the
// real cause in every error message.
const STDERR_NOISE =
	/(?:SyntaxWarning|DeprecationWarning|UserWarning|RuntimeWarning|invalid escape sequence|raw string is also an option|Did you mean)/u;

export class AcpClient implements AcpClientLike {
	readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly options: AcpClientOptions;
	private readonly initializeTimeoutMs: number;
	private readonly operationTimeoutMs: number;
	/** Undefined means a prompt waits for the server until the turn aborts. */
	readonly promptTimeoutMs: number | undefined;
	private readonly maxFrameBytes: number;
	private readonly pending = new Map<JsonRpcId, PendingRequest>();
	private readonly sessions = new Map<string, AcpSessionNewResult>();
	private nextId = 1;
	private buffer = "";
	private stderrTail = "";
	private lastActivity: { at: number; summary: string } | undefined;
	private closed = false;

	constructor(options: AcpClientOptions) {
		this.options = options;
		this.initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
		this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
		this.promptTimeoutMs = options.promptTimeoutMs;
		this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
		this.child = spawn(options.command, options.args ?? [], {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stdout.setEncoding("utf8");
		this.child.stderr.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
		this.child.stderr.on("data", (chunk: string) => this.onStderr(chunk));
		this.exited = new Promise((resolve) => {
			this.child.once("exit", (code, signal) => {
				this.onExit(code, signal);
				resolve({ code, signal });
			});
		});
		this.child.once("error", (error) => this.failAll(error));
	}

	private onStdout(chunk: string): void {
		this.buffer += chunk;
		if (this.buffer.length > this.maxFrameBytes) {
			this.failAll(new Error("ACP output exceeded the maximum frame size"));
			void this.close();
			return;
		}
		let newline: number;
		while ((newline = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
			this.buffer = this.buffer.slice(newline + 1);
			if (!line.trim()) continue;
			if (!line.startsWith("{")) {
				this.options.onStderr?.(line);
				continue;
			}
			try {
				this.handleMessage(JSON.parse(line) as Record<string, unknown>);
			} catch (error) {
				this.failAll(error instanceof Error ? error : new Error(String(error)));
				void this.close();
				return;
			}
		}
	}

	private onStderr(chunk: string): void {
		this.stderrTail = (this.stderrTail + chunk).slice(-8192);
		for (const line of chunk.split(/\r?\n/u)) {
			if (line.trim()) this.options.onStderr?.(line);
		}
	}

	private handleMessage(message: Record<string, unknown>): void {
		const id = message.id;
		if (
			(id !== undefined && id !== null) &&
			("result" in message || "error" in message)
		) {
			this.settle(id as JsonRpcId, message);
			return;
		}
		if (typeof message.method === "string" && id !== undefined && id !== null) {
			void this.handleServerRequest(message, id as JsonRpcId).catch((error) => {
				try {
					this.respondError(
						id as JsonRpcId,
						-32603,
						error instanceof Error ? error.message : String(error),
					);
				} catch {
					// The process may have closed before the error response.
				}
			});
			return;
		}
		if (typeof message.method === "string") {
			this.handleNotification(message);
		}
	}

	private settle(id: JsonRpcId, message: Record<string, unknown>): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		if ("error" in message) {
			pending.reject(new AcpRpcError(message.error as JsonRpcErrorObject));
		} else {
			pending.resolve(message.result);
		}
	}

	private handleNotification(message: Record<string, unknown>): void {
		if (message.method === "session/update" && message.params) {
			const notification = message.params as AcpSessionUpdateNotification;
			this.recordActivity(notification);
			void Promise.resolve(this.options.onUpdate?.(notification)).catch(() => undefined);
		}
	}

	/** Remember what the server last reported, for timeout and exit messages. */
	private recordActivity(notification: AcpSessionUpdateNotification): void {
		const update = (notification.update ?? {}) as Record<string, unknown>;
		const parts = [String(update.sessionUpdate ?? "update")];
		if (update.kind) parts.push(String(update.kind));
		if (update.status) parts.push(String(update.status));
		const hint = activityHint(update);
		if (hint) parts.push(JSON.stringify(hint));
		this.lastActivity = { at: Date.now(), summary: parts.join(" ") };
	}

	/** One line naming the last server activity plus any non-noise stderr. */
	private describeFailureContext(): string {
		const parts: string[] = [];
		if (this.lastActivity) {
			const seconds = Math.max(0, Math.round((Date.now() - this.lastActivity.at) / 1000));
			parts.push(`last activity: ${this.lastActivity.summary} (${seconds}s ago)`);
		}
		const stderr = this.meaningfulStderr();
		if (stderr) parts.push(`server stderr: ${stderr}`);
		return parts.join("; ");
	}

	private meaningfulStderr(limit = 6): string {
		const lines = this.stderrTail
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter((line) => line && !STDERR_NOISE.test(line));
		return lines.slice(-limit).join(" | ").slice(0, 1_000);
	}

	private async handleServerRequest(
		message: Record<string, unknown>,
		id: JsonRpcId,
	): Promise<void> {
		const method = message.method as string;
		if (method === "session/request_permission") {
			const request = message.params as AcpPermissionRequest;
			const response = this.options.onPermission
				? await this.options.onPermission(request)
				: { outcome: { outcome: "cancelled" as const } };
			this.respond(id, response);
			return;
		}
		if (method === "fs/read_text_file" || method === "fs/write_text_file") {
			await this.handleFileRequest(method, message.params, id);
			return;
		}
		this.respondError(id, -32601, `ACP method not supported: ${method}`);
	}

	/**
	 * Answer one file callback. A refusal carries Pi's policy reasons and the
	 * approval key, which the server reports as the tool's failure, so the reason
	 * reaches both the transcript and the model instead of a bare "denied".
	 */
	private async handleFileRequest(
		method: "fs/read_text_file" | "fs/write_text_file",
		params: unknown,
		id: JsonRpcId,
	): Promise<void> {
		const handlers = this.options.fileHandlers;
		if (!handlers) {
			this.respondError(id, -32601, `ACP method not supported: ${method}`);
			return;
		}
		if (method === "fs/read_text_file") {
			const response = await handlers.readTextFile(params as AcpReadTextFileRequest);
			this.respond(id, { content: response.content });
			return;
		}
		await handlers.writeTextFile(params as AcpWriteTextFileRequest);
		this.respond(id, {});
	}

	private respond(id: JsonRpcId, result: unknown): void {
		this.write({ jsonrpc: "2.0", id, result });
	}

	private respondError(id: JsonRpcId, code: number, message: string): void {
		this.write({ jsonrpc: "2.0", id, error: { code, message } });
	}

	private write(message: Record<string, unknown>): void {
		if (this.closed) throw new Error("ACP client is closed");
		if (!this.child.stdin.writable) throw new Error("ACP process stdin is closed");
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private request<T>(
		method: string,
		params: unknown,
		timeoutMs: number | undefined,
		signal?: AbortSignal,
	): Promise<T> {
		if (this.closed) return Promise.reject(new Error("ACP client is closed"));
		if (signal?.aborted) return Promise.reject(new AcpAbortError());
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const pending: PendingRequest = {
				method,
				resolve: (value) => {
					this.pending.delete(id);
					cleanup();
					resolve(value as T);
				},
				reject: (error) => {
					this.pending.delete(id);
					cleanup();
					reject(error);
				},
			};
			this.pending.set(id, pending);
			const timer =
				timeoutMs === undefined
					? undefined
					: setTimeout(() => {
							this.pending.delete(id);
							cleanup();
							reject(new AcpTimeoutError(method, timeoutMs, this.describeFailureContext()));
						}, timeoutMs);
			const onAbort = (): void => {
				this.pending.delete(id);
				cleanup();
				reject(new AcpAbortError());
			};
			const cleanup = (): void => {
				if (timer !== undefined) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			if (signal) signal.addEventListener("abort", onAbort, { once: true });
			try {
				this.write({ jsonrpc: "2.0", id, method, params });
			} catch (error) {
				this.pending.delete(id);
				cleanup();
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private notify(method: string, params: unknown): void {
		try {
			this.write({ jsonrpc: "2.0", method, params });
		} catch {
			// Cancellation is best effort once the process has gone away.
		}
	}

	async initialize(signal?: AbortSignal): Promise<AcpInitializeResult> {
		const result = await this.request<AcpInitializeResult>(
			"initialize",
			{
				protocolVersion: 1,
				clientCapabilities: {
					// The server only offers its client file tools when the matching
					// capability is advertised, and turns off its own create/edit
					// built-ins in favour of them, so a write always reaches Pi.
					fs: {
						readTextFile: Boolean(this.options.fileHandlers?.readTextFile),
						writeTextFile: Boolean(this.options.fileHandlers?.writeTextFile),
					},
					terminal: false,
				},
				clientInfo: { name: "pi-antigravity-acp", version: "0.1.0" },
			},
			this.initializeTimeoutMs,
			signal,
		);
		return result;
	}

	async authenticate(methodId: string, signal?: AbortSignal): Promise<void> {
		await this.request(
			"authenticate",
			{ methodId },
			this.operationTimeoutMs,
			signal,
		);
	}

	async newSession(
		cwd: string,
		signal?: AbortSignal,
		options: AcpNewSessionOptions = {},
	): Promise<AcpSessionNewResult> {
		const additionalDirectories = options.additionalDirectories;
		const result = await this.request<AcpSessionNewResult>(
			"session/new",
			{
				cwd,
				mcpServers: this.options.mcpServers ?? [],
				...(additionalDirectories?.length ? { additionalDirectories } : {}),
				...(options.meta ? { _meta: options.meta } : {}),
			},
			this.operationTimeoutMs,
			signal,
		);
		if (!result || typeof result.sessionId !== "string") {
			throw new Error("ACP session/new did not return a session id");
		}
		this.sessions.set(result.sessionId, result);
		return result;
	}

	async setConfigOption(
		sessionId: string,
		configId: string,
		value: string,
		signal?: AbortSignal,
	): Promise<void> {
		const result = await this.request<{ configOptions?: AcpConfigOption[] }>(
			"session/set_config_option",
			{ sessionId, configId, value },
			this.operationTimeoutMs,
			signal,
		);
		const state = this.sessions.get(sessionId);
		if (state && result?.configOptions) {
			this.sessions.set(sessionId, { ...state, configOptions: result.configOptions });
		}
	}

	async setModel(sessionId: string, modelId: string, signal?: AbortSignal): Promise<void> {
		const state = this.sessions.get(sessionId);
		const configOptions = state?.configOptions ?? [];
		const modelSelector = findSelector(configOptions, "model");
		const thoughtSelector = findSelector(configOptions, "thought_level");
		const split = splitEffortSuffix(modelId);
		if (
			split &&
			modelSelector &&
			thoughtSelector &&
			selectorHas(modelSelector, split.base) &&
			selectorHas(thoughtSelector, split.effort)
		) {
			await this.setConfigOption(sessionId, modelSelector.id, split.base, signal);
			await this.setConfigOption(sessionId, thoughtSelector.id, split.effort, signal);
			return;
		}
		if (modelSelector && selectorHas(modelSelector, modelId)) {
			await this.setConfigOption(sessionId, modelSelector.id, modelId, signal);
			return;
		}
		// Older official builds still implement the removed draft method.
		await this.request(
			"session/set_model",
			{ sessionId, modelId },
			this.operationTimeoutMs,
			signal,
		);
	}

	async prompt(
		sessionId: string,
		prompt: unknown[],
		signal?: AbortSignal,
	): Promise<AcpPromptResponse> {
		if (signal?.aborted) throw new AcpAbortError();
		const onAbort = (): void => this.notify("session/cancel", { sessionId });
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await this.request<AcpPromptResponse>(
				"session/prompt",
				{ sessionId, prompt },
				this.promptTimeoutMs,
				signal,
			);
		} catch (error) {
			// A deadline Pi imposed must stop the server's turn too, or the agent keeps
			// working invisibly after Pi has already reported the turn as failed.
			if (error instanceof AcpTimeoutError) this.notify("session/cancel", { sessionId });
			throw error;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const pending of this.pending.values()) {
			pending.reject(new Error("ACP client closed"));
		}
		this.pending.clear();
		try {
			this.child.stdin.end();
		} catch {
			// The process may already have closed stdin.
		}
		if (this.child.exitCode === null && !this.child.killed) {
			this.child.kill("SIGTERM");
			const timer = setTimeout(() => {
				if (this.child.exitCode === null) this.child.kill("SIGKILL");
			}, 1_500);
			await this.exited.catch(() => undefined);
			clearTimeout(timer);
		}
	}

	private onExit(code: number | null, signal: NodeJS.Signals | null): void {
		this.closed = true;
		const status = signal ? `signal ${signal}` : `code ${String(code)}`;
		const detail = this.describeFailureContext();
		this.failAll(
			new Error(`ACP process exited with ${status}${detail ? `; ${detail}` : ""}`),
		);
	}

	private failAll(error: Error): void {
		this.closed = true;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}

function activityHint(update: Record<string, unknown>): string | undefined {
	const raw = update.rawInput;
	const candidate =
		raw && typeof raw === "object"
			? ["CommandLine", "command", "TargetFile", "file_path", "path"]
					.map((key) => (raw as Record<string, unknown>)[key])
					.find((value) => typeof value === "string" && value.trim())
			: undefined;
	const hint =
		typeof candidate === "string"
			? candidate
			: typeof update.title === "string"
				? update.title
				: undefined;
	return hint ? hint.slice(0, 120) : undefined;
}

function findSelector(
	options: readonly AcpConfigOption[],
	category: "model" | "thought_level",
): AcpConfigOption | undefined {
	return (
		options.find((option) => option.category === category) ??
		options.find((option) => option.id === (category === "model" ? "model" : "thinking_level"))
	);
}

function selectorHas(selector: AcpConfigOption, value: string): boolean {
	return selector.options?.some((option) => option.value === value) ?? false;
}
