#!/usr/bin/env python3
"""Offline behavior tests for original REA-inspired Skill Foundry helpers."""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import check_evidence_ledger as evidence_check

spec = importlib.util.spec_from_file_location(
    'artifact_inventory', ROOT / 'skills' / 'shipped-artifact-provenance' / 'scripts' / 'artifact_inventory.py'
)
assert spec is not None and spec.loader is not None
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        (self.root / 'input-a.bin').write_bytes(b'test release A')
        (self.root / 'input-b.bin').write_bytes(b'test release B')
        self.ledger = {
            'schema_version': 1,
            'artifacts': [
                {'id': 'A', 'path': 'input-a.bin', 'sha256': evidence_check.sha256_file(self.root / 'input-a.bin')},
                {'id': 'B', 'path': 'input-b.bin', 'sha256': evidence_check.sha256_file(self.root / 'input-b.bin')},
            ],
            'evidence': [
                {'id': 'EA', 'artifact_id': 'A', 'authority': 'observed', 'source_location': 'file:bytes:0-4', 'coverage': 'first four bytes', 'producer': 'unit-test reader'},
                {'id': 'EB', 'artifact_id': 'B', 'authority': 'observed', 'source_location': 'file:bytes:0-4', 'coverage': 'first four bytes', 'producer': 'unit-test reader'},
            ],
            'claims': [
                {'id': 'C1', 'text': 'two different files inspected', 'authority': 'observed', 'evidence_ids': ['EA', 'EB'], 'limitations': [], 'status': 'PASS'},
                {'id': 'C2', 'text': 'runtime behavior remains unknown', 'authority': 'unknown', 'evidence_ids': [], 'limitations': ['No execution permitted'], 'status': 'NOT TESTED'},
            ],
            'comparisons': [{'left_artifact_id': 'A', 'right_artifact_id': 'B', 'matched_evidence_pairs': [{'left': 'EA', 'right': 'EB'}], 'claim_ids': ['C1']}]
        }

    def test_hash_and_pairing_pass(self):
        self.assertEqual([], evidence_check.validate(self.ledger, self.root.resolve(), check_files=True))

    def test_digest_mismatch_fails(self):
        ledger = copy.deepcopy(self.ledger)
        ledger['artifacts'][0]['sha256'] = 'a' * 64
        self.assertIn('SHA-256 mismatch', '\n'.join(evidence_check.validate(ledger, self.root.resolve(), check_files=True)))

    def test_pair_misbound_to_another_artifact_fails(self):
        ledger = copy.deepcopy(self.ledger)
        ledger['comparisons'][0]['matched_evidence_pairs'][0] = {'left': 'EB', 'right': 'EA'}
        self.assertIn('artifact identity mismatch', '\n'.join(evidence_check.validate(ledger, self.root.resolve())))

    def test_unknown_cannot_pass(self):
        ledger = copy.deepcopy(self.ledger)
        ledger['claims'][1]['status'] = 'PASS'
        self.assertIn('unknown claim cannot pass', '\n'.join(evidence_check.validate(ledger, self.root.resolve())))

    def test_inferred_claim_needs_limit_and_evidence(self):
        ledger = copy.deepcopy(self.ledger)
        ledger['claims'][0]['authority'] = 'inferred'
        ledger['claims'][0]['limitations'] = []
        self.assertIn('require a limitation', '\n'.join(evidence_check.validate(ledger, self.root.resolve())))

    def test_path_escape_rejected(self):
        ledger = copy.deepcopy(self.ledger)
        ledger['artifacts'][0]['path'] = '../outside.bin'
        self.assertIn('missing/unsafe input path', '\n'.join(evidence_check.validate(ledger, self.root.resolve(), check_files=True)))

    def test_ledger_cli_exit_code(self):
        file = self.root / 'ledger.json'
        file.write_text(json.dumps(self.ledger))
        good = subprocess.run([sys.executable, str(ROOT / 'tools' / 'check_evidence_ledger.py'), str(file), '--root', str(self.root), '--check-files'], capture_output=True, text=True)
        self.assertEqual(0, good.returncode, good.stdout + good.stderr)
        self.assertIn('PASS:', good.stdout)


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)

    def test_zip_safe_inventory_and_content_hash(self):
        target = self.root / 'sample.zip'
        with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr('safe/main.js', b'const x = 123;')
            zf.writestr('../escape.txt', b'untrusted')
        result = inventory.inspect(target)
        self.assertEqual('ZIP-compatible archive', result['detected'])
        self.assertEqual(2, len(result['entries']))
        self.assertEqual(hashlib.sha256(b'const x = 123;').hexdigest(), result['entries'][0]['sha256'])
        self.assertEqual('PASS', result['entries'][0]['hash_status'])
        self.assertEqual('SKIPPED', result['entries'][1]['hash_status'])
        self.assertIn('unsafe_path', result['entries'][1]['risks'])

    def test_budget_enforced(self):
        target = self.root / 'compressed.zip'
        with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr('safe/payload.bin', b'X' * 1024)
        result = inventory.inspect(target, max_member_bytes=512, max_total_expanded=512)
        self.assertIsNone(result['entries'][0]['sha256'])
        self.assertIn('expansion limit', result['entries'][0]['hash_status'])

    def test_binary_sniff_no_execution(self):
        path = self.root / 'example.exe'
        path.write_bytes(b'\x7fELFmore-raw-bytes')
        result = inventory.inspect(path)
        self.assertTrue(result['detected'].startswith('ELF'))
        self.assertEqual([], result['entries'])


if __name__ == '__main__':
    unittest.main()
