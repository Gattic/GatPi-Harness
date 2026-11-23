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
	type AcpClientLike,
	type AcpClientOptions,
	type AcpInitializeResult,
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
import { createAcpStream, type AcpStreamOptions } from "./stream";

export { ANTIGRAVITY_ACP_PROVIDER_ID } from "./models";

export interface AcpLoginInteraction {
	signal?: AbortSignal;
	notify?: (notification: { type: string; message: string }) => void;
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
}

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const AUTH_MARKER_TTL_MS = 60 * 60_000;

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
					const client = createClient({
						command: launch.command,
						args: launch.args,
						cwd: process.cwd(),
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
						await client.authenticate(method.id, interaction.signal);
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
			createAcpStream(model, context, options, {
				resolveRuntime: runtime,
				createClient,
				hasAuth: () => authHealth().status === "oauth-refreshable",
			}),
		streamSimple: (model: AntigravityAcpModel, context: unknown, options?: AcpStreamOptions) =>
			createAcpStream(model, context, options, {
				resolveRuntime: runtime,
				createClient,
				hasAuth: () => authHealth().status === "oauth-refreshable",
			}),
	};
}
