#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createObsidianAdapter,
  obsidianProjectSnapshot,
  obsidianDoctor,
} = require("../src/obsidian-adapter");
const { HermesAdvisoryAdapter } = require("../src/integration-boundary.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("obsidian-readiness-");
const vault = path.join(tmp, "vault");
const alternateVault = path.join(tmp, "alternate-vault");
fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
fs.mkdirSync(path.join(alternateVault, ".obsidian"), { recursive: true });
fs.writeFileSync(path.join(vault, "source.md"), "# Source\nPrivate source body must not enter readiness telemetry.\n");
const fakeObsidian = path.join(tmp, "obsidian");
fs.writeFileSync(fakeObsidian, "#!/usr/bin/env node\nprocess.exit(0);\n");
fs.chmodSync(fakeObsidian, 0o755);

function fakeHermes(name, mode, pidFile) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('hermes 9.9.9'); process.exit(0); }
if (args[0] === 'status') {
  ${mode === "auth-fail" ? "console.log('Authentication: not authenticated\\nProvider: fake-provider\\nModel: fake-model');" : "console.log('Authentication: ready\\nProvider: fake-provider\\nModel: fake-model');"}
  process.exit(0);
}
if (args.includes('-z')) {
  const isCuration = args.some((arg) => arg.includes('HERMES_ADVISORY_CURATION_OK'));
  if (isCuration) {
    ${mode === "curation-fail" ? "console.error('network transport unavailable'); process.exit(1);" : mode === "curation-timeout" ? `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); while (true) {}` : "console.log('HERMES_ADVISORY_CURATION_OK'); process.exit(0);"}
  }
  ${mode === "timeout-auth" ? `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); while (true) {}` : mode === "auth-fail" ? "console.error('Unauthorized API key SECRET_PROVIDER_TOKEN'); process.exit(1);" : mode === "provider-fail" ? "console.error('Model not found for provider fake-provider'); process.exit(1);" : "console.log('HERMES_ADVISORY_AUTH_OK'); process.exit(0);"}
}
if (args[0] === 'chat') { console.log('# Curated result\\nBounded fake-provider response.'); process.exit(0); }
process.exit(2);
`);
  fs.chmodSync(file, 0o755);
  return file;
}

const successHermes = fakeHermes("hermes-success", "success");
const authFailHermes = fakeHermes("hermes-auth-fail", "auth-fail");
const providerFailHermes = fakeHermes("hermes-provider-fail", "provider-fail");
const curationFailHermes = fakeHermes("hermes-curation-fail", "curation-fail");
const timeoutPid = path.join(tmp, "timeout.pid");
const timeoutHermes = fakeHermes("hermes-timeout", "timeout-auth", timeoutPid);
const curationTimeoutPid = path.join(tmp, "curation-timeout.pid");
const curationTimeoutHermes = fakeHermes("hermes-curation-timeout", "curation-timeout", curationTimeoutPid);

const localOnly = obsidianProjectSnapshot(tmp, { vault, bin: "definitely-missing-obsidian", hermesEnabled: false });
assert.equal(localOnly.readiness.vaultFilesystem.ready, true);
assert.equal(localOnly.selection.selectionId, localOnly.readiness.vaultFilesystem.selectionId);
assert.equal(localOnly.selection.projectKey, localOnly.readiness.vaultFilesystem.projectKey);
assert.match(localOnly.selection.pathHash, /^sha256:[a-f0-9]{64}$/);
assert.equal(localOnly.readiness.desktopExecutable.ready, false);
assert.equal(localOnly.readiness.localMarkdown.ready, true, "local Markdown operations do not require the desktop executable");
assert.equal(localOnly.ready, true);
assert.equal(localOnly.curationReady, false);
const missingHermes = obsidianProjectSnapshot(tmp, { vault, bin: fakeObsidian, hermesBin: "definitely-missing-hermes" });
assert.equal(missingHermes.readiness.hermesExecutable.ready, false);
assert.equal(missingHermes.readiness.localMarkdown.ready, true);
assert.equal(missingHermes.curationReady, false);

const layered = obsidianDoctor(tmp, { vault, bin: fakeObsidian, desktopOpen: false, hermesBin: successHermes, hermesProvider: "fake-provider", hermesModel: "fake-model" });
assert.equal(layered.readiness.vaultFilesystem.ready, true);
assert.equal(layered.readiness.desktopExecutable.ready, true);
assert.equal(layered.readiness.desktopOpen.status, "not-running");
assert.equal(layered.readiness.hermesExecutable.ready, true);
assert.equal(layered.readiness.hermesAuthentication.status, "not-probed");
assert.equal(layered.readiness.providerModel.ready, false);
assert.equal(layered.readiness.curation.eligible, false);
assert.equal(layered.curationReady, false, "local status does not overclaim end-to-end curation before a smoke probe");
assert.equal(layered.readiness.curation.status, "not-ready");
assert.deepEqual(layered.readiness.hermesCuration, layered.readiness.curation);
assert.equal(layered.selection.selectionId, localOnly.selection.selectionId, "status and doctor use the same vault selection");

const ctx = { cwd: tmp, sessionManager: { getSessionFile: () => path.join(tmp, "session.jsonl") } };
function createHermesObsidianAdapter(options) {
  return createObsidianAdapter({ ...options, hermesAdapterFactory: (context) => new HermesAdvisoryAdapter({ cwd: context.cwd, bin: options.hermesBin, provider: options.hermesProvider, model: options.hermesModel }) });
}

(async () => {
  const successAdapter = createHermesObsidianAdapter({ vault, bin: fakeObsidian, desktopOpen: false, hermesBin: successHermes, hermesProvider: "fake-provider", hermesModel: "fake-model", hermesKillGraceMs: 50 });
  const before = fs.readdirSync(vault, { recursive: true }).map(String).sort();
  const success = await successAdapter.doctor(ctx, { probeCuration: true, timeoutMs: 2000 });
  assert.equal(success.details.authProbe.ready, true);
  assert.equal(success.details.curationProbe.ready, true);
  assert.equal(success.details.curationProbe.noteWritten, false);
  assert.equal(success.details.curationReady, true);
  assert.equal(success.details.hermesEvidence.authReady, true);
  assert.equal(success.details.hermesEvidence.curationReady, true);
  assert.equal(success.details.readiness.curation.proofCurrent, true);
  const after = fs.readdirSync(vault, { recursive: true }).map(String).sort();
  assert.deepEqual(after, before, "doctor curation smoke is dry-run and writes no vault note");

  const defaultProofAdapter = createHermesObsidianAdapter({ vault, bin: fakeObsidian, desktopOpen: false, hermesBin: successHermes, hermesKillGraceMs: 50 });
  const defaultProofDoctor = await defaultProofAdapter.doctor(ctx, { probeCuration: true, timeoutMs: 2000 });
  assert.equal(defaultProofDoctor.details.curationReady, true);
  const defaultProofStatus = await defaultProofAdapter.status(ctx);
  assert.equal(defaultProofStatus.details.readiness.providerModel.ready, true, "current auth proof establishes default provider/model readiness without a status subprocess");
  assert.equal(defaultProofStatus.details.readiness.providerModel.provider, "configured-default");
  assert.equal(defaultProofStatus.details.readiness.curation.ready, true);
  assert.doesNotMatch(defaultProofStatus.content[0].text, /provider-model-unknown/);

  const overriddenStatus = await defaultProofAdapter.status(ctx, { vault: alternateVault });
  assert.equal(overriddenStatus.details.vault.path, alternateVault, "explicit status vault must override adapter configuration");
  assert.equal(overriddenStatus.details.selection.source, "explicit");
  const overriddenDoctor = await defaultProofAdapter.doctor(ctx, { vault: alternateVault });
  assert.equal(overriddenDoctor.details.vault.path, alternateVault, "explicit doctor vault must override adapter configuration");
  assert.equal(overriddenDoctor.details.selection.source, "explicit");

  const failedAdapter = createHermesObsidianAdapter({ vault, bin: fakeObsidian, hermesBin: authFailHermes, hermesKillGraceMs: 50 });
  const failed = await failedAdapter.doctor(ctx, { probeAuth: true, timeoutMs: 1500 });
  assert.equal(failed.details.authProbe.ready, false);
  assert.equal(failed.details.authProbe.category, "authentication");
  assert.equal(failed.details.curationReady, false);
  const serializedFailure = JSON.stringify(failed.details);
  assert.doesNotMatch(serializedFailure, /SECRET_PROVIDER_TOKEN/);
  assert.doesNotMatch(serializedFailure, /Reply with exactly/);

  const providerAdapter = createHermesObsidianAdapter({ vault, bin: fakeObsidian, hermesBin: providerFailHermes, hermesKillGraceMs: 50 });
  const providerFailed = await providerAdapter.doctor(ctx, { probeAuth: true, timeoutMs: 1500 });
  assert.equal(providerFailed.details.authProbe.category, "provider-model");
  assert.equal(providerFailed.details.readiness.providerModel.ready, false);

  const curationFailAdapter = createHermesObsidianAdapter({ vault, bin: fakeObsidian, hermesBin: curationFailHermes, hermesKillGraceMs: 50 });
  const curationFailed = await curationFailAdapter.doctor(ctx, { probeCuration: true, timeoutMs: 1500 });
  assert.equal(curationFailed.details.authProbe.ready, true);
  assert.equal(curationFailed.details.curationProbe.ready, false);
  assert.equal(curationFailed.details.curationProbe.category, "transport");
  assert.equal(curationFailed.details.curationReady, false);

  const timeoutAdapter = createHermesObsidianAdapter({ vault, bin: fakeObsidian, hermesBin: timeoutHermes, hermesKillGraceMs: 50 });
  const timedOut = await timeoutAdapter.doctor(ctx, { probeAuth: true, timeoutMs: 1000 });
  assert.equal(timedOut.details.authProbe.ready, false);
  assert.equal(timedOut.details.authProbe.category, "timeout");
  const pid = Number(fs.readFileSync(timeoutPid, "utf8"));
  let alive = true;
  for (let i = 0; i < 20 && alive; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    try { process.kill(pid, 0); } catch { alive = false; }
  }
  assert.equal(alive, false, "timed-out Hermes probe must leave no surviving provider process");

  const curationTimeoutAdapter = createHermesObsidianAdapter({ vault, bin: fakeObsidian, hermesBin: curationTimeoutHermes, hermesKillGraceMs: 50 });
  const curationTimedOut = await curationTimeoutAdapter.doctor(ctx, { probeCuration: true, timeoutMs: 1000 });
  assert.equal(curationTimedOut.details.authProbe.ready, true);
  assert.equal(curationTimedOut.details.curationProbe.category, "timeout");
  const curationPid = Number(fs.readFileSync(curationTimeoutPid, "utf8"));
  let curationAlive = true;
  for (let i = 0; i < 20 && curationAlive; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    try { process.kill(curationPid, 0); } catch { curationAlive = false; }
  }
  assert.equal(curationAlive, false, "timed-out curation smoke must leave no surviving provider process");

  const sharedStateFile = path.join(tmp, ".pi", "hermes-advisory", "readiness.json");
  const sharedStateText = fs.readFileSync(sharedStateFile, "utf8");
  assert.equal(fs.statSync(sharedStateFile).mode & 0o777, 0o600);
  assert.doesNotMatch(sharedStateText, /SECRET_PROVIDER_TOKEN|Private source body|Reply with exactly|source\.md|fake-provider|fake-model|\/vault/);
  const stateFile = path.join(tmp, ".pi", "obsidian", "state.json");
  const stateText = fs.readFileSync(stateFile, "utf8");
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(stateFile)).mode & 0o777, 0o700);
  assert.doesNotMatch(stateText, /SECRET_PROVIDER_TOKEN|Private source body|Reply with exactly|source\.md|\/vault/);
  const state = JSON.parse(stateText);
  assert.ok(state.events.every((event) => !Object.keys(event).some((key) => /prompt|query|output|response|credential|token|path|vault|source|topic/i.test(key))));
  console.log("obsidian layered readiness checks passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
