/**
 * Google Antigravity ACP provider for Pi.
 *
 * This provider drives Google's official Antigravity ACP server, the same
 * runtime the Antigravity IDE and `agy acp` use. It is a subscription-backed
 * path: the server owns its Google OAuth token at
 * `~/.gemini/antigravity-acp/acp_token.json` and exposes the models Google
 * provisions for the signed-in account, including Gemini 4 Neon and Carbon.
 *
 * Risk: Google's terms scope the Antigravity client to its own IDE. Driving it
 * from Pi is outside that grant and can cost the signed-in account its access.
 * Use only with accounts you accept that risk for.
 */

import {
	AcpClient,
	type AcpClientFileHandlers,
	type AcpClientLike,
	type AcpClientOptions,
	type AcpInitializeResult,
	type AcpMcpServer,
	type AcpPermissionOutcome,
	type AcpPermissionRequest,
	type AcpQuestion,
} from "./acp";
import {
	type AcpAuthHealth,
	MANAGED_AUTH_MARKER,
	ensureDefaultAuth,
	inspectAuth,
} from "./auth";
import {
	ANTIGRAVITY_ACP_BASE_URL,
	ANTIGRAVITY_ACP_PROVIDER_ID,
	type AcpModelInfo,
	type AntigravityAcpModel,
	FALLBACK_MODELS,
	projectModels,
	restoreModels,
} from "./models";
import { resolveRuntime, type RuntimeLaunch } from "./runtime";
import { createAcpStream, type AcpStreamOptions, type AcpToolActivity } from "./stream";
import {
	authUrlFromLine,
	deliverLoginCode,
	describeAuthUrl,
	parsePastedCredential,
} from "./login";

export { ANTIGRAVITY_ACP_PROVIDER_ID } from "./models";

export type AcpLoginNotification =
	| { type: "progress"; message: string }
	| { type: "auth_url"; url: string; instructions?: string };

export interface AcpLoginInteraction {
	signal?: AbortSignal;
	notify?: (notification: AcpLoginNotification) => void;
	/** Present in Pi's own login dialog; absent callers simply wait for the browser. */
	prompt?: (prompt: {
		type: "manual_code";
		message: string;
		placeholder?: string;
		signal?: AbortSignal;
	}) => Promise<string>;
}

/**
 * Pi's authority over the ACP server: it answers the server's permission
 * requests and decides the calls Pi executes itself (the file callbacks).
 */
export interface AcpAuthority {
	request(request: AcpPermissionRequest): Promise<AcpPermissionOutcome>;
	enforce(toolName: string, input: Record<string, unknown>): { allow: boolean };
}

export interface AntigravityAcpProviderDeps {
	fetch?: typeof globalThis.fetch;
	runtime?: () => Promise<RuntimeLaunch>;
	createClient?: (options: AcpClientOptions) => AcpClientLike;
	discoverModels?: (signal?: AbortSignal) => Promise<AcpModelInfo[]>;
	ensureAuth?: () => void;
	inspectAuth?: () => AcpAuthHealth;
	waitForAuth?: (signal?: AbortSignal, timeoutMs?: number) => Promise<boolean>;
	now?: () => number;
	/** Builds the authority that answers permission requests and file callbacks. */
	createGate?: (cwd: string) => AcpAuthority;
	/** Builds the handlers for the server's `fs/read_text_file` and `fs/write_text_file` callbacks. */
	createFileHandlers?: (cwd: string, gate: AcpAuthority) => AcpClientFileHandlers;
	/** Pi's MCP servers for this session, which the server connects itself. */
	mcpServers?: (cwd: string) => AcpMcpServer[];
	/** Workspace directories Pi grants beyond the session cwd. */
	additionalDirectories?: (cwd: string) => string[];
	/** Observes server-side tool activity, for example in Pi's footer. */
	onToolActivity?: (activity: AcpToolActivity, cwd: string) => void;
	/** Shows a question the server asked instead of a call Pi could judge. */
	onQuestion?: (question: AcpQuestion, cwd: string) => void;
}

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const AUTH_MARKER_TTL_MS = 60 * 60_000;

/**
 * Show the sign-in URL, then accept a pasted redirect URL or code while the
 * browser flow runs. A paste is forwarded to the server's own loopback
 * listener, so the server still performs the exchange and owns the token.
 */
async function offerPastedCode(
	url: string,
	interaction: AcpLoginInteraction,
	auth: Promise<void>,
	fetchImpl?: typeof globalThis.fetch,
): Promise<void> {
	if (!interaction.prompt) return;
	const target = describeAuthUrl(url);
	if (target.port === undefined) return;
	const controller = new AbortController();
	const signal = interaction.signal
		? AbortSignal.any([interaction.signal, controller.signal])
		: controller.signal;
	const pasted = interaction.prompt({
		type: "manual_code",
		message:
			"Paste the redirect URL or authorization code, or submit an empty line to keep waiting for the browser",
		signal,
	});
	const outcome = await Promise.race([
		auth.then(
			() => "authenticated" as const,
			() => "authenticated" as const,
		),
		pasted.then((value) => ({ value })),
	]);
	if (outcome === "authenticated") {
		// The browser finished first; retire the prompt without touching the flow.
		controller.abort();
		return;
	}
	const credential = parsePastedCredential(outcome.value);
	if (credential.error) {
		throw new Error(`Google sign-in failed: ${credential.error}`);
	}
	if (!credential.code) return;
	await deliverLoginCode(target, credential, {
		...(fetchImpl ? { fetch: fetchImpl } : {}),
		...(interaction.signal ? { signal: interaction.signal } : {}),
	});
}

async function pollAuth(
	health: () => AcpAuthHealth,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error("Antigravity ACP login was aborted");
		if (health().status === "oauth-refreshable") return true;
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	return false;
}

function selectAuthMethod(initialized: AcpInitializeResult) {
	const methods = initialized.authMethods ?? [];
	return (
		methods.find(
			(method) => /oauth|google/iu.test(method.id) || /oauth|google/iu.test(method.name),
		) ?? methods[0]
	);
}

export function antigravityAcpProvider(deps: AntigravityAcpProviderDeps = {}) {
	const runtime = deps.runtime ?? (() => resolveRuntime({ fetch: deps.fetch }));
	const createClient =
		deps.createClient ?? ((options: AcpClientOptions) => new AcpClient(options));
	const ensureAuth = deps.ensureAuth ?? (() => ensureDefaultAuth());
	const authHealth = deps.inspectAuth ?? (() => inspectAuth());
	const now = deps.now ?? Date.now;
	let models: AntigravityAcpModel[] = FALLBACK_MODELS.slice();

	const discoverModels =
		deps.discoverModels ??
		(async (signal?: AbortSignal): Promise<AcpModelInfo[]> => {
			const launch = await runtime();
			const client = createClient({
				command: launch.command,
				args: launch.args,
				cwd: process.cwd(),
			});
			try {
				await client.initialize(signal);
				const session = await client.newSession(process.cwd(), signal);
				return session.models?.availableModels ?? [];
			} finally {
				await client.close();
			}
		});

	// One stream shape for both entry points: the session cwd decides which
	// authority gate and workspace Pi hands the server.
	const createProviderStream = (
		model: AntigravityAcpModel,
		context: unknown,
		options?: AcpStreamOptions,
	) => {
		const cwd = options?.cwd ?? process.cwd();
		const gate = deps.createGate ? deps.createGate(cwd) : undefined;
		const permission = gate ? (request: AcpPermissionRequest) => gate.request(request) : undefined;
		const fileHandlers =
			gate && deps.createFileHandlers ? deps.createFileHandlers(cwd, gate) : undefined;
		const mcpServers = deps.mcpServers ? deps.mcpServers(cwd) : undefined;
		const additionalDirectories = deps.additionalDirectories
			? deps.additionalDirectories(cwd)
			: undefined;
		const onToolActivity = deps.onToolActivity
			? (activity: AcpToolActivity) => deps.onToolActivity?.(activity, cwd)
			: undefined;
		const onQuestion = deps.onQuestion
			? (question: AcpQuestion) => deps.onQuestion?.(question, cwd)
			: undefined;
		return createAcpStream(model, context, options, {
			resolveRuntime: runtime,
			createClient,
			hasAuth: () => authHealth().status === "oauth-refreshable",
			cwd,
			...(permission ? { permission } : {}),
			...(fileHandlers ? { fileHandlers } : {}),
			...(mcpServers?.length ? { mcpServers } : {}),
			...(additionalDirectories?.length ? { additionalDirectories } : {}),
			...(onToolActivity ? { onToolActivity } : {}),
			...(onQuestion ? { onQuestion } : {}),
		});
	};

	return {
		id: ANTIGRAVITY_ACP_PROVIDER_ID,
		name: "Google Antigravity (ACP)",
		baseUrl: ANTIGRAVITY_ACP_BASE_URL,
		auth: {
			oauth: {
				name: "Google Antigravity ACP (Google account)",
				isSubscription: true,
				loginLabel: "Sign in with a Google account (Antigravity ACP)",
				login: async (interaction: AcpLoginInteraction) => {
					ensureAuth();
					const launch = await runtime();
					let resolveUrl: ((value: string | undefined) => void) | undefined;
					let urlSeen = false;
					const firstUrl = new Promise<string | undefined>((resolve) => {
						resolveUrl = resolve;
					});
					const surface = (url: string): void => {
						if (urlSeen) return;
						urlSeen = true;
						const target = describeAuthUrl(url);
						const instructions =
							target.port === undefined
								? "No browser on this host? Forward the callback port from the sign-in URL before opening it."
								: `No browser on this host? Forward the callback port first (ssh -L ${target.port}:127.0.0.1:${target.port} <this host>), or paste the redirect URL or authorization code below.`;
						interaction.notify?.({ type: "auth_url", url, instructions });
						resolveUrl?.(url);
					};
					const client = createClient({
						command: launch.command,
						args: launch.args,
						cwd: process.cwd(),
						// A headless sign-in waits for a person, not a fast request.
						operationTimeoutMs: LOGIN_TIMEOUT_MS,
						onStderr: (line: string) => {
							const url = authUrlFromLine(line);
							if (url) surface(url);
						},
					});
					try {
						const initialized = await client.initialize(interaction.signal);
						const method = selectAuthMethod(initialized);
						if (!method) {
							throw new Error("Antigravity ACP advertises no authentication method");
						}
						interaction.notify?.({
							type: "progress",
							message: `Opening ${method.name}…`,
						});
						const auth = client.authenticate(method.id, interaction.signal);
						const url = await Promise.race([
							firstUrl,
							// An already-signed-in server returns without printing a URL.
							auth.then(
								() => undefined,
								() => undefined,
							),
						]);
						if (url !== undefined) {
							await offerPastedCode(url, interaction, auth, deps.fetch);
						}
						await auth;
						const wait =
							deps.waitForAuth ??
							((signal: AbortSignal | undefined, timeoutMs: number) =>
								pollAuth(authHealth, signal, timeoutMs));
						const authenticated = await wait(interaction.signal, LOGIN_TIMEOUT_MS);
						if (!authenticated) {
							throw new Error(
								"Antigravity ACP login did not create acp_token.json; complete the Google sign-in and retry.",
							);
						}
						return {
							type: "oauth" as const,
							access: MANAGED_AUTH_MARKER,
							refresh: MANAGED_AUTH_MARKER,
							expires: now() + AUTH_MARKER_TTL_MS,
						};
					} finally {
						await client.close().catch(() => undefined);
					}
				},
				refresh: async (credential: any, _signal: AbortSignal) => {
					if (authHealth().status !== "oauth-refreshable") {
						throw new Error(
							"Antigravity ACP token is missing; run /login for google-antigravity-acp.",
						);
					}
					return {
						...(credential ?? {}),
						type: "oauth" as const,
						access: MANAGED_AUTH_MARKER,
						refresh: MANAGED_AUTH_MARKER,
						expires: now() + AUTH_MARKER_TTL_MS,
					};
				},
				toAuth: async () => ({ apiKey: MANAGED_AUTH_MARKER }),
			},
		},
		getModels: () => models.slice(),
		refreshModels: async (context: any) => {
			if (!context.allowNetwork) {
				const restored = restoreModels(context.stored?.models ?? []);
				if (restored.length === 0) return;
				await context.publish({
					update: () => {
						models = restored;
					},
				});
				return;
			}
			if (authHealth().status !== "oauth-refreshable") return;
			let discovered: AcpModelInfo[];
			try {
				discovered = await discoverModels(context.signal);
			} catch {
				// A missing or unavailable runtime keeps the conservative offline catalog.
				return;
			}
			const projected = projectModels(discovered);
			if (projected.length === 0) return;
			await context.publish({
				persist: { models: projected, checkedAt: now() },
				update: () => {
					models = projected;
				},
			});
		},
		stream: (model: AntigravityAcpModel, context: unknown, options?: AcpStreamOptions) =>
			createProviderStream(model, context, options),
		streamSimple: (model: AntigravityAcpModel, context: unknown, options?: AcpStreamOptions) =>
			createProviderStream(model, context, options),
	};
}
