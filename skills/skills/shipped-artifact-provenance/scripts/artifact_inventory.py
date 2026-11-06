#!/usr/bin/env python3
"""Produce a bounded, read-only manifest for one file or ZIP-format archive.

This is a standalone fallback, not a REA provider. It reads the supplied file,
identifies a few signatures and, for ZIP containers, hashes members within
explicit expanded-byte budgets. It never executes or extracts files.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import stat
import sys
import zipfile
from typing import Any

CHUNK = 1024 * 1024


def hash_stream(file: Any) -> tuple[str, int]:
    digest = hashlib.sha256()
    count = 0
    for block in iter(lambda: file.read(CHUNK), b''):
        digest.update(block)
        count += len(block)
    return digest.hexdigest(), count


def sniff(path: pathlib.Path) -> str:
    with path.open('rb') as file:
        header = file.read(16)
    if header.startswith(b'\x7fELF'):
        return 'ELF executable/shared object/core (unclassified)'
    if header.startswith(b'MZ'):
        return 'PE/DOS or MZ-prefixed file (header not verified)'
    if header[:4] in (b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xce'):
        return 'Mach-O candidate'
    if header[:4] in (b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca'):
        return 'Mach-O universal/JVM class candidate (ambiguous)'
    if header.startswith(b'GGUF'):
        return 'GGUF candidate'
    if header.startswith(b'\x1f\x8b'):
        return 'gzip candidate'
    if zipfile.is_zipfile(path):
        return 'ZIP-compatible archive'
    return 'unknown'


def _entry_risks(info: zipfile.ZipInfo, previous_names: set[str]) -> list[str]:
    risks: list[str] = []
    pure = pathlib.PurePosixPath(info.filename)
    if info.filename.startswith(('/', '\\')) or '..' in pure.parts or '\\' in info.filename:
        risks.append('unsafe_path')
    if info.filename in previous_names:
        risks.append('duplicate_logical_name')
    if stat.S_ISLNK((info.external_attr >> 16) & 0xFFFF):
        risks.append('symlink_member')
    if info.file_size > 0 and info.compress_size > 0 and info.file_size / info.compress_size > 1000:
        risks.append('extreme_expansion_ratio')
    if info.flag_bits & 1:
        risks.append('encrypted')
    return risks


def inspect(path: pathlib.Path, *, max_entries: int = 2000,
            max_member_bytes: int = 32 * 1024 * 1024,
            max_total_expanded: int = 128 * 1024 * 1024,
            hash_members: bool = True) -> dict[str, Any]:
    if max_entries < 1 or max_member_bytes < 0 or max_total_expanded < 0:
        raise ValueError('invalid budgets')
    if not path.is_file():
        raise ValueError('input must be an existing regular file')
    with path.open('rb') as handle:
        file_hash, size = hash_stream(handle)
    kind = sniff(path)
    out: dict[str, Any] = {
        'schema_version': 1, 'source': str(path), 'sha256': file_hash,
        'size': size, 'detected': kind, 'limitations': [
            'This is an offline byte/header and ZIP-member manifest only; no author/signature authenticity verified.',
            'Detected signatures are candidates, not complete binary format parsing.'
        ],
        'entries': [], 'issues': [], 'coverage': {'member_bytes_hashed': 0, 'member_count_seen': 0}
    }
    if kind != 'ZIP-compatible archive':
        out['limitations'].append('No archive members enumerated for this format.')
        return out
    names: set[str] = set()
    expanded = 0
    with zipfile.ZipFile(path, 'r') as zf:
        infos = zf.infolist()
        out['coverage']['member_count_seen'] = len(infos)
        if len(infos) > max_entries:
            out['issues'].append('entry_limit_reached')
            out['limitations'].append(f'Only first {max_entries} entries inspected from {len(infos)}.')
        for info in infos[:max_entries]:
            risks = _entry_risks(info, names)
            names.add(info.filename)
            obj: dict[str, Any] = {
                'path': info.filename, 'is_directory': info.is_dir(), 'size': info.file_size,
                'compressed_size': info.compress_size, 'crc32_declared': f'{info.CRC:08x}',
                'compression': info.compress_type, 'risks': risks, 'sha256': None,
                'hash_status': 'NOT TESTED'
            }
            if not hash_members or info.is_dir() or risks and ('unsafe_path' in risks or 'encrypted' in risks or 'symlink_member' in risks):
                obj['hash_status'] = 'SKIPPED'
            elif info.file_size > max_member_bytes or info.file_size > max_total_expanded - expanded:
                obj['hash_status'] = 'SKIPPED: expansion limit'
            else:
                try:
                    with zf.open(info, 'r') as member:
                        # Limit reads even if archive metadata was dishonest.
                        digest = hashlib.sha256()
                        member_bytes = 0
                        while True:
                            chunk = member.read(min(CHUNK, max_member_bytes - member_bytes + 1))
                            if not chunk:
                                break
                            member_bytes += len(chunk)
                            if member_bytes > max_member_bytes or member_bytes > max_total_expanded - expanded:
                                raise ValueError('member expansion exceeded configured budget')
                            digest.update(chunk)
                    if member_bytes != info.file_size:
                        raise ValueError('decompressed size disagrees with archive metadata')
                    obj['sha256'] = digest.hexdigest()
                    obj['hash_status'] = 'PASS'
                    expanded += member_bytes
                except (OSError, RuntimeError, EOFError, ValueError, zipfile.BadZipFile) as error:
                    obj['hash_status'] = 'FAIL'
                    risks.append('member_read_error')
                    obj['error'] = type(error).__name__
            out['entries'].append(obj)
    out['coverage']['member_bytes_hashed'] = expanded
    out['coverage']['member_count_returned'] = len(out['entries'])
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('artifact', type=pathlib.Path)
    parser.add_argument('--output', type=pathlib.Path, help='write JSON to an unused file; stdout otherwise')
    parser.add_argument('--max-entries', type=int, default=2000)
    parser.add_argument('--max-member-mib', type=int, default=32)
    parser.add_argument('--max-expanded-mib', type=int, default=128)
    parser.add_argument('--no-member-hash', action='store_true')
    args = parser.parse_args()
    try:
        report = inspect(args.artifact.resolve(), max_entries=args.max_entries,
                         max_member_bytes=args.max_member_mib * 1024 * 1024,
                         max_total_expanded=args.max_expanded_mib * 1024 * 1024,
                         hash_members=not args.no_member_hash)
        payload = json.dumps(report, indent=2, ensure_ascii=False) + '\n'
        if args.output is not None:
            output = args.output.resolve(strict=False)
            with output.open('x', encoding='utf-8') as dst:
                dst.write(payload)
        else:
            print(payload, end='')
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        print(f'ERROR: {error}', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
