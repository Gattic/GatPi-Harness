#!/usr/bin/env python3
"""Verify byte hashes in the packaged Skill Foundry RELEASE_FILES.json manifest.

The manifest provides accidental-change/tamper detection against a trusted copy
of the manifest. Without a separate trusted signature it does NOT authenticate
publisher identity. Files modified by users after extraction will fail checks.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def file_digest(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def verify(root: pathlib.Path, manifest_file: pathlib.Path, strict: bool = True) -> list[str]:
    problems: list[str] = []
    root = root.resolve()
    try:
        manifest = json.loads(manifest_file.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        return [f'Cannot read manifest: {error}']
    if not isinstance(manifest, dict) or manifest.get('schema_version') != 1:
        return ['Unsupported manifest schema']
    entries = manifest.get('files')
    if not isinstance(entries, list):
        return ['Missing files list']
    seen: set[str] = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            problems.append(f'Entry {index}: expected object')
            continue
        relative = entry.get('path')
        if not isinstance(relative, str) or not relative or '\\' in relative:
            problems.append(f'Entry {index}: invalid path')
            continue
        path = pathlib.PurePosixPath(relative)
        if path.is_absolute() or '..' in path.parts or str(path) != relative:
            problems.append(f'Entry {index}: unsafe path: {relative!r}')
            continue
        if relative in seen:
            problems.append(f'Duplicate path: {relative!r}')
            continue
        seen.add(relative)
        candidate = (root / pathlib.Path(*path.parts)).resolve()
        if not candidate.is_relative_to(root) or not candidate.is_file():
            problems.append(f'Missing/unsafe file: {relative!r}')
            continue
        if candidate.stat().st_size != entry.get('size_bytes'):
            problems.append(f'Size mismatch: {relative!r}')
        if file_digest(candidate) != entry.get('sha256'):
            problems.append(f'SHA-256 mismatch: {relative!r}')
    if strict:
        present = {p.relative_to(root).as_posix() for p in root.rglob('*')
                   if p.is_file() and '__pycache__' not in p.parts and p.suffix != '.pyc'
                   and p.name != 'RELEASE_FILES.json'}
        for missing in sorted(present - seen):
            problems.append(f'Unlisted file: {missing!r}')
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=pathlib.Path, default=ROOT)
    parser.add_argument('--manifest', type=pathlib.Path, default=None)
    parser.add_argument('--allow-extra', action='store_true')
    args = parser.parse_args()
    root = args.root.resolve()
    manifest_file = args.manifest or root / 'RELEASE_FILES.json'
    problems = verify(root, manifest_file, strict=not args.allow_extra)
    if problems:
        print(f'FAIL: {len(problems)} file-integrity problems', file=sys.stderr)
        for issue in problems:
            print(f' - {issue}', file=sys.stderr)
        return 1
    print('PASS: every listed file has the expected size and SHA-256, and the directory listing matches')
    print('Note: unsigned manifests do not authenticate publisher identity.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
