/**
 * Verified, manifest-driven installation of the official Antigravity ACP
 * runtime. The archive is downloaded once, its SHA-256 and byte count are
 * checked, and only the two files named by the manifest are extracted.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
	type RuntimeManifest,
	type RuntimePlatformEntry,
	loadManifest,
	platformKey,
	selectRelease,
} from "./manifest";
import { extractZipFile } from "./zip";

export const INSTALL_RECORD = "install.json";

export interface InstallRecord {
	version: string;
	platform: string;
	archive: string;
	archiveSha256: string;
	archiveBytes: number;
	binaryName: string;
	binaryBytes: number;
	harnessName: string;
	harnessBytes: number;
	args: string[];
	installedAt: string;
}

export interface InstalledRuntime {
	command: string;
	harness: string;
	record: InstallRecord;
}

export interface InstallRuntimeOptions {
	root?: string;
	platform?: string;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

export interface ExpectedInstall {
	version: string;
	platform: string;
	entry: RuntimePlatformEntry;
}

export function resolveInstallRoot(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_ANTIGRAVITY_ACP_ROOT?.trim();
	if (override) return path.resolve(override);
	const home = env.HOME?.trim() || os.homedir();
	return path.join(home, ".local", "opt", "agy-acp");
}

function isSafeFileName(name: unknown): name is string {
	return (
		typeof name === "string" &&
		/^[a-z0-9._-]+$/iu.test(name) &&
		name !== "." &&
		name !== ".."
	);
}

function readRecord(directory: string): InstallRecord | undefined {
	const recordPath = path.join(directory, INSTALL_RECORD);
	try {
		const parsed = JSON.parse(fs.readFileSync(recordPath, "utf8")) as Partial<InstallRecord>;
		if (
			typeof parsed.version !== "string" ||
			typeof parsed.platform !== "string" ||
			parsed.platform.length === 0 ||
			typeof parsed.archive !== "string" ||
			typeof parsed.archiveSha256 !== "string" ||
			!Number.isSafeInteger(parsed.archiveBytes) ||
			!isSafeFileName(parsed.binaryName) ||
			!Number.isSafeInteger(parsed.binaryBytes) ||
			!isSafeFileName(parsed.harnessName) ||
			!Number.isSafeInteger(parsed.harnessBytes) ||
			!Array.isArray(parsed.args) ||
			parsed.args.some((arg) => typeof arg !== "string") ||
			typeof parsed.installedAt !== "string"
		) {
			return undefined;
		}
		return parsed as InstallRecord;
	} catch {
		return undefined;
	}
}

function fileMatches(file: string, expectedBytes: number): boolean {
	try {
		const stat = fs.statSync(file);
		return (
			stat.isFile() &&
			stat.size === expectedBytes &&
			(process.platform === "win32" || (stat.mode & 0o111) !== 0)
		);
	} catch {
		return false;
	}
}

function readInstalled(
	directory: string,
	expected?: ExpectedInstall,
): InstalledRuntime | undefined {
	const record = readRecord(directory);
	if (!record) return undefined;
	if (expected) {
		if (
			record.version !== expected.version ||
			record.platform !== expected.platform ||
			record.archive !== expected.entry.archive ||
			record.archiveSha256 !== expected.entry.archiveSha256 ||
			record.archiveBytes !== expected.entry.archiveBytes ||
			record.binaryName !== expected.entry.binaryName ||
			record.binaryBytes !== expected.entry.binaryBytes ||
			record.harnessName !== expected.entry.harnessName ||
			record.harnessBytes !== expected.entry.harnessBytes ||
			record.args.length !== expected.entry.args.length ||
			record.args.some((arg, index) => arg !== expected.entry.args[index])
		) {
			return undefined;
		}
	}
	const command = path.join(directory, record.binaryName);
	const harness = path.join(directory, record.harnessName);
	if (!fileMatches(command, record.binaryBytes) || !fileMatches(harness, record.harnessBytes)) {
		return undefined;
	}
	return { command, harness, record };
}

/** The active managed runtime, if `current` points at a complete installation. */
export function installedRuntime(
	root = resolveInstallRoot(),
	expected?: ExpectedInstall,
): InstalledRuntime | undefined {
	return readInstalled(path.join(root, "current"), expected);
}

export async function downloadArchive(
	url: string,
	destination: string,
	expectedBytes: number,
	expectedSha256: string,
	fetchImpl: typeof globalThis.fetch = globalThis.fetch,
	options: { signal?: AbortSignal; onProgress?: (message: string) => void } = {},
): Promise<void> {
	options.onProgress?.("Downloading the Antigravity ACP runtime (large download)…");
	const response = await fetchImpl(url, {
		redirect: "follow",
		...(options.signal ? { signal: options.signal } : {}),
	});
	if (!response.ok) {
		throw new Error(`Antigravity ACP download failed: HTTP ${response.status} ${response.statusText}`);
	}
	if (!response.body) throw new Error("Antigravity ACP download returned an empty body");
	const hash = crypto.createHash("sha256");
	let bytes = 0;
	const meter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			bytes += chunk.length;
			if (bytes > expectedBytes) {
				callback(new Error(`Antigravity ACP archive exceeds expected ${expectedBytes} bytes`));
				return;
			}
			hash.update(chunk);
			callback(null, chunk);
		},
	});
	try {
		await pipeline(
			Readable.fromWeb(response.body as never),
			meter,
			fs.createWriteStream(destination, { mode: 0o600 }),
		);
		if (bytes !== expectedBytes) {
			throw new Error(
				`Antigravity ACP archive is ${bytes} bytes, expected ${expectedBytes}`,
			);
		}
		const digest = hash.digest("hex");
		if (digest !== expectedSha256) {
			throw new Error(
				`Antigravity ACP archive SHA-256 is ${digest}, expected ${expectedSha256}`,
			);
		}
		options.onProgress?.("Verified the Antigravity ACP runtime archive.");
	} catch (error) {
		fs.rmSync(destination, { force: true });
		throw error;
	}
}

export async function installRuntime(
	entry: RuntimePlatformEntry,
	version: string,
	options: InstallRuntimeOptions = {},
): Promise<InstalledRuntime> {
	const root = options.root ?? resolveInstallRoot();
	const platform = options.platform ?? platformKey();
	const expected: ExpectedInstall = { version, platform, entry };
	const versions = path.join(root, "versions");
	const destination = path.join(versions, entry.archiveSha256);
	const existing = readInstalled(destination, expected);
	if (existing) {
		updateCurrent(root, entry.archiveSha256);
		return existing;
	}
	fs.mkdirSync(versions, { recursive: true });
	const staging = fs.mkdtempSync(path.join(versions, ".install-"));
	const archive = path.join(staging, "download.zip");
	try {
		await downloadArchive(
			entry.archive,
			archive,
			entry.archiveBytes,
			entry.archiveSha256,
			options.fetch ?? globalThis.fetch,
			options,
		);
		options.onProgress?.("Extracting the Antigravity ACP runtime…");
		await extractZipFile(archive, staging, [entry.binaryName, entry.harnessName]);
		fs.rmSync(archive, { force: true });
		const command = path.join(staging, entry.binaryName);
		const harness = path.join(staging, entry.harnessName);
		if (!fileMatches(command, entry.binaryBytes)) {
			throw new Error("Antigravity ACP server has an unexpected size after extraction");
		}
		if (!fileMatches(harness, entry.harnessBytes)) {
			throw new Error("Antigravity ACP harness has an unexpected size after extraction");
		}
		fs.chmodSync(command, 0o755);
		fs.chmodSync(harness, 0o755);
		const record: InstallRecord = {
			version,
			platform,
			archive: entry.archive,
			archiveSha256: entry.archiveSha256,
			archiveBytes: entry.archiveBytes,
			binaryName: entry.binaryName,
			binaryBytes: entry.binaryBytes,
			harnessName: entry.harnessName,
			harnessBytes: entry.harnessBytes,
			args: [...entry.args],
			installedAt: new Date().toISOString(),
		};
		fs.writeFileSync(
			path.join(staging, INSTALL_RECORD),
			`${JSON.stringify(record, null, 2)}\n`,
			{ mode: 0o600 },
		);
		fs.rmSync(destination, { recursive: true, force: true });
		fs.renameSync(staging, destination);
		updateCurrent(root, entry.archiveSha256);
		return {
			command: path.join(destination, entry.binaryName),
			harness: path.join(destination, entry.harnessName),
			record,
		};
	} catch (error) {
		fs.rmSync(staging, { recursive: true, force: true });
		throw error;
	}
}

function updateCurrent(root: string, sha256: string): void {
	const current = path.join(root, "current");
	fs.rmSync(current, { recursive: true, force: true });
	fs.symlinkSync(
		process.platform === "win32"
			? path.join(root, "versions", sha256)
			: path.join("versions", sha256),
		current,
		process.platform === "win32" ? "junction" : "dir",
	);
}

/**
 * Ensure the active runtime is the manifest's pinned release. A complete
 * installation at a different version is replaced so the provider never
 * silently runs an unverified or stale runtime.
 */
export async function ensureRuntime(
	manifest: RuntimeManifest = loadManifest(),
	platform = platformKey(),
	options: InstallRuntimeOptions = {},
): Promise<InstalledRuntime> {
	const root = options.root ?? resolveInstallRoot();
	const entry = selectRelease(manifest, platform);
	const expected: ExpectedInstall = { version: manifest.version, platform, entry };
	const current = readInstalled(path.join(root, "current"), expected);
	if (current) return current;
	return installRuntime(entry, manifest.version, { ...options, root, platform });
}
