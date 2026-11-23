/**
 * Runtime discovery for the Antigravity ACP server.
 *
 * The managed runtime is preferred over ambient executables. `AGY_ACP_BIN`
 * remains the explicit escape hatch for a user-managed installation. When no
 * runtime exists, the pinned manifest release is installed and verified.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	type InstalledRuntime,
	ensureRuntime,
	installedRuntime,
	resolveInstallRoot,
} from "./install";
import {
	type RuntimeManifest,
	type RuntimePlatformEntry,
	loadManifest,
	platformKey,
	selectRelease,
} from "./manifest";

export interface RuntimeLaunch {
	command: string;
	args: string[];
	harness?: string;
	version?: string;
	source: "env" | "managed" | "user-bin" | "path";
}

export interface ResolveRuntimeOptions {
	env?: NodeJS.ProcessEnv;
	autoInstall?: boolean;
	manifest?: RuntimeManifest;
	platform?: string;
	root?: string;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

/** The server requires an empty uid argument on Linux; other platforms use none. */
export function platformArgs(
	platform = process.platform,
	entry?: RuntimePlatformEntry,
): string[] {
	if (entry) return [...entry.args];
	return platform === "linux" ? ["--uid="] : [];
}

function expandHome(file: string, home = os.homedir()): string {
	return file === "~" || file.startsWith("~/") ? path.join(home, file.slice(1)) : file;
}

function isExecutable(file: string): boolean {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

function isScript(file: string): boolean {
	try {
		const fd = fs.openSync(file, "r");
		try {
			const bytes = Buffer.alloc(2);
			const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
			return count === 2 && bytes.toString("utf8") === "#!";
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return false;
	}
}

export async function resolveRuntime(
	options: ResolveRuntimeOptions = {},
): Promise<RuntimeLaunch> {
	const env = options.env ?? process.env;
	const platform = options.platform ?? platformKey();
	const home = env.HOME?.trim() || os.homedir();
	const explicit = env.AGY_ACP_BIN?.trim();
	if (explicit) {
		const command = expandHome(explicit, home);
		if (!isExecutable(command)) {
			throw new Error(`AGY_ACP_BIN is not an executable file: ${command}`);
		}
		return {
			command,
			args: isScript(command) ? [] : platformArgs(process.platform),
			source: "env",
		};
	}
	const root = options.root ?? resolveInstallRoot(env);
	const manifest = options.manifest ?? loadManifest();
	const entry = selectRelease(manifest, platform);
	const managed: InstalledRuntime | undefined = installedRuntime(root, {
		version: manifest.version,
		platform,
		entry,
	});
	if (managed) {
		return {
			command: managed.command,
			args: isScript(managed.command) ? [] : managed.record.args,
			harness: managed.harness,
			version: managed.record.version,
			source: "managed",
		};
	}
	const userBin = path.join(home, ".local", "bin", "agy_acp_server.par");
	if (isExecutable(userBin)) {
		return {
			command: userBin,
			args: isScript(userBin) ? [] : platformArgs(process.platform),
			source: "user-bin",
		};
	}
	for (const directory of (env.PATH ?? "").split(path.delimiter)) {
		if (!directory || !path.isAbsolute(directory)) continue;
		const candidate = path.join(directory, "agy_acp_server.par");
		if (isExecutable(candidate)) {
			return {
				command: candidate,
				args: isScript(candidate) ? [] : platformArgs(process.platform),
				source: "path",
			};
		}
	}
	if (options.autoInstall === false) {
		throw new Error(
			"Google Antigravity ACP server is not installed. Run /login to install it, or set AGY_ACP_BIN.",
		);
	}
	const installed = await ensureRuntime(manifest, platform, {
		root,
		fetch: options.fetch,
		signal: options.signal,
		onProgress: options.onProgress,
	});
	return {
		command: installed.command,
		args: isScript(installed.command) ? [] : installed.record.args ?? entry.args,
		harness: installed.harness,
		version: installed.record.version,
		source: "managed",
	};
}
