import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpFixture } from "./helpers/tmp-fixture.js";

const scriptUrl = new URL("../scripts/apply-pi-global-patches.sh", import.meta.url);
const scriptPath = fileURLToPath(scriptUrl);
const script = fs.readFileSync(scriptUrl, "utf8");

const syntax = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);

assert(
  script.includes("apply_patch_by_file"),
  "global patch script should have a file-by-file fallback for mixed partial installs",
);
assert(
  script.includes("Patch is partially applied or mixed; reconciling per file"),
  "global patch script should detect and report mixed patch states",
);
assert(
  script.includes("git apply --reverse --check \"$file_patch\"") &&
    script.includes("git apply --check \"$file_patch\"") &&
    script.includes("git apply \"${file_patches[$i]}\""),
  "file-by-file fallback should preserve idempotent reverse checks before applying missing file patches",
);
assert(
  script.includes("split_patch_by_hunk") &&
    script.includes("check_patch_by_hunk") &&
    script.includes("apply_patch_by_hunk") &&
    script.includes("reconciling mixed file by hunk"),
  "global patch script should reconcile installs that are only partially patched within one file",
);
assert(
  script.includes("pi-coding-agent-$EXPECTED_VERSION-history-upgrade.patch") &&
    script.indexOf("CODING_AGENT_HISTORY_UPGRADE_PATCH") < script.indexOf("pi-tui-$EXPECTED_VERSION-local.patch"),
  "global patch script should apply the coding-agent history upgrade before moving on to pi-tui patches",
);
assert(
  script.includes('EXPECTED_VERSION="${PI_PATCH_VERSION:-$DEFAULT_EXPECTED_VERSION}"'),
  "patch version should be overridable for upgrades via PI_PATCH_VERSION",
);

const functionStart = script.indexOf("split_patch_by_file() {");
const functionEnd = script.indexOf("\napply_patch() {");
assert.notEqual(functionStart, -1, "test should find patch helper functions");
assert.notEqual(functionEnd, -1, "test should find apply_patch boundary");

const tempDir = tmpFixture("pi-global-patch-script-");
try {
  const samplePath = path.join(tempDir, "sample.txt");
  const patchPath = path.join(tempDir, "sample.patch");
  const runnerPath = path.join(tempDir, "runner.sh");

  fs.writeFileSync(
    samplePath,
    "one\nnew-a\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\nold-b\nthirteen\nfourteen\n",
  );
  fs.writeFileSync(
    patchPath,
    `diff --git a/sample.txt b/sample.txt
--- a/sample.txt
+++ b/sample.txt
@@ -1,5 +1,5 @@
 one
-old-a
+new-a
 three
 four
 five
@@ -9,6 +9,6 @@
 nine
 ten
 eleven
-old-b
+new-b
 thirteen
 fourteen
`,
  );
  fs.writeFileSync(
    runnerPath,
    `set -euo pipefail
${script.slice(functionStart, functionEnd)}
cd "$WORK_DIR"
apply_patch_by_file "$PATCH_FILE" "$(dirname "$WORK_DIR")"
apply_patch_by_file "$PATCH_FILE" "$(dirname "$WORK_DIR")"
`,
  );

  const reconcile = spawnSync("bash", [runnerPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      WORK_DIR: tempDir,
      PATCH_FILE: patchPath,
    },
  });
  assert.equal(reconcile.status, 0, reconcile.stderr || reconcile.stdout);
  assert.match(reconcile.stdout, /reconciling mixed file by hunk/);
  assert.match(reconcile.stdout, /already applied file: sample.txt/);
  assert.equal(
    fs.readFileSync(samplePath, "utf8"),
    "one\nnew-a\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\nnew-b\nthirteen\nfourteen\n",
  );
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
