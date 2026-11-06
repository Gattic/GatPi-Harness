import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { governedCodemode, instrumentExtensionCommands } = require("../../src/pi-extension-kit.js");

export default function codemode(pi: ExtensionAPI) {
  pi = instrumentExtensionCommands(pi, { extension: "codemode" }) as ExtensionAPI;
  const enabled = process.env.PI_CODEMODE !== "0";
  if (typeof createCodemodeExtension !== "function") throw new Error("Harness CodeMode requires Pi's public createCodemodeExtension API");
  // Register the native tool through a policy facade, not another executor.
  // Even the hidden opt-out registration replaces Pi's automatic built-in.
  const native = new Proxy(pi, {
    get(target, key) {
      if (key === "registerTool") return (definition: any) => pi.registerTool({
        ...governedCodemode(definition, { enabled }),
        name: "codemode",
      });
      if (key === "appendEntry") return (type: string, data: any) => {
        if (type === "codemode-store") throw new Error("Persistent CodeMode store writes are disabled; return bounded identifiers instead");
        return pi.appendEntry(type, data);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return createCodemodeExtension({ models: false })(native);
}
