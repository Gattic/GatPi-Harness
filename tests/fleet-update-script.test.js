import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpFixture } from "./helpers/tmp-fixture.js";

// Guards the fleet update tooling's host layout. Every fleet host keeps the
// Gattic/GatPi fork at ~/GatPi and the harness at ~/GatPi-Harness; the payload
// defaults, the driver's guidance and config/pi-fork.env must all agree, and the
// payload preflight must find both checkouts under those defaults.

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const payload = fs.readFileSync(path.join(root, "scripts", "fleet-host-update.sh"), "utf8");
const driver = fs.readFileSync(path.join(root, "scripts", "update-fleet.sh"), "utf8");
const config = fs.readFileSync(path.join(root, "config", "pi-fork.env"), "utf8");

assert.match(
  payload,
  /^harness="\$\{HARNESS_DIR:-\$HOME\/GatPi-Harness\}"$/m,
  "payload must default the harness checkout to ~/GatPi-Harness",
);
assert.match(payload, /^pi_source="\$\{PI_DIR:-\$HOME\/GatPi\}"$/m, "payload must default the Pi fork checkout to ~/GatPi");
assert.doesNotMatch(payload, /\$\{PI_DIR:-\$HOME\/pi\}/, "payload must not default to the legacy ~/pi checkout");
assert.doesNotMatch(payload, /~\/pi\b/, "payload must not reference the legacy ~/pi checkout");

assert.doesNotMatch(driver, /~\/pi\b/, "driver must not reference the legacy ~/pi checkout");
assert.match(
  driver,
  /git -C \$PI_SOURCE_ROOT fetch --unshallow/,
  "driver's shallow-clone guidance must name the configured Pi checkout",
);
assert.match(
  driver,
  /^Host layout: [\s\S]*~\/GatPi-Harness[\s\S]*~\/GatPi/m,
  "driver help must document the host layout",
);

assert.match(config, /^PI_SOURCE_ROOT_DEFAULT="\.\.\/GatPi"$/m, "config must resolve the Pi checkout as ../GatPi");
assert.match(config, /^PI_FORK_URL="git@github\.com:Gattic\/GatPi\.git"$/m, "config must target the Gattic/GatPi fork");
assert.match(
  config,
  /^PI_HARNESS_URL="git@github\.com:Gattic\/GatPi-Harness\.git"$/m,
  "config must target the Gattic/GatPi-Harness repository",
);

function git(args, cwd, extra = []) {
  const result = spawnSync("git", [...extra, ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function initRepo(dir, bareRemote, upstreamRemote) {
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "fixture\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "fixture"], dir, [
    "-c",
    "user.name=Fleet Test",
    "-c",
    "user.email=fleet@example.invalid",
  ]);
  git(["remote", "add", "origin", bareRemote], dir);
  git(["push", "-q", "origin", "main"], dir);
  if (upstreamRemote) git(["remote", "add", "upstream", upstreamRemote], dir);
  return git(["rev-parse", "HEAD"], dir);
}

const tmp = tmpFixture("fleet-update-paths-");
const home = path.join(tmp, "home");
const remotes = path.join(tmp, "remotes");
fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
for (const name of ["GatPi", "GatPi-Harness", "upstream"]) {
  git(["init", "-q", "--bare", path.join(remotes, `${name}.git`)], tmp);
}
const piHead = initRepo(
  path.join(home, "GatPi"),
  path.join(remotes, "GatPi.git"),
  path.join(remotes, "upstream.git"),
);
initRepo(path.join(home, "GatPi-Harness"), path.join(remotes, "GatPi-Harness.git"));
fs.writeFileSync(
  path.join(home, ".pi", "agent", "settings.json"),
  `${JSON.stringify({ extensions: [] }, null, 2)}\n`,
);

const script = [
  "export MODE=preflight",
  `export PI_PATCH_COMMIT=${piHead}`,
  `export PI_UPSTREAM_URL=${path.join(remotes, "upstream.git")}`,
  payload,
].join("\n");
const preflight = spawnSync("bash", ["-s"], {
  input: script,
  encoding: "utf8",
  env: {
    ...process.env,
    HOME: home,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
  },
});
assert.equal(preflight.status, 0, `payload preflight failed:\n${preflight.stdout}\n${preflight.stderr}`);

const fields = new Map(
  preflight.stdout
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
assert.equal(fields.get("PREFLIGHT_OK"), "yes", preflight.stdout);
assert.equal(fields.get("HARNESS_EXISTS"), "yes", "payload must find the harness at ~/GatPi-Harness");
assert.equal(fields.get("HARNESS_ORIGIN"), path.join(remotes, "GatPi-Harness.git"));
assert.equal(fields.get("PI_EXISTS"), "yes", "payload must find the Pi fork at ~/GatPi");
assert.equal(fields.get("PI_ORIGIN"), path.join(remotes, "GatPi.git"));
assert.equal(fields.get("PI_HEAD"), piHead);
assert.equal(fields.get("PI_UPSTREAM"), path.join(remotes, "upstream.git"));
assert.equal(fields.get("PI_PATCH_PRESENT"), "yes");

console.log("fleet-update-script tests passed");
