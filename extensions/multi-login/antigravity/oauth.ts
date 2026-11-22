/**
 * Google Antigravity OAuth for Cloud Code Assist.
 *
 * Ported from the upstream Pi implementation that was removed in 0.71.0
 * (earendil-works/pi packages/ai/src/utils/oauth/google-antigravity.ts, MIT,
 * commit fe66edd94). The client, scopes and callback path are Antigravity's,
 * not Gemini CLI's: they unlock the same Cloud Code Assist surface the IDE
 * uses, including its Claude and gpt-oss models.
 *
 * The callback server uses node:http; this module is imported only when the
 * provider is enabled in multi-login's config.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ANTIGRAVITY_CLIENT_METADATA, antigravityUserAgent } from "./models";

export interface AntigravityCredential {
	type?: "oauth";
	refresh: string;
	access: string;
	expires: number;
	projectId: string;
	email?: string;
}

export interface AntigravityInteraction {
	signal: AbortSignal;
	prompt(prompt: { type: "manual_code"; message: string; placeholder?: string; signal?: AbortSignal }): Promise<string>;
	notify(event: { type: "auth_url"; url: string; instructions?: string } | { type: "progress"; message: string }): void;
}

export type FetchLike = typeof globalThis.fetch;

export interface AntigravityClient {
	clientId: string;
	clientSecret: string;
}

const CREDENTIALS_FILENAME = "antigravity-oauth.json";

/** Machine-local configuration lives in the Pi agent directory, beside settings.json. */
function agentDir(env: NodeJS.ProcessEnv): string {
	return resolve(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
}

/** The credentials file this machine is expected to provide unless PI_ANTIGRAVITY_OAUTH_CONFIG overrides it. */
export function antigravityCredentialsFile(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.PI_ANTIGRAVITY_OAUTH_CONFIG || join(agentDir(env), CREDENTIALS_FILENAME));
}

function credentialsFromFile(file: string): Partial<AntigravityClient> {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Antigravity credentials file ${file} is not valid JSON: ${(error as Error).message}`);
	}
	const record = parsed as Record<string, unknown>;
	const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
	return { clientId: text(record.clientId), clientSecret: text(record.clientSecret) };
}

/**
 * Antigravity needs Google's OAuth client identifiers, but committing them trips
 * GitHub push protection, so they never live in the repository. They come from
 * PI_ANTIGRAVITY_CLIENT_ID and PI_ANTIGRAVITY_CLIENT_SECRET, or from a
 * machine-local file outside the checkout: $PI_CODING_AGENT_DIR/antigravity-oauth.json,
 * or the path in PI_ANTIGRAVITY_OAUTH_CONFIG. Both must be present.
 */
export function antigravityClient(env: NodeJS.ProcessEnv = process.env): AntigravityClient {
	const fromEnv: Partial<AntigravityClient> = {
		clientId: env.PI_ANTIGRAVITY_CLIENT_ID?.trim(),
		clientSecret: env.PI_ANTIGRAVITY_CLIENT_SECRET?.trim(),
	};
	const file = antigravityCredentialsFile(env);
	const resolved = fromEnv.clientId && fromEnv.clientSecret ? fromEnv : credentialsFromFile(file);
	if (!resolved.clientId || !resolved.clientSecret) {
		throw new Error(
			`Antigravity OAuth needs Google client credentials: set PI_ANTIGRAVITY_CLIENT_ID and PI_ANTIGRAVITY_CLIENT_SECRET, or write {"clientId": "...", "clientSecret": "..."} to ${file}`,
		);
	}
	return { clientId: resolved.clientId, clientSecret: resolved.clientSecret };
}

const CALLBACK_PATH = "/oauth-callback";
const CALLBACK_PORT = 51121;
const CALLBACK_HOST = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";

/** Project Antigravity itself falls back to when discovery returns nothing. */
export const DEFAULT_PROJECT_ID = "rising-fact-p41fc";

const CODE_ASSIST_ENDPOINTS = [
	"https://cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
];

export function base64url(buffer: Buffer): string {
	return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function generatePkce(): { verifier: string; challenge: string } {
	const verifier = base64url(randomBytes(32));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

const successHtml = `<html><body><h1>Google authentication completed.</h1><p>You can close this window and return to the terminal.</p></body></html>`;
const errorHtml = (message: string): string =>
	`<html><body><h1>Google authentication did not complete.</h1><p>${message}</p></body></html>`;

export interface CallbackServer {
	/** Resolves with the authorization code, or null when the server is closed first. */
	waitForCode(): Promise<{ code: string; state: string } | null>;
	close(): void;
}

/** Local callback server. Returns null when the port is unavailable, so login falls back to pasting the URL. */
export async function startCallbackServer(): Promise<CallbackServer | null> {
	let settle: ((value: { code: string; state: string } | null) => void) | undefined;
	let settled = false;
	const code = new Promise<{ code: string; state: string } | null>((resolve) => {
		settle = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
	});

	let server: Server;
	try {
		server = await new Promise<Server>((resolve, reject) => {
			const candidate = createServer((req, res) => {
				const url = new URL(req.url || "", `http://localhost:${CALLBACK_PORT}`);
				if (url.pathname !== CALLBACK_PATH) {
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(errorHtml("Callback route not found."));
					return;
				}
				const error = url.searchParams.get("error");
				if (error) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(errorHtml(`Error: ${error}`));
					return;
				}
				const authCode = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				if (!authCode || !state) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(errorHtml("Missing code or state parameter."));
					return;
				}
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(successHtml);
				settle?.({ code: authCode, state });
			});
			candidate.on("error", reject);
			candidate.listen(CALLBACK_PORT, CALLBACK_HOST, () => resolve(candidate));
		});
	} catch {
		return null;
	}

	return {
		waitForCode: () => code,
		close: () => {
			settle?.(null);
			server.close();
		},
	};
}

/** Accept either the full redirect URL or a bare authorization code. */
export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};
	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		return { code: value };
	}
}

interface LoadCodeAssistPayload {
	cloudaicompanionProject?: string | { id?: string };
}

async function fetchJson<T>(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<T | undefined> {
	try {
		const response = await fetchImpl(url, init);
		if (!response.ok) return undefined;
		return (await response.json()) as T;
	} catch {
		return undefined;
	}
}

/** Discover the Cloud Code Assist project for this account, as Antigravity does at startup. */
export async function discoverProject(
	accessToken: string,
	fetchImpl: FetchLike = globalThis.fetch,
	signal?: AbortSignal,
): Promise<string> {
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": antigravityUserAgent(),
		"Client-Metadata": JSON.stringify(ANTIGRAVITY_CLIENT_METADATA),
	};
	const body = JSON.stringify({ metadata: ANTIGRAVITY_CLIENT_METADATA });
	for (const endpoint of CODE_ASSIST_ENDPOINTS) {
		signal?.throwIfAborted();
		const data = await fetchJson<LoadCodeAssistPayload>(fetchImpl, `${endpoint}/v1internal:loadCodeAssist`, {
			method: "POST",
			headers,
			body,
			signal,
		});
		if (!data) continue;
		const project = data.cloudaicompanionProject;
		if (typeof project === "string" && project) return project;
		if (project && typeof project === "object" && project.id) return project.id;
	}
	return DEFAULT_PROJECT_ID;
}

export async function fetchUserEmail(
	accessToken: string,
	fetchImpl: FetchLike = globalThis.fetch,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const data = await fetchJson<{ email?: string }>(fetchImpl, USERINFO_URL, {
		headers: { Authorization: `Bearer ${accessToken}` },
		signal,
	});
	return data?.email;
}

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
}

/** Exchange the refresh token. Keeps the stored project id, which the stream needs. */
export async function refreshAntigravityToken(
	credential: AntigravityCredential,
	fetchImpl: FetchLike = globalThis.fetch,
	signal?: AbortSignal,
): Promise<AntigravityCredential> {
	if (!credential.projectId) throw new Error("Antigravity credentials are missing the Cloud Code Assist project id");
	const { clientId, clientSecret } = antigravityClient();
	const response = await fetchImpl(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: credential.refresh,
			grant_type: "refresh_token",
		}),
		signal,
	});
	if (!response.ok) throw new Error(`Antigravity token refresh failed: ${await response.text()}`);
	const data = (await response.json()) as TokenResponse;
	// A credential written before project discovery carried the IDE identity falls back to the
	// shared default project; re-discover so the account's own companion project is used.
	const projectId =
		credential.projectId && credential.projectId !== DEFAULT_PROJECT_ID
			? credential.projectId
			: await discoverProject(data.access_token, fetchImpl, signal);
	return {
		...credential,
		projectId,
		refresh: data.refresh_token || credential.refresh,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
	};
}

/** Build the authorization URL Antigravity uses: offline access, forced consent, PKCE. */
export function buildAuthorizationUrl(verifier: string, challenge: string): string {
	const { clientId } = antigravityClient();
	const params = new URLSearchParams({
		client_id: clientId,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: SCOPES.join(" "),
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: verifier,
		access_type: "offline",
		prompt: "consent",
	});
	return `${AUTH_URL}?${params.toString()}`;
}

/** Run the full Antigravity login and return a storable credential. */
export async function loginAntigravity(
	interaction: AntigravityInteraction,
	fetchImpl: FetchLike = globalThis.fetch,
	options: { startCallbackServer?: () => Promise<CallbackServer | null> } = {},
): Promise<AntigravityCredential> {
	const { signal } = interaction;
	// Resolve the client first: a missing configuration must fail before a browser
	// window or the callback port is opened.
	const { clientId, clientSecret } = antigravityClient();
	const { verifier, challenge } = generatePkce();
	const server = await (options.startCallbackServer ?? startCallbackServer)();

	interaction.notify({ type: "progress", message: "Waiting for the Google sign-in to finish..." });
	interaction.notify({
		type: "auth_url",
		url: buildAuthorizationUrl(verifier, challenge),
		instructions: "Complete the sign-in in your browser.",
	});

	const manualAbort = new AbortController();
	const manual = interaction
		.prompt({
			type: "manual_code",
			message: "Paste the redirect URL (or authorization code)",
			signal: manualAbort.signal,
		})
		.then((value) => ({ kind: "manual" as const, value }))
		.catch((error: unknown) => ({ kind: "error" as const, error }));
	const callback = server ? server.waitForCode().then((value) => ({ kind: "callback" as const, value })) : undefined;

	let code: string | undefined;
	let state: string | undefined;
	try {
		const winner = await (callback ? Promise.race([callback, manual]) : manual);
		if (winner.kind === "error") throw winner.error;
		if (winner.kind === "callback") {
			manualAbort.abort();
			if (winner.value) {
				code = winner.value.code;
				state = winner.value.state;
			}
		} else {
			const parsed = parseAuthorizationInput(winner.value);
			code = parsed.code;
			state = parsed.state;
		}
	} finally {
		server?.close();
	}
	if (!code) throw new Error("No authorization code received");
	if (state !== undefined && state !== verifier) throw new Error("OAuth state mismatch - possible CSRF attack");
	signal.throwIfAborted();

	const response = await fetchImpl(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			code,
			grant_type: "authorization_code",
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier,
		}),
		signal,
	});
	if (!response.ok) throw new Error(`Antigravity token exchange failed: ${await response.text()}`);
	const token = (await response.json()) as TokenResponse;
	if (!token.refresh_token) throw new Error("No refresh token received. Please try again.");

	interaction.notify({ type: "progress", message: "Looking up the Cloud Code Assist project..." });
	const email = await fetchUserEmail(token.access_token, fetchImpl, signal);
	const projectId = await discoverProject(token.access_token, fetchImpl, signal);

	return {
		refresh: token.refresh_token,
		access: token.access_token,
		expires: Date.now() + token.expires_in * 1000 - 5 * 60 * 1000,
		projectId,
		email,
	};
}
