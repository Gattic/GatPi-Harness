/**
 * Google Antigravity provider for Pi, registered by the multi-login extension.
 *
 * Antigravity is Google's agentic IDE. Its OAuth client reaches Cloud Code
 * Assist, which serves Gemini, Claude and gpt-oss models under the signed-in
 * Google account's plan — the subscription-backed path Google's public Gemini
 * API does not offer. This provider mimics that client's handshake the way the
 * harness's Anthropic shaper mimics Claude Code: same OAuth client, scopes and
 * callback, plus the IDE's request envelope and headers.
 *
 * Risk: Google's terms scope this client to its own IDE. Driving it from Pi is
 * outside that grant and can cost the signed-in account its access. Use only
 * with accounts you accept that risk for.
 */

import type { AntigravityModel } from "./models";
import {
	ANTIGRAVITY_ENDPOINT,
	currentAntigravityModels,
	discoverAntigravityModels,
	setAntigravityModels,
} from "./models";
import {
	type AntigravityCredential,
	type AntigravityInteraction,
	type CallbackServer,
	type FetchLike,
	loginAntigravity,
	refreshAntigravityToken,
} from "./oauth";
import { streamAntigravity, streamSimpleAntigravity, type AntigravityStreamOptions } from "./stream";

export const ANTIGRAVITY_PROVIDER_ID = "google-antigravity";

export interface AntigravityProviderDeps {
	/** Injected transport for tests; defaults to the global fetch. */
	fetch?: FetchLike;
	/** Injected callback server for tests; defaults to the local http server. */
	startCallbackServer?: () => Promise<CallbackServer | null>;
}

export function antigravityProvider(deps: AntigravityProviderDeps = {}) {
	const fetchImpl = deps.fetch ?? globalThis.fetch;
	return {
		id: ANTIGRAVITY_PROVIDER_ID,
		name: "Google Antigravity",
		baseUrl: ANTIGRAVITY_ENDPOINT,
		auth: {
			oauth: {
				name: "Google Antigravity (Google account)",
				isSubscription: true,
				loginLabel: "Sign in with a Google account (Antigravity)",
				login: async (interaction: AntigravityInteraction) => {
					const credential = await loginAntigravity(interaction, fetchImpl, {
						startCallbackServer: deps.startCallbackServer,
					});
					// Seed the catalog now so the model picker reflects the plan right after login.
					try {
						const models = await discoverAntigravityModels({
							accessToken: credential.access,
							projectId: credential.projectId,
							fetchImpl,
							force: true,
						});
						if (models) setAntigravityModels(credential.projectId, models);
					} catch {
						// Discovery is best-effort: the static snapshot stays until a later refresh.
					}
					return { ...credential, type: "oauth" as const };
				},
				refresh: async (credential: AntigravityCredential, signal: AbortSignal) =>
					refreshAntigravityToken(credential, fetchImpl, signal),
				toAuth: async (credential: AntigravityCredential) => ({
					apiKey: JSON.stringify({ token: credential.access, projectId: credential.projectId }),
				}),
			},
		},
		getModels: () => currentAntigravityModels() as AntigravityModel[],
		refreshModels: async (context: {
			credential?: { type?: string; access?: unknown; projectId?: unknown };
			stored?: { models?: unknown };
			allowNetwork: boolean;
			force?: boolean;
			signal: AbortSignal;
			publish(publication: { persist?: unknown; update?: () => void }): Promise<boolean>;
		}) => {
			const credential = context.credential;
			if (credential?.type !== "oauth") return;
			const projectId = typeof credential.projectId === "string" ? credential.projectId : undefined;
			if (!projectId) return;
			if (!context.allowNetwork) {
				// Offline phase: restore the persisted catalog before any network access.
				const storedModels = context.stored?.models;
				if (Array.isArray(storedModels) && storedModels.length > 0) {
					setAntigravityModels(projectId, storedModels as AntigravityModel[]);
				}
				return;
			}
			if (typeof credential.access !== "string" || !credential.access) return;
			const models = await discoverAntigravityModels({
				accessToken: credential.access,
				projectId,
				fetchImpl,
				signal: context.signal,
				force: context.force,
			});
			if (!models) return;
			await context.publish({
				persist: { models, checkedAt: Date.now() },
				update: () => setAntigravityModels(projectId, models),
			});
		},
		stream: (model: AntigravityModel, context: unknown, options?: AntigravityStreamOptions) =>
			streamAntigravity(model, context, options, fetchImpl),
		streamSimple: (model: AntigravityModel, context: unknown, options?: AntigravityStreamOptions) =>
			streamSimpleAntigravity(model, context, options, fetchImpl),
	};
}
