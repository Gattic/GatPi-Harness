#!/usr/bin/env python3
"""Check Agent Skills metadata and this library's delivery/routing contracts.

This verifies static properties ONLY; it does not invoke an agent/model or prove
positive/negative prompts actually route correctly. Behavioral evaluation must
be performed separately as described in standards/evaluation-methodology.md.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parent.parent
NAME_RE = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')


def parse_frontmatter(text: str) -> tuple[dict, str]:
    match = re.match(r'\A---\r?\n(.*?)\r?\n---\r?\n',text,re.S)
    if not match:
        raise ValueError('missing YAML frontmatter')
    data={}
    for line in match.group(1).splitlines():
        m=re.match(r'^([a-z][a-z0-9-]*):\s*(.*?)\s*$',line)
        if m:
            key, value=m.groups()
            if value.startswith('"'):
                value=json.loads(value)  # generated YAML JSON scalar subset
            data[key]=value
    return data,text[match.end():]


def validate(root: pathlib.Path, verbose: bool=False) -> list[str]:
    issues=[]
    catalog=json.loads((root/'catalog.json').read_text(encoding='utf-8'))
    manifest=json.loads((root/'manifest.json').read_text(encoding='utf-8'))
    specialists=json.loads((root/'specialists.json').read_text(encoding='utf-8'))
    role_ids=[role['roleId'] for role in specialists.get('roles') or []]
    if not role_ids or len(role_ids)!=len(set(role_ids)):
        issues.append('specialists.json must declare unique role ids')
    paths=list((root/'skills').glob('*/SKILL.md'))
    actual={p.parent.name for p in paths}
    expected={x['name'] for x in catalog}
    if len(expected)!=len(catalog):
        issues.append('duplicate skill names in catalog')
    if actual!=expected:
        issues.append(f'skill folders != catalog: missing {sorted(expected-actual)}; extra {sorted(actual-expected)}')
    if manifest.get('skill_count')!=len(catalog):
        issues.append('manifest skill_count mismatch')
    for s in catalog:
        n=s['name']
        path=root/'skills'/n/'SKILL.md'
        if not path.exists():
            continue
        raw=path.read_text(encoding='utf-8')
        try:
            fm,body=parse_frontmatter(raw)
        except (ValueError,json.JSONDecodeError) as e:
            issues.append(f'{n}: invalid frontmatter: {e}')
            continue
        if fm.get('name')!=n or not NAME_RE.fullmatch(n) or len(n)>64:
            issues.append(f'{n}: invalid name')
        d=fm.get('description','')
        if not isinstance(d,str) or not 1<=len(d)<=1024:
            issues.append(f'{n}: invalid description length')
        if not d.startswith('Use when ') or 'Do not use when ' not in d:
            issues.append(f'{n}: description lacks positive or negative trigger')
        if fm.get('license')!='MIT':
            issues.append(f'{n}: license not recorded')
        checks=['## Activation boundary','## Establish before work','## Workflow','## Deliverables',
                '## Acceptance gate','## Anti-patterns and boundaries','## Failure handling','## Handoff',
                '## Harness delegation','**Use:**','**Do not use:**','**Pass only if:**','**Avoid:**',
                'PASS','FAIL','NOT TESTED','BLOCKED']
        for snippet in checks:
            if snippet not in body:
                issues.append(f'{n}: missing {snippet!r}')
        for role_id in role_ids:
            if f'`{role_id}`' not in body:
                issues.append(f'{n}: missing specialist role {role_id!r}')
        nsteps=len(re.findall(r'(?m)^\d+\.\s+\S',body))
        if nsteps<5 or nsteps != len(s['steps']):
            issues.append(f'{n}: bad step count {nsteps}')
        if "['" in body:
            issues.append(f'{n}: stray Python repr list')
        if len(re.findall(r'\b\w+\b',body))<170:
            issues.append(f'{n}: entrypoint may be too sparse')
        if len(re.findall(r'\b\w+\b',body))>2000:
            issues.append(f'{n}: entrypoint too long for selective loading')
        if s['goal'] not in body:
            issues.append(f'{n}: intended goal absent')
        if s['gate'] not in body:
            issues.append(f'{n}: quality gate absent')
        evalp=root/'evals'/(n+'.json')
        if not evalp.exists():
            issues.append(f'{n}: missing evals JSON')
        else:
            try:
                ev=json.loads(evalp.read_text(encoding='utf-8'))
                if ev.get('skill')!=n:
                    issues.append(f'{n}: eval skill mismatch')
                if len(ev.get('positive',[]))<3 or len(ev.get('negative',[]))<2 or len(ev.get('behavior',[]))<1:
                    issues.append(f'{n}: insufficient eval coverage')
                if ev.get('status')!='DESIGNED_NOT_EXECUTED':
                    issues.append(f'{n}: must not mislabel unrun eval tests')
                if len({x['prompt'] for x in ev['positive']+ev['negative']})<5:
                    issues.append(f'{n}: duplicate routing eval prompts')
            except (OSError,json.JSONDecodeError) as e:
                issues.append(f'{n}: invalid eval JSON {e}')
        for rel in s.get('refs',[]):
            if not (path.parent/rel).exists():
                issues.append(f'{n}: missing relative ref {rel}')
        if verbose:
            print(f"Checked {n}: {nsteps} workflow steps, {len(d)} description chars")
    if len(list((root/'evals').glob('*.json')))!=len(catalog):
        issues.append('extra or missing evaluation files')
    return issues


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=pathlib.Path,default=ROOT)
    parser.add_argument('--verbose',action='store_true')
    args=parser.parse_args()
    root=args.root.resolve()
    errors=validate(root,args.verbose)
    if errors:
        print(f'FAIL: {len(errors)} issues')
        for error in errors:
            print(' -',error)
        sys.exit(1)
    print(f'PASS: {len(json.loads((root/"catalog.json").read_text()))} skills: metadata, structure, gate, eval contracts and file references')
