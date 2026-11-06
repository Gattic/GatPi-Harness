"use strict";

// Private client configuration shared by the CLI and the Pi extension. Values are
// read from an owner-only env file; they are never logged or returned to callers.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseEnv } = require("node:util");

const required = ["REDIS_HOST", "REDIS_USERNAME", "REDIS_PASSWORD", "REDIS_CA", "REDIS_CERT", "REDIS_KEY"];

function configFile(env = process.env) {
  const file = env.PI_QUEUE_ENV || path.join(env.HOME || os.homedir(), ".config", "pi-queue", "client.env");
  if (!path.isAbsolute(file)) throw new Error("PI_QUEUE_ENV must be an absolute private connection-file path");
  return file;
}

function clientConfiguration(env = process.env) {
  const file = configFile(env);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 64 * 1024 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("Queue client configuration must be an owner-only regular file of at most 64 KiB");
  }
  const values = parseEnv(fs.readFileSync(file, "utf8"));
  if (required.some((key) => !values[key])) throw new Error("Queue client configuration is missing required Redis/TLS fields");
  if (["REDIS_CA", "REDIS_CERT", "REDIS_KEY"].some((key) => !path.isAbsolute(values[key]))) {
    throw new Error("Queue certificate paths must be absolute");
  }
  return { file, values };
}

// ioredis options for the TLS, client-certificate, ACL-user broker.
function connectionOptions(values) {
  return {
    host: values.REDIS_HOST,
    port: Number(values.REDIS_PORT || 6380),
    username: values.REDIS_USERNAME,
    password: values.REDIS_PASSWORD,
    tls: {
      ca: fs.readFileSync(values.REDIS_CA),
      cert: fs.readFileSync(values.REDIS_CERT),
      key: fs.readFileSync(values.REDIS_KEY),
    },
  };
}

module.exports = { clientConfiguration, connectionOptions };
