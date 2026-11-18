#!/usr/bin/env python3
"""Validate a Skill Foundry claim ledger. Does NOT validate REA-native Evidence.

The input schema is standards/claim-ledger-schema.json. This tool checks referential
integrity, authority boundaries, source file hashes and explicit comparison
pairing. It never executes the inspected artifact or follows network URLs.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import sys
from typing import Any

ALLOWED_AUTHORITIES = {'observed', 'inferred', 'unknown'}
ALLOWED_STATUSES = {'PASS', 'FAIL', 'NOT TESTED', 'BLOCKED'}
HASH = re.compile(r'^[0-9a-fA-F]{64}$')


def _string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ''


def _items(data: Any, name: str, errors: list[str]) -> list[dict]:
    value = data.get(name) if isinstance(data, dict) else None
    if not isinstance(value, list):
        errors.append(f'{name}: expected array')
        return []
    if not all(isinstance(x, dict) for x in value):
        errors.append(f'{name}: all items must be objects')
    return [x for x in value if isinstance(x, dict)]


def _unique(items: list[dict], name: str, errors: list[str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for index, obj in enumerate(items):
        item_id = _string(obj.get('id'))
        if not item_id:
            errors.append(f'{name}[{index}]: missing non-empty id')
        elif item_id in out:
            errors.append(f'{name}[{index}]: duplicate id {item_id}')
        else:
            out[item_id] = obj
    return out


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as file:
        for block in iter(lambda: file.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def _safe_file(root: pathlib.Path, path_value: str) -> pathlib.Path | None:
    if not path_value or '\x00' in path_value:
        return None
    candidate = pathlib.Path(path_value)
    if candidate.is_absolute() or '..' in candidate.parts:
        return None
    resolved = (root / candidate).resolve(strict=False)
    if not resolved.is_relative_to(root) or not resolved.is_file():
        return None
    return resolved


def validate(data: object, root: pathlib.Path, check_files: bool = False) -> list[str]:
    errors: list[str] = []
    if not isinstance(data, dict):
        return ['root: expected JSON object']
    if data.get('schema_version') != 1:
        errors.append('schema_version: expected 1')
    artifacts = _unique(_items(data, 'artifacts', errors), 'artifacts', errors)
    evidence = _unique(_items(data, 'evidence', errors), 'evidence', errors)
    claims = _unique(_items(data, 'claims', errors), 'claims', errors)
    comparisons = _items(data, 'comparisons', errors)
    if not artifacts:
        errors.append('artifacts: at least one input artifact is required')
    for ident, item in artifacts.items():
        h = _string(item.get('sha256'))
        if not HASH.fullmatch(h):
            errors.append(f'artifact {ident}: sha256 must be 64 hex characters')
        path_value = _string(item.get('path'))
        if not path_value:
            errors.append(f'artifact {ident}: missing relative path')
        if check_files and h and HASH.fullmatch(h):
            actual_path = _safe_file(root, path_value)
            if actual_path is None:
                errors.append(f'artifact {ident}: missing/unsafe input path {path_value!r} (must stay inside --root)')
            else:
                actual_hash = sha256_file(actual_path)
                if actual_hash.lower() != h.lower():
                    errors.append(f'artifact {ident}: SHA-256 mismatch for {path_value!r}: expected {h}, actual {actual_hash}')
    for ident, item in evidence.items():
        target = _string(item.get('artifact_id'))
        if target not in artifacts:
            errors.append(f'evidence {ident}: unknown artifact_id {target!r}')
        if item.get('authority') not in ALLOWED_AUTHORITIES:
            errors.append(f'evidence {ident}: invalid authority')
        if not _string(item.get('source_location')):
            errors.append(f'evidence {ident}: source_location is required')
        if not _string(item.get('coverage')):
            errors.append(f'evidence {ident}: coverage statement required (even if partial)')
        if not _string(item.get('producer')):
            errors.append(f'evidence {ident}: producer must name an observed tool or inspected file')
    for ident, item in claims.items():
        authority = item.get('authority')
        if authority not in ALLOWED_AUTHORITIES:
            errors.append(f'claim {ident}: invalid authority')
        if not _string(item.get('text')):
            errors.append(f'claim {ident}: missing text')
        if item.get('status') not in ALLOWED_STATUSES:
            errors.append(f'claim {ident}: invalid status')
        ids = item.get('evidence_ids')
        if not isinstance(ids, list) or any(not isinstance(x, str) for x in ids):
            errors.append(f'claim {ident}: evidence_ids must be an array of strings')
            ids = []
        if len(set(ids)) != len(ids):
            errors.append(f'claim {ident}: duplicate evidence reference')
        for eid in ids:
            if eid not in evidence:
                errors.append(f'claim {ident}: missing evidence {eid!r}')
        if authority in {'observed', 'inferred'} and not ids:
            errors.append(f'claim {ident}: observed/inferred claims require evidence')
        if authority == 'observed' and ids and not any(evidence.get(eid, {}).get('authority') == 'observed' for eid in ids):
            errors.append(f'claim {ident}: observed claim has no observed evidence')
        if authority == 'unknown' and item.get('status') == 'PASS':
            errors.append(f'claim {ident}: unknown claim cannot pass an acceptance gate')
        limitations = item.get('limitations', [])
        if not isinstance(limitations, list) or any(not isinstance(x, str) for x in limitations):
            errors.append(f'claim {ident}: limitations must be an array of strings')
        elif authority in {'inferred', 'unknown'} and not any(x.strip() for x in limitations):
            errors.append(f'claim {ident}: inferred/unknown claims require a limitation explanation')
    seen_pairings: set[tuple[str, str, str, str]] = set()
    for index, comparison in enumerate(comparisons):
        prefix = f'comparisons[{index}]'
        left, right = _string(comparison.get('left_artifact_id')), _string(comparison.get('right_artifact_id'))
        if left not in artifacts or right not in artifacts or not left or not right:
            errors.append(f'{prefix}: unknown left/right artifact ID')
        if left == right:
            errors.append(f'{prefix}: comparing the same artifact identity')
        pairs = comparison.get('matched_evidence_pairs')
        if not isinstance(pairs, list):
            errors.append(f'{prefix}: matched_evidence_pairs must be an array (possibly empty)')
            pairs = []
        for n, pair in enumerate(pairs):
            if not isinstance(pair, dict):
                errors.append(f'{prefix}.pairs[{n}]: expected object')
                continue
            l, r = _string(pair.get('left')), _string(pair.get('right'))
            if l not in evidence or r not in evidence:
                errors.append(f'{prefix}.pairs[{n}]: missing Evidence id')
                continue
            if evidence[l]['artifact_id'] != left or evidence[r]['artifact_id'] != right:
                errors.append(f'{prefix}.pairs[{n}]: evidence artifact identity mismatch')
            key = (left, right, l, r)
            if key in seen_pairings:
                errors.append(f'{prefix}.pairs[{n}]: duplicated evidence pairing')
            seen_pairings.add(key)
        ids = comparison.get('claim_ids', [])
        if not isinstance(ids, list) or any(x not in claims for x in ids):
            errors.append(f'{prefix}: unknown or invalid claim_ids')
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('ledger', type=pathlib.Path, help='normalized human-curated claim ledger JSON; NOT a REA-native Evidence record')
    parser.add_argument('--root', type=pathlib.Path, default=pathlib.Path('.'), help='root for reading relative artifact paths')
    parser.add_argument('--check-files', action='store_true', help='verify every local SHA-256 under --root')
    args = parser.parse_args()
    try:
        data = json.loads(args.ledger.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        print(f'FAIL: cannot read normalized claim ledger: {error}', file=sys.stderr)
        return 2
    errors = validate(data, args.root.resolve(), check_files=args.check_files)
    if errors:
        print(f'FAIL: {len(errors)} claim-ledger issue(s)')
        for error in errors:
            print(f' - {error}')
        return 1
    print(f'PASS: claim ledger consistent ({len(data["artifacts"])} artifact(s), {len(data["evidence"])} Evidence entry(ies), {len(data["claims"])} claim(s))')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
