"use strict";

// Review-ledger storage and overlay used by both extension telemetry and the
// opportunity-review workflow. Keeping it here breaks the previous
// extension-telemetry <-> extension-opportunity-review require cycle.

const fs = require("node:fs");
const path = require("node:path");
const { FileIntegrationStorage } = require("./file-integration-storage");
const { hash } = require("./reviewed-evidence");

function storage(cwd) {
  return new FileIntegrationStorage(path.join(cwd, ".pi", "extension-telemetry"), { maxJsonBytes: 512 * 1024 });
}

function reviews(cwd) {
  const file = path.join(cwd, ".pi", "extension-telemetry", "opportunity-reviews.json");
  if (!fs.existsSync(file)) return [];
  const value = storage(cwd).readJson("opportunity-reviews");
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.reviews)) throw new Error("opportunity review ledger is unreadable; preserve it");
  return value.reviews;
}

function overlayReviews(events, cwd) {
  const byId = new Map(reviews(cwd).map(r => [r.eventId, r]));
  for (const event of events) {
    if (event.kind !== "opportunity") continue;
    const review = byId.get(event.eventId), valid = review && review.eventHash === hash(event);
    // A rating is a judgment about an existing opportunity, never another opportunity.
    event.reviewed = Boolean(valid);
    event.value = valid ? review.value : "unknown";
    if (valid) { event.coreDisplacement = review.coreDisplacement; event.analysisOutcome = review.analysisOutcome || null; }
  }
  return events;
}

module.exports = { storage, reviews, overlayReviews };
