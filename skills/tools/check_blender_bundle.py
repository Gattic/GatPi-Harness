#!/usr/bin/env python3
"""Check the bundled EL4CTEO/blender-skills material against its provenance ledger.

Static integrity only: recorded file digests, change annotations, byte-identical
shared helpers, no leftover upstream skill names and the per-skill third-party
notice. It does not run Blender; tests/blender/run_all.py does that.

--refresh rewrites the recorded digests and the notices after an intentional edit.
Change tags are edited by hand in research/blender-skills-provenance.json.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LEDGER = "research/blender-skills-provenance.json"
NOTICE = "THIRD_PARTY_NOTICES.md"
HELPER = "_bpyx.py"
MIT_TERMS = """Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE."""


def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(root: pathlib.Path) -> dict:
    return json.loads((root / LEDGER).read_text(encoding="utf-8"))


def files_by_skill(ledger: dict) -> dict[str, list[str]]:
    """Ledger paths inside each skill directory, relative to that directory."""
    grouped: dict[str, list[str]] = {}
    for entry in ledger["files"]:
        parts = pathlib.PurePosixPath(entry["path"]).parts
        if parts[0] == "skills":
            grouped.setdefault(parts[1], []).append("/".join(parts[2:]))
    return {skill: sorted(paths) for skill, paths in sorted(grouped.items())}


def notice_text(ledger: dict, paths: list[str]) -> str:
    source = ledger["source"]
    lines = [
        "# Third-party notices", "",
        f"The files listed below are copied or adapted from [{source['repository'].split('github.com/')[-1]}]"
        f"({source['repository']}) at commit `{source['commit']}` (release {source['release']}), "
        "distributed under the MIT License. Everything else in this skill directory is Skill Foundry "
        "material under the pack's own MIT license.", "",
        "Adaptations (skill names and links remapped to this pack, compatibility changes for Blender "
        "releases older than 5.2) are recorded per file in the pack's "
        "`research/blender-skills-provenance.json`.", "",
        "## Files", "",
    ]
    lines += [f"- `{path}`" for path in paths]
    lines += ["", "## License", "", "MIT License", "", source["copyright"], "", MIT_TERMS, ""]
    return "\n".join(lines)


def check(root: pathlib.Path) -> list[str]:
    issues: list[str] = []
    ledger = load(root)
    upstream_names = sorted(ledger["skill_map"], key=len, reverse=True)
    leftover = re.compile(r"(?<![A-Za-z0-9-])(" + "|".join(map(re.escape, upstream_names)) + r")(?![A-Za-z0-9-])")
    seen: set[str] = set()
    for entry in ledger["files"]:
        relative = entry["path"]
        if relative in seen:
            issues.append(f"duplicate ledger path: {relative}")
            continue
        seen.add(relative)
        path = root / relative
        if not path.is_file():
            issues.append(f"missing bundled file: {relative}")
            continue
        actual = digest(path)
        if actual != entry["sha256"]:
            issues.append(f"digest differs from ledger (edit, then --refresh): {relative}")
        if (actual != entry["upstream_sha256"]) != bool(entry["changes"]):
            issues.append(f"change tags must be listed exactly when the file differs from upstream: {relative}")
        unknown = sorted(set(entry["changes"]) - set(ledger["change_tags"]))
        if unknown:
            issues.append(f"undocumented change tags {unknown}: {relative}")
        if path.suffix in {".md", ".py"}:
            text = "\n".join(line for line in path.read_text(encoding="utf-8").splitlines()
                             if not line.startswith("Provenance:"))
            names = sorted(set(leftover.findall(text)))
            if names:
                issues.append(f"upstream skill names left in {relative}: {names}")
    helpers = sorted((root / "skills").glob(f"*/scripts/{HELPER}"))
    if len({digest(path) for path in helpers}) > 1:
        issues.append(f"{HELPER} copies differ; copy procedural-3d-blender/scripts/{HELPER} over the others")
    for path in helpers:
        if path.relative_to(root).as_posix() not in seen:
            issues.append(f"{HELPER} copy missing from the ledger: {path.relative_to(root).as_posix()}")
    for skill, paths in files_by_skill(ledger).items():
        notice = root / "skills" / skill / NOTICE
        if not notice.is_file() or notice.read_text(encoding="utf-8") != notice_text(ledger, paths):
            issues.append(f"{skill}: {NOTICE} is missing or stale (--refresh)")
    return issues


def refresh(root: pathlib.Path) -> None:
    ledger = load(root)
    for entry in ledger["files"]:
        entry["sha256"] = digest(root / entry["path"])
    ledger["files"].sort(key=lambda entry: entry["path"])
    (root / LEDGER).write_text(json.dumps(ledger, indent=1) + "\n", encoding="utf-8")
    for skill, paths in files_by_skill(ledger).items():
        (root / "skills" / skill / NOTICE).write_text(notice_text(ledger, paths), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=pathlib.Path, default=ROOT)
    parser.add_argument("--refresh", action="store_true", help="rewrite recorded digests and notices")
    args = parser.parse_args()
    target = args.root.resolve()
    if args.refresh:
        refresh(target)
    problems = check(target)
    if problems:
        print(f"FAIL: {len(problems)} issues")
        for problem in problems:
            print(" -", problem)
        sys.exit(1)
    print(f"PASS: {len(load(target)['files'])} bundled files match the provenance ledger; notices and shared helpers are consistent")
