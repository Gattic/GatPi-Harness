import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { applyHarnessEnvironmentDefaults } = require(join(LIB_ROOT, "src", "harness-environment.js"));
const { readProjectMemoryPosture, applyProjectMemoryPosture } = require(join(LIB_ROOT, "src", "project-memory-posture.js"));
const { resolveProjectMemoryRollout } = require(join(LIB_ROOT, "src", "project-memory-rollout.js"));
const { instrumentExtensionCommands } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));
const { writePrivateJson } = require(join(LIB_ROOT, "src", "project-memory-decisions.js"));

// This module is deliberately first in the configured extension list. Apply
// only missing values so explicit launch/session environment overrides win for
// keys the harness does not declare a posture for.
const EFFECTIVE = applyHarnessEnvironmentDefaults({ root: LIB_ROOT });
const DECLARED = readProjectMemoryPosture({ root: LIB_ROOT });
const ROLLOUT = resolveProjectMemoryRollout(applyProjectMemoryPosture(process.env, { root: LIB_ROOT }).env);
const POSTURE_FILE = join(LIB_ROOT, ".pi", "harness-defaults", "posture.json");
const DECLARED_FILE = "config/memory-posture.json";
const EXTENSION_VERSION = "harness-defaults-2026-10-25.1";

// Preserved overrides that disagree with the canonical defaults are recorded so
// the resolved posture is explicit. The record holds configuration keys and
// values only; it never contains credentials, prompts, or transcripts.
function posture() {
  return {
    schemaVersion: 1,
    at: new Date().toISOString(),
    source: EFFECTIVE.source,
    requestedStage: ROLLOUT.requestedStage,
    effectiveStage: ROLLOUT.effectiveStage,
    stageAuthority: ROLLOUT.stageAuthority,
    operatorAutomatic: ROLLOUT.operatorAutomatic,
    applied: EFFECTIVE.applied.length,
    preserved: EFFECTIVE.preserved,
    conflicts: EFFECTIVE.conflicts,
    declared: {
      present: DECLARED.present,
      invalid: Boolean(DECLARED.invalid),
      reason: DECLARED.reason || null,
      file: DECLARED.present ? DECLARED_FILE : null,
      recordedAt: DECLARED.recordedAt || null,
      overrides: DECLARED.overrides,
    },
  };
}

function recordPosture(value: ReturnType<typeof posture>) {
  try {
    // Atomic, private, and symlink-refusing; the record is metadata only.
    writePrivateJson(POSTURE_FILE, value);
  } catch {
    // Posture recording is advisory observability; it must never block startup.
  }
}

recordPosture(posture());

export default function harnessDefaults(pi: ExtensionAPI) {
  pi = instrumentExtensionCommands(pi, { extension: "00-harness-defaults", version: EXTENSION_VERSION }) as ExtensionAPI;
  pi.registerCommand("harness-defaults-status", {
    description: "Show canonical guarded harness defaults, explicit environment overrides, declared posture, and the recorded rollout posture",
    handler: async (_args: string, ctx: any) => {
      ctx.ui.notify(JSON.stringify({
        version: EXTENSION_VERSION,
        source: EFFECTIVE.source,
        applied: EFFECTIVE.applied,
        preservedOverrides: EFFECTIVE.preserved,
        conflicts: EFFECTIVE.conflicts,
        posture: posture(),
        effective: Object.fromEntries(Object.keys(EFFECTIVE.defaults).sort().map((key) => [key, process.env[key]])),
      }, null, 2), "info");
    },
  });
}
