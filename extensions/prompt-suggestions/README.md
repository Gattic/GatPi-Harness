# Pi prompt suggestions extension

Project/package-local Pi extension that adds prompt suggestions without patching Pi core.

## Enable

Install/symlink into an auto-discovered extension directory:

```bash
scripts/install-prompt-suggestions-extension.sh
```

Or manually:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD/extensions/prompt-suggestions" ~/.pi/agent/extensions/prompt-suggestions
```

Or add this directory to Pi settings as an extension/package source.

Restart Pi to activate the extension.

**Shared-library changes require a fresh Pi process, not `/reload`.** Libraries under `src/`, including `prompt-suggestion-model.js` and `prompt-suggestion-policy.js`, are loaded through native `createRequire` and can remain in Node's CommonJS cache after an extension reload. Exit Pi and start it again when updating these libraries so the new model and cancellation behavior takes effect.

## Choose the suggestion model

Prompt suggestions use a Pi model that is separate from the session model. The choice is machine-wide and remembered in the agent directory:

```bash
/prompt-suggestions-model openai-codex/gpt-6-astra
```

With no argument, the command opens a picker of models whose providers have working authentication. The saved configuration is:

```text
<agent-dir>/prompt-suggestions.json
```

```json
{
  "schemaVersion": 1,
  "provider": "openai-codex",
  "modelId": "gpt-6-astra",
  "updatedAt": "2026-11-05T00:00:00.000Z"
}
```

`<agent-dir>` defaults to `~/.pi/agent` and follows `PI_CODING_AGENT_DIR`. Changing the session model with `/model` does not change this setting, and changing this setting does not change the session model. If no model is configured, deterministic local suggestions still work and model refinement is skipped. The extension never invokes Hermes.

## Behavior

- On an existing/non-empty chat, precomputes an empty-prompt suggestion for a likely next step at Pi's post-retry `agent_settled` boundary.
- Model-prompt submission cancels in-flight refinement and consumes automatic suggestions until `agent_settled`, not merely until the session leaf changes. Pre-prompt compaction can advance the leaf and restore Pi's idle state before agent start; neither rendering nor Tab can resurrect the previous hint during that gap. Consumption does not mark Pi busy and has no timer. Explicit Ctrl+R retry overrides consumption while Pi is idle, allowing recovery after failed preflight without an agent turn. A new editor/session also starts unconsumed.
- Registered extension commands that do not start a model turn, including `/policy-approve` and `/policy-approve-directory`, preserve the cached suggestion. It reappears when the editor clears, with Tab acceptance and the shared suggestion unchanged; no Ctrl+R or replacement refinement is needed. A command that sends model input consumes the suggestion before preflight. Prompt templates, skills, and unknown slash commands still consume suggestions on submission.
- A deterministic local suggestion is shown first so the editor remains responsive even when the configured model is slow or unavailable. It uses the original labelled-next-step and categorical fallback behavior.
- The configured model then runs as an optional background refinement for the same empty-prompt state and may replace the local suggestion. Refinement defaults to evidence-gated `auto`, where incomplete evidence permits one attempt per new idle state and unrestricted refinement requires the acceptance and non-timeout reliability bars. Suggestions are cancellable background work without request deadlines or readiness cooldowns.
- The model aims for a concise prompt, but modest length overruns are preserved rather than cut off. Already-truncated, excessively long, or over-line-limit refinements are rejected so the complete local suggestion remains visible.
- Suggestions may span multiple lines when a structured prompt is more useful; multiline and long single-line suggestions are wrapped into adjacent hint lines.
- A small `suggesting…` indicator is shown while a suggestion/refinement request is in flight.
- Tab accepts the visible suggestion into the editor, preserving any suggestion newlines.
- Tab does not submit.
- Ctrl+R immediately retries/retriggers the empty-prompt suggestion for the current session state. Manual retry bypasses the automatic evidence gate while refinement remains enabled.
- Status clients such as Android pi-dash can request the same manual retry through `pi.events.emit("prompt-suggestion:request", { respond })`. The callback runs synchronously with `null` when generation was accepted, or a user-facing error string when unavailable. Acceptance starts generation, not a model turn; the result arrives through `prompt-suggestion:changed`. This preserves both desktop and client drafts. The extension must be enabled, Pi idle with an existing conversation, and the desktop editor empty. Local suggestions can repeat; model refinement follows the same policy as Ctrl+R.
- Escape dismisses the visible suggestion without changing text and cancels in-flight refinement. Acceptance, typing, new agent turns, and shutdown/reload also cancel unused work.
- Slash commands, bash prompts (`!`), multiline text with content after the cursor, and normal Enter submit behavior are left alone.
- Current-prompt autocomplete has been removed; the configured model is used only for empty-prompt next-step suggestions.
- Every change of the session's current suggestion is emitted on the extension event bus as `prompt-suggestion:changed` with the suggestion text, or `null` while Pi works, after model-prompt submission, and on shutdown. It does not depend on this editor's typed text or Escape dismissal, so status consumers such as the pi-dash session dashboard can offer the suggestion in their own prompt input.

## Configuration

Environment variables:

- `PI_PROMPT_SUGGESTIONS=0` disables the extension behavior.
- `PI_PROMPT_SUGGESTIONS_REFINE=off|auto|1` disables model refinement, enables the default evidence-gated cohort, or explicitly forces automatic refinement on while keeping deterministic local suggestions.
- `PI_PROMPT_SUGGESTIONS_REFINE_MIN_ATTEMPTS=20`, `PI_PROMPT_SUGGESTIONS_REFINE_MIN_ACCEPTANCE_RATE=0.20`, `PI_PROMPT_SUGGESTIONS_REFINE_MAX_FAILURE_RATE=0.25`, and `PI_PROMPT_SUGGESTIONS_REFINE_WINDOW_DAYS=30` tune the evidence gate.
- `PI_PROMPT_SUGGESTIONS_CONTEXT_CHARS=6000` sets the total scanner-redacted recent-context cap (bounded to 1,000–12,000).
- `PI_PROMPT_SUGGESTIONS_MODEL=provider/modelId` overrides the saved machine-wide model for the current process.
- `PI_PROMPT_SUGGESTIONS_CONFIG=<path>` overrides the configuration file path.
- `PI_PROMPT_SUGGESTION_ACCEPT_KEY=ctrl+space` changes the accept key. Defaults to `tab`.
- `PI_PROMPT_SUGGESTION_RETRY_KEY=ctrl+r` changes the retry/retrigger key. Defaults to `ctrl+r`.

The prompt packet restores the original eight-message recent-context semantics as one scanner-redacted string, capped at 900 characters per public text message and 6,000 characters total by default, plus bounded public skill telemetry. It never contains raw session objects, unredacted tool output, private reasoning, secrets, command arguments, or absolute paths. Model input and output are scanned before use.

## Status and observability

Run `/prompt-suggestions` to show whether the extension is active, the refinement policy, the configured model and whether it is available, the configuration path, the configured accept/retry keys, idle/working gate state, the current editor cache state/source, and the latest fixed categorical refinement failure reason. Metadata-only telemetry stores the same reason code without provider error text or session content.

Run `/prompt-suggestions-model` with no argument to choose the machine-wide model, or pass `provider/modelId` directly.

## Limits

This extension cannot render true inline ghost text inside Pi's built-in editor without core support. It uses Pi's supported custom editor API and renders the suggestion as adjacent hint line(s) below the editor.
