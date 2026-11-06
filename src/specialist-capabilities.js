"use strict";

// Capability discovery depends on the pinned BlenderAI add-on binding, which in
// turn depends on specialist-runtime and the shared primitives. Keeping it out
// of primitives prevents primitives -> blenderai -> runtime -> primitives.

const fs = require("node:fs");
const path = require("node:path");
const { executable, inSystemRuntime, blenderRuntimeBinding } = require("./specialist-primitives");

// A Blender MCP contract is only runnable when pi is configured to reach that
// server and its Blender listener is actually listening. Checking both here
// keeps a run from burning an attempt on tool calls that cannot connect.
// Discovery only reads the MCP configuration and the kernel's listening
// sockets; it never starts Blender and never contacts a provider.
function blenderMcpStatus(mcp, { env = process.env, cwd = process.cwd() } = {}) {
  const server = String(mcp?.server || "").trim();
  if (!server) return ["blender-mcp:server-undeclared"];
  const reasons = [];
  const candidates = [env.HOME ? path.join(env.HOME, ".pi", "agent", "mcp.json") : null, path.join(cwd, ".pi", "mcp.json")].filter(Boolean);
  const configured = candidates.some(file => {
    try { return Boolean(JSON.parse(fs.readFileSync(file, "utf8"))?.mcpServers?.[server]); }
    catch { return false; }
  });
  if (!configured) reasons.push(`blender-mcp:server-not-configured:${server}`);
  const host = String(mcp?.host || "localhost"), port = Number(mcp?.port || 9876);
  if (listenerReachable(port) === false) reasons.push(`blender-mcp:listener-unreachable:${host}:${port}`);
  return reasons;
}

// Preflight is synchronous, so the listener check reads the kernel's listening
// sockets instead of opening a connection. Any LISTEN socket on the declared
// port satisfies it; null means the socket table is unavailable on this host,
// which is unknown rather than unreachable.
function listenerReachable(port) {
  const wanted = Number(port).toString(16).toUpperCase().padStart(4, "0");
  let readable = false;
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    readable = true;
    for (const line of text.split("\n").slice(1)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 4 || columns[3] !== "0A") continue;
      if (columns[1].split(":").pop() === wanted) return true;
    }
  }
  return readable ? false : null;
}

function capabilityStatus(contract, { env = process.env, cwd = process.cwd() } = {}) {
  const prerequisites = [...new Set([...(contract.settings?.prerequisites || []), ...(contract.settings?.containment === "bwrap" ? ["bwrap"] : [])])];
  const needsBlender = prerequisites.includes("blender") || contract.settings?.domainOperations?.includes("blender-script");
  const systemPrerequisites = prerequisites.filter(name => name !== "blender");
  const missing = systemPrerequisites.filter(name => !executable(name, env));
  const reasons = missing.map(name => `tool-unavailable:${name}`);
  if (needsBlender) {
    try { blenderRuntimeBinding(contract.settings?.blenderRuntime); }
    catch (error) { reasons.push(`blender:${error.message}`); }
  }
  if (contract.settings?.blenderAi) {
    try { require("./specialist-blenderai").blenderAiBinding(contract.settings.blenderAi); }
    catch (error) { reasons.push(`blenderai:${error.message}`); }
  }
  if (contract.settings?.blenderMcp) reasons.push(...blenderMcpStatus(contract.settings.blenderMcp, { env, cwd }));
  if (contract.settings?.containment === "bwrap") reasons.push(...systemPrerequisites.filter(name => name !== "bwrap" && executable(name, env) && !inSystemRuntime(executable(name, env))).map(name => `runtime-root-unreviewed:${name}`));
  // Discovery never executes an installer/shim or probes a provider.
  return { available: reasons.length === 0, reasons, containment: contract.settings?.containment || null };
}

module.exports = { capabilityStatus };
