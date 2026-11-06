#!/usr/bin/env node
"use strict";

const { parseArgs } = require("node:util");
const { clientConfiguration, connectionOptions } = require("./config.js");
const { createRequestQueue, STATES } = require("./request-queue.js");

const usage = `pi-queue — Redis queue that Pi DeepSeek requests join before reaching the model
(connection: PI_QUEUE_ENV or ~/.config/pi-queue/client.env)

status [ID]                      Concurrency limit, running and waiting requests, totals; or one request
list [--state STATE] [--limit N] Recent requests, newest first (states: ${STATES.join(", ")})
limit [N]                        Show, or set, the concurrency limit shared by every machine
`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { state: { type: "string" }, limit: { type: "string" }, help: { type: "boolean" } },
  });
  const [command, argument] = positionals;
  if (values.help || !command) return void process.stdout.write(usage);
  if (!["status", "list", "limit"].includes(command)) throw new Error(`Unknown command ${command}`);
  const { values: connection } = clientConfiguration();
  const queue = createRequestQueue(connectionOptions(connection), { prefix: connection.QUEUE_PREFIX });
  const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  try {
    if (command === "status") {
      if (!argument) print(await queue.status());
      else {
        const found = await queue.show(argument);
        if (!found) throw new Error(`Unknown request ${argument}`);
        print(found);
      }
    } else if (command === "list") {
      print(await queue.list({ state: values.state, limit: values.limit === undefined ? 20 : Number(values.limit) }));
    } else if (argument === undefined) {
      print({ limit: (await queue.status()).limit });
    } else {
      print({ limit: await queue.setLimit(Number(argument)) });
    }
  } finally {
    await queue.close();
  }
}

main().catch((error) => {
  process.stderr.write(`pi-queue: ${error.message}\n`);
  process.exitCode = 1;
});
