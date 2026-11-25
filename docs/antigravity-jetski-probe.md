# Jetski remote-agent proxy probe (unreached)

`JetskiRemoteAgentProxyService/ListAvailableModels` is the IDE language
server's remote-agent surface for enumerating served experiences (Neon,
Carbon and others). It was investigated as an alternative to the ACP provider
that now serves those models in Pi. This note records why it stays unrun and
what each remaining path costs.

## What was tried

The bundled `language_server` 1.5.2 was started headless, exactly as the IDE
does it, with a fresh CSRF token:

```
resources/bin/language_server --standalone --override_ide_name antigravity \
  --subclient_type hub --override_ide_version 1.5.2 \
  --override_user_agent_name antigravity --https_server_port 0 \
  --app_data_dir antigravity \
  --api_server_url https://generativelanguage.googleapis.com \
  --cloud_code_endpoint https://daily-cloudcode-pa.googleapis.com \
  --enable_sidecars --headless
```

It served RPCs on `https://127.0.0.1:37343` (the plain-HTTP discovery port is
separate). With `x-codeium-csrf-token` set from `ANTIGRAVITY_SERVER_CSRF_TOKEN`:

| Probe | Result |
| --- | --- |
| `LanguageServerService/GetUpdateStatus` | 200 |
| `LanguageServerService/GetAuthStatus` | `{"authResult":{}}` — no account |
| `LanguageServerService/GetHubOAuthAccessTokenHeadless` | 404 — no such endpoint |
| LS log | "error getting token source: You are not logged into Antigravity", "[RemoteControl] No signed-in account, staying disconnected", `proxyServerURL: ""` |

Nothing is stored to copy: `~/.config/antigravity/plugin-secrets.json` does not
exist (the directory holds only `credential-user-scope`, a user id), and the
Chromium profile holds only `agy_session_csrf_token`, a CSRF cookie rather than
an OAuth token. The LS mints the credential named
`jetski-standalone-oauth-token` into its file-based secret store only after
`LoginWithBrowser`/`LoginAUTO`, both browser flows. The token is therefore not
obtainable non-interactively.

## Path A — interactive sign-in, then retry the probe

1. Launch the IDE and sign in with the Google account that holds the
   entitlement.
2. Confirm the LS sees the account: `GetAuthStatus` returns a populated
   `authResult`, and the LS log shows "Auth succeeded".
3. Read the credential from `~/.config/antigravity/plugin-secrets.json`
   (mode 600). Keep the token out of the repository, transcripts and logs.
4. POST to the LS or AICode endpoint with that bearer token, for example
   `/google.gca.aicode.v1main.JetskiRemoteAgentProxyService/ListAvailableModels`,
   and compare the returned experiences with the ACP catalog
   (`pi --list-models antigravity`).

Costs and risks: the sign-in is manual; the token rotates and expires; the
protobuf is undocumented; the OAuth client is scoped to Google's IDE, so
driving it from another client is outside the grant; and the entitlement may
not expose anything the ACP provider lacks.

## Path B — drop the proxy probe

The ACP provider already serves Neon and Carbon with request-level context
accounting, tool authority through Pi's policy, tests and a live end-to-end
verification. The proxy would add remote-agent enumeration and cascade
metadata, which nothing in Pi consumes today. Dropping the probe keeps the
supported path, avoids an interactive credential with an undocumented,
entitlement-dependent surface, and loses no capability Pi currently uses.

## Recommendation

Path B. If the remote-agent surface is ever needed, treat Path A as a manual,
per-machine investigation documented here rather than an automated step.
