"""Public-CLI regressions for the bundled offline SEO helper (no network)."""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
HELPER = ROOT / "skills" / "seo-technical-audit" / "scripts" / "site_audit.py"


class SeoHelperTests(unittest.TestCase):
    def audit(self, pages, *args):
        with tempfile.TemporaryDirectory(prefix="skill-seo-regression-") as td:
            root = pathlib.Path(td)
            site = root / "site"
            site.mkdir()
            for name, body in pages.items():
                (site / name).write_text(body, encoding="utf-8")
            out = root / "report.json"
            result = subprocess.run(
                [sys.executable, str(HELPER), "--html-dir", str(site),
                 "--out", str(out), *args],
                capture_output=True, text=True, timeout=10,
            )
            report = json.loads(out.read_text()) if out.exists() else None
            return result, report

    def test_valueless_robots_content_is_a_missing_value_not_a_crash(self):
        result, report = self.audit({
            "broken.html": '<html><head><meta name="robots" content></head><body></body></html>'
        })
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("", report["pages"][0]["meta_robots"])
        self.assertNotIn("NOINDEX_PRESENT_REVIEW_IF_INTENTIONAL", report["issue_counts"])
        self.assertEqual(1, report["issue_counts"]["MISSING_TITLE"])

    def test_valueless_description_is_normalized_in_the_json_contract(self):
        result, report = self.audit({
            "broken.html": '<html><head><meta name="description" content></head></html>'
        })
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("", report["pages"][0]["description"])
        self.assertEqual(1, report["issue_counts"]["MISSING_META_DESCRIPTION"])

    def test_export_audit_counts_duplicates_and_preserves_decorative_alt(self):
        pages = {
            "index.html": '<html lang="en"><head><title>Catalog overview</title>'
                          '<meta name="description" content="Overview">'
                          '<link rel="canonical" href="https://example.invalid/">'
                          '</head><body><h1>Catalog</h1><img src="d.png" alt=""></body></html>',
            "catalog.html": '<html lang="en"><head><title>Shared title</title>'
                            '<meta name="description" content="Catalog">'
                            '<link rel="canonical" href="https://example.invalid/catalog">'
                            '</head><body><h1>Products</h1><img src="p.png"></body></html>',
            "broken.html": '<html><head><title>Shared title</title>'
                           '<meta name="robots" content></head><body><img src="m.png"></body></html>',
        }
        result, report = self.audit(pages)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("offline-static-html", report["mode"])
        self.assertEqual(3, report["page_count"])
        self.assertEqual({
            "DUPLICATE_TITLE_IN_SAMPLE": 2,
            "IMAGES_MISSING_ALT_ATTRIBUTE": 2,
            "MISSING_H1": 1,
            "MISSING_HTML_LANG": 1,
            "MISSING_META_DESCRIPTION": 1,
            "NO_DECLARED_CANONICAL_REVIEW_CONTEXT": 1,
        }, report["issue_counts"])
        clean = next(page for page in report["pages"] if page["path"] == "index.html")
        self.assertEqual([], clean["issues"])
        self.assertEqual(0, clean["missing_alt_count"])
        self.assertTrue(any("not indexation" in value for value in report["caveats"]))

    def test_noindex_and_missing_alt_remain_observable(self):
        result, report = self.audit({
            "page.html": '<html lang="en"><head><title>Private page</title>'
                         '<meta name="description" content="Private">'
                         '<meta name="robots" content="NOINDEX, follow">'
                         '<link rel="canonical" href="https://example.invalid/private">'
                         '</head><body><h1>Private</h1><img src="a.png" alt="">'
                         '<img src="b.png"></body></html>'
        })
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual({
            "IMAGES_MISSING_ALT_ATTRIBUTE": 1,
            "NOINDEX_PRESENT_REVIEW_IF_INTENTIONAL": 1,
        }, report["issue_counts"])

    def test_offline_page_budget_is_enforced(self):
        result, report = self.audit({"a.html": "<title>A</title>",
                                     "b.html": "<title>B</title>"}, "--max-pages", "1")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(1, report["page_count"])
        self.assertEqual("a.html", report["pages"][0]["path"])
        result, report = self.audit({"a.html": "<title>A</title>"}, "--max-pages", "0")
        self.assertNotEqual(0, result.returncode)
        self.assertIsNone(report)


if __name__ == "__main__":
    unittest.main()
