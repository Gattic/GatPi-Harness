"use strict";

const LABELS = Object.freeze({
  "extension-portfolio": "Extensions",
  "role-runtime": "Role runtime",
  "project-memory": "Project memory",
  "compounding-effectiveness": "Compounding",
  "phase7-release": "Phase 7",
  "verification-center": "Verification",
  "visual-verification": "Visual verify",
});

function visibleLength(value) { return [...String(value || "")].length; }
function fit(value, width) {
  const target = Math.max(1, Number(width) || 1);
  const chars = [...String(value || "")];
  if (chars.length > target) return chars.slice(0, Math.max(0, target - 1)).join("") + (target > 1 ? "~" : "");
  return chars.join("") + " ".repeat(target - chars.length);
}
function status(value) {
  const table = {
    ready: "READY", degraded: "DEGRADED", blocked: "BLOCKED", unknown: "UNKNOWN", "not-applicable": "N/A",
    authorized: "AUTH", "read-only": "READ-ONLY", "advisory-only": "ADVISORY", disabled: "DISABLED",
    passed: "PASS", failed: "FAIL", "insufficient-data": "INSUFFICIENT", "null-result": "NULL", stale: "STALE",
    available: "READY", partial: "PARTIAL", missing: "MISSING",
  };
  return table[value] || String(value || "UNKNOWN").toUpperCase();
}
function attention(item) {
  return ["degraded", "blocked", "unknown"].includes(item.technicalReadiness.status)
    || ["failed", "insufficient-data", "null-result", "stale"].includes(item.fieldProof.status)
    || item.provenance.some((row) => String(row.freshness).startsWith("stale"));
}
function filteredCapabilities(snapshot, filter) {
  if (filter === "attention") return snapshot.capabilities.filter(attention);
  if (filter === "stale") return snapshot.capabilities.filter((item) => item.provenance.some((row) => String(row.freshness).startsWith("stale")));
  return snapshot.capabilities;
}
function bordered(lines, width) {
  const inner = Math.max(1, width - 2);
  return [`+${"-".repeat(inner)}+`, ...lines.map((line) => `|${fit(line, inner)}|`), `+${"-".repeat(inner)}+`];
}
function compactRow(item, selected, width) {
  const stage = item.currentStage ? ` ${item.currentStage}` : "";
  const prefix = selected ? ">" : " ";
  const label = LABELS[item.capabilityId] || item.capabilityId;
  const row = `${prefix} ${label}${stage} | T:${status(item.technicalReadiness.status)} P:${status(item.policyAuthorization.status)} F:${status(item.fieldProof.status)}`;
  return fit(row, width);
}
function detailLines(item, width) {
  if (!item) return [fit("No capability selected", width)];
  const label = LABELS[item.capabilityId] || item.capabilityId;
  return [
    fit(`${label}${item.currentStage ? ` / ${item.currentStage}` : ""}`, width),
    fit(`technical : ${status(item.technicalReadiness.status)}`, width),
    fit(`policy    : ${status(item.policyAuthorization.status)} mutation=${item.policyAuthorization.mutationAllowed ? "yes" : "no"} auto=${item.policyAuthorization.automationAllowed ? "yes" : "no"}`, width),
    fit(`field     : ${status(item.fieldProof.status)} n=${item.fieldProof.sampleSize} days=${item.fieldProof.observedDays}`, width),
    fit(`rollback  : ${status(item.rollbackControl.status)}`, width),
    fit(`next      : ${item.nextObservation.actionCode}`, width),
    fit(`surface   : ${item.nextObservation.surfaceId || "none"}`, width),
    fit(`provenance: ${item.provenance.length} record(s)`, width),
    ...item.provenance.slice(0, 4).map((row) => fit(`- ${row.sourceId} ${row.freshness} ${row.evidenceRef || "no-evidence"}`, width)),
  ];
}
function provenanceLines(item, width) {
  if (!item) return [fit("No capability selected", width)];
  return [fit(`Provenance / ${LABELS[item.capabilityId] || item.capabilityId}`, width), ...item.provenance.map((row, index) => fit(`${index + 1}. ${row.sourceId} ${row.recordType} ${row.freshness} ${row.evidenceRef || "none"}`, width))];
}

function renderRolloutCenterFrame(snapshot, state = {}, requestedWidth = 80) {
  const width = Math.max(32, Math.floor(Number(requestedWidth) || 80));
  const filter = state.filter || "all";
  const capabilities = filteredCapabilities(snapshot, filter);
  const selectedIndex = Math.max(0, Math.min(capabilities.length - 1, Number(state.selectedIndex) || 0));
  const selected = capabilities[selectedIndex] || null;
  const stale = snapshot.counts?.stale || 0;
  const header = `Rollout Center | ${snapshot.posture} | filter=${filter} | stale=${stale}`;
  const footer = "Up/Down select | Enter detail | P provenance | Tab filter | R refresh | Esc close";
  const body = [fit(header, width - 2)];
  if (width < 52) {
    for (const [index, item] of capabilities.entries()) body.push(compactRow(item, index === selectedIndex, width - 2));
    if (!capabilities.length) body.push(fit("No capabilities match this filter", width - 2));
    if (state.mode === "detail") body.push(...detailLines(selected, width - 2));
    if (state.mode === "provenance") body.push(...provenanceLines(selected, width - 2));
  } else if (width < 96) {
    for (const [index, item] of capabilities.entries()) body.push(compactRow(item, index === selectedIndex, width - 2));
    body.push(fit("-".repeat(width - 2), width - 2));
    body.push(...(state.mode === "provenance" ? provenanceLines(selected, width - 2) : detailLines(selected, width - 2)));
  } else {
    const inner = width - 2; const left = 43; const right = inner - left - 3;
    const leftRows = capabilities.map((item, index) => compactRow(item, index === selectedIndex, left));
    const rightRows = state.mode === "provenance" ? provenanceLines(selected, right) : detailLines(selected, right);
    const rows = Math.max(leftRows.length, rightRows.length);
    for (let index = 0; index < rows; index++) body.push(`${fit(leftRows[index] || "", left)} | ${fit(rightRows[index] || "", right)}`);
  }
  body.push(fit(footer, width - 2));
  const frame = bordered(body, width);
  if (frame.some((line) => visibleLength(line) > width)) throw new Error("rollout frame exceeded requested width");
  return frame;
}

module.exports = { LABELS, renderRolloutCenterFrame, filteredCapabilities, attention, fit, visibleLength };
