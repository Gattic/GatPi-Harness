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

The flow opens `http://localhost:51121/oauth-callback`, and also accepts a
pasted redirect URL or bare authorization code when that port is unavailable.
The stored credential holds the access/refresh token, the discovered Cloud Code
Assist project id, and the account email; it lives in Pi's own auth storage.
Project discovery announces Antigravity's client identity (`ideType:
ANTIGRAVITY`, `pluginType: CLOUD_CODE`), which is what makes the endpoint
report the account's own companion project instead of the shared default. A
credential that only holds the default project re-discovers on the next token
refresh.

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

### Credential requirements

Three things must exist on the host:

1. **Runtime.** The managed install at `~/.local/opt/agy-acp/current`
   (override the root with `PI_ANTIGRAVITY_ACP_ROOT`), an executable named by
   `AGY_ACP_BIN`, or `agy_acp_server.par` on `PATH`. When none is present the
   pinned 1.5.2 archive is downloaded on first use; see the rollout steps for
   the CPU requirement.
2. **The server's Google token.**
   `~/.gemini/antigravity-acp/acp_token.json` (or under `GEMINI_HOME`) with a
   non-empty `refresh_token`. Pi reads only that field and never copies the
   token. The states it distinguishes are `oauth-refreshable` (usable),
   `missing` (no token and no auth type in `settings.json`),
   `configured-not-authenticated` (an auth type but no token) and `corrupt`
   (unparsable JSON or an empty refresh token). A prompt fails with
   "Google Antigravity ACP is not authenticated. Run /login for
   google-antigravity-acp."; a token refresh fails with "Antigravity ACP token
   is missing".
3. **Pi's marker.** An entry named `google-antigravity-acp` in
   `~/.pi/agent/auth.json` whose `access` and `refresh` are the string
   `antigravity-acp-managed` and which carries no secret. `/login
   google-antigravity-acp` writes it once the server reports a token; without
   it Pi reports the provider as unauthenticated before spawning the server.

No Gemini API key or Cloud Code credential is involved; the ACP token is
independent of the `google-antigravity` provider above. `pi auth check
--provider google-antigravity-acp` answers `provider_not_found` because that
command does not load extension-registered providers; verify instead with
`pi --list-models antigravity` (the `google-antigravity-acp` models appear) and
a one-line prompt.

### Tool authority and approvals

An ACP model runs on Antigravity's own harness, not Pi's agent loop. Pi sends
the transcript as text and never hands the model Pi's tools; the server owns
its file and shell tools and executes them inside its runtime. Pi keeps the
*authority* over them:

- **Every permission request is a Pi policy decision.** When the server asks
  `session/request_permission`, `src/acp-permission-gate.js` maps the tool call
  onto Pi's policy: `execute` becomes a Pi `bash` command, `edit`/`write`/
  `delete` become Pi writes with their target path, `read` stays a read. The
  request then runs through the same shell parsing, path rules and approval
  store as Pi's own tool calls (`src/policy-enforcement.js`), using the
  project's `.pi/policy-gate/policy.json`.
- **A conforming call is approved from policy.** No dialog and no approval
  prompt: a command Pi's shell rules accept, a write inside the project, or a
  read is answered with the server's `allow` option straight away.
- **One mode for both surfaces.** `/policy-mode advisory|warn|block|approval`
  changes Pi tool calls and ACP tool calls together (`src/policy-mode.js`).
  `advisory` and `warn` never refuse; `block` refuses a violation; `approval`
  reports the approval key for a violation instead of opening a dialog.
- **Approvals are Pi's, not the server's.** A granted request is stored in
  `.pi/policy-enforcer/approvals.json`; `/policy-approve`, `/policy-approve-
  directory` and `/policy-approvals` work unchanged. Pi answers with the
  server's one-shot `allow` option, never its `allow_always` option, unless Pi
  already holds the grant — a persistent server-side approval would bypass
  Pi's policy on later calls.
- **A refusal says why and how to accept it.** The notification carries the
  policy reasons and `Approve once with: /policy-approve <key>`. Granting the
  key makes that call conform, and it is approved without further prompting.
- **ACP tools Pi has no rule for are not blocked.** A tool kind such as
  `fetch` follows Pi's convention for unknown tools: policy decides, and a
  missing tool-allowlist entry is only an advisory warning.
- **A write or command Pi cannot see is refused.** If an `execute` or
  `edit`/`write`/`delete` request arrives without a command or path, there is
  no request shape to judge or to grant, so the call is refused outright.
- **No dialog mid-stream.** Pi cannot render a dialog while the assistant turn
  is streaming and the server is waiting for the permission answer; a prompt
  there deadlocks the turn. Approvals are granted ahead of time with
  `/policy-approve`, not asked in the middle of a turn.
- **A turn lasts as long as the server needs.** There is no client-side prompt
  deadline: while a background command runs (`WaitMsBeforeAsync`), the server
  sends nothing at all, so a timer cannot tell a long command from a hang and
  would fail turns that are still working. Esc aborts the turn and sends
  `session/cancel`, which stops the server's work. `promptTimeoutMs` remains
  available for programmatic callers that need a bound; when set, a timeout
  also cancels the server turn and names the last activity.
- **Failures name the real cause.** Error messages report the last server
  activity (tool, status and command or path) and filter the bundle's own
  Python `SyntaxWarning` output instead of appending it verbatim.
- **Pi decides the workspace.** The ACP server confines itself to the session
  cwd. Pi passes its own project scope (`PI_HARNESS_PROJECT_DIRS` plus
  `/policy-approve-directory` grants) to `session/new` as
  `additionalDirectories`, so the server sees exactly the directories Pi is
  allowed to work in, and Pi's write rules still gate every change.
- **Tool activity is visible.** The footer shows the ACP tool currently
  running, and a denial names the policy reasons instead of leaving only the
  server's "denied by pre-tool hook" wording.
- **Context is the request's, not the turn's.** The prompt result's usage sums
  every internal model call of the turn (billing), so it can dwarf the context
  window even when the turn was small. The server's `usage_update`
  notifications carry the tokens currently in context; Pi records that
  occupancy as the message's context size, so the footer percentage and
  compaction thresholds use the last request rather than the aggregate. When
  no occupancy is reported, Pi estimates from its own messages instead of
  reading the aggregate.

Boundaries worth knowing:

- The server's own policy can auto-approve calls (for example reads) without
  asking Pi; those never reach Pi's gate.
- Pi cannot see the server's tool results as Pi tool results, so the
  transcript records the model's text only.
- ACP sessions provision `skills/system/run-workflow/SKILL.md` inside the
  session cwd; that directory is not a Pi skill and is untracked in Git.

## Runtime host requirements

The ACP runtime is a Go launcher with an embedded CPython 3.14 and the
Antigravity application. The launcher is compiled with AES and AVX enabled and
fails fast, before it prints anything else, when the CPU lacks them:

```
FATAL ERROR: This binary was compiled with aes enabled, but this feature is not available on this processor (go/sigill-fail-fast).
```

- The requirement is **AES + AVX** (Sandy Bridge class and later). AVX2 is not
  required: a Westmere CPU (AES, no AVX) fails on `avx`, and a Nehalem (neither)
  fails on `aes`.
- Every published `linux-x86_64` release (1.2.0, 1.5.0 and 1.5.2) carries the
  same requirement; Google ships no baseline build. The sibling
  `localharness_external` binary does run on those CPUs, so only the server is
  affected.
- Check a host before rollout. Both flags must be present:
  `grep -qw aes /proc/cpuinfo && grep -qw avx /proc/cpuinfo && echo supported`

Fleet status (checked 2026-11):

| host | CPU | aes | avx | ACP |
| --- | --- | --- | --- | --- |
| gbig00 | Xeon E5530 | no | no | not supported |
| gbig01 | Xeon X5670 | yes | no | not supported |
| gbig02 | Xeon E5530 | no | no | not supported |
| gbig03 | Xeon X5570 | no | no | not supported |
| gbig04 | Xeon E5-2640 | yes | yes | configured, verified |
| ghome | Ryzen 9 3900X | yes | yes | supported, not yet configured |
| sparky0–2 | aarch64 | yes | n/a | arm64 archive; not yet verified |

Emulation is not a practical fallback: QEMU 7.2 with `-cpu max` does run the
1.5.2 server, but startup costs about 38 s and the provider spawns a fresh
server for every Pi turn, against roughly 4 s natively.

## Rollout steps

1. **Confirm the CPU** as above. Do not install the runtime on a host that fails
   the check; the install succeeds and every spawn then dies with SIGILL.
2. **Install the managed runtime.** Either run `/login google-antigravity-acp`
   on the host (it downloads the 274 MB archive, verifies its SHA-256 and size,
   and extracts 815 MB under `~/.local/opt/agy-acp`), or copy an installation
   already verified on another host, using the `archiveSha256` of the
   `runtime-manifest.json` entry for the platform as the version directory:

   ```
   ssh source-host 'cd ~/.local/opt/agy-acp/versions && tar -cf - <sha256>' \
     | ssh target-host 'mkdir -p ~/.local/opt/agy-acp/versions && cd ~/.local/opt/agy-acp/versions && tar -xf -'
   ssh target-host 'cd ~/.local/opt/agy-acp && ln -sfn versions/<sha256> current'
   ```

   `installedRuntime` re-checks the version, archive SHA-256, byte counts and
   executable bits against the pinned manifest, so a copy is accepted only if it
   matches. Set `AGY_ACP_BIN` to bypass the managed runtime with a user-managed
   binary.
3. **Provide the Google credential.** The server owns its token at
   `~/.gemini/antigravity-acp/acp_token.json` (or under `GEMINI_HOME`); Pi keeps
   only a non-secret marker. Either sign in on the host (see the headless note
   below), or copy the token from a machine already signed in to the same
   Google account:

   ```
   ssh signed-in-host 'tar -cf - -C ~/.gemini antigravity-acp/acp_token.json antigravity-acp/settings.json' \
     | ssh target-host 'mkdir -p ~/.gemini && tar -xf - -C ~/.gemini && chmod 600 ~/.gemini/antigravity-acp/*.json'
   ```

   The file holds only the OAuth client id/secret, project id, refresh token,
   scopes and token URI — no access token or expiry. The server mints an access
   token from the refresh token on each start and rewrites the file, so a copy
   is self-sustaining. Copying does not rotate the refresh token: both hosts
   keep working until Google revokes it (password change, security event,
   unused for about six months, or the per-client token cap).
4. **Add Pi's auth marker**, merged into the existing store rather than
   replacing it:

   ```
   python3 - <<'EOF'
   import json, os, time
   p = os.path.expanduser("~/.pi/agent/auth.json")
   d = json.load(open(p)) if os.path.exists(p) else {}
   d["google-antigravity-acp"] = {"type": "oauth", "access": "antigravity-acp-managed",
                                 "refresh": "antigravity-acp-managed",
                                 "expires": int(time.time() * 1000) + 3600_000}
   tmp = p + ".tmp"
   open(tmp, "w").write(json.dumps(d, indent=2) + "\n")
   os.chmod(tmp, 0o600)
   os.replace(tmp, p)
   EOF
   ```

   The marker carries no secret; without it Pi reports the provider as
   unauthenticated before it ever spawns the server.
5. **Verify** on the host:

   ```
   pi --list-models                                   # the ACP models appear
   pi -p --no-session --model google-antigravity-acp/gemini-4-neon:high \
     "Reply with exactly: OK"
   ```

   Then check a turn that runs many server-side calls. The prompt result's
   usage is the turn's billing aggregate, while `usage_update` reports the
   request's context, so the footer must stay small: a verified turn of sixteen
   reads reported an aggregate of 2,273,186 tokens (216.8% of the 1,048,576
   window) and a context of 53,378 (5.1%). Pi showed 5% and did not compact;
   the next prompt continued in the same session instead of hitting the
   proactive threshold.

   On gbig04 the raw ACP handshake answered `initialize` in 3.5 s, and a
   `gemini-4-neon` prompt with thought level `high` returned `end_turn` in 9.4 s
   including server startup.

## Logging in on a headless host

The login forwards the server's stderr to the dialog. When the server prints its
Google sign-in URL, the dialog shows that URL with an `ssh -L` hint naming the
callback port it opened, and offers a paste field. Three ways to finish:

- **Same machine with a browser** — the dialog opens the URL; nothing else is
  needed.
- **Forward the callback port** — run
  `ssh -L <port>:127.0.0.1:<port> <this host>` from your workstation before
  opening the URL.
- **Paste the redirect URL or code** — sign in anywhere, then paste either the
  URL you were redirected to (`http://127.0.0.1:<port>/?code=…&state=…`) or just
  the `code` value. Pi forwards it to the server's own loopback listener, so the
  server still validates the state and performs the token exchange; Pi writes
  no credential of its own. Submitting an empty line keeps waiting for the
  browser, and the request timeout is extended to the five-minute login window
  so a headless sign-in is not cut short.

The dialog does not open the URL for you; use `ctrl+click` or `ctrl+x` to copy
it. Expect it roughly a minute after the dialog appears, because the server
first tries to launch a browser of its own and only then prints the URL. If the
sign-in cannot complete, the dialog shows the server's error (an expired or
reused code reports `Onboarding failed: The authentication flow did not complete
successfully.`) and you can run `/login google-antigravity-acp` again.

Copying the token (step 3) remains the fastest option when another machine is
already signed in to the same account.

`pi auth login google-antigravity-acp` and `pi auth check --provider` cover only
built-in providers and answer `Unknown provider` / `provider_not_found` for this
extension provider; use `/login` in the TUI, or `pi -p --model` for a check.

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

See [antigravity-jetski-probe.md](antigravity-jetski-probe.md) for the unreached
`JetskiRemoteAgentProxyService/ListAvailableModels` alternative, the headless
probe that showed its token requires an interactive sign-in, and the case for
dropping that probe.
