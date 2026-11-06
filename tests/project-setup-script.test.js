import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const scriptUrl = new URL("../scripts/check-project-setup.sh", import.meta.url);
const scriptPath = fileURLToPath(scriptUrl);
const script = fs.readFileSync(scriptUrl, "utf8");

const syntax = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);

assert(
  script.includes("git rev-parse --path-format=absolute --git-common-dir") &&
    script.includes('"$harness_root/.pi/extensions"') &&
    script.includes('"$harness_root/extensions"'),
  "global settings checks should resolve the canonical harness root when run from a nested isolated Git worktree",
);
assert(
  script.includes("multi-login extension exists"),
  "setup checks should require the harness multi-login extension",
);
assert(
  script.includes("PI_CODING_AGENT_DIR=\"$smoke_agent_dir\""),
  "setup smoke checks should run with an isolated Pi agent dir so missing user auth cannot affect command registration checks",
);
assert(
  script.includes("PI_OFFLINE=1 PI_CODING_AGENT_DIR=\"$smoke_agent_dir\""),
  "model-free setup smoke checks should disable Pi startup network activity",
);
assert(
  script.includes('"$@" </dev/null >"$log" 2>&1'),
  "print-mode setup smokes should not wait for EOF from the parent verifier's stdin pipe",
);
assert(
  script.includes("'/cognitive-status'") &&
    script.includes("'/trace-status'") &&
    script.includes("'/goal-status'") &&
    script.includes("'/hermes-status'") &&
    script.includes("'/multi-login'"),
  "setup smoke checks should invoke extension and package commands that do not require a model/API key",
);
assert(
  !script.includes("'say only ok'") && !script.includes("grep -qx 'ok'"),
  "setup smoke checks should not require a model response",
);
assert(
  (script.match(/--no-session/g) || []).length >= 5,
  "setup smoke probes must not create disposable Pi sessions",
);
assert(
  script.includes("PI_PROJECT_SETUP_SMOKE_TIMEOUT_SECONDS") && script.includes("timeout --signal=TERM --kill-after=5s"),
  "each setup smoke probe should have a configurable hard timeout",
);
assert(
  script.includes("output (last 40 lines)") && script.includes("timed out after"),
  "failed or timed-out setup probes should identify the step and retain bounded diagnostics",
);
