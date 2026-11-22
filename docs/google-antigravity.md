# Google Antigravity provider (multi-login)

`multi-login` can add Google's subscription-backed Cloud Code Assist surface as
the `google-antigravity` provider. It is the path the Antigravity IDE uses:
a Google OAuth client plus the `v1internal:streamGenerateContent` endpoint,
not the Gemini API. Pi's own `google` provider stays API-key only.

## OAuth client credentials

Antigravity's Google client identifiers are not stored in this repository. They
are public constants of the Antigravity IDE, but committing them trips GitHub
push protection, so each machine supplies them once, either way:

- Environment: `PI_ANTIGRAVITY_CLIENT_ID` and `PI_ANTIGRAVITY_CLIENT_SECRET`.
- A machine-local file outside the checkout, `antigravity-oauth.json`, mode `600`:

```json
{"clientId": "…apps.googleusercontent.com", "clientSecret": "…"}
```

The file is read from `$PI_CODING_AGENT_DIR` (default `~/.pi/agent`), beside
`settings.json` and `multi-login.json`; set `PI_ANTIGRAVITY_OAUTH_CONFIG` to
point at another path. Both values must be present. Without them,
`/login google-antigravity` fails before opening a browser or the callback
port, naming the environment variables and the file path it looked for.

## Enable it

Add the provider to the multi-login config (`~/.pi/agent/multi-login.json`):

```json
{
  "accounts": { "google-antigravity": 1 },
  "priority": ["google-antigravity/gemini-3-flash", "anthropic/claude-opus-5-5"]
}
```

Registration is opt-in: without an `accounts` entry no Antigravity provider,
models or login method appear in the session. `accounts` counts create
`google-antigravity-account-N` aliases for multi-account failover.

Then sign in once per account:

```
/login google-antigravity
```

The flow opens `http://localhost:51121/oauth-callback`, and also accepts a
pasted redirect URL or bare authorization code when that port is unavailable.
The stored credential holds the access/refresh token, the discovered Cloud Code
Assist project id, and the account email; it lives in Pi's own auth storage.

## Models

The catalog mirrors the upstream Pi provider removed in 0.71.0: Claude Opus
4.5/4.6 Thinking, Claude Sonnet 4.5/4.6, Gemini 3 Flash, Gemini 3.1 Pro
High/Low, and GPT-OSS 120B Medium. What the account's plan allows is decided by
Google, not by this catalog.

Requests carry Antigravity's envelope (`requestType: "agent"`, an
`antigravity/<version>` User-Agent, the IDE's leading system instruction) and
fall back across the sandbox, autopush and production endpoints on 403/404.
Set `PI_AI_ANTIGRAVITY_VERSION` to announce a different IDE build.

## Quota failures

Cloud Code Assist reports exhausted plans as "You have exhausted your
capacity…" and rejects keys as "API key not valid". Both now classify as
account failures, so multi-login fails over to the next account instead of
retrying the exhausted one.

## Risks

- Google's terms scope this OAuth client to its own IDE. Driving it from Pi is
  outside that grant; an account can lose access. Use it only on accounts you
  accept that risk for.
- The handshake is undocumented and may change without notice. The provider is
  isolated in `extensions/multi-login/antigravity/` for that reason.
- Credentials are never logged; tests mock every network call and supply
  synthetic client identifiers from the environment.

## Verification

```
node tests/google-antigravity.test.js
node tests/multi-login.test.js
```

The test covers the authorization URL and PKCE, callback and manual login,
refresh, project discovery, the request envelope, message/tool conversion, SSE
parsing, endpoint fallback, multi-login registration and quota classification.
