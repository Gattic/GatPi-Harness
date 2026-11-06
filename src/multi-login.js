"use strict";

// Multiple logins per provider plus prioritized failover between them.
// Pure logic used by extensions/multi-login; Pi APIs are passed in.
// The user selects a normal model; when its account fails, the session moves to the next usable
// entry of the expanded priority list (each model on login 1, then on logins 2..N).

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

// Explicit exhausted usage or authentication failures make an account unusable.
// A generic 429/rate limit can be temporary throttling, not an exhausted subscription;
// leave those errors and the selected model alone so Pi/user retries stay on that account.
const ACCOUNT_FAILURE_PATTERN = new RegExp(
  [
    "usage[ _-]?limit",
    "insufficient[ _-]?(?:quota|credits|balance)",
    "(?:out of|no more) (?:extra )?(?:usage|credits|quota|budget)",
    "(?:exceeded|exhausted|reached) (?:your )?(?:current )?(?:quota|usage|credit|budget)(?: limit)?",
    "(?:quota|usage|credits|budget) (?:is |are |has been )?(?:exhausted|depleted)",
    "credit balance is too low",
    "billing_hard_limit_reached",
    "\\b401\\b",
    "\\b403\\b",
    "unauthori[sz]ed",
    "authentication_error",
    "invalid.{0,20}(?:api.?key|token)",
    "token (?:refresh failed|has expired|expired|has been invalidated)",
    "no api key",
  ].join("|"),
  "i",
);

function aliasProviderId(base, index) {
  return `${base}-account-${index}`;
}

function parseModelRef(ref) {
  const slash = String(ref).indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) throw new Error(`multi-login: invalid model reference "${ref}"; expected provider/model`);
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

function validateConfig(config, source) {
  const fail = (message) => {
    throw new Error(`multi-login: ${source}: ${message}`);
  };
  if (!config || typeof config !== "object") fail("expected a JSON object");
  const accounts = config.accounts ?? {};
  if (typeof accounts !== "object" || Array.isArray(accounts)) fail("accounts must map provider ids to login counts");
  for (const [provider, count] of Object.entries(accounts)) {
    if (!Number.isInteger(count) || count < 1) fail(`accounts.${provider} must be an integer >= 1`);
  }
  if (!Array.isArray(config.priority) || config.priority.length === 0) fail("priority must be a non-empty list of provider/model");
  const priority = config.priority.map(parseModelRef);
  const cooldownMinutes = config.cooldownMinutes ?? 60;
  if (typeof cooldownMinutes !== "number" || !(cooldownMinutes > 0)) fail("cooldownMinutes must be a positive number");
  return { accounts, priority, cooldownMinutes };
}

// The user's agent-dir config replaces the harness default as a whole.
function loadConfig({ agentDir, defaultFile }) {
  const userFile = path.join(agentDir, "multi-login.json");
  const file = fs.existsSync(userFile) ? userFile : defaultFile;
  return { file, ...validateConfig(JSON.parse(fs.readFileSync(file, "utf8")), file) };
}

class CooldownStore {
  constructor(file, now = () => Date.now()) {
    this.file = file;
    this.now = now;
  }

  read() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
    const now = this.now();
    return Object.fromEntries(Object.entries(raw.cooldowns ?? {}).filter(([, until]) => until > now));
  }

  write(cooldowns) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ cooldowns }, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }

  coolDown(provider, minutes) {
    const cooldowns = this.read();
    cooldowns[provider] = this.now() + minutes * 60_000;
    this.write(cooldowns);
    return cooldowns[provider];
  }

  clear() {
    this.write({});
  }
}

// One atomic record per directory avoids lost updates between sessions in different projects.
// Hash the absolute cwd so paths are not exposed in filenames or persisted model records.
class DirectoryModelStore {
  constructor(dir) {
    this.dir = dir;
  }

  fileFor(cwd) {
    const key = createHash("sha256").update(path.resolve(cwd)).digest("hex");
    return path.join(this.dir, `${key}.json`);
  }

  read(cwd) {
    const file = this.fileFor(cwd);
    let selection;
    try {
      selection = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
    if (!selection || typeof selection.provider !== "string" || !selection.provider ||
        typeof selection.modelId !== "string" || !selection.modelId) {
      throw new Error(`multi-login: invalid directory model selection in ${file}`);
    }
    return selection;
  }

  write(cwd, model) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.fileFor(cwd);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ provider: model.provider, modelId: model.id })}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}

function isAccountFailure(message) {
  return message?.stopReason === "error" && ACCOUNT_FAILURE_PATTERN.test(message.errorMessage ?? "");
}

/** Each priority model on login 1, then on its alias logins, in order. */
function expandPriority(priority, accounts) {
  return priority.flatMap(({ provider, modelId }) =>
    Array.from({ length: accounts[provider] ?? 1 }, (_, i) => ({
      provider: i === 0 ? provider : aliasProviderId(provider, i + 1),
      modelId,
    })),
  );
}

/** Expanded entries with their resolved model and why they are unusable, if they are. */
function describeCandidates(entries, registry, cooldowns) {
  return entries.map(({ provider, modelId }) => {
    const model = registry.find(provider, modelId);
    let unavailable;
    if (!model) unavailable = "unknown model";
    else if (!registry.hasConfiguredAuth(model)) unavailable = "not signed in";
    else if (cooldowns[provider]) unavailable = `cooling down until ${new Date(cooldowns[provider]).toISOString()}`;
    return { ref: `${provider}/${modelId}`, provider, model, unavailable };
  });
}

/**
 * The next usable entry below the failed model. A model outside the list falls back to the top.
 * The list never wraps: a deliberately chosen lower model does not jump back up.
 */
function nextCandidate(failed, entries, registry, cooldowns) {
  const index = entries.findIndex((e) => e.provider === failed.provider && e.modelId === failed.id);
  return describeCandidates(entries.slice(index + 1), registry, cooldowns).find((c) => !c.unavailable);
}

/**
 * A provider with the same models, API, and login flows as `base` under a new id, so each alias
 * keeps its own credential in auth.json. Aliases use only their stored credential, never the
 * base provider's ambient environment keys.
 */
function createAliasProvider(base, id, index) {
  const rename = (model) => ({ ...model, provider: id });
  const apiKey = base.auth.apiKey && {
    name: `${base.auth.apiKey.name} (account ${index})`,
    ...(base.auth.apiKey.login ? { login: (interaction) => base.auth.apiKey.login(interaction) } : {}),
    resolve: async ({ credential }) =>
      credential?.key ? { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" } : undefined,
  };
  const oauth = base.auth.oauth && { ...base.auth.oauth, name: `${base.auth.oauth.name} (account ${index})` };
  return {
    id,
    name: `${base.name} (account ${index})`,
    baseUrl: base.baseUrl,
    headers: base.headers,
    auth: { ...(apiKey ? { apiKey } : {}), ...(oauth ? { oauth } : {}) },
    getModels: () => base.getModels().map(rename),
    ...(base.getAllModels ? { getAllModels: () => base.getAllModels().map(rename) } : {}),
    ...(base.filterModels ? { filterModels: (models, credential) => base.filterModels(models, credential) } : {}),
    stream: (model, context, options) => base.stream(model, context, options),
    streamSimple: (model, context, options) => base.streamSimple(model, context, options),
  };
}

module.exports = {
  aliasProviderId,
  loadConfig,
  validateConfig,
  CooldownStore,
  DirectoryModelStore,
  isAccountFailure,
  expandPriority,
  describeCandidates,
  nextCandidate,
  createAliasProvider,
};
