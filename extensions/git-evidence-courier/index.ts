import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { runSecurityCheckpoint, securityCheckpointSummary } = require("../../src/security-checkpoint.js");

type Level = "info" | "warning" | "error";

type RunResult = {
	label: string;
	command: string;
	code: number;
	stdout: string;
	stderr: string;
	killed: boolean;
};

type RepoInfo =
	| {
			ok: true;
			root: string;
			branch: string;
			upstream?: string;
			localSha: string;
			shortSha: string;
			porcelain: string;
			isClean: boolean;
			totalChanged: number;
			reason?: string;
	  }
	| {
			ok: false;
			reason: string;
	  };

type Report = {
	title: string;
	body: string;
	level: Level;
	details?: Record<string, unknown>;
};

type PostgresIsolation = {
	required: boolean;
	provisioned: boolean;
	runtime?: "docker" | "podman";
	containerName?: string;
	volumeName?: string;
	port?: number;
	connectionString?: string;
	cleanup: "not-required" | "not-started" | "pending" | "removed" | "already-removed" | "failed";
	failure?: string;
	infrastructure: RunResult[];
};

const GIT_TIMEOUT_MS = 30_000;
// Per verifier command. A Prisma repository's full suite (cold migration replay plus
// unit and database tests) was measured at 73 minutes; 30 minutes killed it every time.
const VERIFY_TIMEOUT_MS = 120 * 60_000;
const PUSH_TIMEOUT_MS = 2 * 60_000;
const POSTGRES_IMAGE = "docker.io/postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777";
// `docker stop` returns before Docker finishes auto-removing a --rm container; an inspect
// in that window still finds it (state "removing"). Measured: 10 of 10 immediate inspects.
const CONTAINER_REMOVAL_CONFIRMATION_ATTEMPTS = 40;
const CONTAINER_REMOVAL_CONFIRMATION_INTERVAL_MS = 250;
const POSTGRES_USER = "gitverify";
const POSTGRES_DATABASE = "gitverify_test";

const EMPTY_PARAMS = Type.Object({});

function trim(s: string): string {
	return s.trim();
}

function succeeded(result: RunResult): boolean {
	return result.code === 0 && !result.killed;
}

function clip(s: string, max = 6_000): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]`;
}

function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'"'"'`)}'`;
}

function reportText(report: Report): string {
	return `${report.title}\n\n${report.body}`;
}

function publicRun(result: RunResult): Record<string, unknown> {
	return {
		label: result.label,
		command: result.command,
		code: result.code,
		killed: result.killed,
		stdout: clip(result.stdout.trim(), 1_500),
		stderr: clip(result.stderr.trim(), 1_500),
	};
}

async function exec(
	pi: ExtensionAPI,
	cwd: string,
	label: string,
	command: string,
	args: string[],
	timeout = GIT_TIMEOUT_MS,
): Promise<RunResult> {
	const result = await pi.exec(command, args, { cwd, timeout });
	const rendered = [command, ...args.map(shellQuote)].join(" ");
	return {
		label,
		command: rendered,
		code: result.code,
		stdout: result.stdout,
		stderr: result.stderr,
		killed: result.killed,
	};
}

async function git(
	pi: ExtensionAPI,
	cwd: string,
	label: string,
	args: string[],
	timeout = GIT_TIMEOUT_MS,
): Promise<RunResult> {
	// Interrupted diagnostic refreshes must not leave index.lock behind.
	// Mandatory locks for explicit Git mutations remain enabled.
	return exec(pi, cwd, label, "git", ["--no-optional-locks", ...args], timeout);
}

async function shell(
	pi: ExtensionAPI,
	cwd: string,
	label: string,
	command: string,
	timeout = VERIFY_TIMEOUT_MS,
	environment?: Record<string, string>,
): Promise<RunResult> {
	const assignments = Object.entries(environment ?? {}).map(([key, value]) => `${key}=${value}`);
	const executable = assignments.length > 0 ? "env" : "sh";
	const args = assignments.length > 0 ? [...assignments, "sh", "-lc", command] : ["-lc", command];
	const result = await pi.exec(executable, args, { cwd, timeout });
	return {
		label,
		command,
		code: result.code,
		stdout: result.stdout,
		stderr: result.stderr,
		killed: result.killed,
	};
}

async function getRepoInfo(pi: ExtensionAPI, cwd: string): Promise<RepoInfo> {
	const root = await git(pi, cwd, "repo root", ["rev-parse", "--show-toplevel"]);
	if (!succeeded(root)) {
		return { ok: false, reason: "Not inside a git repository." };
	}

	const repoRoot = trim(root.stdout);
	const branch = await git(pi, repoRoot, "branch", ["branch", "--show-current"]);
	const sha = await git(pi, repoRoot, "HEAD", ["rev-parse", "HEAD"]);
	const shortSha = await git(pi, repoRoot, "short HEAD", ["rev-parse", "--short", "HEAD"]);
	const porcelain = await git(pi, repoRoot, "porcelain", ["status", "--porcelain"]);
	const upstream = await git(pi, repoRoot, "upstream", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);

	if (!succeeded(sha)) {
		return { ok: false, reason: "Could not resolve HEAD." };
	}
	if (![branch, shortSha, porcelain].every(succeeded)) {
		return { ok: false, reason: "Could not inspect repository state." };
	}

	return {
		ok: true,
		root: repoRoot,
		branch: trim(branch.stdout),
		upstream: succeeded(upstream) ? trim(upstream.stdout) : undefined,
		localSha: trim(sha.stdout),
		shortSha: trim(shortSha.stdout),
		porcelain: porcelain.stdout,
		isClean: trim(porcelain.stdout).length === 0,
		totalChanged: porcelain.stdout.split("\n").filter(Boolean).length,
	};
}

function parseUpstream(upstream: string | undefined, branch: string): { remote: string; branch: string } {
	if (upstream && upstream.includes("/")) {
		const [remote, ...rest] = upstream.split("/");
		return { remote, branch: rest.join("/") };
	}
	return { remote: "origin", branch };
}

function parsePublishArgs(
	args: string,
	fallbackBranch: string,
): {
	verify: boolean;
	remote: string;
	branch: string;
	help: boolean;
	error?: string;
} {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let verify = false;
	let help = false;
	const positional: string[] = [];

	for (const token of tokens) {
		if (token === "--verify") verify = true;
		else if (token === "--no-verify") verify = false;
		else if (token === "--help" || token === "-h") help = true;
		else if (token.startsWith("-")) {
			return { verify, remote: "origin", branch: fallbackBranch, help, error: `Unknown option: ${token}` };
		} else positional.push(token);
	}

	if (positional.length > 2) {
		return { verify, remote: "origin", branch: fallbackBranch, help, error: "Usage: /git:publish [--verify] [remote] [branch]" };
	}

	return {
		verify,
		remote: positional[0] ?? "origin",
		branch: positional[1] ?? fallbackBranch,
		help,
	};
}

async function pathExists(pi: ExtensionAPI, cwd: string, path: string): Promise<boolean> {
	const result = await exec(pi, cwd, `exists ${path}`, "test", ["-e", path]);
	if (result.killed || (result.code !== 0 && result.code !== 1)) {
		throw new Error(`Could not check whether ${path} exists.\n${formatRun(result)}`);
	}
	return succeeded(result);
}

function splitUserCommands(args: string): string[] {
	const text = args.trim();
	if (!text) return [];
	return text
		.split(/\s*(?:&&|\n)\s*/)
		.map((s) => s.trim())
		.filter(Boolean);
}

async function inferVerifyCommands(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	const commands = ["git diff --check", "git diff --cached --check"];

	if ((await pathExists(pi, cwd, "lakefile.lean")) || (await pathExists(pi, cwd, "lakefile.toml"))) {
		commands.push("lake build");
		return commands;
	}
	if (await pathExists(pi, cwd, "Cargo.toml")) {
		commands.push("cargo test");
		return commands;
	}
	if (await pathExists(pi, cwd, "go.mod")) {
		commands.push("go test ./...");
		return commands;
	}
	if ((await pathExists(pi, cwd, "pyproject.toml")) || (await pathExists(pi, cwd, "pytest.ini"))) {
		commands.push("pytest");
		return commands;
	}
	if (await pathExists(pi, cwd, "package.json")) {
		commands.push("npm run lint --if-present", "npm run typecheck --if-present", "npm test --if-present");
		return commands;
	}

	return commands;
}

async function detectIsolatedPostgres(pi: ExtensionAPI, cwd: string): Promise<{ required: boolean; failure?: string }> {
	const schemaPath = join(cwd, "prisma", "schema.prisma");
	if (!(await pathExists(pi, cwd, schemaPath))) return { required: false };
	try {
		const schema = await readFile(schemaPath, "utf8");
		return { required: /provider\s*=\s*["']postgresql["']/.test(schema) };
	} catch {
		return { required: true, failure: "Could not inspect prisma/schema.prisma safely; refusing to run inferred verifiers without database isolation." };
	}
}

function failedRun(label: string, message: string): RunResult {
	return {
		label,
		command: label,
		code: 1,
		stdout: "",
		stderr: message,
		killed: false,
	};
}

function redactIsolationSecrets(result: RunResult, isolation: PostgresIsolation): RunResult {
	if (!isolation.connectionString) return result;
	const password = new URL(isolation.connectionString).password;
	const redact = (value: string) => value
		.replaceAll(isolation.connectionString!, "[isolated-postgres-url]")
		.replaceAll(password, "[redacted]");
	return { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) };
}

async function provisionIsolatedPostgres(pi: ExtensionAPI, cwd: string, isolation: PostgresIsolation): Promise<void> {
	const detection = await detectIsolatedPostgres(pi, cwd);
	isolation.required = detection.required;
	if (!detection.required) return;
	isolation.cleanup = "not-started";
	isolation.failure = detection.failure;
	if (detection.failure) return;

	for (const candidate of ["docker", "podman"] as const) {
		const versionTemplate = candidate === "docker" ? "{{.ServerVersion}}" : "{{.Version.Version}}";
		const available = await exec(pi, cwd, `${candidate} daemon`, candidate, ["info", "--format", versionTemplate]);
		if (succeeded(available)) {
			isolation.runtime = candidate;
			break;
		}
	}
	if (!isolation.runtime) {
		isolation.failure = "No usable Docker or Podman runtime is available for the isolated PostgreSQL verifier.";
		return;
	}

	const containerName = `pi-gitverify-postgres-${randomBytes(8).toString("hex")}`;
	const password = randomBytes(24).toString("hex");
	isolation.containerName = containerName;
	isolation.volumeName = `${containerName}-data`;
	// Record both names before allocation: an interrupted client may still create them.
	isolation.cleanup = "pending";
	const storage = await exec(pi, cwd, "create isolated PostgreSQL volume", isolation.runtime, [
		"volume", "create", "--driver", "local", "--label", "pi.gitverify=isolated", isolation.volumeName,
	]);
	isolation.infrastructure.push(storage);
	if (!succeeded(storage)) {
		isolation.failure = "Could not create the isolated PostgreSQL data volume.";
		return;
	}
	const launch = await exec(
		pi,
		cwd,
		"start isolated PostgreSQL",
		isolation.runtime,
		[
			"run",
			"--detach",
			"--rm",
			"--name",
			containerName,
			"--label",
			"pi.gitverify=isolated",
			"--publish",
			"127.0.0.1::5432",
			// Migration temporary files share PGDATA; keep them off bounded RAM filesystems.
			"--volume",
			`${isolation.volumeName}:/var/lib/postgresql/data`,
			"--memory",
			"3g",
			"--cpus",
			"2",
			"--env",
			`POSTGRES_USER=${POSTGRES_USER}`,
			"--env",
			`POSTGRES_PASSWORD=${password}`,
			"--env",
			`POSTGRES_DB=${POSTGRES_DATABASE}`,
			POSTGRES_IMAGE,
		],
		2 * 60_000,
	);
	launch.command = `${isolation.runtime} run --detach --rm --name ${shellQuote(containerName)} --label pi.gitverify=isolated --publish 127.0.0.1::5432 [isolated-postgres-image]`;
	isolation.infrastructure.push(launch);
	if (!succeeded(launch)) {
		isolation.failure = `Could not start the isolated PostgreSQL container: ${trim(launch.stderr) || `exit ${launch.code}${launch.killed ? ", killed" : ""}`}`;
		return;
	}

	const portResult = await exec(pi, cwd, "isolated PostgreSQL port", isolation.runtime, ["port", containerName, "5432/tcp"]);
	isolation.infrastructure.push(portResult);
	const portMatch = trim(portResult.stdout).match(/^127\.0\.0\.1:(\d+)$/m);
	if (!succeeded(portResult) || !portMatch) {
		isolation.failure = "The isolated PostgreSQL container did not expose a loopback-only host port.";
		return;
	}
	isolation.port = Number(portMatch[1]);

	let readiness: RunResult | undefined;
	for (let attempt = 0; attempt < 60; attempt += 1) {
		readiness = await exec(
			pi,
			cwd,
			"isolated PostgreSQL readiness",
			isolation.runtime,
			["exec", containerName, "pg_isready", "-U", POSTGRES_USER, "-d", POSTGRES_DATABASE],
			10_000,
		);
		if (succeeded(readiness) || readiness.killed) break;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	if (readiness) isolation.infrastructure.push(readiness);
	if (!readiness || !succeeded(readiness)) {
		isolation.failure = "The isolated PostgreSQL container did not become ready within 15 seconds.";
		return;
	}

	isolation.provisioned = true;
	isolation.connectionString = `postgresql://${POSTGRES_USER}:${password}@127.0.0.1:${isolation.port}/${POSTGRES_DATABASE}`;
}

async function cleanupIsolatedPostgres(pi: ExtensionAPI, cwd: string, isolation: PostgresIsolation): Promise<void> {
	const { runtime, containerName, volumeName } = isolation;
	if (!runtime || !containerName || !volumeName || isolation.cleanup !== "pending") return;

	const fail = (message: string) => {
		isolation.failure = `${isolation.failure ? `${isolation.failure} ` : ""}${message}`;
		return "failed" as const;
	};
	const absent = (result: RunResult) => !result.killed && result.code > 0
		&& /no such (?:object|container|volume)|does not exist/i.test(`${result.stdout}\n${result.stderr}`);

	const removeOwned = async (kind: "container" | "volume", name: string): Promise<"removed" | "already-removed" | "failed"> => {
		const inspectArgs = kind === "container"
			? ["inspect", "--type", "container", "--format", "{{ index .Config.Labels \"pi.gitverify\" }}", name]
			: ["volume", "inspect", "--format", "{{ index .Labels \"pi.gitverify\" }}", name];
		const ownership = await exec(pi, cwd, `verify isolated PostgreSQL ${kind} ownership`, runtime, inspectArgs);
		isolation.infrastructure.push(ownership);
		if (absent(ownership)) return "already-removed";
		if (!succeeded(ownership)) return fail(`Could not confirm isolated PostgreSQL ${kind} ownership before cleanup.`);
		if (trim(ownership.stdout) !== "isolated") return fail(`Refused to remove a ${kind} without the pi.gitverify=isolated label.`);

		const removal = await exec(pi, cwd, `remove isolated PostgreSQL ${kind}`, runtime, kind === "container"
			? ["stop", "--time", "5", name]
			: ["volume", "rm", name]);
		isolation.infrastructure.push(removal);
		if (!succeeded(removal)) return fail(`Failed to remove the isolated PostgreSQL ${kind}.`);
		// Wait while the container is still present; any other outcome is final.
		const attempts = kind === "container" ? CONTAINER_REMOVAL_CONFIRMATION_ATTEMPTS : 1;
		let confirmation = await exec(pi, cwd, `confirm isolated PostgreSQL ${kind} removal`, runtime, inspectArgs);
		for (let attempt = 1; attempt < attempts && succeeded(confirmation); attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, CONTAINER_REMOVAL_CONFIRMATION_INTERVAL_MS));
			confirmation = await exec(pi, cwd, `confirm isolated PostgreSQL ${kind} removal`, runtime, inspectArgs);
		}
		isolation.infrastructure.push(confirmation);
		return absent(confirmation) ? "removed" : fail(`Could not confirm removal of the isolated PostgreSQL ${kind}.`);
	};

	const container = await removeOwned("container", containerName);
	if (container === "failed") {
		isolation.cleanup = "failed";
		return;
	}
	// A failed launch or an auto-removed container can still leave its named volume.
	const volume = await removeOwned("volume", volumeName);
	isolation.cleanup = volume === "failed" ? "failed"
		: container === "already-removed" && volume === "already-removed" ? "already-removed" : "removed";
}

function publicIsolation(isolation: PostgresIsolation): Record<string, unknown> {
	return {
		required: isolation.required,
		provisioned: isolation.provisioned,
		runtime: isolation.runtime,
		containerName: isolation.containerName,
		volumeName: isolation.volumeName,
		loopbackPort: isolation.port,
		cleanup: isolation.cleanup,
		failure: isolation.failure,
		infrastructure: isolation.infrastructure.map(publicRun),
	};
}

function formatIsolation(isolation: PostgresIsolation): string[] {
	if (!isolation.required) return ["- Not required (no Prisma PostgreSQL datasource detected)."];
	return [
		`- Provisioned: ${isolation.provisioned && isolation.connectionString ? "yes" : "no"}`,
		`- Runtime: ${isolation.runtime ?? "unavailable"}`,
		`- Container: ${isolation.containerName ?? "not started"}`,
		`- Data volume: ${isolation.volumeName ?? "not created"}`,
		`- Host binding: ${isolation.port ? `127.0.0.1:${isolation.port}` : "unavailable"}`,
		`- Cleanup: ${isolation.cleanup}`,
		...(isolation.failure ? [`- Failure: ${isolation.failure}`] : []),
	];
}

async function runVerify(
	pi: ExtensionAPI,
	cwd: string,
	args: string,
): Promise<{ ok: boolean; commands: string[]; results: RunResult[]; isolation: PostgresIsolation; security: any }> {
	const explicit = splitUserCommands(args);
	const commands = explicit.length > 0 ? explicit : await inferVerifyCommands(pi, cwd);
	const results: RunResult[] = [];
	const security = runSecurityCheckpoint(cwd);
	const isolation: PostgresIsolation = { required: false, provisioned: false, cleanup: "not-required", infrastructure: [] };

	try {
		if (explicit.length === 0) await provisionIsolatedPostgres(pi, cwd, isolation);
		if (isolation.required && !isolation.connectionString) {
			results.push(failedRun("isolated PostgreSQL provisioning", isolation.failure ?? "Isolated PostgreSQL provisioning failed."));
		} else {
			const environment = isolation.connectionString
				? {
						TEST_DATABASE_URL: isolation.connectionString,
						DATABASE_URL: isolation.connectionString,
						DIRECT_DATABASE_URL: isolation.connectionString,
					}
				: undefined;
			for (const command of commands) {
				const result = redactIsolationSecrets(
					await shell(pi, cwd, command, command, VERIFY_TIMEOUT_MS, environment),
					isolation,
				);
				results.push(result);
				if (!succeeded(result)) break;
			}
		}
	} finally {
		await cleanupIsolatedPostgres(pi, cwd, isolation);
	}

	const ok = results.length === commands.length && results.every(succeeded) && isolation.cleanup !== "failed";
	return { ok, commands, results, isolation, security };
}

function formatRun(result: RunResult): string {
	const mark = succeeded(result) ? "✅" : "❌";
	let text = `- ${mark} ${result.label}: ${result.command} (exit ${result.code}${result.killed ? ", killed" : ""})`;
	const output = clip([result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n"), 1_500);
	if (output) text += `\n${output.split("\n").map((line) => `  ${line}`).join("\n")}`;
	return text;
}

function emitReport(pi: ExtensionAPI, ctx: ExtensionCommandContext, title: string, body: string, level: Level = "info", details?: Record<string, unknown>) {
	const text = `${title}\n\n${body}`;
	console.log(text);
	try {
		pi.sendMessage({
			customType: "git-evidence-courier",
			content: text,
			display: true,
			details: { title, timestamp: Date.now(), ...details },
		});
	} catch {
		// Non-session contexts can ignore persisted display messages.
	}
	ctx.ui.notify(title, level);
}

async function buildEvidenceReport(pi: ExtensionAPI, cwd: string): Promise<Report> {
	const repo = await getRepoInfo(pi, cwd);
	if (!repo.ok) {
		return {
			title: "Git evidence unavailable",
			body: repo.reason,
			level: "warning",
			details: { ok: false, reason: repo.reason },
		};
	}

	const status = await git(pi, repo.root, "status", ["status", "--short", "--branch"]);
	const lastCommit = await git(pi, repo.root, "last commit", ["log", "-1", "--oneline"]);
	const diffStat = await git(pi, repo.root, "diff stat", ["diff", "--stat"]);
	const cachedStat = await git(pi, repo.root, "cached diff stat", ["diff", "--cached", "--stat"]);
	const upstream = parseUpstream(repo.upstream, repo.branch);
	const remoteSha = await git(pi, repo.root, "remote SHA", ["ls-remote", upstream.remote, `refs/heads/${upstream.branch}`]);
	const verifierHints = await inferVerifyCommands(pi, repo.root);

	const remoteLine = succeeded(remoteSha) && trim(remoteSha.stdout) ? trim(remoteSha.stdout).split(/\s+/)[0] : "unavailable";
	// ls-remote is live, but the origin/<branch> tracking ref only moves on fetch or push.
	// Counting against the tracking ref would pair a current remote SHA with stale counts,
	// so count against the SHA the remote reported; use the tracking ref only when the
	// remote reported none (unreachable, or the branch no longer exists), and say so.
	const remoteShaKnown = /^[0-9a-f]{40,64}$/.test(remoteLine);
	const countAgainst = remoteShaKnown ? remoteLine : repo.upstream;
	const aheadBehind = countAgainst
		? await git(pi, repo.root, "ahead/behind", ["rev-list", "--left-right", "--count", `HEAD...${countAgainst}`])
		: undefined;
	const cleanLine = repo.isClean ? "clean" : `${repo.totalChanged} changed file(s)`;
	const aheadBehindParts = aheadBehind && succeeded(aheadBehind) ? trim(aheadBehind.stdout).split(/\s+/) : undefined;
	const aheadBehindCounts = aheadBehindParts ? `${aheadBehindParts[0]} ahead / ${aheadBehindParts[1]} behind` : undefined;
	let aheadBehindLine = "(unavailable)";
	if (aheadBehindCounts) {
		aheadBehindLine = remoteShaKnown ? aheadBehindCounts : `${aheadBehindCounts} (last-fetched ${repo.upstream}; remote SHA unavailable)`;
	} else if (remoteShaKnown) {
		aheadBehindLine = `(unavailable: remote commit ${remoteLine.slice(0, 7)} is not in the local repository; run git fetch)`;
	}

	const lines = [
		`Repo: ${repo.root}`,
		`Branch: ${repo.branch || "(detached)"}`,
		`Upstream: ${repo.upstream ?? "(none)"}`,
		`Local SHA: ${repo.localSha}`,
		`Remote ${upstream.remote}/${upstream.branch}: ${remoteLine}`,
		`Tree: ${cleanLine}`,
		"",
		"Status:",
		clip(status.stdout.trim() || "(clean)"),
		"",
		"Last commit:",
		clip(lastCommit.stdout.trim() || "(none)"),
		"",
		"Ahead/behind:",
		aheadBehindLine,
		"",
		"Unstaged diff stat:",
		clip(diffStat.stdout.trim() || "(none)"),
		"",
		"Staged diff stat:",
		clip(cachedStat.stdout.trim() || "(none)"),
		"",
		"Suggested verification:",
		...verifierHints.map((cmd) => `- ${cmd}`),
	];

	return {
		title: "Git evidence",
		body: lines.join("\n"),
		level: "info",
		details: {
			ok: true,
			outcome: repo.isClean ? "succeeded" : "domain-negative",
			repoRoot: repo.root,
			branch: repo.branch,
			upstream: repo.upstream,
			localSha: repo.localSha,
			remote: `${upstream.remote}/${upstream.branch}`,
			remoteSha: remoteLine,
			isClean: repo.isClean,
			totalChanged: repo.totalChanged,
			ahead: aheadBehindParts?.[0],
			behind: aheadBehindParts?.[1],
			verifierHints,
			status: publicRun(status),
			lastCommit: publicRun(lastCommit),
			diffStat: publicRun(diffStat),
			cachedDiffStat: publicRun(cachedStat),
		},
	};
}

async function buildVerifyReport(pi: ExtensionAPI, cwd: string, args: string): Promise<Report> {
	const repo = await getRepoInfo(pi, cwd);
	if (!repo.ok) {
		return {
			title: "Git verify unavailable",
			body: repo.reason,
			level: "warning",
			details: { ok: false, reason: repo.reason },
		};
	}

	const verification = await runVerify(pi, repo.root, args);
	const treeAfter = await git(pi, repo.root, "status", ["status", "--porcelain"]);
	const statusKnown = succeeded(treeAfter);
	const cleanAfter = statusKnown && trim(treeAfter.stdout).length === 0;
	const ok = verification.ok && statusKnown;

	const body = [
		`Repo: ${repo.root}`,
		`Result: ${ok ? "passed" : "failed"}`,
		`Tree after verify: ${statusKnown ? (cleanAfter ? "clean" : "dirty") : "unknown"}`,
		...(!statusKnown ? [formatRun(treeAfter)] : []),
		securityCheckpointSummary(verification.security),
		...((verification.security.semgrep?.findings || []).slice(0, 10).map((finding: any) => `- ${finding.path}:${finding.start?.line || 1} ${finding.checkId}: ${finding.message}`)),
		"",
		"Isolated PostgreSQL:",
		...formatIsolation(verification.isolation),
		"",
		"Commands:",
		...verification.results.map(formatRun),
	].join("\n");

	return {
		title: ok ? "Git verify passed" : "Git verify failed",
		body,
		level: ok ? "info" : "error",
		details: {
			ok,
			repoRoot: repo.root,
			cleanAfter,
			status: publicRun(treeAfter),
			commands: verification.commands,
			results: verification.results.map(publicRun),
			isolatedPostgres: publicIsolation(verification.isolation),
			security: verification.security,
		},
	};
}

async function evidence(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	const report = await buildEvidenceReport(pi, ctx.cwd);
	emitReport(pi, ctx, report.title, report.body, report.level, report.details);
}

async function verify(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string) {
	const report = await buildVerifyReport(pi, ctx.cwd, args);
	emitReport(pi, ctx, report.title, report.body, report.level, report.details);
}

async function publish(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string) {
	const repo = await getRepoInfo(pi, ctx.cwd);
	if (!repo.ok) {
		emitReport(pi, ctx, "Git publish unavailable", repo.reason, "warning");
		return;
	}
	if (!repo.branch) {
		emitReport(pi, ctx, "Git publish blocked", "Detached HEAD; cannot infer branch to publish.", "error");
		return;
	}
	const parsed = parsePublishArgs(args, repo.branch);
	if (parsed.help || parsed.error) {
		emitReport(pi, ctx, parsed.error ? "Git publish usage error" : "Git publish usage", parsed.error ?? "Usage: /git:publish [--verify] [remote] [branch]", parsed.error ? "error" : "info");
		return;
	}
	if (!repo.isClean) {
		const changed = clip(trim(repo.porcelain));
		emitReport(pi, ctx, "Git publish blocked", `Working tree is not clean. Commit or stash changes first.\n\n${changed}`, "error");
		return;
	}

	const steps: string[] = [
		`Repo: ${repo.root}`,
		`Branch: ${repo.branch}`,
		`Target: ${parsed.remote}/${parsed.branch}`,
		"Pre-push tree: clean",
		`Local SHA before push: ${repo.localSha}`,
	];

	if (parsed.verify) {
		const verification = await runVerify(pi, repo.root, "");
		steps.push("", "Verification:", ...verification.results.map(formatRun));
		if (!verification.ok) {
			emitReport(pi, ctx, "Git publish blocked", steps.join("\n"), "error");
			return;
		}
	}

	const remoteBefore = await git(pi, repo.root, "remote SHA before", ["ls-remote", parsed.remote, `refs/heads/${parsed.branch}`]);
	const remoteBeforeSha = succeeded(remoteBefore) && trim(remoteBefore.stdout) ? trim(remoteBefore.stdout).split(/\s+/)[0] : undefined;
	if (remoteBeforeSha) {
		const ancestor = await git(pi, repo.root, "remote ancestor check", ["merge-base", "--is-ancestor", remoteBeforeSha, "HEAD"]);
		if (!succeeded(ancestor)) {
			steps.push(`Remote SHA before push: ${remoteBeforeSha}`);
			emitReport(pi, ctx, "Git publish blocked", `${steps.join("\n")}\n\nRemote branch is not an ancestor of local HEAD. Pull/rebase first.`, "error");
			return;
		}
	}

	const pushCommand = `git push ${shellQuote(parsed.remote)} ${shellQuote(`HEAD:${parsed.branch}`)}`;
	if (!ctx.hasUI) {
		steps.push("", "Confirmation:", "Blocked: /git:publish requires interactive user confirmation before pushing.");
		emitReport(pi, ctx, "Git publish blocked", steps.join("\n"), "error");
		return;
	}

	const confirmed = await ctx.ui.confirm(
		"Confirm git publish",
		[
			`Repo: ${repo.root}`,
			`Branch: ${repo.branch}`,
			`Target: ${parsed.remote}/${parsed.branch}`,
			`Local SHA: ${repo.localSha}`,
			`Verification: ${parsed.verify ? "passed" : "not run (use --verify to require inferred verification before push)"}`,
			`Command: ${pushCommand}`,
			"",
			"Push now?",
		].join("\n"),
		{ timeout: 60_000 },
	);
	if (!confirmed) {
		steps.push("", "Confirmation:", "User declined, cancelled, or timed out. Nothing was pushed.");
		emitReport(pi, ctx, "Git publish cancelled", steps.join("\n"), "warning");
		return;
	}
	steps.push("", "Confirmation:", "User confirmed push.");

	const pushResult = await git(pi, repo.root, "push", ["push", parsed.remote, `HEAD:${parsed.branch}`], PUSH_TIMEOUT_MS);
	steps.push("", "Push:", formatRun(pushResult));
	if (!succeeded(pushResult)) {
		emitReport(pi, ctx, "Git publish failed", steps.join("\n"), "error");
		return;
	}

	const remoteAfter = await git(pi, repo.root, "remote SHA after", ["ls-remote", parsed.remote, `refs/heads/${parsed.branch}`]);
	const headAfter = await git(pi, repo.root, "local SHA after", ["rev-parse", "HEAD"]);
	const treeAfter = await git(pi, repo.root, "status after", ["status", "--porcelain"]);
	const remoteAfterSha = succeeded(remoteAfter) && trim(remoteAfter.stdout) ? trim(remoteAfter.stdout).split(/\s+/)[0] : "unavailable";
	const localAfterSha = trim(headAfter.stdout);
	const cleanAfter = succeeded(treeAfter) && trim(treeAfter.stdout).length === 0;
	const matches = succeeded(remoteAfter) && succeeded(headAfter) && remoteAfterSha === localAfterSha;

	steps.push("", "Remote confirmation:", `Local HEAD: ${localAfterSha}`, `${parsed.remote}/${parsed.branch}: ${remoteAfterSha}`, `SHA match: ${matches ? "yes" : "NO"}`, `Post-push tree: ${cleanAfter ? "clean" : "dirty"}`);

	const ok = matches && cleanAfter;
	emitReport(pi, ctx, ok ? "Git publish complete" : "Git publish needs attention", steps.join("\n"), ok ? "info" : "warning");
}

export default function gitEvidenceCourier(pi: ExtensionAPI) {
  pi = require("../../src/pi-extension-kit.js").instrumentExtensionCommands(pi, { extension: "git-evidence-courier", outcomePolicies: { gitevidence: { readiness: "domain-negative" }, gitverify: "domain-negative" } }) as ExtensionAPI;
	pi.registerTool({
		name: "gitevidence",
		label: "Git Evidence",
		description: "Collect read-only git evidence: branch/upstream, local and remote SHA, dirty/clean tree status, diff stats, and verifier hints.",
		promptSnippet: "Collect read-only git status, diff, local/remote SHA, and clean-tree evidence",
		promptGuidelines: [
			"Use gitevidence when you need current git state, commit evidence, publish readiness evidence, remote SHA evidence, or clean-tree status; gitevidence is read-only and never pushes.",
		],
		parameters: EMPTY_PARAMS,
		async execute(_toolCallId, _params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Git evidence cancelled." }], details: { cancelled: true } };
			}
			onUpdate?.({ content: [{ type: "text", text: "Collecting git evidence..." }], details: undefined });
			const report = await buildEvidenceReport(pi, ctx.cwd);
			return {
				content: [{ type: "text", text: reportText(report) }],
				details: report.details ?? {},
			};
		},
	});

	pi.registerTool({
		name: "gitverify",
		label: "Git Verify",
		description: "Run inferred git-aware repository verification, automatically using disposable isolated PostgreSQL for Prisma/PostgreSQL repositories. Does not accept arbitrary shell commands, and does not push or publish.",
		promptSnippet: "Run git diff checks and inferred project verification with isolated PostgreSQL when required, without pushing",
		promptGuidelines: [
			"Use gitverify before claiming a repository is verified, ready to commit, or ready to publish; gitverify never pushes and never runs arbitrary shell commands.",
			"Do not use gitverify for publishing; /git:publish is the separate user-confirmed slash command for push/publish workflows.",
		],
		parameters: EMPTY_PARAMS,
		async execute(_toolCallId, _params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Git verification cancelled." }], details: { cancelled: true } };
			}
			onUpdate?.({ content: [{ type: "text", text: "Running git verification..." }], details: undefined });
			const report = await buildVerifyReport(pi, ctx.cwd, "");
			return {
				content: [{ type: "text", text: reportText(report) }],
				details: report.details ?? {},
			};
		},
	});

	pi.registerCommand("git:evidence", {
		description: "Show git status, diff evidence, remote SHA, and verifier hints",
		handler: async (_args, ctx) => evidence(pi, ctx),
	});

	pi.registerCommand("git:verify", {
		description: "Run inferred or explicit verification commands with clean-tree evidence and isolated PostgreSQL for inferred Prisma verification",
		handler: async (args, ctx) => verify(pi, ctx, args),
	});

	pi.registerCommand("git:publish", {
		description: "Push current branch after clean-tree checks and explicit user confirmation; confirms remote SHA matches local HEAD",
		handler: async (args, ctx) => publish(pi, ctx, args),
	});
}
