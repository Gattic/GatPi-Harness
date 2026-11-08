import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const {
  appendFileSection,
  evaluateSinglePayload,
  normalizePayloadLimit,
  sectionedWriteRule,
} = require(join(LIB_ROOT, "src", "write-chunking.js"));
const { instrumentExtensionCommands } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

// Long document turns are what stall the provider stream. The rule is enforced at
// the tool boundary so guidance alone cannot be bypassed by one giant payload.
export default function writeChunking(pi: ExtensionAPI) {
  if (process.env.PI_WRITE_CHUNKING === "0") return;
  pi = instrumentExtensionCommands(pi, { extension: "write-chunking" }) as ExtensionAPI;

  // Read per factory invocation so a changed limit applies after /reload.
  const limit = normalizePayloadLimit(process.env.PI_WRITE_CHUNK_LIMIT);
  const rule = sectionedWriteRule(limit);

  pi.on("tool_call" as any, (event: any) => {
    const decision = evaluateSinglePayload(event, { limit });
    if (!decision.blocked) return undefined;
    return { block: true, reason: decision.reason };
  });

  pi.registerTool({
    name: "append_file",
    label: "Append file section",
    description:
      "Append content to the end of a file, creating the file and parent directories when missing. Use it for the sections after the first write so a large document never needs one oversized payload.",
    promptSnippet: "Append a section to a file without rewriting it",
    promptGuidelines: [rule || "Use append_file to extend an existing file instead of rewriting all of it."],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to append to (relative or absolute)" }),
      content: Type.String({ description: "Content to append; a separating newline is added when missing" }),
    }),
    prepareLoadout: (loadout: any) => {
      if (!rule) return undefined;
      const write = loadout.declared.find((tool: any) => tool.name === "write");
      if (!write) return undefined;
      return { descriptions: { write: `${write.description} ${rule}` } };
    },
    async execute(
      _toolCallId: string,
      { path, content }: { path: string; content: string },
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      ctx: any,
    ) {
      const result = appendFileSection({ path, content, cwd: ctx?.cwd });
      return {
        content: [
          {
            type: "text" as const,
            text: `${result.created ? "Created" : "Appended to"} ${result.path} (+${result.appendedChars} characters)`,
          },
        ],
        details: result,
      };
    },
  });
}
