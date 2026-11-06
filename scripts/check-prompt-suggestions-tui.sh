#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

ext="$(pwd)/extensions/prompt-suggestions/index.ts"
log="${TMPDIR:-/tmp}/pi-prompt-suggestions-tui-$$.log"
auto_log="${TMPDIR:-/tmp}/pi-prompt-suggestions-auto-tui-$$.log"
requests_log="${TMPDIR:-/tmp}/pi-prompt-suggestions-model-requests-$$.log"
trap 'rm -f "$log" "$log.clean" "$auto_log" "$auto_log.clean" "$requests_log"' EXIT

if ! command -v script >/dev/null 2>&1; then
  printf 'skip - script(1) unavailable for prompt suggestions TUI smoke; install util-linux/bsdutils to run it\n'
  exit 0
fi

workdir="$(mktemp -d)"
server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; fi
  rm -rf "$workdir"
  rm -f "$log" "$log.clean" "$auto_log" "$auto_log.clean" "$requests_log"
}
trap cleanup EXIT

# Deterministic local OpenAI-compatible provider. No Hermes install, binary, or
# environment variable is involved; the configured suggestion model is exercised
# through Pi's normal provider-neutral model registry.
cat >"$workdir/server.js" <<'NODE'
const fs = require("node:fs");
const http = require("node:http");
const log = process.argv[2];
const portFile = process.argv[3];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    fs.appendFileSync(log, `${body}\n`);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "suggestion", choices: [{ index: 0, delta: { role: "assistant", content: "Confirm automatic suggestions now appear without Ctrl+R" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "suggestion", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
NODE
node "$workdir/server.js" "$requests_log" "$workdir/port" &
server_pid=$!
for _ in $(seq 1 100); do [[ -s "$workdir/port" ]] && break; sleep 0.05; done
if [[ ! -s "$workdir/port" ]]; then
  printf 'prompt suggestions TUI validation could not start its local fixture provider\n' >&2
  exit 1
fi
port="$(cat "$workdir/port")"

cat >"$workdir/provider.ts" <<TS
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("fixture", {
    name: "Prompt Suggestion Fixture",
    baseUrl: "http://127.0.0.1:$port/v1",
    apiKey: "fixture-key",
    api: "openai-completions",
    models: [
      {
        type: "chat",
        id: "suggestion",
        name: "Suggestion Fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
  });
}
TS

cat >"$workdir/prompt-suggestions.json" <<'JSON'
{"schemaVersion":1,"provider":"fixture","modelId":"suggestion"}
JSON

provider_ext="$workdir/provider.ts"
config_file="$workdir/prompt-suggestions.json"

# Typing into an empty session must not invoke the configured model.
(
  sleep 2
  printf 'fix'
  sleep 4
  printf '\003'
  sleep 1
  printf '\003'
) | timeout 180 script -q -f -c "PI_PROMPT_SUGGESTIONS_CONFIG='$config_file' PI_PROMPT_SUGGESTIONS_MODEL='' pi --no-session --no-extensions -e '$provider_ext' -e '$ext'" "$log" >/dev/null || true

if [[ ! -s "$log" ]]; then
  printf 'prompt suggestions TUI validation did not produce a session log: %s\n' "$log" >&2
  exit 1
fi
perl -0777 -pe 's/\e\[[0-9;?]*[ -\/]*[@-~]//g; s/\r//g' "$log" >"$log.clean"
if grep -q 'the failing tests\|Confirm automatic suggestions' "$log.clean"; then
  printf 'prompt suggestions TUI validation unexpectedly observed a suggestion while typing; log: %s\n' "$log" >&2
  exit 1
fi
if [[ -s "$requests_log" ]]; then
  printf 'prompt suggestions TUI validation unexpectedly called the model while typing; request log: %s\n' "$requests_log" >&2
  exit 1
fi

# Resume a deterministic completed turn. The empty editor should schedule
# automatically and send the scanner-redacted eight-message context through the
# configured model. The tool result is cut at `/home/` by the extension's
# 900-character source bound, exercising the truncation/privacy regression before
# an explicit Ctrl+R retry.
session_file="$workdir/session.jsonl"
node - "$session_file" "$workdir" <<'NODE'
const fs = require("node:fs");
const [file, cwd] = process.argv.slice(2);
const entries = [
  { type: "session", version: 3, id: "prompt-suggestion-tui-fixture", timestamp: "2026-08-24T00:00:00.000Z", cwd },
  { type: "message", id: "user-1", parentId: null, timestamp: "2026-08-24T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Repair automatic prompt suggestions." }] } },
  { type: "custom_message", id: "context-1", parentId: "user-1", timestamp: "2026-08-24T00:00:02.000Z", customType: "cognitive-automation", content: "## Cognitive integration boundary context\n\n### Active objective\nRepair automatic prompt suggestions.\n\n### Constraints and safety\nnone", display: false },
  { type: "message", id: "tool-1", parentId: "context-1", timestamp: "2026-08-24T00:00:03.000Z", message: { role: "toolResult", toolCallId: "tool-call-1", toolName: "read", content: [{ type: "text", text: `${"x".repeat(894)}/home/private/path` }], isError: false, timestamp: Date.parse("2026-08-24T00:00:03.000Z") } },
  { type: "message", id: "assistant-1", parentId: "tool-1", timestamp: "2026-08-24T00:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "## Repair result\n\nAll checks passed. The working tree is clean." }], stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
];
fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
NODE
: >"$requests_log"
(
  sleep 6
  printf '\022'
  sleep 3
  printf '\003'
  sleep 1
  printf '\003'
) | timeout 180 script -q -f -c "cd '$workdir' && PI_PROMPT_SUGGESTIONS_CONFIG='$config_file' PI_PROMPT_SUGGESTIONS_MODEL='' pi --session '$session_file' --no-extensions -e '$provider_ext' -e '$ext'" "$auto_log" >/dev/null || true

if [[ ! -s "$auto_log" ]]; then
  printf 'automatic prompt suggestion TUI validation did not produce a session log: %s\n' "$auto_log" >&2
  exit 1
fi
perl -0777 -pe 's/\e\[[0-9;?]*[ -\/]*[@-~]//g; s/\r//g' "$auto_log" >"$auto_log.clean"
if ! grep -Fq 'Return ONLY one concise, complete prompt for the best next step.' "$requests_log"; then
  printf 'automatic prompt suggestion did not restore the original instruction; request log: %s\n' "$requests_log" >&2
  exit 1
fi
if ! grep -Fq '[user] Repair automatic prompt suggestions.' "$requests_log"; then
  printf 'automatic prompt suggestion did not send the bounded recent user context to the model; request log: %s\n' "$requests_log" >&2
  exit 1
fi
if ! grep -Fq '[assistant] ## Repair result All checks passed. The working tree is clean.' "$requests_log"; then
  printf 'automatic prompt suggestion did not send the bounded recent assistant context to the model; request log: %s\n' "$requests_log" >&2
  exit 1
fi
if grep -Fq '/home/' "$requests_log"; then
  printf 'prompt suggestion leaked a home-directory prefix cut at the context boundary; request log: %s\n' "$requests_log" >&2
  exit 1
fi
prompt_requests="$(grep -Fc 'Return ONLY one concise, complete prompt for the best next step.' "$requests_log" || true)"
if (( prompt_requests < 2 )); then
  printf 'Ctrl+R did not force a second prompt suggestion request; observed %s request(s); request log: %s\n' "$prompt_requests" "$requests_log" >&2
  exit 1
fi
if ! grep -Fq 'Confirm automatic suggestions now appear without Ctrl+R' "$auto_log.clean"; then
  printf 'automatic model refinement was not shown without manual retry; log: %s\n' "$auto_log" >&2
  exit 1
fi

printf 'prompt suggestions TUI smoke passed\n'
