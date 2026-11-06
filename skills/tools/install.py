#!/usr/bin/env python3
"""Install selected skill directories into a local agent's skills directory.

Examples:
  python tools/install.py --list
  python tools/install.py --target .agents/skills --skill systematic-debugging --skill seo-technical-audit
  python tools/install.py --target .claude/skills --all --dry-run
  python tools/install.py --target /path/to/project/.cursor/skills --all

No host-specific command is assumed. The caller chooses an existing, supported
skills discovery path. Existing folders are left intact unless --force is set.
"""
from __future__ import annotations
import argparse
import json
import pathlib
import shutil
import sys
import tempfile

ROOT=pathlib.Path(__file__).resolve().parent.parent


def install(target: pathlib.Path, names: list[str], force: bool=False, dry_run: bool=False) -> list[str]:
    messages=[]
    if not dry_run:
        target.mkdir(parents=True,exist_ok=True)
    for name in names:
        src=ROOT/'skills'/name
        if not src.is_dir() or not (src/'SKILL.md').is_file():
            raise ValueError(f'Unknown skill: {name}')
        dest=target/name
        if dest.exists() and not force:
            messages.append(f'SKIPPED (already exists): {dest}')
            continue
        if dry_run:
            messages.append(f'WOULD {"REPLACE" if dest.exists() else "INSTALL"}: {dest}')
            continue
        # Stage copy before touching a pre-existing target.
        stage=pathlib.Path(tempfile.mkdtemp(prefix='.skill-stage-',dir=target))
        backup=None
        try:
            staged=stage/name
            shutil.copytree(src,staged,symlinks=False)
            if dest.exists():
                backup=pathlib.Path(tempfile.mkdtemp(prefix='.skill-backup-',dir=target))
                dest.rename(backup/name)
            staged.rename(dest)
            messages.append(f'INSTALLED: {dest}')
            if backup is not None:
                shutil.rmtree(backup)
        except Exception:
            if backup is not None and (backup/name).exists() and not dest.exists():
                (backup/name).rename(dest)
            raise
        finally:
            if stage.exists():
                shutil.rmtree(stage)
    return messages


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--list',action='store_true',help='Print available names and exit')
    parser.add_argument('--target',type=pathlib.Path,help='Target agent skills directory')
    parser.add_argument('--skill',action='append',default=[],help='Skill name; repeatable')
    parser.add_argument('--all',action='store_true',help='Install all skills (may increase routing noise)')
    parser.add_argument('--force',action='store_true',help='Replace existing skill folders safely')
    parser.add_argument('--dry-run',action='store_true')
    args=parser.parse_args()
    catalog=json.loads((ROOT/'catalog.json').read_text(encoding='utf-8'))
    valid={x['name'] for x in catalog}
    if args.list:
        for entry in sorted(catalog,key=lambda x:x['name']):
            print(f"{entry['name']:<36} {entry['category']:<14} {entry['goal']}")
        sys.exit(0)
    if args.target is None:
        parser.error('--target is required unless --list is set')
    if not args.skill and not args.all:
        parser.error('choose at least one --skill, or --all')
    chosen=sorted(valid) if args.all else list(dict.fromkeys(args.skill))
    unknown=[name for name in chosen if name not in valid]
    if unknown:
        parser.error(f'Unknown skills: {unknown}')
    for msg in install(args.target.expanduser().resolve(),chosen,args.force,args.dry_run):
        print(msg)
