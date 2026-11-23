/**
 * Local credential inspection for the Antigravity ACP server.
 *
 * The ACP server owns its OAuth token and stores it at
 * `~/.gemini/antigravity-acp/acp_token.json` (or under `GEMINI_HOME`). The
 * provider never copies the token into Pi's auth store; it stores only a
 * non-secret marker and asks the server to refresh the token itself.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MANAGED_AUTH_MARKER = "antigravity-acp-managed";

export type AcpAuthStatus =
	| "missing"
	| "oauth-refreshable"
	| "configured-not-authenticated"
	| "corrupt";

export interface AcpAuthHealth {
	status: AcpAuthStatus;
	authType?: string;
	tokenFile: boolean;
	settingsFile: boolean;
	directory: string;
	tokenPath: string;
	settingsPath: string;
}

function expandHome(file: string, home: string): string {
	return file === "~" || file.startsWith("~/") ? path.join(home, file.slice(1)) : file;
}

/** The server relocates its whole tree under GEMINI_HOME when that is set. */
export function resolveAcpDirectory(env: NodeJS.ProcessEnv = process.env): string {
	const home = env.HOME?.trim() || os.homedir();
	const geminiHome = env.GEMINI_HOME?.trim();
	const base = geminiHome ? expandHome(geminiHome, home) : path.join(home, ".gemini");
	return path.join(base, "antigravity-acp");
}

function regularFile(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

export function inspectAuth(env: NodeJS.ProcessEnv = process.env): AcpAuthHealth {
	const directory = resolveAcpDirectory(env);
	const tokenPath = path.join(directory, "acp_token.json");
	const settingsPath = path.join(directory, "settings.json");
	const tokenFile = regularFile(tokenPath);
	const settingsFile = regularFile(settingsPath);
	let authType: string | undefined;
	if (settingsFile) {
		try {
			const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
				auth?: { type?: unknown };
			};
			if (typeof settings.auth?.type === "string") authType = settings.auth.type;
		} catch {
			return { status: "corrupt", tokenFile, settingsFile, directory, tokenPath, settingsPath };
		}
	}
	if (tokenFile) {
		try {
			const token = JSON.parse(fs.readFileSync(tokenPath, "utf8")) as {
				refresh_token?: unknown;
			};
			if (typeof token.refresh_token === "string" && token.refresh_token.length > 0) {
				return {
					status: "oauth-refreshable",
					...(authType ? { authType } : {}),
					tokenFile,
					settingsFile,
					directory,
					tokenPath,
					settingsPath,
				};
			}
			return {
				status: "corrupt",
				...(authType ? { authType } : {}),
				tokenFile,
				settingsFile,
				directory,
				tokenPath,
				settingsPath,
			};
		} catch {
			return {
				status: "corrupt",
				...(authType ? { authType } : {}),
				tokenFile,
				settingsFile,
				directory,
				tokenPath,
				settingsPath,
			};
		}
	}
	if (authType) {
		return {
			status: "configured-not-authenticated",
			authType,
			tokenFile,
			settingsFile,
			directory,
			tokenPath,
			settingsPath,
		};
	}
	return { status: "missing", tokenFile, settingsFile, directory, tokenPath, settingsPath };
}

export function hasAuth(env: NodeJS.ProcessEnv = process.env): boolean {
	return inspectAuth(env).status === "oauth-refreshable";
}

/**
 * Ensure the server has an auth method selected before the first login. The
 * server reads settings.json on startup; without an auth choice it may not
 * expose or complete the Google OAuth flow. Existing token/auth settings are
 * preserved, and no credential values are written here.
 */
export function ensureDefaultAuth(env: NodeJS.ProcessEnv = process.env): void {
	const directory = resolveAcpDirectory(env);
	const tokenPath = path.join(directory, "acp_token.json");
	const settingsPath = path.join(directory, "settings.json");
	if (regularFile(tokenPath)) return;
	let settings: Record<string, unknown> = {};
	if (regularFile(settingsPath)) {
		try {
			settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
			if (settings.auth && typeof settings.auth === "object") return;
		} catch {
			settings = {};
		}
	}
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	fs.writeFileSync(
		settingsPath,
		`${JSON.stringify({ ...settings, auth: { type: "oauth-personal" } }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	fs.chmodSync(settingsPath, 0o600);
}

/** Local logout. The server's token is removed; the next login recreates it. */
export function clearAuth(env: NodeJS.ProcessEnv = process.env): void {
	const directory = resolveAcpDirectory(env);
	fs.rmSync(path.join(directory, "acp_token.json"), { force: true });
	const settingsPath = path.join(directory, "settings.json");
	try {
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
		delete settings.auth;
		const temporary = `${settingsPath}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(temporary, settingsPath);
	} catch {
		fs.rmSync(settingsPath, { force: true });
	}
}
