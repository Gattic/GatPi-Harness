/**
 * Minimal, streaming ZIP reader for the Antigravity ACP runtime archive.
 *
 * The archive contains a ~700 MB server and a ~130 MB harness, so extraction
 * must not buffer either file in memory. The central directory is small and is
 * read directly; each entry is then streamed from its local header through
 * inflate (when deflated) into its destination.
 */

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_BYTES = 22;
const EOCD_MAX_COMMENT_BYTES = 0xffff;

export interface ZipEntry {
	name: string;
	compressionMethod: number;
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
	isDirectory: boolean;
}

function readExactly(fd: number, buffer: Buffer, position: number): void {
	let offset = 0;
	while (offset < buffer.length) {
		const count = fs.readSync(fd, buffer, offset, buffer.length - offset, position + offset);
		if (count <= 0) throw new Error("Unexpected end of ZIP archive");
		offset += count;
	}
}

export function readZipDirectory(filePath: string): ZipEntry[] {
	const fd = fs.openSync(filePath, "r");
	try {
		const stat = fs.fstatSync(fd);
		if (stat.size < EOCD_MIN_BYTES) throw new Error("ZIP archive is too small");
		const tailSize = Math.min(stat.size, EOCD_MIN_BYTES + EOCD_MAX_COMMENT_BYTES);
		const tail = Buffer.alloc(tailSize);
		readExactly(fd, tail, stat.size - tailSize);
		let eocd = -1;
		for (let index = tail.length - EOCD_MIN_BYTES; index >= 0; index--) {
			if (tail.readUInt32LE(index) === EOCD_SIGNATURE) {
				eocd = index;
				break;
			}
		}
		if (eocd < 0) throw new Error("ZIP archive has no end-of-central-directory record");
		const totalEntries = tail.readUInt16LE(eocd + 10);
		const centralSize = tail.readUInt32LE(eocd + 12);
		const centralOffset = tail.readUInt32LE(eocd + 16);
		if (
			totalEntries === 0xffff ||
			centralSize === 0xffffffff ||
			centralOffset === 0xffffffff
		) {
			throw new Error("ZIP64 archives are not supported");
		}
		if (centralOffset + centralSize > stat.size) {
			throw new Error("ZIP central directory points outside the archive");
		}
		const central = Buffer.alloc(centralSize);
		readExactly(fd, central, centralOffset);
		const entries: ZipEntry[] = [];
		let offset = 0;
		for (let index = 0; index < totalEntries; index++) {
			if (offset + 46 > central.length) throw new Error("Truncated ZIP central directory");
			if (central.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
				throw new Error("Invalid ZIP central directory entry");
			}
			const compressionMethod = central.readUInt16LE(offset + 10);
			const compressedSize = central.readUInt32LE(offset + 20);
			const uncompressedSize = central.readUInt32LE(offset + 24);
			const nameLength = central.readUInt16LE(offset + 28);
			const extraLength = central.readUInt16LE(offset + 30);
			const commentLength = central.readUInt16LE(offset + 32);
			const localHeaderOffset = central.readUInt32LE(offset + 42);
			const nameStart = offset + 46;
			const nameEnd = nameStart + nameLength;
			if (nameEnd > central.length) throw new Error("Truncated ZIP entry name");
			const name = central.subarray(nameStart, nameEnd).toString("utf8");
			if (
				compressedSize === 0xffffffff ||
				uncompressedSize === 0xffffffff ||
				localHeaderOffset === 0xffffffff
			) {
				throw new Error("ZIP64 entries are not supported");
			}
			entries.push({
				name,
				compressionMethod,
				compressedSize,
				uncompressedSize,
				localHeaderOffset,
				isDirectory: name.endsWith("/"),
			});
			offset = nameEnd + extraLength + commentLength;
		}
		return entries;
	} finally {
		fs.closeSync(fd);
	}
}

function safeRelativeName(name: string): string {
	if (!name || name.includes("\0") || name.includes("\\")) {
		throw new Error(`Unsafe ZIP entry name: ${JSON.stringify(name)}`);
	}
	if (name.startsWith("/") || /^[A-Za-z]:/u.test(name)) {
		throw new Error(`Absolute ZIP entry name: ${JSON.stringify(name)}`);
	}
	const parts = name.split("/");
	if (parts.some((part) => part === ".." || part === "")) {
		throw new Error(`Path traversal in ZIP entry: ${JSON.stringify(name)}`);
	}
	return parts.join(path.sep);
}

async function extractEntry(
	filePath: string,
	entry: ZipEntry,
	destination: string,
): Promise<void> {
	const relative = safeRelativeName(entry.name);
	const target = path.resolve(destination, relative);
	const root = path.resolve(destination);
	if (target !== root && !target.startsWith(root + path.sep)) {
		throw new Error(`ZIP entry escapes the destination: ${JSON.stringify(entry.name)}`);
	}
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const fd = fs.openSync(filePath, "r");
	let dataOffset: number;
	try {
		const header = Buffer.alloc(30);
		readExactly(fd, header, entry.localHeaderOffset);
		if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
			throw new Error("Invalid ZIP local file header");
		}
		const nameLength = header.readUInt16LE(26);
		const extraLength = header.readUInt16LE(28);
		dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
	} finally {
		fs.closeSync(fd);
	}
	if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
		throw new Error(`Unsupported ZIP compression method ${entry.compressionMethod}`);
	}
	const input =
		entry.compressedSize === 0
			? Readable.from([])
			: fs.createReadStream(filePath, {
					start: dataOffset,
					end: dataOffset + entry.compressedSize - 1,
				});
	const output = fs.createWriteStream(target, { mode: 0o755 });
	if (entry.compressionMethod === 8) {
		await pipeline(input, zlib.createInflateRaw(), output);
	} else {
		await pipeline(input, output);
	}
	const written = fs.statSync(target).size;
	if (written !== entry.uncompressedSize) {
		throw new Error(
			`ZIP entry ${JSON.stringify(entry.name)} extracted ${written} bytes, expected ${entry.uncompressedSize}`,
		);
	}
	fs.chmodSync(target, 0o755);
}

/**
 * Extract the requested top-level files from a ZIP archive. When expected names
 * are supplied, the archive must contain exactly those files; unexpected or
 * duplicate entries are rejected so a substituted archive cannot smuggle in
 * extra files or overwrite a runtime payload.
 */
export async function extractZipFile(
	filePath: string,
	destination: string,
	expectedNames?: readonly string[],
): Promise<void> {
	const entries = readZipDirectory(filePath);
	const expected = expectedNames ? new Set(expectedNames) : undefined;
	if (expected) {
		if (entries.length !== expected.size) {
			throw new Error(
				`ZIP archive contains ${entries.length} entries, expected ${expected.size}`,
			);
		}
		const names = new Set(entries.map((entry) => entry.name));
		if (names.size !== entries.length) throw new Error("ZIP archive contains duplicate entries");
		for (const entry of entries) {
			if (entry.isDirectory || !expected.has(entry.name)) {
				throw new Error(`ZIP archive contains an unexpected entry: ${JSON.stringify(entry.name)}`);
			}
			safeRelativeName(entry.name);
			if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
				throw new Error(`Unsupported ZIP compression method ${entry.compressionMethod}`);
			}
		}
	}
	for (const entry of entries) {
		if (entry.isDirectory) continue;
		safeRelativeName(entry.name);
		if (expected && !expected.has(entry.name)) continue;
		await extractEntry(filePath, entry, destination);
	}
	if (expected) {
		for (const name of expected) {
			const target = path.join(destination, safeRelativeName(name));
			if (!fs.existsSync(target)) {
				throw new Error(`ZIP archive is missing ${JSON.stringify(name)}`);
			}
		}
	}
}
