import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const {
  aliasProviderId,
  loadConfig,
  CooldownStore,
  DirectoryModelStore,
  isAccountFailure,
  expandPriority,
  describeCandidates,
  nextCandidate,
  createAliasProvider,
} = require(join(LIB_ROOT, "src", "multi-login.js"));
const { withAnthropicOAuth } = require(join(LIB_ROOT, "src", "anthropic-oauth.js"));
const { instrumentExtensionCommands } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

const EXTENSION_VERSION = "multi-login-2026-10-12.1";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

export default function multiLogin(pi: ExtensionAPI) {
  pi = instrumentExtensionCommands(pi, { extension: "multi-login", version: EXTENSION_VERSION }) as ExtensionAPI;
  const config = loadConfig({ agentDir: AGENT_DIR, defaultFile: join(LIB_ROOT, "config", "multi-login.json") });
  const bases = new Map(builtinProviders().map((provider: any) => [provider.id, provider]));
  // Register the shaped base as well as using it for aliases; native auth remains unchanged.
  const anthropic = withAnthropicOAuth(bases.get("anthropic"));
  bases.set("anthropic", anthropic);
  pi.registerProvider(anthropic);
  for (const [baseId, count] of Object.entries(config.accounts) as [string, number][]) {
    const base = bases.get(baseId);
    if (!base) throw new Error(`multi-login: ${config.file}: accounts.${baseId} is not a built-in provider`);
    // Login 1 is the built-in provider itself; logins 2..count are aliases.
    for (let index = 2; index <= count; index++) {
      pi.registerProvider(createAliasProvider(base, aliasProviderId(baseId, index), index));
    }
  }

  // Isolated children need the same OAuth providers and login aliases, but
  // their inherited model is fixed: no failover, cooldowns or directory writes.
  if (process.env.PI_SUBAGENT_PARENT_ID) return;

  const cooldowns = new CooldownStore(join(AGENT_DIR, "multi-login-state.json"));
  const directoryModels = new DirectoryModelStore(join(AGENT_DIR, "multi-login-models"));
  const entries = expandPriority(config.priority, config.accounts);
  let restoringModel = false;

  pi.on("model_select", (event, ctx) => {
    // Restoring history or a directory default is not a new choice. Failover's setModel is.
    if (!restoringModel && event.source !== "restore") directoryModels.write(ctx.cwd, event.model);
  });

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "new") return;
    // Explicit CLI selection and existing conversation history take precedence over defaults.
    if (process.argv.slice(2).some((arg) => /^(--model|--provider|--models)(=|$)/.test(arg))) return;
    if (ctx.sessionManager.getBranch().some((entry) => entry.type === "message")) return;
    const saved = directoryModels.read(ctx.cwd);
    if (!saved) {
      if (ctx.model) directoryModels.write(ctx.cwd, ctx.model);
      return;
    }
    if (ctx.model && ctx.model.provider === saved.provider && ctx.model.id === saved.modelId) return;
    const model = ctx.modelRegistry.find(saved.provider, saved.modelId);
    const previous = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
    // Pi throws when the saved provider has no usable credential, so a failed
    // restore must not abort session_start or replace the current model.
    restoringModel = true;
    let switched = false;
    try {
      switched = model !== undefined && (await pi.setModel(model));
    } catch {
      switched = false;
    } finally {
      restoringModel = false;
    }
    // A restore is never silent: the session was started on another provider/model than the one saved for this directory.
    if (switched) {
      ctx.ui.notify(`multi-login: restored saved directory model ${saved.provider}/${saved.modelId} (was ${previous}).`, "info");
    } else {
      ctx.ui.notify(`multi-login: saved directory model ${saved.provider}/${saved.modelId} is unavailable; keeping the current model.`, "warning");
    }
  });

  pi.on("message_end", async (event: any, ctx: any) => {
    const message = event.message;
    if (message?.role !== "assistant" || !isAccountFailure(message)) return;
    const until = cooldowns.coolDown(message.provider, config.cooldownMinutes);
    const next = nextCandidate({ provider: message.provider, id: message.model }, entries, ctx.modelRegistry, cooldowns.read());
    const unavailable = `multi-login: ${message.provider} is unavailable until ${new Date(until).toLocaleTimeString()} (${message.errorMessage}).`;
    if (!next) {
      ctx.ui?.notify?.(`${unavailable} No lower account in the priority list is usable.`, "error");
      return;
    }
    let switched = false;
    try {
      switched = await pi.setModel(next.model);
    } catch {
      switched = false;
    }
    if (!switched) {
      ctx.ui?.notify?.(`${unavailable} Could not switch to ${next.ref}; no lower account is usable.`, "error");
      return;
    }
    ctx.ui?.notify?.(`${unavailable} Switched to ${next.ref}.`, "warning");
    // Pi retries only errors it classifies as transient, and retries on the session model.
    // Restate the failure as a rate limit so the turn is retried on the model just selected.
    return {
      message: {
        ...message,
        errorMessage: `multi-login: account unavailable; retrying on ${next.ref} (rate limit retry): ${message.errorMessage}`,
      },
    };
  });

  pi.registerCommand("multi-login", {
    description: "Show multi-login accounts and failover order; '/multi-login reset' clears cooldowns",
    handler: async (args: string, ctx: any) => {
      if (args.trim() === "reset") {
        cooldowns.clear();
        ctx.ui.notify("multi-login: cooldowns cleared", "info");
        return;
      }
      const lines = [
        `config: ${config.file}`,
        `logins: /login <provider> for ${[...new Set(entries.map((e: any) => e.provider))].join(", ")}`,
        "on a usage limit or auth failure the session moves to the next usable entry below its model:",
        ...describeCandidates(entries, ctx.modelRegistry, cooldowns.read()).map(
          (c: any, i: number) => `  ${i + 1}. ${c.ref} — ${c.unavailable ?? "ready"}`,
        ),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
