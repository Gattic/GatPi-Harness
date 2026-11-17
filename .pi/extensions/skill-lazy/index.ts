import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { reduceSkillsOptions, applySkillsReduction, rewriteSkillsBlock } = require(
  join(LIB_ROOT, "src", "skill-lazy.js"),
);
const { notify } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));

// The user-scope skill catalog is advertised by Pi with a full description and
// path per skill on every request. Project skills belong to the current
// repository and stay fully described; the global catalog is reduced to a name
// index that points at each SKILL.md. Disable with PI_SKILL_LAZY=0.
export default function skillLazy(pi: ExtensionAPI) {
  let lastIndex = "";

  // The model never pays for the full catalog; the user can still inspect it.
  pi.registerCommand("skill-catalog", {
    description: "Show the lazy global skill index (names grouped by skill directory)",
    handler: async (_args: string, ctx: any) =>
      notify(ctx, lastIndex || "No user-scope skills are lazy-loaded in this session.", "info"),
  });

  pi.on("before_agent_start" as any, async (event: any) => {
    const options = event.systemPromptOptions;
    const reduction = reduceSkillsOptions(options);
    if (!reduction) return;
    lastIndex = reduction.section;
    applySkillsReduction(options, reduction);

    // An earlier handler may already have forced an exact prompt text. Rewrite
    // that text so the request matches the reduced sections we just persisted.
    const forced = options.forceSystemPrompt;
    if (typeof forced === "string" && forced) {
      const rewritten = rewriteSkillsBlock(forced, reduction);
      if (rewritten !== forced) return { systemPrompt: rewritten };
    }
  });
}
