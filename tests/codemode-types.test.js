"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { tmpFixture } = require("./helpers/tmp-fixture");

const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const sdkRoot = fs.realpathSync(path.join(globalRoot, "@earendil-works/pi-coding-agent"));
const monorepo = path.resolve(sdkRoot, "../..");
const root = path.resolve(__dirname, "..");
const directory = tmpFixture("pi-codemode-typecheck-");
try {
  const config = path.join(directory, "tsconfig.json");
  fs.writeFileSync(config, JSON.stringify({
    files: ["extensions/codemode/index.ts", ".pi/extensions/code-context/index.ts", ".pi/extensions/docs-lookup/index.ts", ".pi/extensions/test-runner/index.ts", ".pi/extensions/output-compactor/index.ts"].map(file => path.join(root, file)),
    compilerOptions: {
      noEmit: true, skipLibCheck: true, strict: true,
      target: "es2022", module: "esnext", moduleResolution: "bundler",
      types: ["node"], typeRoots: [path.join(monorepo, "node_modules/@types")],
      paths: {
        "@earendil-works/pi-coding-agent": [path.join(sdkRoot, "dist/index.d.ts")],
        "@earendil-works/pi-ai": [path.join(sdkRoot, "../ai/dist/index.d.ts")],
        "typebox": [path.join(monorepo, "node_modules/typebox/build/index.d.mts")],
      },
    },
  }), { mode: 0o600 });
  const checked = spawnSync("tsc", ["--project", config, "--pretty", "false"], { cwd: root, encoding: "utf8", timeout: 60000 });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  console.log("codemode affected extension typecheck passed against installed Pi declarations");
} finally { fs.rmSync(directory, { recursive: true }); }
