/**
 * Cloud Code Assist transport for the Google Antigravity provider.
 *
 * Ported from the upstream Pi provider removed in 0.71.0
 * (earendil-works/pi packages/ai/src/providers/google-gemini-cli.ts, MIT,
 * commit fe66edd94), adapted to Pi's current TranscriptContext and message
 * types. The request envelope and headers are the ones the Antigravity IDE
 * sends: `requestType: "agent"`, an `antigravity/<version>` User-Agent, the
 * IDE's leading system instruction, and the sandbox endpoint fallback order.
 */

import {
	type AssistantMessageEventStream,
	calculateCost,
	collapseSystemMessages,
	createAssistantMessageEventStream,
	getCurrentTools,
	getInitialSystemMessage,
	getSystemMessageText,
	withoutInitialSystemMessage,
} from "@earendil-works/pi-ai";

import { ANTIGRAVITY_ENDPOINTS, type AntigravityModel } from "./models";

export type FetchLike = typeof globalThis.fetch;

/** Antigravity version the request identifies as; override for a different IDE build. */
const DEFAULT_ANTIGRAVITY_VERSION = "1.107.0";

const ANTIGRAVITY_SYSTEM_INSTRUCTION =
	"You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding." +
	"You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question." +
	"**Absolute paths only**" +
	"**Proactiveness**";

const CLAUDE_THINKING_BETA_HEADER = "interleaved-thinking-2025-05-14";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_EMPTY_STREAM_RETRIES = 2;
const EMPTY_STREAM_BASE_DELAY_MS = 500;

let toolCallCounter = 0;

export interface AntigravityStreamOptions {
	signal?: AbortSignal;
	apiKey?: string;
	headers?: Record<string, string | null>;
	temperature?: number;
	maxTokens?: number;
	sessionId?: string;
	toolChoice?: string;
	reasoning?: string;
	thinkingBudgets?: Record<string, number>;
	fetch?: FetchLike;
	maxRetries?: number;
	maxRetryDelayMs?: number;
	onPayload?: (payload: unknown, model: unknown) => unknown | Promise<unknown>;
	onResponse?: (response: { status: number; headers: Record<string, string> }, model: unknown) => unknown;
	onProviderStreamEvent?: (event: unknown, model: unknown) => unknown;
	thinking?: { enabled: boolean; budgetTokens?: number; level?: string };
}

interface Part {
	text?: string;
	thought?: boolean;
	thoughtSignature?: string;
	functionCall?: { name: string; args: Record<string, unknown>; id?: string };
	functionResponse?: {
		name: string;
		response: Record<string, unknown>;
		parts?: Part[];
		id?: string;
	};
	inlineData?: { mimeType: string; data: string };
}

interface Content {
	role: "user" | "model";
	parts: Part[];
}

interface CloudCodeAssistRequest {
	project: string;
	model: string;
	request: {
		contents: Content[];
		sessionId?: string;
		systemInstruction?: { role?: string; parts: { text: string }[] };
		generationConfig?: {
			maxOutputTokens?: number;
			temperature?: number;
			thinkingConfig?: { includeThoughts?: boolean; thinkingBudget?: number; thinkingLevel?: string };
		};
		tools?: { functionDeclarations: Record<string, unknown>[] }[];
		toolConfig?: { functionCallingConfig: { mode: string } };
	};
	requestType?: string;
	userAgent?: string;
	requestId?: string;
}

interface CloudCodeAssistChunk {
	response?: {
		candidates?: {
			content?: { role: string; parts?: Part[] };
			finishReason?: string;
		}[];
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
			thoughtsTokenCount?: number;
			totalTokenCount?: number;
			cachedContentTokenCount?: number;
		};
		responseId?: string;
	};
}

export function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, "\uFFFD");
}

function getGeminiMajorVersion(modelId: string): number | undefined {
	const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/u);
	return match ? Number.parseInt(match[1]!, 10) : undefined;
}

/** Models behind Cloud Code Assist that need explicit tool call ids in both directions. */
export function requiresToolCallId(modelId: string): boolean {
	const major = getGeminiMajorVersion(modelId);
	return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-") || (major !== undefined && major >= 3);
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
	const major = getGeminiMajorVersion(modelId);
	return major === undefined ? true : major >= 3;
}

function isGemini3ProModel(modelId: string): boolean {
	return /gemini-3(?:\.\d+)?-pro/u.test(modelId.toLowerCase());
}

function isGemini3FlashModel(modelId: string): boolean {
	return /gemini-3(?:\.\d+)?-flash/u.test(modelId.toLowerCase());
}

function isGemini3Model(modelId: string): boolean {
	return isGemini3ProModel(modelId) || isGemini3FlashModel(modelId);
}

const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/u;

function isValidThoughtSignature(signature: string | undefined): boolean {
	if (!signature) return false;
	if (signature.length % 4 !== 0) return false;
	return base64SignaturePattern.test(signature);
}

function resolveThoughtSignature(isSameProviderAndModel: boolean, signature: string | undefined): string | undefined {
	return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

export function retainThoughtSignature(existing: string | undefined, incoming: string | undefined): string | undefined {
	if (typeof incoming === "string" && incoming.length > 0) return incoming;
	return existing;
}

/** `thought: true` marks thinking content; `thoughtSignature` alone does not. */
export function isThinkingPart(part: Pick<Part, "thought">): boolean {
	return part.thought === true;
}

export function mapStopReasonString(reason: string): string {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		default:
			return "error";
	}
}

export function mapToolChoice(choice: string | undefined): string | undefined {
	switch (choice) {
		case "auto":
			return "AUTO";
		case "none":
			return "NONE";
		case "any":
			return "ANY";
		default:
			return undefined;
	}
}

const JSON_SCHEMA_META_DECLARATIONS = new Set([
	"$schema",
	"$id",
	"$anchor",
	"$dynamicAnchor",
	"$vocabulary",
	"$comment",
	"$defs",
	"definitions",
]);

function sanitizeForOpenApi(schema: unknown): unknown {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return schema;
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (JSON_SCHEMA_META_DECLARATIONS.has(key)) continue;
		result[key] = sanitizeForOpenApi(value);
	}
	return result;
}

const JSON_SCHEMA_NAME_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]);
const JSON_SCHEMA_SUBSCHEMAS = new Set([
	"additionalProperties",
	"unevaluatedProperties",
	"propertyNames",
	"items",
	"prefixItems",
	"additionalItems",
	"unevaluatedItems",
	"contains",
	"allOf",
	"anyOf",
	"oneOf",
	"not",
	"if",
	"then",
	"else",
	"contentSchema",
]);

/** Gemini honors `enum` but ignores `const` in `parametersJsonSchema`. */
function rewriteConstAsEnum(schema: unknown, isNameMap = false): unknown {
	if (Array.isArray(schema)) return schema.map((item) => rewriteConstAsEnum(item));
	if (typeof schema !== "object" || schema === null) return schema;
	const result: Record<string, unknown> = Object.fromEntries(
		Object.entries(schema).map(([key, value]) => {
			if (isNameMap || JSON_SCHEMA_SUBSCHEMAS.has(key)) return [key, rewriteConstAsEnum(value)];
			if (JSON_SCHEMA_NAME_MAPS.has(key)) return [key, rewriteConstAsEnum(value, true)];
			return [key, value];
		}),
	);
	if (!isNameMap && "const" in result && result.enum === undefined) {
		const value = result.const;
		if (typeof value === "string" || typeof value === "number") {
			delete result.const;
			result.enum = [value];
		}
	}
	return result;
}

/** Claude models behind Cloud Code Assist need the legacy OpenAPI `parameters` field. */
function convertTools(tools: { name: string; description?: string; parameters: unknown }[], modelId: string) {
	if (tools.length === 0) return undefined;
	const useParameters = modelId.startsWith("claude-");
	return [
		{
			functionDeclarations: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				...(useParameters
					? { parameters: sanitizeForOpenApi(tool.parameters) }
					: { parametersJsonSchema: rewriteConstAsEnum(tool.parameters) }),
			})),
		},
	];
}

/** Convert Pi's transcript into Cloud Code Assist contents, preserving thought signatures. */
export function convertMessages(model: AntigravityModel, context: unknown): Content[] {
	const messages = withoutInitialSystemMessage(
		collapseSystemMessages(context as never).messages,
	) as {
		role: string;
		provider?: string;
		api?: string;
		model?: string;
		content?: unknown;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
	}[];
	const contents: Content[] = [];
	const normalizeToolCallId = (id: string): string =>
		requiresToolCallId(model.id) ? id.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 64) : id;

	for (const msg of messages) {
		if (msg.role === "user") {
			const content = msg.content;
			if (typeof content === "string") {
				contents.push({ role: "user", parts: [{ text: sanitizeSurrogates(content) }] });
				continue;
			}
			const parts: Part[] = (content as { type: string; text?: string; mimeType?: string; data?: string }[]).map(
				(item) =>
					item.type === "text"
						? { text: sanitizeSurrogates(item.text ?? "") }
						: { inlineData: { mimeType: item.mimeType ?? "", data: item.data ?? "" } },
			);
			if (parts.length > 0) contents.push({ role: "user", parts });
			continue;
		}

		if (msg.role === "assistant") {
			const isSameProviderAndModel = msg.provider === model.provider && msg.api === model.api && msg.model === model.id;
			const parts: Part[] = [];
			const blocks = (msg.content ?? []) as {
				type: string;
				text?: string;
				thinking?: string;
				textSignature?: string;
				thinkingSignature?: string;
				thoughtSignature?: string;
				id?: string;
				name?: string;
				arguments?: Record<string, unknown>;
			}[];
			for (const block of blocks) {
				if (block.type === "text") {
					const signature = resolveThoughtSignature(isSameProviderAndModel, block.textSignature);
					if ((!block.text || block.text.trim() === "") && !signature) continue;
					parts.push({ text: sanitizeSurrogates(block.text ?? ""), ...(signature && { thoughtSignature: signature }) });
				} else if (block.type === "thinking") {
					if (isSameProviderAndModel) {
						const signature = resolveThoughtSignature(isSameProviderAndModel, block.thinkingSignature);
						if ((!block.thinking || block.thinking.trim() === "") && !signature) continue;
						parts.push({
							thought: true,
							text: sanitizeSurrogates(block.thinking ?? ""),
							...(signature && { thoughtSignature: signature }),
						});
					} else if (block.thinking && block.thinking.trim() !== "") {
						// Signatures are model-specific; readable thinking from another model is sent as text.
						parts.push({ text: sanitizeSurrogates(block.thinking) });
					}
				} else if (block.type === "toolCall") {
					const signature = resolveThoughtSignature(isSameProviderAndModel, block.thoughtSignature);
					parts.push({
						functionCall: {
							name: block.name ?? "",
							args: block.arguments ?? {},
							...(requiresToolCallId(model.id) && block.id ? { id: normalizeToolCallId(block.id) } : {}),
						},
						...(signature && { thoughtSignature: signature }),
					});
				}
			}
			if (parts.length > 0) contents.push({ role: "model", parts });
			continue;
		}

		if (msg.role === "toolResult") {
			const blocks = (msg.content ?? []) as { type: string; text?: string; mimeType?: string; data?: string }[];
			const text = blocks
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join("\n");
			const images = model.input.includes("image") ? blocks.filter((block) => block.type === "image") : [];
			const hasText = text.trim().length > 0;
			const hasImages = images.length > 0;
			const responseValue = hasText ? sanitizeSurrogates(text) : hasImages ? "(see attached image)" : "";
			const imageParts: Part[] = images.map((image) => ({
				inlineData: { mimeType: image.mimeType ?? "", data: image.data ?? "" },
			}));
			const includeId = requiresToolCallId(model.id);
			const functionResponse: Part = {
				functionResponse: {
					name: msg.toolName ?? "",
					response: msg.isError ? { error: responseValue } : { output: responseValue },
					...(hasImages && supportsMultimodalFunctionResponse(model.id) && { parts: imageParts }),
					...(includeId && msg.toolCallId ? { id: normalizeToolCallId(msg.toolCallId) } : {}),
				},
			};

			// Cloud Code Assist requires all function responses of a turn in one user message.
			const last = contents[contents.length - 1];
			if (last?.role === "user" && last.parts.some((part) => part.functionResponse)) {
				last.parts.push(functionResponse);
			} else {
				contents.push({ role: "user", parts: [functionResponse] });
			}

			// Gemini < 3 cannot nest images in a function response; Gemini 3+, Claude and
			// gpt-oss behind Cloud Code Assist accept the nested shape.
			if (hasImages && !supportsMultimodalFunctionResponse(model.id)) {
				contents.push({ role: "user", parts: [{ text: "Tool result image:" }, ...imageParts] });
			}
		}
	}

	return contents;
}

function getDisabledThinkingConfig(modelId: string): { thinkingBudget?: number; thinkingLevel?: string } {
	// Gemini 3.1 Pro cannot disable thinking, and Gemini 3 Flash/Lite do not either;
	// the lowest level without includeThoughts keeps hidden thinking invisible.
	if (isGemini3ProModel(modelId)) return { thinkingLevel: "LOW" };
	if (isGemini3FlashModel(modelId)) return { thinkingLevel: "MINIMAL" };
	return { thinkingBudget: 0 };
}

function getAntigravityThinkingLevel(effort: string, modelId: string): string {
	if (isGemini3ProModel(modelId)) {
		return effort === "minimal" || effort === "low" ? "LOW" : "HIGH";
	}
	switch (effort) {
		case "minimal":
			return "MINIMAL";
		case "low":
			return "LOW";
		case "medium":
			return "MEDIUM";
		default:
			return "HIGH";
	}
}

function getAntigravityHeaders(): Record<string, string> {
	const version = process.env.PI_AI_ANTIGRAVITY_VERSION || DEFAULT_ANTIGRAVITY_VERSION;
	return { "User-Agent": `antigravity/${version} darwin/arm64` };
}

function needsClaudeThinkingBetaHeader(model: AntigravityModel): boolean {
	return model.id.startsWith("claude-") && model.reasoning;
}

/** Request envelope, including the IDE's leading system instruction. */
export function buildRequest(
	model: AntigravityModel,
	context: unknown,
	projectId: string,
	options: AntigravityStreamOptions = {},
): CloudCodeAssistRequest {
	const transcript = (context as { messages: { role: string }[] }).messages;
	const initialSystem = getInitialSystemMessage(transcript);
	const systemText = initialSystem ? getSystemMessageText(initialSystem) : "";
	const tools = getCurrentTools(transcript);

	const generationConfig: CloudCodeAssistRequest["request"]["generationConfig"] = {};
	if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
	if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens;
	if (options.thinking?.enabled && model.reasoning) {
		const thinkingConfig: { includeThoughts?: boolean; thinkingBudget?: number; thinkingLevel?: string } = {
			includeThoughts: true,
		};
		if (options.thinking.level !== undefined) thinkingConfig.thinkingLevel = options.thinking.level;
		else if (options.thinking.budgetTokens !== undefined) thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		generationConfig.thinkingConfig = thinkingConfig;
	} else if (model.reasoning && options.thinking && !options.thinking.enabled) {
		generationConfig.thinkingConfig = getDisabledThinkingConfig(model.id);
	}

	const request: CloudCodeAssistRequest["request"] = { contents: convertMessages(model, context) };
	if (options.sessionId) request.sessionId = options.sessionId;
	const existingParts: { text: string }[] = systemText ? [{ text: sanitizeSurrogates(systemText) }] : [];
	request.systemInstruction = {
		role: "user",
		parts: [
			{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
			{ text: `Please ignore following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]` },
			...existingParts,
		],
	};
	if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;
	const convertedTools = convertTools(tools as never, model.id);
	if (convertedTools) {
		request.tools = convertedTools;
		const mode = mapToolChoice(options.toolChoice);
		if (mode) request.toolConfig = { functionCallingConfig: { mode } };
	}

	return {
		project: projectId,
		model: model.id,
		request,
		requestType: "agent",
		userAgent: "antigravity",
		requestId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
	};
}

function extractRetryDelay(errorText: string, response?: Response): number | undefined {
	const normalize = (ms: number): number | undefined => (ms > 0 ? Math.ceil(ms + 1000) : undefined);
	const headers = response?.headers;
	const headerValue =
		headers?.get("retry-after") ?? headers?.get("x-ratelimit-reset-after") ?? headers?.get("x-ratelimit-reset");
	if (headerValue) {
		const seconds = Number(headerValue);
		if (Number.isFinite(seconds)) return normalize(seconds * 1000);
	}
	const retryDelay = errorText.match(/"retryDelay"\s*:\s*"([\d.]+)s"/u);
	if (retryDelay) return normalize(Number.parseFloat(retryDelay[1]!) * 1000);
	const reset = errorText.match(/reset after\s+(\d+)h(\d+)m(\d+)s/u);
	if (reset) return normalize((Number(reset[1]) * 3600 + Number(reset[2]) * 60 + Number(reset[3])) * 1000);
	const plain = errorText.match(/reset after\s+(\d+)s/u) ?? errorText.match(/retry in\s+([\d.]+)s/u);
	if (plain) return normalize(Number.parseFloat(plain[1]!) * 1000);
	return undefined;
}

function isRetryableError(status: number, errorText: string): boolean {
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
	return /resource.?exhausted|rate.?limit|overloaded|service.?unavailable|other.?side.?closed/iu.test(errorText);
}

function extractErrorMessage(errorText: string): string {
	try {
		const parsed = JSON.parse(errorText) as { error?: { message?: string } };
		if (parsed.error?.message) return parsed.error.message;
	} catch {
		// Not JSON: return as-is.
	}
	return errorText;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timeout);
			reject(new Error("Request was aborted"));
		});
	});
}

function headersToRecord(headers: Headers): Record<string, string> {
	const record: Record<string, string> = {};
	headers.forEach((value, key) => {
		record[key] = value;
	});
	return record;
}

function mergeHeaders(...sources: (Record<string, string | null> | undefined)[]): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const source of sources) {
		for (const [name, value] of Object.entries(source ?? {})) {
			if (value !== null) merged[name] = value;
		}
	}
	return merged;
}

function endpointsFor(model: AntigravityModel): string[] {
	const preferred = model.baseUrl?.trim();
	if (!preferred) return [...ANTIGRAVITY_ENDPOINTS];
	return [preferred, ...ANTIGRAVITY_ENDPOINTS.filter((endpoint) => endpoint !== preferred)];
}

/** Full Cloud Code Assist stream for the Antigravity provider. */
export function streamAntigravity(
	model: AntigravityModel,
	context: unknown,
	options: AntigravityStreamOptions = {},
	fetchImpl: FetchLike = globalThis.fetch,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const fetchFn = options.fetch ?? fetchImpl;
	const maxRetries = options.maxRetries ?? MAX_RETRIES;

	(async () => {
		const output = {
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
			errorMessage: undefined as string | undefined,
			responseId: undefined as string | undefined,
		};

		try {
			const apiKeyRaw = options?.apiKey;
			if (!apiKeyRaw) throw new Error("Google Antigravity requires OAuth authentication. Use /login to authenticate.");
			let accessToken: string;
			let projectId: string;
			try {
				const parsed = JSON.parse(apiKeyRaw) as { token: string; projectId: string };
				accessToken = parsed.token;
				projectId = parsed.projectId;
			} catch {
				throw new Error("Invalid Google Antigravity credentials. Use /login to re-authenticate.");
			}
			if (!accessToken || !projectId) {
				throw new Error("Missing token or project id in Google Antigravity credentials. Use /login to re-authenticate.");
			}

			const endpoints = endpointsFor(model);
			let requestBody = buildRequest(model, context, projectId, options);
			const nextBody = await options?.onPayload?.(requestBody, model);
			if (nextBody !== undefined) requestBody = nextBody as CloudCodeAssistRequest;
			const requestHeaders = mergeHeaders(
				{
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
					Accept: "text/event-stream",
				},
				getAntigravityHeaders(),
				needsClaudeThinkingBetaHeader(model) ? { "anthropic-beta": CLAUDE_THINKING_BETA_HEADER } : undefined,
				options.headers,
			);
			const requestBodyJson = JSON.stringify(requestBody);

			let response: Response | undefined;
			let lastError: Error | undefined;
			let requestUrl: string | undefined;
			let endpointIndex = 0;

			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				if (options?.signal?.aborted) throw new Error("Request was aborted");
				try {
					requestUrl = `${endpoints[endpointIndex]}/v1internal:streamGenerateContent?alt=sse`;
					response = await fetchFn(requestUrl, {
						method: "POST",
						headers: requestHeaders,
						body: requestBodyJson,
						signal: options?.signal,
					});
					await options?.onResponse?.(
						{ status: response.status, headers: headersToRecord(response.headers) },
						model,
					);
					if (response.ok) break;

					const errorText = await response.text();
					if ((response.status === 403 || response.status === 404) && endpointIndex < endpoints.length - 1) {
						endpointIndex++;
						continue;
					}
					if (attempt < maxRetries && isRetryableError(response.status, errorText)) {
						if (endpointIndex < endpoints.length - 1) endpointIndex++;
						const serverDelay = extractRetryDelay(errorText, response);
						const delayMs = serverDelay ?? BASE_DELAY_MS * 2 ** attempt;
						const maxDelayMs = options?.maxRetryDelayMs ?? 60000;
						if (maxDelayMs > 0 && serverDelay && serverDelay > maxDelayMs) {
							throw new Error(
								`Server requested ${Math.ceil(serverDelay / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s). ${extractErrorMessage(errorText)}`,
							);
						}
						await sleep(delayMs, options?.signal);
						continue;
					}
					throw new Error(`Cloud Code Assist API error (${response.status}): ${extractErrorMessage(errorText)}`);
				} catch (error) {
					if (error instanceof Error && (error.name === "AbortError" || error.message === "Request was aborted")) {
						throw new Error("Request was aborted");
					}
					lastError = error instanceof Error ? error : new Error(String(error));
					if (lastError.message === "fetch failed" && lastError.cause instanceof Error) {
						lastError = new Error(`Network error: ${lastError.cause.message}`);
					}
					if (attempt < maxRetries) {
						await sleep(BASE_DELAY_MS * 2 ** attempt, options?.signal);
						continue;
					}
					throw lastError;
				}
			}

			if (!response || !response.ok) throw lastError ?? new Error("Failed to get response after retries");

			let started = false;
			const ensureStarted = () => {
				if (!started) {
					stream.push({ type: "start", partial: output } as never);
					started = true;
				}
			};
			const resetOutput = () => {
				output.content = [];
				output.usage = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
				output.stopReason = "stop";
				output.errorMessage = undefined;
				output.timestamp = Date.now();
				started = false;
			};

			type Block = {
				type: "text" | "thinking";
				text?: string;
				thinking?: string;
				textSignature?: string;
				thinkingSignature?: string;
			};

			const streamResponse = async (activeResponse: Response): Promise<boolean> => {
				if (!activeResponse.body) throw new Error("No response body");
				let hasContent = false;
				let currentBlock: Block | null = null;
				const blocks = output.content as Block[];
				const blockIndex = () => blocks.length - 1;
				const reader = activeResponse.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				const abortHandler = () => {
					void reader.cancel().catch(() => {});
				};
				options?.signal?.addEventListener("abort", abortHandler);

				const endBlock = () => {
					if (!currentBlock) return;
					if (currentBlock.type === "text") {
						stream.push({
							type: "text_end",
							contentIndex: blockIndex(),
							content: currentBlock.text,
							partial: output,
						} as never);
					} else {
						stream.push({
							type: "thinking_end",
							contentIndex: blockIndex(),
							content: currentBlock.thinking,
							partial: output,
						} as never);
					}
				};

				try {
					while (true) {
						if (options?.signal?.aborted) throw new Error("Request was aborted");
						const { done, value } = await reader.read();
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						const lines = buffer.split("\n");
						buffer = lines.pop() || "";

						for (const line of lines) {
							if (!line.startsWith("data:")) continue;
							const jsonText = line.slice(5).trim();
							if (!jsonText) continue;
							let chunk: CloudCodeAssistChunk;
							try {
								chunk = JSON.parse(jsonText) as CloudCodeAssistChunk;
							} catch {
								continue;
							}
							await options?.onProviderStreamEvent?.(chunk, model);
							const data = chunk.response;
							if (!data) continue;
							output.responseId ||= data.responseId;
							const candidate = data.candidates?.[0];

							for (const part of candidate?.content?.parts ?? []) {
								if (part.text !== undefined) {
									hasContent = true;
									const thinking = isThinkingPart(part);
									if (
										!currentBlock ||
										(thinking && currentBlock.type !== "thinking") ||
										(!thinking && currentBlock.type !== "text")
									) {
										endBlock();
										if (thinking) {
											currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
											blocks.push(currentBlock);
											ensureStarted();
											stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output } as never);
										} else {
											currentBlock = { type: "text", text: "" };
											blocks.push(currentBlock);
											ensureStarted();
											stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output } as never);
										}
									}
									if (currentBlock.type === "thinking") {
										currentBlock.thinking = (currentBlock.thinking ?? "") + part.text;
										currentBlock.thinkingSignature = retainThoughtSignature(
											currentBlock.thinkingSignature,
											part.thoughtSignature,
										);
										stream.push({
											type: "thinking_delta",
											contentIndex: blockIndex(),
											delta: part.text,
											partial: output,
										} as never);
									} else {
										currentBlock.text = (currentBlock.text ?? "") + part.text;
										currentBlock.textSignature = retainThoughtSignature(
											currentBlock.textSignature,
											part.thoughtSignature,
										);
										stream.push({
											type: "text_delta",
											contentIndex: blockIndex(),
											delta: part.text,
											partial: output,
										} as never);
									}
								}

								if (part.functionCall) {
									hasContent = true;
									endBlock();
									currentBlock = null;
									const providedId = part.functionCall.id;
									const needsNewId =
										!providedId ||
										(output.content as { type: string; id?: string }[]).some(
											(block) => block.type === "toolCall" && block.id === providedId,
										);
									const toolCallId = needsNewId
										? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
										: providedId;
									const toolCall = {
										type: "toolCall",
										id: toolCallId,
										name: part.functionCall.name || "",
										arguments: (part.functionCall.args as Record<string, unknown>) ?? {},
										...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
									};
									output.content.push(toolCall);
									ensureStarted();
									stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output } as never);
									stream.push({
										type: "toolcall_delta",
										contentIndex: blockIndex(),
										delta: JSON.stringify(toolCall.arguments),
										partial: output,
									} as never);
									stream.push({
										type: "toolcall_end",
										contentIndex: blockIndex(),
										toolCall,
										partial: output,
									} as never);
								}
							}

							if (candidate?.finishReason) {
								output.stopReason = mapStopReasonString(candidate.finishReason);
								if ((output.content as { type: string }[]).some((block) => block.type === "toolCall")) {
									output.stopReason = "toolUse";
								}
							}

							if (data.usageMetadata) {
								// promptTokenCount includes cached tokens, so subtract for fresh input.
								const promptTokens = data.usageMetadata.promptTokenCount || 0;
								const cacheReadTokens = data.usageMetadata.cachedContentTokenCount || 0;
								output.usage = {
									input: promptTokens - cacheReadTokens,
									output:
										(data.usageMetadata.candidatesTokenCount || 0) + (data.usageMetadata.thoughtsTokenCount || 0),
									cacheRead: cacheReadTokens,
									cacheWrite: 0,
									totalTokens: data.usageMetadata.totalTokenCount || 0,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								};
								calculateCost(model as never, output.usage as never);
							}
						}
					}
				} finally {
					options?.signal?.removeEventListener("abort", abortHandler);
				}

				endBlock();
				return hasContent;
			};

			let receivedContent = false;
			let currentResponse = response;
			for (let emptyAttempt = 0; emptyAttempt <= MAX_EMPTY_STREAM_RETRIES; emptyAttempt++) {
				if (options?.signal?.aborted) throw new Error("Request was aborted");
				if (emptyAttempt > 0) {
					await sleep(EMPTY_STREAM_BASE_DELAY_MS * 2 ** (emptyAttempt - 1), options?.signal);
					if (!requestUrl) throw new Error("Missing request URL");
					currentResponse = await fetchFn(requestUrl, {
						method: "POST",
						headers: requestHeaders,
						body: requestBodyJson,
						signal: options?.signal,
					});
					await options?.onResponse?.(
						{ status: currentResponse.status, headers: headersToRecord(currentResponse.headers) },
						model,
					);
					if (!currentResponse.ok) {
						throw new Error(`Cloud Code Assist API error (${currentResponse.status}): ${await currentResponse.text()}`);
					}
				}
				const streamed = await streamResponse(currentResponse);
				if (streamed) {
					receivedContent = true;
					break;
				}
				if (emptyAttempt < MAX_EMPTY_STREAM_RETRIES) resetOutput();
			}

			if (!receivedContent) throw new Error("Cloud Code Assist API returned an empty response");
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			stream.push({ type: "done", reason: output.stopReason, message: output } as never);
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output } as never);
			stream.end();
		}
	})();

	return stream;
}

/** Map Pi's neutral reasoning level onto the Antigravity thinking controls. */
export function streamSimpleAntigravity(
	model: AntigravityModel,
	context: unknown,
	options: AntigravityStreamOptions = {},
	fetchImpl: FetchLike = globalThis.fetch,
): AssistantMessageEventStream {
	// Pi's internal buildBaseOptions (which also clamps output to the remaining
	// context window) is not reachable from extensions, so size the budget from
	// the catalog; the agent loop's overflow handling covers the rest.
	const base = {
		...options,
		maxTokens: Math.min(options.maxTokens ?? model.maxTokens, model.maxTokens),
	};
	if (!options.reasoning || options.reasoning === "off") {
		return streamAntigravity(model, context, { ...base, thinking: { enabled: false } }, fetchImpl);
	}
	const effort = options.reasoning === "xhigh" || options.reasoning === "max" ? "high" : options.reasoning;
	if (isGemini3Model(model.id)) {
		return streamAntigravity(
			model,
			context,
			{ ...base, thinking: { enabled: true, level: getAntigravityThinkingLevel(effort, model.id) } },
			fetchImpl,
		);
	}
	const budgets: Record<string, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16384, ...options.thinkingBudgets };
	let thinkingBudget = budgets[effort] ?? budgets.high!;
	const maxTokens = Math.min((base.maxTokens || 0) + thinkingBudget, model.maxTokens);
	if (maxTokens <= thinkingBudget) thinkingBudget = Math.max(0, maxTokens - 1024);
	return streamAntigravity(
		model,
		context,
		{ ...base, maxTokens, thinking: { enabled: true, budgetTokens: thinkingBudget } },
		fetchImpl,
	);
}
