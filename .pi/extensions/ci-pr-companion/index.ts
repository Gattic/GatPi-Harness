import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { normalizeOperation } = require("../../../src/pi-extension-kit.js");
const CI_OPERATIONS = ["ciStatus", "ciFailures", "prSummary", "prReview", "prRisk", "prVerify"];
const ENABLED = process.env.PI_CI_PR_COMPANION !== "0";
const STATE_DIR = ".pi/ci-pr-companion";
function writeJson(file: string, data: any) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`); }
function run(cwd: string, cmd: string, args: string[], timeout = 8000) { try { return { ok: true, stdout: execFileSync(cmd, args, { cwd, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim() }; } catch (e: any) { return { ok: false, stdout: String(e?.stdout || "").trim(), stderr: String(e?.stderr || e?.message || e).trim() }; } }
function workflows(cwd: string) { const dir = join(cwd, ".github", "workflows"); try { return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => ({ file: `.github/workflows/${f}`, text: readFileSync(join(dir, f), "utf8").slice(0, 4000) })); } catch { return []; } }
function ciStatus(cwd: string) { const gh = run(cwd, "gh", ["run", "list", "--limit", "10", "--json", "databaseId,status,conclusion,workflowName,headBranch,createdAt,url"]); const git = run(cwd, "git", ["status", "--short"]); const branch = run(cwd, "git", ["branch", "--show-current"]); return { generatedAt: new Date().toISOString(), branch: branch.stdout, ghAvailable: gh.ok, runs: gh.ok ? JSON.parse(gh.stdout || "[]") : [], ghError: gh.ok ? undefined : gh.stderr, gitStatus: git.stdout, workflows: workflows(cwd).map((w) => w.file) }; }
function failures(cwd: string) { const status = ciStatus(cwd); const failed = (status.runs || []).filter((r: any) => r.conclusion && r.conclusion !== "success"); return { ...status, failed, recommendation: failed.length ? "Use gh run view <id> --log or paste CI logs into /pr-review for local triage." : "No failed GitHub runs found or gh unavailable." }; }
function prSummary(cwd: string) { const pr = run(cwd, "gh", ["pr", "view", "--json", "number,title,state,author,headRefName,baseRefName,url,body,reviewDecision,statusCheckRollup"]); const diff = run(cwd, "git", ["diff", "--stat", "HEAD"]); const files = run(cwd, "git", ["diff", "--name-only", "HEAD"]); return { generatedAt: new Date().toISOString(), prAvailable: pr.ok, pr: pr.ok ? JSON.parse(pr.stdout || "{}") : null, prError: pr.ok ? undefined : pr.stderr, diffStat: diff.stdout, changedFiles: files.stdout.split(/\n/).filter(Boolean) }; }
function review(cwd: string) { const pr = prSummary(cwd); const ci = failures(cwd); const risks = [] as string[]; if (pr.changedFiles.some((f: string) => /package|lock|Dockerfile|\.github/.test(f))) risks.push("dependency/build/CI configuration changed"); if (pr.changedFiles.some((f: string) => /auth|secret|token|privacy|security/i.test(f))) risks.push("security/privacy-sensitive files changed"); if (ci.failed?.length) risks.push("CI has non-success runs"); return { generatedAt: new Date().toISOString(), pr, ci: { failed: ci.failed, workflows: ci.workflows }, risks, recommendations: ["Run /test-gaps for changed files", "Run /verify-plan changed or /verify-run changed", risks.length ? "Use /policy-check for risky commands/paths" : "Proceed with normal reviewer-verifier gate"] }; }
function formatStatus(s: any) { return [`CI status branch=${s.branch || "unknown"} gh=${s.ghAvailable}`, ...(s.runs || []).slice(0, 8).map((r: any) => `${r.status}/${r.conclusion || "-"} ${r.workflowName} ${r.url || ""}`), s.ghError ? `gh: ${s.ghError}` : ""].filter(Boolean).join("\n"); }

export default function ciPrCompanion(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  if (!ENABLED) return;
  pi.registerCommand("ci-status", { description: "Show local/GitHub CI status when gh is available", handler: async (_args: string, ctx: any) => { const s = ciStatus(ctx.cwd); writeJson(join(ctx.cwd, STATE_DIR, "latest-ci-status.json"), s); ctx.ui.notify(formatStatus(s), s.ghAvailable ? "info" : "warning"); } });
  pi.registerCommand("ci-failures", { description: "Show failed/non-success CI runs", handler: async (_args: string, ctx: any) => ctx.ui.notify(JSON.stringify(failures(ctx.cwd), null, 2), "info") });
  pi.registerCommand("pr-summary", { description: "Summarize current pull request when gh is available", handler: async (_args: string, ctx: any) => ctx.ui.notify(JSON.stringify(prSummary(ctx.cwd), null, 2), "info") });
  pi.registerCommand("pr-review", { description: "Generate local PR review risks and recommended checks", handler: async (_args: string, ctx: any) => ctx.ui.notify(JSON.stringify(review(ctx.cwd), null, 2), "info") });
  pi.registerCommand("pr-risk", { description: "Show PR risk summary", handler: async (_args: string, ctx: any) => ctx.ui.notify(JSON.stringify({ risks: review(ctx.cwd).risks }, null, 2), "info") });
  pi.registerCommand("pr-verify", { description: "Recommend PR verification commands", handler: async (_args: string, ctx: any) => ctx.ui.notify(["Recommended PR verification:", "1. /test-gaps", "2. /verify-run changed", "3. /policy-check <risky command> if needed", "4. /topology-recommend review verification"].join("\n"), "info") });
  pi.registerTool({
    name: "ci_pr_companion",
    label: "CI/PR companion",
    description: "Inspect optional GitHub CI/PR context and recommend local verification, risk, and review actions.",
    parameters: Type.Object({ operation: Type.Optional(Type.String({ description: "Operation: ciStatus, ciFailures, prSummary, prReview, prRisk, or prVerify. Case, snake_case, and kebab-case variants are accepted; status/failures/summary/review/risk/verify are aliases." })), input: Type.Optional(Type.Any()) }),
    async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
      const op = normalizeOperation(params.operation, {
        toolName: "ci_pr_companion",
        defaultOperation: "ciStatus",
        operations: CI_OPERATIONS,
        aliases: { status: "ciStatus", ci: "ciStatus", failures: "ciFailures", summary: "prSummary", pr: "prSummary", review: "prReview", risk: "prRisk", verify: "prVerify" },
      });
      const details = op === "ciFailures" ? failures(ctx.cwd) : op === "prSummary" ? prSummary(ctx.cwd) : op === "prReview" ? review(ctx.cwd) : op === "prRisk" ? { risks: review(ctx.cwd).risks } : op === "prVerify" ? { commands: ["/test-gaps", "/verify-run changed", "/policy-check <risky command>"] } : ciStatus(ctx.cwd);
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });
}
