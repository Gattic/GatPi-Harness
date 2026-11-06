#!/usr/bin/env node
"use strict";
const { previewRetention, applyRetention, rollbackRetention } = require("../src/state-retention");
const args = process.argv.slice(2); const cwd = process.cwd(); const apply = args.includes("--apply") && args.includes("--yes"); const rollbackIndex = args.indexOf("--rollback"); const manifestId = args.find((value) => value.startsWith("--manifest="))?.slice("--manifest=".length);
let result;
if (rollbackIndex >= 0) result = rollbackRetention({ cwd, manifestId: args[rollbackIndex + 1], apply });
else { const preview = previewRetention({ cwd }); const className = args.find((value) => value.startsWith("--class="))?.slice(8); if (apply && !manifestId) throw new Error("--apply --yes requires --manifest=<preview-id>"); result = apply ? applyRetention({ cwd, manifestId, className, apply: true }) : preview; }
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
