/**
 * Google Antigravity model catalog (Cloud Code Assist).
 *
 * The static snapshot below was recovered from the upstream Pi provider that
 * was removed in 0.71.0 (earendil-works/pi commit fe66edd94, MIT) and is only a
 * fallback: Google provisions models per account and rotates them, so the live
 * catalog comes from `v1internal:retrieveUserQuota`, which reports every model
 * the signed-in account may bill. Discovery is cached, and any failure keeps the
 * previous list (ultimately the static snapshot). The account's own catalog
 * (`v1internal:fetchAvailableModels`) then supplies display names, modality flags
 * and context limits; it also marks the tab-completion buckets that are not chat
 * models. When that endpoint is unavailable, quota ids get inferred metadata.
 *
 * The `api` label is the Google wire format for message/tool conversion.
 * Cloud Code Assist itself is not a Pi API implementation, so the provider
 * supplies its own stream.
 */

import type { FetchLike } from "./oauth";

export interface AntigravityModel {
	id: string;
	name: string;
	provider: "google-antigravity";
	api: "google-generative-ai";
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

export const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";

/** Fallback order when an endpoint answers 403/404, as Antigravity itself does. */
export const ANTIGRAVITY_ENDPOINTS = [
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://autopush-cloudcode-pa.sandbox.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
];

export const DEFAULT_ANTIGRAVITY_VERSION = "1.107.0";

/** The IDE identifies itself with this User-Agent; the endpoint gates models by client. */
export function antigravityUserAgent(): string {
	const version = process.env.PI_AI_ANTIGRAVITY_VERSION || DEFAULT_ANTIGRAVITY_VERSION;
	return `antigravity/${version} darwin/arm64`;
}

/** The IDE's client identity; the endpoint keys tiers and projects off it. */
export const ANTIGRAVITY_CLIENT_METADATA = {
	ideType: "ANTIGRAVITY",
	platform: "DARWIN_ARM64",
	pluginType: "CLOUD_CODE",
	ideName: "antigravity",
} as const;

const ANTHROPIC_COST = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const SONNET_COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const PRO_COST = { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.375 };
const FLASH_COST = { input: 0.5, output: 3, cacheRead: 0.5, cacheWrite: 0 };
const FLASH_LITE_COST = { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0 };
const GPT_OSS_COST = { input: 0.09, output: 0.36, cacheRead: 0, cacheWrite: 0 };

const CLAUDE_LIMITS = { contextWindow: 200000, maxTokens: 64000 };
const GEMINI_LIMITS = { contextWindow: 1048576, maxTokens: 65535 };
const GPT_LIMITS = { contextWindow: 131072, maxTokens: 32768 };

function model(entry: Omit<AntigravityModel, "provider" | "api" | "baseUrl">): AntigravityModel {
	return {
		...entry,
		provider: "google-antigravity",
		api: "google-generative-ai",
		baseUrl: ANTIGRAVITY_ENDPOINT,
	};
}

/** Fallback catalog used before the first discovery and whenever discovery fails. */
export const STATIC_ANTIGRAVITY_MODELS: AntigravityModel[] = [
	model({
		id: "claude-opus-4-5-thinking",
		name: "Claude Opus 4.5 Thinking (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: ANTHROPIC_COST,
		...CLAUDE_LIMITS,
	}),
	model({
		id: "claude-opus-4-6-thinking",
		name: "Claude Opus 4.6 Thinking (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: ANTHROPIC_COST,
		...CLAUDE_LIMITS,
		maxTokens: 128000,
	}),
	model({
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5 (Antigravity)",
		reasoning: false,
		input: ["text", "image"],
		cost: SONNET_COST,
		...CLAUDE_LIMITS,
	}),
	model({
		id: "claude-sonnet-4-5-thinking",
		name: "Claude Sonnet 4.5 Thinking (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: SONNET_COST,
		...CLAUDE_LIMITS,
	}),
	model({
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6 (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: SONNET_COST,
		...CLAUDE_LIMITS,
	}),
	model({
		id: "gemini-3-flash",
		name: "Gemini 3 Flash (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: FLASH_COST,
		...GEMINI_LIMITS,
	}),
	model({
		id: "gemini-3.1-pro-high",
		name: "Gemini 3.1 Pro High (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: PRO_COST,
		...GEMINI_LIMITS,
	}),
	model({
		id: "gemini-3.1-pro-low",
		name: "Gemini 3.1 Pro Low (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: PRO_COST,
		...GEMINI_LIMITS,
	}),
	model({
		id: "gpt-oss-120b-medium",
		name: "GPT-OSS 120B Medium (Antigravity)",
		reasoning: false,
		input: ["text"],
		cost: GPT_OSS_COST,
		...GPT_LIMITS,
	}),
];

/** Display tokens for ids the quota endpoint reports but the snapshot does not describe. */
const NAME_TOKENS: Record<string, string> = {
	claude: "Claude",
	gemini: "Gemini",
	gpt: "GPT",
	oss: "OSS",
	opus: "Opus",
	sonnet: "Sonnet",
	flash: "Flash",
	lite: "Lite",
	pro: "Pro",
	neon: "Neon",
	carbon: "Carbon",
	hydrogen: "Hydrogen",
	argon: "Argon",
	sonar: "Sonar",
	tiered: "Tiered",
	image: "Image",
	thinking: "Thinking",
	preview: "Preview",
	high: "High",
	low: "Low",
	medium: "Medium",
	xhigh: "XHigh",
	max: "Max",
	"120b": "120B",
	"20b": "20B",
};

function displayName(id: string): string {
	const parts: string[] = [];
	const tokens = id.split("-");
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		const next = tokens[index + 1];
		// Version pairs such as "5-5" read as 5.5; "2.5" and "3.1" are already dotted.
		if (/^\d+$/u.test(token) && next !== undefined && /^\d+$/u.test(next)) {
			parts.push(`${token}.${next}`);
			index += 1;
			continue;
		}
		parts.push(NAME_TOKENS[token] ?? token.charAt(0).toUpperCase() + token.slice(1));
	}
	return `${parts.join(" ")} (Antigravity)`;
}

function costFor(id: string): AntigravityModel["cost"] {
	if (id.startsWith("claude-opus")) return ANTHROPIC_COST;
	if (id.startsWith("claude")) return SONNET_COST;
	if (id.startsWith("gpt-oss")) return GPT_OSS_COST;
	if (id.includes("lite")) return FLASH_LITE_COST;
	if (/pro|neon|carbon|hydrogen|argon|sonar/u.test(id)) return PRO_COST;
	return FLASH_COST;
}

function limitsFor(id: string): { contextWindow: number; maxTokens: number } {
	if (id.startsWith("gpt-oss")) return GPT_LIMITS;
	if (id.startsWith("claude")) return CLAUDE_LIMITS;
	return GEMINI_LIMITS;
}

/** Build a model entry for any id the account reports, so new releases need no code change. */
export function modelForId(id: string): AntigravityModel {
	const existing = STATIC_ANTIGRAVITY_MODELS.find((entry) => entry.id === id);
	if (existing) return existing;
	return model({
		id,
		name: displayName(id),
		reasoning: !id.startsWith("gpt-oss"),
		input: id.startsWith("gpt-oss") ? ["text"] : ["text", "image"],
		cost: costFor(id),
		...limitsFor(id),
	});
}

/** Metadata `fetchAvailableModels` reports for a model the account may use. */
interface CatalogEntry {
	displayName?: unknown;
	supportsImages?: unknown;
	supportsThinking?: unknown;
	maxTokens?: unknown;
	maxOutputTokens?: unknown;
}

interface CatalogPayload {
	models?: Record<string, CatalogEntry>;
}

/** Buckets of the quota response; only `modelId` matters for the catalog. */
interface QuotaPayload {
	buckets?: { modelId?: unknown }[];
}

/**
 * Chat models the account may bill. `tab_*` and `chat_*` buckets are the IDE's
 * tab-completion models, not chat models, so they are excluded.
 */
export function parseProvisionedModelIds(payload: unknown): string[] {
	const buckets = (payload as QuotaPayload | undefined)?.buckets;
	if (!Array.isArray(buckets)) return [];
	const ids: string[] = [];
	for (const bucket of buckets) {
		const id = bucket?.modelId;
		if (typeof id !== "string") continue;
		const trimmed = id.trim();
		if (!trimmed || trimmed.startsWith("tab_") || trimmed.startsWith("chat_") || ids.includes(trimmed)) continue;
		ids.push(trimmed);
	}
	return ids;
}

const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Prefer the endpoint's own name and limits; ids it omits or leaves unnamed fall
 * back to inference. The endpoint is authoritative, so its flags win.
 */
function modelFromCatalog(id: string, entry: CatalogEntry | undefined): AntigravityModel {
	const base = modelForId(id);
	const named = typeof entry?.displayName === "string" && entry.displayName.length > 0;
	return {
		...base,
		name: named ? `${entry.displayName} (Antigravity)` : base.name,
		reasoning: typeof entry?.supportsThinking === "boolean" ? entry.supportsThinking : base.reasoning,
		input: typeof entry?.supportsImages === "boolean" ? (entry.supportsImages ? ["text", "image"] : ["text"]) : base.input,
		contextWindow: positiveNumber(entry?.maxTokens, base.contextWindow),
		maxTokens: positiveNumber(entry?.maxOutputTokens, base.maxTokens),
	};
}

/**
 * The IDE's own catalog: display names, modality flags and limits per model, plus
 * the tab/chat ids that are not chat models. Best effort — an unavailable endpoint
 * leaves discovery on quota ids with inferred metadata.
 */
async function fetchAntigravityModelCatalog(
	endpoint: string,
	headers: Record<string, string>,
	projectId: string,
	fetchImpl: FetchLike,
	signal?: AbortSignal,
): Promise<Record<string, CatalogEntry> | undefined> {
	try {
		const response = await fetchImpl(`${endpoint}/v1internal:fetchAvailableModels`, {
			method: "POST",
			headers,
			body: JSON.stringify({ project: projectId }),
			signal,
		});
		if (!response.ok) return undefined;
		const payload = (await response.json()) as CatalogPayload;
		const models = payload?.models;
		return models && typeof models === "object" ? models : undefined;
	} catch {
		return undefined;
	}
}

interface ModelCacheEntry {
	projectId: string;
	models: AntigravityModel[];
	fetchedAt: number;
}

let cacheEntry: ModelCacheEntry | undefined;

/** Drop the in-memory catalog; tests use this to isolate cases. */
export function resetAntigravityModelCache(): void {
	cacheEntry = undefined;
}

/** Synchronous catalog: the last discovery, or the static snapshot before the first one. */
export function currentAntigravityModels(): AntigravityModel[] {
	return cacheEntry ? cacheEntry.models : STATIC_ANTIGRAVITY_MODELS;
}

export function setAntigravityModels(projectId: string, models: AntigravityModel[], fetchedAt = Date.now()): void {
	cacheEntry = { projectId, models, fetchedAt };
}

/** Fresh cache for this project, or undefined when absent or stale. */
export function cachedAntigravityModels(projectId: string, now = Date.now()): AntigravityModel[] | undefined {
	if (!cacheEntry || cacheEntry.projectId !== projectId) return undefined;
	if (now - cacheEntry.fetchedAt >= MODEL_CACHE_TTL_MS) return undefined;
	return cacheEntry.models;
}

export interface DiscoverAntigravityModelsOptions {
	accessToken: string;
	projectId: string;
	fetchImpl?: FetchLike;
	signal?: AbortSignal;
	/** Skip the TTL check and fetch now. */
	force?: boolean;
	/** Injectable clock for tests. */
	now?: number;
}

/**
 * Live catalog from `v1internal:retrieveUserQuota`. Returns undefined when every
 * endpoint fails or reports no chat models; callers keep the previous catalog.
 */
export async function discoverAntigravityModels(
	options: DiscoverAntigravityModelsOptions,
): Promise<AntigravityModel[] | undefined> {
	const now = options.now ?? Date.now();
	if (!options.force) {
		const cached = cachedAntigravityModels(options.projectId, now);
		if (cached) return cached;
	}
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const headers = {
		Authorization: `Bearer ${options.accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": antigravityUserAgent(),
		"Client-Metadata": JSON.stringify(ANTIGRAVITY_CLIENT_METADATA),
	};
	const body = JSON.stringify({ project: options.projectId });
	for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
		options.signal?.throwIfAborted();
		let response: Response;
		try {
			response = await fetchImpl(`${endpoint}/v1internal:retrieveUserQuota`, {
				method: "POST",
				headers,
				body,
				signal: options.signal,
			});
		} catch {
			continue;
		}
		if (!response.ok) continue;
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			continue;
		}
		const ids = parseProvisionedModelIds(payload);
		if (ids.length === 0) continue;
		const catalog = await fetchAntigravityModelCatalog(endpoint, headers, options.projectId, fetchImpl, options.signal);
		// The quota ids are the entitlement; the catalog only names and measures them.
		const models = ids.map((id) => modelFromCatalog(id, catalog?.[id]));
		setAntigravityModels(options.projectId, models, now);
		return models;
	}
	return undefined;
}
