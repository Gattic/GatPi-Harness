#!/usr/bin/env python3
"""Purely offline integration tests; run with `python -m unittest discover -s tests -v`."""
from __future__ import annotations
import hashlib
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT=pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'tools'))
import audit_repositories
import install
import regenerate
import validate_skills


class PackTests(unittest.TestCase):
    def test_all_skill_contracts(self):
        self.assertEqual([],validate_skills.validate(ROOT))

    def test_generator_is_deterministic(self):
        sample=ROOT/'skills'/'comfyui-graph-engineering'/'SKILL.md'
        before=hashlib.sha256(sample.read_bytes()).hexdigest()
        catalog=json.loads((ROOT/'catalog.json').read_text(encoding='utf-8'))
        self.assertEqual(len(catalog),regenerate.regenerate(ROOT))
        after=hashlib.sha256(sample.read_bytes()).hexdigest()
        self.assertEqual(before,after)
        self.assertEqual([],validate_skills.validate(ROOT))

    def test_safe_installer_is_selective(self):
        with tempfile.TemporaryDirectory() as td:
            dst=pathlib.Path(td)/'skills'
            names=['seo-technical-audit','3d-modeling-topology']
            dry=install.install(dst,names,dry_run=True)
            self.assertEqual(2,len(dry))
            self.assertFalse(dst.exists())
            done=install.install(dst,names)
            self.assertEqual(2,len(done))
            for name in names:
                self.assertTrue((dst/name/'SKILL.md').is_file())
            existing=(dst/names[0]/'SKILL.md')
            existing.write_text('USER CUSTOMIZATION',encoding='utf-8')
            self.assertIn('SKIPPED',install.install(dst,[names[0]])[0])
            self.assertEqual('USER CUSTOMIZATION',existing.read_text())
            self.assertIn('INSTALLED',install.install(dst,[names[0]],force=True)[0])
            self.assertIn('name: seo-technical-audit',existing.read_text())

    @unittest.skipUnless(subprocess.run(['which','git'],capture_output=True).returncode==0,'git missing')
    def test_exhaustive_auditor_on_local_fixture(self):
        with tempfile.TemporaryDirectory() as td:
            tmp=pathlib.Path(td)
            repo=tmp/'fake-repo'
            (repo/'a'/'nested').mkdir(parents=True)
            (repo/'b').mkdir(parents=True)
            (repo/'a'/'nested'/'SKILL.md').write_text(
                '---\nname: nested\ndescription: Use when testing a nested skill.\n---\n'
                '# Nested\n## Workflow\n1. Gather inputs\n2. Validate outputs\n3. Test\n4. Review\n5. Deliver\n'
                '## Outputs\nProduce evidence. Avoid guessing; use tools and have a fallback.\n',encoding='utf-8')
            (repo/'b'/'SKILL.md').write_text(
                '---\nname: b\ndescription: Use when checking multiple skill documents.\n---\n'
                '# B\n1. Review\n2. Inspect\n3. Verify\n4. Run\n5. Report\n',encoding='utf-8')
            (repo/'AGENTS.md').write_text('not a skill',encoding='utf-8')
            subprocess.run(['git','init','-q',str(repo)],check=True,capture_output=True)
            subprocess.run(['git','-C',str(repo),'add','.'],check=True,capture_output=True)
            subprocess.run(['git','-C',str(repo),'-c','user.name=Test','-c','user.email=test@example.invalid',
                            'commit','-q','-m','fixture'],check=True,capture_output=True)
            out=tmp/'report'
            result=audit_repositories.do_audit(['obra/superpowers'],{'obra/superpowers':str(repo)},
                                                tmp/'clones',out,400000,180)
            self.assertTrue(result['audit_is_exhaustive'])
            self.assertEqual(2,result['skills_scored'])
            self.assertEqual(1,result['repositories_complete'])
            self.assertEqual({'a/nested/SKILL.md','b/SKILL.md'}, {s['path'] for s in result['skills']})
            self.assertTrue((out/'source-skills.csv').is_file())
            self.assertIn('nested', (out/'individual-reviews.md').read_text())


if __name__=='__main__':
    unittest.main()
