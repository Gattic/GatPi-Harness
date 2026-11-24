/**
 * Headless-friendly sign-in for the Antigravity ACP server.
 *
 * The server runs its own Google OAuth loopback listener and prints the
 * sign-in URL to stderr. Pi only sees that stream because the login client
 * forwards it. A host without a browser cannot open the URL, and its callback
 * port is unreachable from another machine, so the same flow can be finished
 * by pasting the redirect URL or the bare authorization code: forwarding it to
 * the server's own listener completes the exchange the server started.
 */

/** A sign-in URL the server printed, with the callback details it encodes. */
export interface AcpLoginUrl {
	url: string;
	/** Loopback port the server listens on for the OAuth redirect. */
	port?: number;
	/** CSRF state the server generated for this sign-in attempt. */
	state?: string;
}

/** What a pasted redirect URL or code yields. */
export interface PastedCredential {
	code?: string;
	state?: string;
	error?: string;
}

/** Google's authorization URL, which the server prints inside an xdg-open failure line. */
const AUTH_URL_PATTERN = /https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s'"`<>]+/u;

/** The sign-in URL in one stderr line, if it holds one. */
export function authUrlFromLine(line: string): string | undefined {
	return AUTH_URL_PATTERN.exec(line)?.[0];
}

/** The URL together with the loopback port and state it carries. */
export function describeAuthUrl(url: string): AcpLoginUrl {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { url };
	}
	const redirect = parsed.searchParams.get("redirect_uri");
	const state = parsed.searchParams.get("state")?.trim();
	let port: number | undefined;
	if (redirect) {
		try {
			const target = new URL(redirect);
			const value = Number(target.port);
			if (Number.isInteger(value) && value > 0) port = value;
		} catch {
			// A malformed redirect_uri simply leaves the port unknown.
		}
	}
	return { url, ...(port === undefined ? {} : { port }), ...(state ? { state } : {}) };
}

/**
 * Read a pasted redirect URL, query string or bare code. An authorization code
 * may itself contain slashes, so anything without a query is taken verbatim.
 */
export function parsePastedCredential(pasted: string): PastedCredential {
	const text = pasted.trim();
	if (!text) return {};
	const queryStart = text.indexOf("?");
	const hasQuery = queryStart >= 0 || /(?:^|[?&])code=/u.test(text);
	if (!hasQuery) {
		return /^https?:\/\//iu.test(text) ? {} : { code: text };
	}
	const params = new URLSearchParams(queryStart >= 0 ? text.slice(queryStart + 1) : text);
	const code = params.get("code")?.trim();
	const state = params.get("state")?.trim();
	const error = params.get("error")?.trim();
	return {
		...(code ? { code } : {}),
		...(state ? { state } : {}),
		...(error ? { error } : {}),
	};
}

export interface DeliverLoginCodeOptions {
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
}

/**
 * Hand the pasted code to the listener the server opened for this attempt.
 * The server validates the state, exchanges the code and writes its token
 * file, so nothing is stored here.
 */
export async function deliverLoginCode(
	target: AcpLoginUrl,
	credential: PastedCredential,
	options: DeliverLoginCodeOptions = {},
): Promise<void> {
	if (target.port === undefined) {
		throw new Error(
			"The Antigravity ACP sign-in URL carries no loopback callback port, so a pasted code cannot be delivered.",
		);
	}
	const callback = new URL(`http://127.0.0.1:${target.port}/`);
	if (credential.code) callback.searchParams.set("code", credential.code);
	const state = credential.state ?? target.state;
	if (state) callback.searchParams.set("state", state);
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const response = await fetchImpl(callback, {
		redirect: "follow",
		...(options.signal ? { signal: options.signal } : {}),
	});
	await response.text().catch(() => "");
	if (!response.ok) {
		throw new Error(
			`The Antigravity ACP server rejected the pasted code (HTTP ${response.status}). Start the login again and paste a fresh redirect URL or code.`,
		);
	}
}
