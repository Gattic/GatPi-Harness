#!/usr/bin/env python3
"""Offline checks for the bundled Blender guides and scripts, plus an opt-in native run.

The native test needs a real Blender: set SKILL_FOUNDRY_BLENDER to its executable.
Without it the test is skipped, which is NOT TESTED, not native acceptance.
"""
from __future__ import annotations

import ast
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import check_blender_bundle  # noqa: E402

LEDGER = json.loads((ROOT / check_blender_bundle.LEDGER).read_text(encoding='utf-8'))
CATALOG = {entry['name']: entry for entry in json.loads((ROOT / 'catalog.json').read_text(encoding='utf-8'))}
HOST_SIDE = {'run_in_blender.py'}  # runs under the host Python, not inside Blender


class BlenderBundleTests(unittest.TestCase):
    def test_ledger_notices_and_shared_helper(self):
        self.assertEqual([], check_blender_bundle.check(ROOT))

    def test_checker_detects_edits_and_missing_notice(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            script = root / 'skills' / 'demo-skill' / 'scripts' / 'tool.py'
            script.parent.mkdir(parents=True)
            script.write_text('def run():\n    return {}\n', encoding='utf-8')
            (root / 'research').mkdir()
            ledger = {key: LEDGER[key] for key in ('schema_version', 'source', 'change_tags', 'skill_map')}
            ledger['files'] = [{'path': 'skills/demo-skill/scripts/tool.py', 'upstream_path': 'x/tool.py',
                                'upstream_sha256': check_blender_bundle.digest(script), 'sha256': '', 'changes': []}]
            (root / check_blender_bundle.LEDGER).write_text(json.dumps(ledger), encoding='utf-8')
            self.assertTrue(any('digest differs' in issue for issue in check_blender_bundle.check(root)))
            check_blender_bundle.refresh(root)
            self.assertEqual([], check_blender_bundle.check(root))
            script.write_text('def run():\n    return {"edited": True}\n', encoding='utf-8')
            issues = check_blender_bundle.check(root)
            self.assertTrue(any('digest differs' in issue for issue in issues))
            self.assertTrue(any('change tags' in issue for issue in issues))
            check_blender_bundle.refresh(root)
            (root / 'skills' / 'demo-skill' / check_blender_bundle.NOTICE).unlink()
            self.assertTrue(any('missing or stale' in issue for issue in check_blender_bundle.check(root)))

    def test_bundled_python_parses_and_scripts_expose_run(self):
        for entry in LEDGER['files']:
            path = ROOT / entry['path']
            if path.suffix != '.py':
                continue
            tree = ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
            parts = pathlib.PurePosixPath(entry['path']).parts
            if parts[0] == 'skills' and parts[2] == 'scripts' and path.name not in HOST_SIDE | {check_blender_bundle.HELPER}:
                functions = {node.name for node in tree.body if isinstance(node, ast.FunctionDef)}
                self.assertIn('run', functions, f'{entry["path"]} must expose run(**kwargs)')

    def test_every_bundled_skill_is_cataloged_with_its_files(self):
        for skill, paths in check_blender_bundle.files_by_skill(LEDGER).items():
            self.assertIn(skill, CATALOG, f'{skill} holds bundled files but is not in the catalog')
            entry = CATALOG[skill]
            self.assertIn(check_blender_bundle.NOTICE, entry['refs'], f'{skill} must list its third-party notice')
            self.assertIn(LEDGER['source']['repository'], entry.get('source_inspiration') or [], skill)
            for relative in paths:
                if relative.endswith('/' + check_blender_bundle.HELPER):
                    continue  # imported by the sibling scripts, never run directly
                self.assertIn(relative, entry['refs'], f'{skill} does not reference {relative}')

    @unittest.skipUnless(os.environ.get('SKILL_FOUNDRY_BLENDER'),
                         'NOT TESTED: set SKILL_FOUNDRY_BLENDER to a Blender executable to run the bundled scripts')
    def test_native_blender_suite(self):
        # The in-Blender tests write renders, bakes, exports and (from the windowed tracking test)
        # quit.blend under the temp directory, and Blender creates its user config directory.
        # Both are pointed at a scratch directory so the user's profile and temp files stay untouched.
        scratch = tempfile.mkdtemp(prefix='skill-foundry-blender-')
        result = subprocess.run(
            [os.environ['SKILL_FOUNDRY_BLENDER'], '-b', '--factory-startup', '--python-exit-code', '1',
             '-P', str(ROOT / 'tests' / 'blender' / 'run_all.py')],
            cwd=ROOT, capture_output=True, text=True,
            env={**os.environ, 'TMPDIR': scratch, 'BLENDER_USER_RESOURCES': os.path.join(scratch, 'blender-user')},
            encoding='utf-8', errors='replace', timeout=3600)
        lines = result.stdout.splitlines()
        summary = next((line for line in reversed(lines) if ' passed, ' in line), '')
        failures = [line for line in lines if line.startswith('FAIL ')]
        for line in lines:
            if line.startswith('SKIP '):
                print(line)
        print(f'native Blender suite: {summary}')
        kept = f'outputs kept in {scratch}'
        self.assertEqual([], failures, kept)
        self.assertEqual(0, result.returncode, f'{kept}\n{result.stderr[-2000:]}')
        self.assertTrue(summary, f'the in-Blender runner printed no summary; {kept}')
        leftovers = [str(path.relative_to(ROOT)) for path in (ROOT / 'skills').rglob('__pycache__')]
        self.assertEqual([], leftovers, 'the suite must not write bytecode into skill directories')
        shutil.rmtree(scratch)  # outputs of a passing run are disposable; a failing run keeps them


if __name__ == '__main__':
    unittest.main()
