import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { createToolChurnGuard } = require(join(LIB_ROOT, "src", "tool-churn-guard.js"));
const { instrumentExtensionCommands } = require(join(LIB_ROOT, "src", "extension-telemetry.js"));

const ENABLED = process.env.PI_TOOL_CHURN_GUARD !== "0";
const EXTENSION_VERSION = "tool-churn-guard-2026-08-23.1";

export default function toolChurnGuardExtension(pi: ExtensionAPI) {
  pi = instrumentExtensionCommands(pi, { extension: "tool-churn-guard", version: EXTENSION_VERSION }) as ExtensionAPI;
  if (!ENABLED) return;
  const guard = createToolChurnGuard();

  pi.on("session_start" as any, () => guard.reset());
  pi.on("tool_call" as any, (event: any) => { guard.observeCall(event); });
  pi.on("tool_result" as any, (event: any) => {
    const recommendation = guard.observeResult(event);
    if (!recommendation) return;
    const record = {
      timestamp: new Date().toISOString(),
      reason: recommendation.reason,
      tool: recommendation.tool,
      operation: recommendation.operation,
      count: recommendation.count,
    };
    try { pi.appendEntry?.("tool-churn-guard", record); } catch {}
    return {
      content: [
        ...(Array.isArray(event.content) ? event.content : []),
        { type: "text", text: `[tool-churn-guard] ${recommendation.message}` },
      ],
    };
  });

  pi.registerCommand("tool-churn-status", {
    description: "Show metadata-only repeated-tool-call guard status",
    handler: async (_args: string, ctx: any) => ctx.ui.notify(JSON.stringify({ version: EXTENSION_VERSION, enabled: ENABLED, ...guard.status() }, null, 2), "info"),
  });
}
