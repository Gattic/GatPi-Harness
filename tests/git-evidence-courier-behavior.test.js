"use strict";
const { tmpFixture } = require("./helpers/tmp-fixture");

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { before, test } = require("node:test");

process.env.PI_EXTENSION_TELEMETRY = "0";

let factory;
before(async () => {
  const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  const piRoot = fs.realpathSync(path.join(globalRoot, "@earendil-works", "pi-coding-agent"));
  const { createJiti } = require(require.resolve("jiti", { paths: [piRoot] }));
  const file = path.resolve(__dirname, "../extensions/git-evidence-courier/index.ts");
  const jiti = createJiti(file, {
    interopDefault: true,
    alias: { typebox: require.resolve("typebox", { paths: [piRoot] }) },
  });
  const mod = await jiti.import(file);
  factory = mod.default || mod;
});

const verifierCommands = [
  "git diff --check",
  "git diff --cached --check",
  "npm run lint --if-present",
  "npm run typecheck --if-present",
  "npm test --if-present",
];

function setup(t, override = () => undefined) {
  const cwd = tmpFixture("pi-gitverify-termination-");
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, "prisma"));
  fs.writeFileSync(path.join(cwd, "package.json"), '{"scripts":{"test":"node --test"}}\n');
  fs.writeFileSync(path.join(cwd, "prisma/schema.prisma"), 'datasource db { provider = "postgresql" }\n');
  const calls = [];
  const tools = new Map();
  const commands = new Map();
  const messages = [];
  const resources = { container: false, volume: false };
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify() {},
      confirm() { throw new Error("Failed verification must never reach publish confirmation"); },
    },
  };
  factory({
    on() {},
    registerTool(definition) { tools.set(definition.name, definition); },
    registerCommand(name, definition) { commands.set(name, definition); },
    sendMessage(message) { messages.push(message); },
    async exec(command, args = [], options = {}) {
      const rawArgs = args;
      if (command === "git") args = args.filter(arg => arg !== "--no-optional-locks");
      const call = { command, args, options, rawArgs };
      calls.push(call);
      let result = { stdout: "", stderr: "", code: 0, killed: false };
      // Only the external process boundary is simulated. No Docker, npm scripts,
      // git mutations, remote access, or shared database operations run here.
      if (command === "test") {
        result.code = fs.existsSync(path.resolve(cwd, args[1])) ? 0 : 1;
      } else if (command === "git") {
        if (args[0] === "rev-parse") {
          result.stdout = args.includes("--show-toplevel") ? cwd
            : args.includes("--abbrev-ref") ? "origin/main"
              : args.includes("--short") ? "abcdef0" : "abcdef0".repeat(6);
        } else if (args[0] === "branch") result.stdout = "main";
        else if (args[0] !== "status") throw new Error(`Unexpected Git operation: ${args[0]}`);
      } else if (command === "docker" || command === "podman") {
        if (args[0] === "volume") {
          assert.ok(["create", "inspect", "rm"].includes(args[1]), `Unexpected volume operation: ${args[1]}`);
          if (args[1] === "create") resources.volume = true;
          if (args[1] === "rm") resources.volume = false;
          result.stdout = args[1] === "inspect" ? "isolated" : args.at(-1);
          if (args[1] === "inspect" && !resources.volume) result = { ...result, code: 1, stdout: "", stderr: "No such volume" };
        } else {
          const output = {
            info: "27.0.0", run: "fixture-container", port: "127.0.0.1:49152",
            exec: "accepting connections", inspect: "isolated", stop: "fixture-container",
          }[args[0]];
          assert.notEqual(output, undefined, `Unexpected container operation: ${args[0]}`);
          if (args[0] === "run") resources.container = true;
          if (args[0] === "stop") resources.container = false;
          result.stdout = output;
          if (args[0] === "inspect" && !resources.container) result = { ...result, code: 1, stdout: "", stderr: "No such container" };
        }
      } else if (command !== "env" && command !== "sh") {
        throw new Error(`Unexpected executable: ${command}`);
      }
      return { ...result, ...override(call, calls) };
    },
  });
  return {
    calls, messages, resources,
    verify: () => tools.get("gitverify").execute("verify", {}, undefined, undefined, ctx),
    command: (name, args) => commands.get(name).handler(args, ctx),
  };
}

function shellCommands(calls) {
  return calls.filter(call => call.command === "env" || call.command === "sh").map(call => call.args.at(-1));
}

function assertFailed(result) {
  assert.equal(result.details.ok, false);
  assert.match(result.content[0].text, /^Git verify failed/);
  assert.doesNotMatch(result.content[0].text, /Result: passed/);
}

test("normal zero exits complete every verifier and clean up isolation", async t => {
  const runner = setup(t);
  const result = await runner.verify();
  assert.equal(result.details.ok, true);
  assert.equal(result.details.isolatedPostgres.cleanup, "removed");
  assert.deepEqual(shellCommands(runner.calls), verifierCommands);
  assert.ok(result.details.results.every(result => result.code === 0 && !result.killed));
  assert.ok(runner.calls.filter(call => call.command === "git").every(call => call.rawArgs[0] === "--no-optional-locks"), "Git evidence must never acquire optional index-refresh locks");
  assert.deepEqual(runner.resources, { container: false, volume: false });
  assert.ok(runner.calls.filter(call => call.command === "env").every(call => call.options.timeout === 7_200_000));
});

for (const index of [0, 2, 4]) {
  test(`killed zero exit at verifier ${index + 1} fails and stops the pipeline`, async t => {
    const target = verifierCommands[index];
    const runner = setup(t, call => call.command === "env" && call.args.at(-1) === target ? { killed: true } : undefined);
    const result = await runner.verify();
    assertFailed(result);
    assert.equal(result.details.results.length, index + 1);
    assert.deepEqual(shellCommands(runner.calls), verifierCommands.slice(0, index + 1));
    assert.equal(result.details.results.at(-1).killed, true);
    assert.ok(result.content[0].text.includes(`- ❌ ${target}:`));
    assert.equal(result.details.isolatedPostgres.cleanup, "removed", "cleanup still runs after interruption");
  });
}

for (const failure of [{ code: 7 }, { code: null }, { code: 143, killed: true }]) {
  test(`non-success status ${JSON.stringify(failure)} is never accepted`, async t => {
    const runner = setup(t, call => call.command === "env" ? failure : undefined);
    const result = await runner.verify();
    assertFailed(result);
    assert.deepEqual(shellCommands(runner.calls), verifierCommands.slice(0, 1));
    assert.equal(result.details.results[0].code, failure.code, "reports do not coerce null status to zero");
    assert.equal(result.details.isolatedPostgres.cleanup, "removed");
  });
}

for (const operation of ["run", "port", "exec"]) {
  test(`killed PostgreSQL ${operation} cannot authorize verifiers`, async t => {
    const runner = setup(t, call => call.command === "docker" && call.args[0] === operation ? { killed: true } : undefined);
    const result = await runner.verify();
    assertFailed(result);
    assert.deepEqual(shellCommands(runner.calls), []);
    assert.equal(result.details.isolatedPostgres.cleanup, "removed", "a partially launched owned container is still cleaned");
    assert.equal(runner.calls.filter(call => call.command === "docker" && call.args[0] === operation).length, 1);
  });
}

for (const operation of ["inspect", "stop"]) {
  test(`killed PostgreSQL ${operation} cannot be reported as successful cleanup`, async t => {
    const runner = setup(t, call => call.command === "docker" && call.args[0] === operation ? { killed: true } : undefined);
    const result = await runner.verify();
    assertFailed(result);
    assert.equal(result.details.isolatedPostgres.cleanup, "failed");
    if (operation === "inspect") {
      assert.ok(!runner.calls.some(call => call.command === "docker" && call.args[0] === "stop"), "unconfirmed ownership never authorizes removal");
    }
  });
}

test("a killed ownership lookup cannot claim that the container was already removed", async t => {
  const runner = setup(t, call => call.command === "docker" && call.args[0] === "inspect"
    ? { code: 1, killed: true, stdout: "", stderr: "No such container" } : undefined);
  const result = await runner.verify();
  assertFailed(result);
  assert.equal(result.details.isolatedPostgres.cleanup, "failed");
});

for (const failure of [{ code: 0, killed: true }, { code: null }]) {
  test(`interrupted schema discovery ${JSON.stringify(failure)} fails closed`, async t => {
    const runner = setup(t, call => call.command === "test" && call.args[1].endsWith("prisma/schema.prisma") ? failure : undefined);
    await assert.rejects(runner.verify(), /Could not check/);
    assert.deepEqual(shellCommands(runner.calls), [], "an unknown datasource must never run without isolation");
    assert.ok(!runner.calls.some(call => call.command === "docker"));
  });
}

test("killed initial git status cannot claim a clean repository", async t => {
  const runner = setup(t, call => call.command === "git" && call.args[0] === "status" ? { killed: true } : undefined);
  const result = await runner.verify();
  assert.equal(result.details.ok, false);
  assert.match(result.content[0].text, /^Git verify unavailable/);
  assert.deepEqual(shellCommands(runner.calls), []);
});

test("killed final git status cannot claim verified clean-tree evidence", async t => {
  let statuses = 0;
  const runner = setup(t, call => call.command === "git" && call.args[0] === "status" && ++statuses === 2 ? { killed: true } : undefined);
  const result = await runner.verify();
  assertFailed(result);
  assert.equal(result.details.cleanAfter, false);
  assert.match(result.content[0].text, /Tree after verify: unknown/);
});

for (const runtime of ["docker", "podman"]) {
  test(`${runtime} allocates labelled disk-backed storage and confirms both resources removed`, async t => {
    const runner = setup(t, call => runtime === "podman" && call.command === "docker" ? { code: 1 } : undefined);
    const result = await runner.verify();
    assert.equal(result.details.ok, true);
    const isolation = result.details.isolatedPostgres;
    const calls = runner.calls.filter(call => call.command === runtime);
    const creation = calls.find(call => call.args[0] === "volume" && call.args[1] === "create");
    const launch = calls.find(call => call.args[0] === "run");
    assert.deepEqual(creation.args, ["volume", "create", "--driver", "local", "--label", "pi.gitverify=isolated", isolation.volumeName]);
    assert.equal(launch.args[launch.args.indexOf("--volume") + 1], `${isolation.volumeName}:/var/lib/postgresql/data`);
    assert.ok(!launch.args.includes("--tmpfs"));
    for (const inspection of calls.filter(call => call.args[0] === "inspect")) {
      assert.equal(inspection.args[inspection.args.indexOf("--type") + 1], "container", "Podman must not resolve an absent container to the same-prefix volume");
    }
    assert.equal(launch.args[launch.args.indexOf("--memory") + 1], "3g");
    assert.equal(launch.args[launch.args.indexOf("--cpus") + 1], "2");
    assert.equal(launch.args[launch.args.indexOf("--publish") + 1], "127.0.0.1::5432");
    const labels = isolation.infrastructure.map(row => row.label);
    for (const kind of ["container", "volume"]) {
      assert.ok(labels.indexOf(`verify isolated PostgreSQL ${kind} ownership`) < labels.indexOf(`remove isolated PostgreSQL ${kind}`));
      assert.ok(labels.indexOf(`remove isolated PostgreSQL ${kind}`) < labels.indexOf(`confirm isolated PostgreSQL ${kind} removal`));
    }
    assert.deepEqual(runner.resources, { container: false, volume: false });
  });
}

for (const failure of [{ code: 1 }, { killed: true }]) {
  test(`volume allocation ${JSON.stringify(failure)} cleans partial resources without launching verifiers`, async t => {
    const runner = setup(t, call => call.args[0] === "volume" && call.args[1] === "create" ? failure : undefined);
    const result = await runner.verify();
    assertFailed(result);
    assert.deepEqual(shellCommands(runner.calls), []);
    assert.ok(!runner.calls.some(call => call.args[0] === "run"));
    assert.equal(result.details.isolatedPostgres.cleanup, "removed");
    assert.deepEqual(runner.resources, { container: false, volume: false });
  });
}

for (const operation of ["create", "run", "verifier"]) {
  test(`an exception during ${operation} still cleans allocated storage`, async t => {
    const runner = setup(t, call => {
      if ((operation === "create" && call.args[0] === "volume" && call.args[1] === "create")
        || (operation === "run" && call.args[0] === "run")
        || (operation === "verifier" && call.command === "env")) throw new Error("fixture process exception");
    });
    await assert.rejects(runner.verify(), /fixture process exception/);
    assert.deepEqual(runner.resources, { container: false, volume: false });
  });
}

test("a --rm container still being removed after stop is confirmed once it disappears", async t => {
  // Docker returns from `stop` before it finishes auto-removing a --rm container, so
  // the first inspections still find it (state "removing").
  let removing = 2;
  const runner = setup(t, (call, calls) => {
    const stopped = calls.some(previous => previous.args[0] === "stop");
    if (call.args[0] === "inspect" && stopped && removing > 0) {
      removing -= 1;
      return { code: 0, stdout: "isolated", stderr: "" };
    }
  });
  const result = await runner.verify();
  assert.equal(result.details.ok, true);
  assert.equal(result.details.isolatedPostgres.cleanup, "removed");
  const stopIndex = runner.calls.findIndex(call => call.args[0] === "stop");
  assert.equal(runner.calls.slice(stopIndex).filter(call => call.args[0] === "inspect").length, 3);
  assert.ok(runner.calls.some(call => call.args[0] === "volume" && call.args[1] === "rm"));
  assert.deepEqual(runner.resources, { container: false, volume: false });
});

test("an already-removed container does not skip its volume cleanup", async t => {
  const runner = setup(t, call => {
    if (call.args[0] === "inspect") {
      runner.resources.container = false;
      return { code: 1, stdout: "", stderr: "No such container" };
    }
  });
  const result = await runner.verify();
  assert.equal(result.details.ok, true);
  assert.equal(result.details.isolatedPostgres.cleanup, "removed");
  assert.ok(runner.calls.some(call => call.args[0] === "volume" && call.args[1] === "rm"));
  assert.deepEqual(runner.resources, { container: false, volume: false });
});

for (const kind of ["container", "volume"]) {
  test(`unconfirmed ${kind} ownership never authorizes removal`, async t => {
    const runner = setup(t, call => (kind === "container" ? call.args[0] === "inspect" : call.args[0] === "volume" && call.args[1] === "inspect")
      ? { stdout: "unrelated" } : undefined);
    const result = await runner.verify();
    assertFailed(result);
    assert.equal(result.details.isolatedPostgres.cleanup, "failed");
    assert.ok(!runner.calls.some(call => call.args[0] === "volume" && call.args[1] === "rm"));
    if (kind === "container") assert.ok(!runner.calls.some(call => call.args[0] === "stop"));
  });
}

for (const operation of ["inspect", "rm"]) {
  test(`interrupted volume ${operation} fails cleanup closed`, async t => {
    const runner = setup(t, call => call.args[0] === "volume" && call.args[1] === operation ? { killed: true } : undefined);
    const result = await runner.verify();
    assertFailed(result);
    assert.equal(result.details.isolatedPostgres.cleanup, "failed");
  });
}

for (const kind of ["container", "volume"]) {
  test(`a successful removal without confirmed ${kind} absence is not a cleanup pass`, async t => {
    const runner = setup(t, (call, calls) => {
      const inspecting = kind === "container" ? call.args[0] === "inspect" : call.args[0] === "volume" && call.args[1] === "inspect";
      const removed = calls.some(previous => kind === "container" ? previous.args[0] === "stop" : previous.args[0] === "volume" && previous.args[1] === "rm");
      return inspecting && removed ? { code: 0, stdout: "isolated", stderr: "" } : undefined;
    });
    const result = await runner.verify();
    assertFailed(result);
    assert.equal(result.details.isolatedPostgres.cleanup, "failed");
  });
}

test("explicit verification also rejects killed zero exits and stops", async t => {
  const runner = setup(t, call => call.command === "sh" ? { killed: true } : undefined);
  await runner.command("git:verify", "first-check && second-check");
  assert.equal(runner.messages.at(-1).details.ok, false);
  assert.deepEqual(shellCommands(runner.calls), ["first-check"]);
  assert.match(runner.messages.at(-1).content, /❌ first-check/);
});

test("publish --verify never advances beyond killed verification", async t => {
  const runner = setup(t, call => call.command === "env" ? { killed: true } : undefined);
  await runner.command("git:publish", "--verify");
  assert.equal(runner.messages.at(-1).details.title, "Git publish blocked");
  assert.deepEqual(shellCommands(runner.calls), verifierCommands.slice(0, 1));
  assert.ok(!runner.calls.some(call => call.command === "git" && ["ls-remote", "push"].includes(call.args[0])));
});
