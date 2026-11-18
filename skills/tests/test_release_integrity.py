"""Offline negative/positive tests for the release-manifest verifier."""
from __future__ import annotations

import hashlib
import json
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
from verify_release import verify  # noqa: E402


class ReleaseIntegrityTests(unittest.TestCase):
    def test_good_manifest_and_byte_mutation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            document = root / 'one.txt'
            document.write_bytes(b'initial')
            manifest = root / 'RELEASE_FILES.json'
            manifest.write_text(json.dumps({'schema_version': 1, 'files': [
                {'path': 'one.txt', 'size_bytes': 7, 'sha256': hashlib.sha256(b'initial').hexdigest()}
            ]}), encoding='utf-8')
            self.assertEqual(verify(root, manifest), [])
            document.write_bytes(b'changed')
            self.assertTrue(any('SHA-256 mismatch' in issue for issue in verify(root, manifest)))

    def test_traversal_and_unlisted_file(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            (root / 'extra').write_bytes(b'extra')
            manifest = root / 'RELEASE_FILES.json'
            manifest.write_text(json.dumps({'schema_version': 1, 'files': [
                {'path': '../secret', 'size_bytes': 1, 'sha256': '0' * 64}
            ]}), encoding='utf-8')
            result = verify(root, manifest)
            self.assertTrue(any('unsafe path' in issue for issue in result))
            self.assertTrue(any('Unlisted file' in issue for issue in result))


if __name__ == '__main__':
    unittest.main()
