"use strict";

// GPU grant validation is a pure filesystem check. It lives in a leaf module so
// sandbox construction (specialist-primitives) does not have to import
// specialist-diagnostics, which itself depends on the primitives.

const fs = require("node:fs");
const { GPU_DEVICE } = require("./specialist-schemas");

function fail(code) {
  throw new Error(`SPECIALIST_DIAGNOSTIC_${code}`);
}

function validateGpuDevices(devices = []) {
  if (!Array.isArray(devices) || devices.length > 8 || new Set(devices).size !== devices.length) fail("GPU_GRANT_INVALID");
  for (const device of devices) {
    if (typeof device !== "string" || !GPU_DEVICE.test(device)) fail("GPU_GRANT_INVALID");
    if (!fs.existsSync(device) || fs.realpathSync(device) !== device || !fs.statSync(device).isCharacterDevice()) fail("GPU_UNAVAILABLE");
  }
  return devices;
}

module.exports = { validateGpuDevices };
