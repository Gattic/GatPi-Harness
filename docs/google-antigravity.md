# Google Antigravity provider (multi-login)

`multi-login` registers two independent Google Antigravity providers:

- `google-antigravity-acp` is **registered by default**. It drives Google's
official Antigravity ACP server and is the preferred path for the models the
Antigravity client exposes, including Gemini 4 Neon and Carbon.
- `google-antigravity` is the subscription-backed Cloud Code Assist surface and
remains **opt-in** through `accounts`. It uses a Google OAuth client plus the
`v1internal:streamGenerateContent` endpoint, not the Gemini API. Pi's own
`google` provider stays API-key only.

An `accounts` entry for either provider creates `-account-N` aliases and
priority slots; it is not required to register the ACP provider.

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

Cloud Code registration is opt-in: without an `accounts` entry no
`google-antigravity` provider, models or login method appear in the session.
`accounts` counts create `google-antigravity-account-N` aliases for
multi-account failover.

Then sign in once per account:

```
/login google-antigravity
```

## Antigravity ACP

The ACP provider needs no `accounts` entry and is available in every session.
Its login installs the pinned official runtime (1.5.2) on first use and opens
Google sign-in:

```
/login google-antigravity-acp
```

The server owns its OAuth token at
`~/.gemini/antigravity-acp/acp_token.json` (or under `GEMINI_HOME`); Pi stores
only a non-secret managed-auth marker. The ACP token is independent of the
Cloud Code credential above. No Gemini API key is used. The runtime archive is
downloaded from Google's release URL and verified against the pinned SHA-256,
size and expected archive entries before installation.

ACP models appear in `/model` without a config entry. Adding
`"google-antigravity-acp": 1` to `accounts` is only needed for multi-account
aliases or priority/failover entries.

The flow opens `http://localhost:51121/oauth-callback`, and also accepts a
pasted redirect URL or bare authorization code when that port is unavailable.
The stored credential holds the access/refresh token, the discovered Cloud Code
Assist project id, and the account email; it lives in Pi's own auth storage.
Project discovery announces Antigravity's client identity (`ideType:
ANTIGRAVITY`, `pluginType: CLOUD_CODE`), which is what makes the endpoint
report the account's own companion project instead of the shared default. A
credential that only holds the default project re-discovers on the next token
refresh.

## Models

The catalog is discovered per account. At login and on every model refresh the
provider asks `v1internal:retrieveUserQuota`, which reports each model the
signed-in plan may bill, and maps those ids to Pi models (new releases appear
without a code change). The account's catalog (`fetchAvailableModels`) then
supplies the display name, modality flags and context limits, and identifies
the tab-completion buckets (`tab_*`, `chat_*`) that are not chat models. If that
endpoint is unavailable, the quota ids still become models with inferred
metadata. The result is cached for ten minutes and persisted, so a restart
restores it offline. Any failure — no credential, an HTTP error, an empty
response — keeps the previous catalog, and the static snapshot below is the
last resort:

Claude Opus 4.5/4.6 Thinking, Claude Sonnet 4.5/4.6, Gemini 3 Flash, Gemini
3.1 Pro High/Low, and GPT-OSS 120B Medium. The snapshot mirrors the upstream Pi
provider removed in 0.71.0; it exists only so the picker is never empty.

Which models a plan actually allows is decided by Google, and the consumer
Gemini plan and the Cloud Code Assist API do not expose the same set. A Google
AI Ultra account reports `paidTier: g1-ultra-tier`, and the Gemini app offers
it Neon, Carbon and Hydrogen, but Code Assist only serves the models its quota
lists. On such an account that set includes `gemini-4-hydrogen-sonar` while
`gemini-4-neon`, `gemini-4-carbon` and the other Gemini 4 variants answer 404
(sandbox) or 429 (production quota), so they never reach the picker.

Production and sandbox quotas differ: `cloudcode-pa.googleapis.com` can return
429 for every model while `daily-cloudcode-pa.sandbox.googleapis.com` still
serves them. The provider tries the sandbox endpoint first for that reason.

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
- The handshake is undocumented and may change without notice. The providers
  are isolated in `extensions/multi-login/antigravity/` and
  `extensions/multi-login/antigravity-acp/` for that reason.
- Credentials are never logged; tests mock every network call and supply
  synthetic client identifiers from the environment. The ACP runtime is
  installed only after `/login`, and its archive is verified before use.

## Verification

```
node tests/google-antigravity.test.js
node tests/multi-login.test.js
node tests/antigravity-acp.test.js
```

The tests cover the authorization URL and PKCE, callback and manual login,
refresh, project discovery, the request envelope, message/tool conversion, SSE
parsing, endpoint fallback, default ACP registration, runtime installation and
verification, ACP login/model/stream behavior, multi-login registration and
quota classification.
