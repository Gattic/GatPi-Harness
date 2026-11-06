#!/usr/bin/env node
"use strict";
const { configFromEnv, resolveVaultPath } = require("../src/obsidian-adapter");
const { previewManagedPermissions, applyManagedPermissions } = require("../src/managed-state-permissions");
const cwd = process.cwd(); const args = process.argv.slice(2); let vault = null; try { vault = resolveVaultPath({ cwd }, args.find((value) => value.startsWith("--vault="))?.slice(8), configFromEnv()); } catch {}
const preview = previewManagedPermissions({ cwd, vault }); const apply = args.includes("--apply") && args.includes("--yes"); const manifestId = args.find((value) => value.startsWith("--manifest="))?.slice("--manifest=".length); if (apply && !manifestId) throw new Error("--apply --yes requires --manifest=<preview-id>"); const result = apply ? applyManagedPermissions({ cwd, vault, manifestId, apply: true }) : preview; process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
