/**
 * Official Google Antigravity ACP runtime manifest.
 *
 * The manifest pins the runtime Google publishes for the Antigravity ACP
 * server. It is deliberately small and local: the provider downloads only the
 * archive named here, verifies its SHA-256 and size, and never trusts a remote
 * manifest or an unverified archive.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface RuntimePlatformEntry {
	archive: string;
	archiveSha256: string;
	archiveBytes: number;
	binaryName: string;
	binaryBytes: number;
	harnessName: string;
	harnessBytes: number;
	args: string[];
}

export interface RuntimeManifest {
	schemaVersion: 1;
	version: string;
	generatedAt: string;
	platforms: Record<string, RuntimePlatformEntry>;
}

export const RUNTIME_VERSION = "1.5.2";
export const MANIFEST_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"runtime-manifest.json",
);

/** Map Node's platform/arch pair to the archive key Google publishes. */
export function platformKey(platform = process.platform, arch = process.arch): string {
	if (platform === "linux") {
		if (arch === "x64") return "linux-x86_64";
		if (arch === "arm64") return "linux-aarch64";
	}
	if (platform === "darwin") {
		if (arch === "arm64") return "darwin-aarch64";
		if (arch === "x64") return "darwin-x86_64";
	}
	if (platform === "win32" && arch === "x64") return "windows-x86_64";
	throw new Error(`Google Antigravity ACP has no runtime for ${platform}/${arch}`);
}

function isSafeRuntimeFileName(name: string): boolean {
	return /^[a-z0-9._-]+$/iu.test(name) && name !== "." && name !== "..";
}

export function loadManifest(file = MANIFEST_PATH): RuntimeManifest {
	const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as RuntimeManifest;
	validateManifest(parsed);
	return parsed;
}

export function validateManifest(manifest: RuntimeManifest): void {
	if (!manifest || manifest.schemaVersion !== 1) {
		throw new Error("Antigravity ACP runtime manifest schemaVersion must be 1");
	}
	if (manifest.version !== RUNTIME_VERSION) {
		throw new Error(
			`Antigravity ACP runtime manifest must pin ${RUNTIME_VERSION}, not ${String(manifest.version)}`,
		);
	}
	const platforms = manifest.platforms;
	if (!platforms || typeof platforms !== "object" || Object.keys(platforms).length === 0) {
		throw new Error("Antigravity ACP runtime manifest has no platforms");
	}
	for (const [key, entry] of Object.entries(platforms)) {
		if (!entry || typeof entry !== "object") {
			throw new Error(`Antigravity ACP runtime manifest entry ${key} is not an object`);
		}
		if (!entry.archive.startsWith("https://dl.google.com/agy-extensions/releases/")) {
			throw new Error(`Antigravity ACP runtime manifest entry ${key} has an untrusted archive URL`);
		}
		if (!/^[0-9a-f]{64}$/u.test(entry.archiveSha256)) {
			throw new Error(`Antigravity ACP runtime manifest entry ${key} has an invalid SHA-256`);
		}
		if (!Number.isSafeInteger(entry.archiveBytes) || entry.archiveBytes <= 0) {
			throw new Error(`Antigravity ACP runtime manifest entry ${key} has an invalid archive size`);
		}
		if (!isSafeRuntimeFileName(entry.binaryName) || !isSafeRuntimeFileName(entry.harnessName)) {
			throw new Error(`Antigravity ACP runtime manifest entry ${key} has an unsafe file name`);
		}
		if (!Number.isSafeInteger(entry.binaryBytes) || entry.binaryBytes <= 0) {
			throw new Error(`Antigravity ACP runtime manifest entry ${key} has an invalid binary size`);
		}
		if (!Number.isSafeInteger(entry.harnessBytes) || entry.harnessBytes <= 0) {
			throw new Error(`Antigravity ACP runtime manifest entry ${key} has an invalid harness size`);
		}
		if (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== "string")) {
			throw new Error(`Antigravity ACP runtime manifest entry ${key} has invalid launch arguments`);
		}
	}
}

export function selectRelease(
	manifest: RuntimeManifest,
	platform = platformKey(),
): RuntimePlatformEntry {
	const entry = manifest.platforms[platform];
	if (!entry) {
		throw new Error(`Antigravity ACP runtime manifest has no release for ${platform}`);
	}
	return entry;
}
