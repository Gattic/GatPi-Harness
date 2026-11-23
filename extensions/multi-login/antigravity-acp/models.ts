/**
 * Model catalog for the Antigravity ACP provider.
 *
 * Antigravity advertises effort-qualified ACP model IDs (for example
 * `gemini-4-neon-high`) while the ACP session exposes the base model and a
 * separate thought-level selector. The fallback catalog projects one Pi model
 * per base and keeps the exact ACP IDs in `thinkingLevelMap`, so Pi's thinking
 * control selects the corresponding server variant.
 */

export interface AcpModelInfo {
	modelId: string;
	name: string;
}

export type ThinkingLevel = "low" | "medium" | "high" | "xhigh";

export interface AcpCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface AntigravityAcpModel {
	id: string;
	name: string;
	provider: "google-antigravity-acp";
	api: "antigravity-acp";
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: AcpCost;
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string>>;
}

export const ANTIGRAVITY_ACP_PROVIDER_ID = "google-antigravity-acp";
export const ANTIGRAVITY_ACP_API = "antigravity-acp";
export const ANTIGRAVITY_ACP_BASE_URL = "acp://antigravity";

const ZERO_COST: AcpCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const NEON_RATES: AcpCost = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 };
const CARBON_RATES: AcpCost = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 };
const ARGON_RATES: AcpCost = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 };
const HYDROGEN_RATES: AcpCost = { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 };
const FLASH_RATES: AcpCost = { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 };
const PRO_RATES: AcpCost = { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 };
const GEMINI_LIMITS = { contextWindow: 1048576, maxTokens: 65535 };

export function splitEffortSuffix(
	modelId: string,
): { base: string; effort: ThinkingLevel } | undefined {
	const match = /^(.*)-(low|medium|high|xhigh)$/u.exec(modelId);
	if (!match?.[1]) return undefined;
	return { base: match[1], effort: match[2] as ThinkingLevel };
}

export function effortFromId(modelId: string): ThinkingLevel | undefined {
	return splitEffortSuffix(modelId)?.effort;
}

function effortFromName(name: string): ThinkingLevel | undefined {
	const parenthesized = /\((?<effort>low|medium|high|xhigh)\)/iu.exec(name);
	if (parenthesized?.groups?.effort) return parenthesized.groups.effort.toLowerCase() as ThinkingLevel;
	const word = /\b(?<effort>low|medium|high|xhigh)\b/iu.exec(name);
	return word?.groups?.effort?.toLowerCase() as ThinkingLevel | undefined;
}

export function validModelId(id: string): boolean {
	return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(id);
}

export function costRatesFor(modelId: string): AcpCost {
	const base = splitEffortSuffix(modelId)?.base ?? modelId;
	if (/^gemini-4-neon$/u.test(base)) return NEON_RATES;
	if (/^gemini-4-carbon$/u.test(base)) return CARBON_RATES;
	if (/^gemini-4-argon$/u.test(base)) return ARGON_RATES;
	if (/^gemini-4-hydrogen$/u.test(base)) return HYDROGEN_RATES;
	if (/^gemini-(?:3\.[678]|4)-flash$/u.test(base)) return FLASH_RATES;
	if (/^(?:gemini-3\.1-pro|gemini-pro-agent)$/u.test(base)) return PRO_RATES;
	return ZERO_COST;
}

function model(
	id: string,
	name: string,
	options: {
		reasoning: boolean;
		thinkingLevelMap?: Partial<Record<ThinkingLevel, string>>;
		cost?: AcpCost;
		contextWindow?: number;
		maxTokens?: number;
	} = { reasoning: false },
): AntigravityAcpModel {
	return {
		id,
		name,
		provider: ANTIGRAVITY_ACP_PROVIDER_ID,
		api: ANTIGRAVITY_ACP_API,
		baseUrl: ANTIGRAVITY_ACP_BASE_URL,
		reasoning: options.reasoning,
		input: ["text", "image"],
		cost: options.cost ?? costRatesFor(id),
		contextWindow: options.contextWindow ?? GEMINI_LIMITS.contextWindow,
		maxTokens: options.maxTokens ?? GEMINI_LIMITS.maxTokens,
		...(options.thinkingLevelMap ? { thinkingLevelMap: options.thinkingLevelMap } : {}),
	};
}

function reasoningModel(
	baseId: string,
	name: string,
	variants: Partial<Record<ThinkingLevel, string>>,
): AntigravityAcpModel {
	return model(baseId, name, { reasoning: true, thinkingLevelMap: variants });
}

function fixedModel(id: string, name: string): AntigravityAcpModel {
	return model(id, name, { reasoning: false });
}

/** Offline catalog, ordered with the Gemini 4 family first. */
export const FALLBACK_MODELS: AntigravityAcpModel[] = [
	reasoningModel("gemini-4-neon", "Gemini 4 Neon", {
		low: "gemini-4-neon-low",
		medium: "gemini-4-neon-medium",
		high: "gemini-4-neon-high",
	}),
	reasoningModel("gemini-4-carbon", "Gemini 4 Carbon", {
		low: "gemini-4-carbon-low",
		medium: "gemini-4-carbon-medium",
		high: "gemini-4-carbon-high",
	}),
	reasoningModel("gemini-4-hydrogen", "Gemini 4 Hydrogen", {
		low: "gemini-4-hydrogen-low",
		medium: "gemini-4-hydrogen-medium",
		high: "gemini-4-hydrogen-high",
		xhigh: "gemini-4-hydrogen-xhigh",
	}),
	reasoningModel("gemini-4-argon", "Gemini 4 Argon", {
		low: "gemini-4-argon-low",
		medium: "gemini-4-argon-medium",
		high: "gemini-4-argon-high",
	}),
	reasoningModel("gemini-3.8-flash", "Gemini 3.8 Flash", {
		low: "gemini-3.8-flash-low",
		medium: "gemini-3.8-flash-medium",
		high: "gemini-3.8-flash-high",
	}),
	reasoningModel("gemini-3.7-flash", "Gemini 3.7 Flash", {
		low: "gemini-3.7-flash-low",
		medium: "gemini-3.7-flash-medium",
		high: "gemini-3.7-flash-high",
	}),
	reasoningModel("gemini-3.6-flash", "Gemini 3.6 Flash", {
		low: "gemini-3.6-flash-low",
		medium: "gemini-3.6-flash-medium",
		high: "gemini-3.6-flash-high",
	}),
	reasoningModel("gemini-3.1-pro", "Gemini 3.1 Pro", {
		low: "gemini-3.1-pro-low",
		high: "gemini-pro-agent",
	}),
];

/** Group advertised effort variants into one Pi model per base. */
export function projectModels(models: readonly AcpModelInfo[]): AntigravityAcpModel[] {
	const safe = models.filter((candidate) => validModelId(candidate.modelId.trim()));
	const groups = new Map<
		string,
		{ name: string; variants: Partial<Record<ThinkingLevel, string>>; members: AcpModelInfo[] }
	>();
	for (const candidate of safe) {
		const id = candidate.modelId.trim();
		const effort = effortFromName(candidate.name) ?? effortFromId(id);
		if (!id.startsWith("gemini-") || !effort) continue;
		const base = splitEffortSuffix(id)?.base ?? id;
		const key = base.toLowerCase();
		const group = groups.get(key) ?? {
			name: candidate.name.trim() || base,
			variants: {},
			members: [],
		};
		group.variants[effort] = id;
		group.members.push(candidate);
		groups.set(key, group);
	}
	const emittedGroups = new Set<string>();
	const emittedIds = new Set<string>();
	const projected: AntigravityAcpModel[] = [];
	for (const candidate of safe) {
		const id = candidate.modelId.trim();
		if (emittedIds.has(id)) continue;
		const effort = effortFromName(candidate.name) ?? effortFromId(id);
		const base = splitEffortSuffix(id)?.base ?? id;
		const key = base.toLowerCase();
		const group = groups.get(key);
		if (group && Object.keys(group.variants).length >= 2) {
			if (emittedGroups.has(key)) continue;
			emittedGroups.add(key);
			for (const member of group.members) emittedIds.add(member.modelId.trim());
			const variants = group.variants;
			const name = group.name.replace(/\s*\([^)]*\)\s*$/u, "").trim() || base;
			projected.push(reasoningModel(base, name, variants));
			continue;
		}
		emittedIds.add(id);
		if (id.startsWith("gemini-") && effort) {
			projected.push(reasoningModel(base, candidate.name.trim() || id, { [effort]: id }));
		} else {
			projected.push(fixedModel(id, candidate.name.trim() || id));
		}
	}
	return projected;
}

/** Rebuild a persisted catalog from the current rates and limits. */
export function restoreModels(stored: readonly unknown[]): AntigravityAcpModel[] {
	const restored: AntigravityAcpModel[] = [];
	const ids = new Set<string>();
	for (const entry of stored) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as Partial<AntigravityAcpModel>;
		if (candidate.provider !== ANTIGRAVITY_ACP_PROVIDER_ID || candidate.api !== ANTIGRAVITY_ACP_API) {
			continue;
		}
		const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
		if (!validModelId(id) || ids.has(id)) continue;
		const name = typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : id;
		if (candidate.reasoning === true) {
			const variants: Partial<Record<ThinkingLevel, string>> = {};
			for (const effort of ["low", "medium", "high", "xhigh"] as const) {
				const value = candidate.thinkingLevelMap?.[effort];
				if (typeof value === "string" && validModelId(value)) variants[effort] = value;
			}
			if (Object.keys(variants).length === 0) continue;
			restored.push(reasoningModel(id, name, variants));
		} else if (candidate.reasoning === false) {
			restored.push(fixedModel(id, name));
		} else {
			continue;
		}
		ids.add(id);
	}
	return restored;
}

export function thinkingLevel(options?: {
	thinking?: { enabled?: boolean; level?: string };
	reasoning?: string;
}): ThinkingLevel {
	const level = options?.thinking?.level ?? options?.reasoning;
	if (level === "low" || level === "medium" || level === "high" || level === "xhigh") {
		return level;
	}
	return "medium";
}

/** The exact ACP model ID for the selected Pi thinking level. */
export function acpModelId(model: AntigravityAcpModel, level: ThinkingLevel): string {
	return model.thinkingLevelMap?.[level] ?? model.id;
}
