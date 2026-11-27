/**
 * Pi's configured MCP servers, translated into the `mcpServers` entries of an
 * ACP `session/new` request.
 *
 * Pi connects its own MCP servers as a client, and the ACP server cannot reuse
 * those connections, so the configuration is handed over instead and the server
 * connects the servers inside its own runtime. Two consequences follow from
 * that, and both are deliberate:
 *
 * - The forwarded servers' tools belong to the ACP agent. Pi's tool hooks and
 *   policy gate never see those calls; only the server's own policy applies.
 * - A server Pi cannot hand over faithfully is skipped and reported, never
 *   silently dropped: a stdio entry with its own `cwd` (ACP stdio has no such
 *   field), an entry whose env or header value is a shell command (`!cmd`), an
 *   entry that relies on Pi's OAuth login (the server has no access to that
 *   credential), and an entry whose env or header names a variable that is not
 *   set.
 *
 * Configuration is read the way Pi reads it: `mcp.json` in the agent directory,
 * then `<project>/.pi/mcp.json` when the project is trusted. A project entry
 * replaces a global entry of the same name, and an override-only project entry
 * (just `enabled`, `exposure`, `toolExposure`) changes the global entry instead
 * of defining a new server.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AcpHttpHeader, AcpMcpServer, AcpEnvVariable } from "./acp";

const SERVER_NAME = /^[A-Za-z0-9_-]+$/u;
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const ENV_VAR_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/u;
/** The only keys a project override may set, as in Pi's own loader. */
const OVERRIDE_KEYS = new Set(["enabled", "exposure", "toolExposure"]);

export interface AcpMcpServersOptions {
	/** Pi's agent directory, holding the global `mcp.json`. */
	agentDir: string;
	/** Session working directory, whose `.pi/mcp.json` applies when trusted. */
	cwd: string;
	projectTrusted: boolean;
}

export interface AcpMcpServersResult {
	servers: AcpMcpServer[];
	/** Servers Pi knows but could not hand to the ACP server, with the reason. */
	skipped: Array<{ name: string; reason: string }>;
	/** Configuration problems, reported like Pi reports them. */
	errors: string[];
}

type RawEntry = Record<string, unknown>;

interface LoadedEntry {
	name: string;
	config: RawEntry;
	source: string;
}

/** A config value Pi resolves before use: a literal, an env template or a shell command. */
type ConfigValue = { value: string } | { missing: string } | { command: string };

function isRecord(value: unknown): value is RawEntry {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandHome(value: string): string {
	return value === "~" || value.startsWith("~/") ? join(homedir(), value.slice(1)) : value;
}

/**
 * Resolve one config value the way Pi does: `${NAME}` and `$NAME` read the
 * environment, `$$` and `$!` are literals, and a leading `!` is a shell command
 * Pi would run itself. A missing variable is reported rather than sent as an
 * unresolved template.
 */
function resolveConfigValue(raw: string, env: Record<string, string | undefined>): ConfigValue {
	if (raw.startsWith("!")) return { command: raw.slice(1) };
	let resolved = "";
	let index = 0;
	while (index < raw.length) {
		const dollar = raw.indexOf("$", index);
		if (dollar < 0) {
			resolved += raw.slice(index);
			break;
		}
		resolved += raw.slice(index, dollar);
		const next = raw[dollar + 1];
		if (next === "$" || next === "!") {
			resolved += next;
			index = dollar + 2;
			continue;
		}
		if (next === "{") {
			const end = raw.indexOf("}", dollar + 2);
			const name = end < 0 ? "" : raw.slice(dollar + 2, end);
			if (ENV_VAR_NAME.test(name)) {
				const value = env[name];
				if (value === undefined) return { missing: name };
				resolved += value;
				index = end + 1;
				continue;
			}
			resolved += raw.slice(dollar, end < 0 ? dollar + 1 : end + 1);
			index = end < 0 ? dollar + 1 : end + 1;
			continue;
		}
		const match = raw.slice(dollar + 1).match(ENV_VAR_PREFIX);
		if (match) {
			const value = env[match[0]];
			if (value === undefined) return { missing: match[0] };
			resolved += value;
			index = dollar + 1 + match[0].length;
			continue;
		}
		resolved += "$";
		index = dollar + 1;
	}
	return { value: resolved };
}

/**
 * Resolve every value of a string map, or name the one that cannot be resolved.
 * A shell command is never run here: the ACP server would have to run it, and
 * Pi does not hand its own shell execution to another runtime.
 */
function resolveValues(
	values: RawEntry,
	env: Record<string, string | undefined>,
	label: string,
): { values: Record<string, string> } | { reason: string } {
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) {
		if (typeof value !== "string") return { reason: `${label} "${key}" is not a string` };
		const configValue = resolveConfigValue(value, env);
		if ("command" in configValue) {
			return { reason: `${label} "${key}" is a shell command (${configValue.command}), which only Pi can run` };
		}
		if ("missing" in configValue) {
			return { reason: `${label} "${key}" names the unset variable ${configValue.missing}` };
		}
		resolved[key] = configValue.value;
	}
	return { values: resolved };
}

function stringList(value: unknown): string[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
	return value as string[];
}

function isOverride(value: RawEntry): boolean {
	return (
		value.command === undefined &&
		value.url === undefined &&
		value.type === undefined &&
		Object.keys(value).every((key) => OVERRIDE_KEYS.has(key))
	);
}

function readConfigFile(
	path: string,
	scope: "global" | "project",
	servers: Map<string, LoadedEntry>,
	errors: string[],
): void {
	if (!existsSync(path)) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/u, ""));
	} catch (error) {
		errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		errors.push(`${path}: expected an object with an "mcpServers" object`);
		return;
	}
	for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
		if (!isRecord(value)) {
			errors.push(`${path}: server "${name}" must be an object`);
			continue;
		}
		if (scope === "project" && isOverride(value)) {
			const base = servers.get(name);
			const extra = Object.keys(value).filter((key) => !OVERRIDE_KEYS.has(key));
			if (!base) {
				errors.push(`${path}: server "${name}" needs "command" or "url", or a global server to override`);
			} else if (extra.length > 0) {
				errors.push(`${path}: server "${name}": an override can only set ${[...OVERRIDE_KEYS].join(", ")}`);
			} else {
				servers.set(name, { ...base, config: { ...base.config, ...value } });
			}
			continue;
		}
		servers.set(name, { name, config: value, source: path });
	}
}

/** Translate one Pi entry into an ACP `McpServer`, or say why it cannot be handed over. */
function toAcpServer(
	entry: LoadedEntry,
	env: Record<string, string | undefined>,
): { server: AcpMcpServer } | { reason: string } {
	const { name, config } = entry;
	if (!SERVER_NAME.test(name)) {
		return { reason: `invalid server name "${name}" (use letters, digits, "_" and "-")` };
	}
	if (config.enabled === false) return { reason: "disabled in mcp.json" };

	if (config.command !== undefined) {
		if (typeof config.command !== "string" || !config.command.trim()) {
			return { reason: "\"command\" must be a non-empty string" };
		}
		const args = stringList(config.args);
		if (!args) return { reason: "\"args\" must be a list of strings" };
		if (config.cwd !== undefined) {
			return { reason: "stdio servers with their own \"cwd\" cannot be forwarded: ACP has no cwd field" };
		}
		if (config.env !== undefined && !isRecord(config.env)) return { reason: "\"env\" must be an object" };
		const envValues = resolveValues((config.env as RawEntry) ?? {}, env, "env");
		if ("reason" in envValues) return envValues;
		const variables: AcpEnvVariable[] = Object.entries(envValues.values).map(([key, value]) => ({
			name: key,
			value,
		}));
		return {
			server: {
				name,
				command: expandHome(config.command),
				args: args.map(expandHome),
				env: variables,
			},
		};
	}

	if (config.url !== undefined) {
		if (typeof config.url !== "string" || !config.url.trim()) {
			return { reason: "\"url\" must be a non-empty string" };
		}
		if (config.oauth !== undefined) {
			return { reason: "relies on Pi's OAuth login, which the ACP server cannot reuse" };
		}
		if (config.headers !== undefined && !isRecord(config.headers)) {
			return { reason: "\"headers\" must be an object" };
		}
		const headerValues = resolveValues((config.headers as RawEntry) ?? {}, env, "header");
		if ("reason" in headerValues) return headerValues;
		const headers: AcpHttpHeader[] = Object.entries(headerValues.values).map(([key, value]) => ({
			name: key,
			value,
		}));
		return { server: { type: "http", name, url: config.url, headers } };
	}

	return { reason: "needs \"command\" (stdio) or \"url\" (HTTP)" };
}

/**
 * Load Pi's MCP servers as ACP `mcpServers` entries. Order follows the config
 * files: global entries first, then project entries, with replacements keeping
 * the replaced entry's position as in Pi.
 */
export function loadAcpMcpServers(options: AcpMcpServersOptions): AcpMcpServersResult {
	const servers = new Map<string, LoadedEntry>();
	const errors: string[] = [];
	readConfigFile(join(options.agentDir, "mcp.json"), "global", servers, errors);
	if (options.projectTrusted) {
		readConfigFile(join(options.cwd, ".pi", "mcp.json"), "project", servers, errors);
	}

	const env = process.env;
	const result: AcpMcpServersResult = { servers: [], skipped: [], errors };
	for (const entry of servers.values()) {
		const translated = toAcpServer(entry, env);
		if ("reason" in translated) result.skipped.push({ name: entry.name, reason: translated.reason });
		else result.servers.push(translated.server);
	}
	return result;
}
