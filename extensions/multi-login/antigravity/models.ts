/**
 * Google Antigravity model catalog (Cloud Code Assist).
 *
 * Recovered from the upstream Pi provider that was removed in 0.71.0
 * (earendil-works/pi commit fe66edd94, MIT). Prices and limits mirror the
 * Cloud Code Assist models Antigravity exposes; the account's plan, not this
 * catalog, decides what is actually billable.
 *
 * The `api` label is the Google wire format for message/tool conversion.
 * Cloud Code Assist itself is not a Pi API implementation, so the provider
 * supplies its own stream.
 */

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

const ANTHROPIC_COST = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const SONNET_COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const PRO_COST = { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.375 };

function model(entry: Omit<AntigravityModel, "provider" | "api" | "baseUrl">): AntigravityModel {
	return {
		...entry,
		provider: "google-antigravity",
		api: "google-generative-ai",
		baseUrl: ANTIGRAVITY_ENDPOINT,
	};
}

export const ANTIGRAVITY_MODELS: AntigravityModel[] = [
	model({
		id: "claude-opus-4-5-thinking",
		name: "Claude Opus 4.5 Thinking (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: ANTHROPIC_COST,
		contextWindow: 200000,
		maxTokens: 64000,
	}),
	model({
		id: "claude-opus-4-6-thinking",
		name: "Claude Opus 4.6 Thinking (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: ANTHROPIC_COST,
		contextWindow: 200000,
		maxTokens: 128000,
	}),
	model({
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5 (Antigravity)",
		reasoning: false,
		input: ["text", "image"],
		cost: SONNET_COST,
		contextWindow: 200000,
		maxTokens: 64000,
	}),
	model({
		id: "claude-sonnet-4-5-thinking",
		name: "Claude Sonnet 4.5 Thinking (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: SONNET_COST,
		contextWindow: 200000,
		maxTokens: 64000,
	}),
	model({
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6 (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: SONNET_COST,
		contextWindow: 200000,
		maxTokens: 64000,
	}),
	model({
		id: "gemini-3-flash",
		name: "Gemini 3 Flash (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.5, output: 3, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65535,
	}),
	model({
		id: "gemini-3.1-pro-high",
		name: "Gemini 3.1 Pro High (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: PRO_COST,
		contextWindow: 1048576,
		maxTokens: 65535,
	}),
	model({
		id: "gemini-3.1-pro-low",
		name: "Gemini 3.1 Pro Low (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: PRO_COST,
		contextWindow: 1048576,
		maxTokens: 65535,
	}),
	model({
		id: "gpt-oss-120b-medium",
		name: "GPT-OSS 120B Medium (Antigravity)",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.09, output: 0.36, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 32768,
	}),
];
