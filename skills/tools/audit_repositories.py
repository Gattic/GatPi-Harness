#!/usr/bin/env python3
"""Inventory and heuristically audit EVERY tracked SKILL.md in specified Git repos.

Examples:
    python tools/audit_repositories.py --out source-audit
    python tools/audit_repositories.py --repo obra/superpowers --out source-audit
    python tools/audit_repositories.py --offline-repo obra/superpowers=/path/to/clone

Requirements: Python 3.10+, git, network access when not using --offline-repo.
Security: inspect tracked paths and SKILL.md as UNTRUSTED TEXT. Never execute repository code.

The score is a transparent lint/quality *signal*, not proof that an agent skill works.
Actual task behavior requires a separate controlled evaluation in an agent runtime.
"""
from __future__ import annotations

import argparse
import collections
import csv
import datetime
import hashlib
import json
import os
import pathlib
import re
import shlex
import subprocess
import sys
from dataclasses import dataclass, asdict
from typing import Any
from urllib.parse import unquote

REPOSITORIES = [
    'Comfy-Org/ComfyUI', 'obra/superpowers', 'mattpocock/skills',
    'addyosmani/agent-skills', 'anthropics/skills', 'vercel-labs/agent-skills',
    'openai/skills', 'trailofbits/skills', 'supabase/agent-skills',
    'debpalash/VoiceStudio', 'OpenBMB/VoxCPM', 'openwhispr/openwhispr',
    'freemocap/freemocap', 'nikopueringer/CorridorKey', 'latent-spaces/brag',
    'Autom8AI/Open-Higgsfield-AI', 'heygen-com/hyperframes', 'opf/openproject',
]

APP_REPOS = {
    'Comfy-Org/ComfyUI', 'debpalash/VoiceStudio', 'OpenBMB/VoxCPM',
    'openwhispr/openwhispr', 'freemocap/freemocap',
    'nikopueringer/CorridorKey', 'Autom8AI/Open-Higgsfield-AI', 'opf/openproject',
}

INDICATORS = {
    'trigger': [r'\bwhen to use\b', r'\buse this skill when\b', r'\buse when\b', r'\btrigger\b', r'\bwhen the user\b'],
    'negative_trigger': [r'\bdo not use\b', r'\bdon.t use\b', r'\bnot suitable\b', r'\bavoid using\b', r'\bdo not trigger\b'],
    'workflow': [r'(?m)^\s*\d+[.)]\s+\w+', r'(?m)^#{1,4}\s+(workflow|steps|procedure|process|instructions)\b', r'(?m)^\s*[-*]\s+(first|then|next|run|check|verify)\b'],
    'inputs': [r'\binputs?\b', r'\bprerequisites?\b', r'\brequirements?\b', r'\bprovided files?\b'],
    'outputs': [r'\bdeliverables?\b', r'\boutputs?\b', r'\bartifacts?\b', r'\bproduce\b', r'\bexport\b'],
    'verification': [r'\bverif(y|ication)\b', r'\bvalidat(e|ion)\b', r'\bacceptance criteria\b', r'\bassert\b', r'\btest(s|ing)?\b', r'\bquality check\b'],
    'failure': [r'\bfailure\b', r'\btroubleshoot\b', r'\bif .*unavailable\b', r'\bfallback\b', r'\brecover\b', r'\bblocked\b'],
    'security': [r'\bauthori[sz]ation\b', r'\bsecret(s)?\b', r'\buntrusted\b', r'\bconsent\b', r'\bpermission(s)?\b', r'\bprivacy\b', r'\bprompt injection\b'],
    'evidence': [r'\bproof\b', r'\bevidence\b', r'\bmeasur(e|ed|ement)\b', r'\bbenchmark\b', r'\bsource(s)?\b', r'\blog(s)?\b'],
    'tools': [r'\bcli\b', r'\bscript(s)?\b', r'\btool(s)?\b', r'\bcommand(s)?\b', r'```(?:bash|sh|python|json)'],
    'constraints': [r'\bdo not\b', r'\bnever\b', r'\bmust not\b', r'\bavoid\b', r'\bconstraints?\b'],
}

DOMAINS = {
    'security': ('security','vulnerability','threat','audit','pentest','semgrep','yara','malware','crypto','supply-chain'),
    'engineering': ('code','python','cpp','c++','git','test','debug','api','database','frontend','react','performance','CI/CD'),
    'media': ('video','audio','voice','image','comfy','animation','render','figma','3d','motion','frame'),
    'writing': ('document','pdf','pptx','xlsx','write','copy','presentation','slides','email'),
    'research': ('research','source','investigate','browser','search','evidence'),
    'operations': ('project','plan','workflow','roadmap','release','deploy','shipping'),
}


def cmd(*args: str, timeout: int = 180, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, timeout=timeout, check=check)


def git_text(repo: pathlib.Path, *args: str, timeout: int = 120) -> str:
    return cmd('git','-C',str(repo),*args,timeout=timeout).stdout.decode('utf-8','replace')


def list_tracked_file_metadata(repo: pathlib.Path) -> dict[str, dict[str,str]]:
    raw = cmd('git','-C',str(repo),'ls-tree','-r','-z','HEAD',timeout=180).stdout
    result={}
    for part in raw.split(b'\0'):
        if not part:
            continue
        header,pathname=part.split(b'\t',1)
        mode,kind,object_sha=header.decode('ascii').split()
        result[pathname.decode('utf-8','replace')]={'mode':mode,'kind':kind,'sha':object_sha}
    return result


def list_tracked_files(repo: pathlib.Path) -> list[str]:
    return list(list_tracked_file_metadata(repo))


def resolve_symlink_blob(repo: pathlib.Path, skill_path: str,
                         metadata: dict[str,dict[str,str]], max_bytes: int) -> str:
    current=skill_path
    visited=set()
    while metadata.get(current,{}).get('mode')=='120000':
        if current in visited or len(visited)>=12:
            raise ValueError(f'Symlink cycle or excessive depth at {skill_path}')
        visited.add(current)
        pointer,_=git_blob(repo,current,4096)
        target=pointer.strip()
        if not target or target.startswith('/'):
            raise ValueError(f'Invalid absolute/empty SKILL.md symlink at {current}')
        current=os.path.normpath(str(pathlib.PurePosixPath(current).parent / target)).replace('\\','/')
        if current.startswith('../') or current not in metadata:
            raise ValueError(f'Symlink destination not tracked inside repository: {skill_path} -> {target}')
    return current


def git_blob(repo: pathlib.Path, path: str, max_bytes: int) -> tuple[str, bool]:
    # blob read; does not checkout files, import modules, or execute any upstream code.
    raw = cmd('git','-C',str(repo),'show',f'HEAD:{path}',timeout=180).stdout
    return raw[:max_bytes].decode('utf-8', 'replace'), len(raw) > max_bytes


def clone_repository(name: str, root: pathlib.Path, timeout: int) -> pathlib.Path:
    folder = root / (name.replace('/', '__'))
    if folder.exists():
        git_text(folder, 'rev-parse', '--is-inside-work-tree')
        return folder
    folder.parent.mkdir(parents=True, exist_ok=True)
    url = f'https://github.com/{name}.git'
    # Partial clone avoids pulling media/model assets from large application repositories.
    try:
        cmd('git', '-c','core.longpaths=true', 'clone','--quiet','--depth=1',
            '--filter=blob:none','--no-checkout',url,str(folder),timeout=timeout)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        if folder.exists():
            import shutil
            shutil.rmtree(folder)
        # On servers that do not support the blob filter, shallow clone is fallback.
        cmd('git', 'clone','--quiet','--depth=1','--no-checkout',url,str(folder),timeout=timeout)
    return folder


def parse_frontmatter(text: str) -> dict[str, str]:
    match = re.match(r'\A---\s*\n(.*?)\n---\s*(?:\n|\Z)',text,re.S)
    if not match:
        return {}
    data: dict[str,str] = {}
    for line in match.group(1).splitlines():
        m = re.match(r'^([a-zA-Z][\w-]*):\s*(.*)$',line)
        if not m:
            continue
        key,value = m.groups()
        if key not in ('name','description','license','compatibility','allowed-tools'):
            continue
        if value.startswith(('"', "'")):
            try:
                value = json.loads(value)
            except (json.JSONDecodeError,TypeError):
                value = value.strip('"\'')
        data[key] = str(value)
    return data


def category_for(name: str, desc: str, path: str) -> str:
    search = f'{name} {desc} {path}'.lower()
    scores = {domain: sum(1 for token in tokens if token.lower() in search)
              for domain,tokens in DOMAINS.items()}
    best = max(scores, key=lambda x: scores[x])
    return best if scores[best] else 'general'


def refs_in_text(text: str, current: str, tracked: set[str]) -> tuple[list[str], list[str]]:
    missing: list[str] = []
    checked: list[str] = []
    base = pathlib.PurePosixPath(current).parent
    for path in re.findall(r'\[[^\]]*\]\(([^)]+)\)',text):
        link = unquote(path.strip().split(' ')[0].strip('<>'))
        if link.startswith(('http:','https:','mailto:','#','data:','/')):
            continue
        relative = link.split('#')[0].split('?')[0]
        if not relative:
            continue
        normalized = pathlib.PurePosixPath(os.path.normpath(str(base / relative)).replace('\\','/'))
        resolved = str(normalized)
        checked.append(resolved)
        if resolved not in tracked and not any(k.startswith(resolved.rstrip('/')+'/') for k in tracked):
            missing.append(resolved)
    return checked,missing


def license_hint(repo: pathlib.Path, current: str, tracked: set[str], max_bytes: int) -> str:
    ancestors = [str(pathlib.PurePosixPath(current).parent)]
    while ancestors[-1] not in ('.',''):
        ancestors.append(str(pathlib.PurePosixPath(ancestors[-1]).parent))
    filenames = ('LICENSE', 'LICENSE.md','LICENSE.txt','COPYING','COPYING.md')
    for folder in ancestors:
        for filename in filenames:
            key = f'{folder}/{filename}' if folder not in ('.','') else filename
            if key in tracked:
                try:
                    snippet, truncated = git_blob(repo,key, min(max_bytes,12000))
                    low=snippet.lower()
                    if 'attribution-sharealike' in low or 'cc-by-sa' in low:
                        label='CC-BY-SA (verify version)'
                    elif 'apache license' in low:
                        label='Apache (verify version)'
                    elif 'mit license' in low or ('permission is hereby granted' in low):
                        label='MIT'
                    elif 'gnu affero' in low:
                        label='AGPL (verify version)'
                    elif 'gnu general public' in low:
                        label='GPL (verify version)'
                    else:
                        label='CHECK_LICENSE_FILE'
                except (subprocess.CalledProcessError,subprocess.TimeoutExpired):
                    label='LICENSE_FILE_NOT_READABLE'
                return f'{label}; source={key}'
    return 'NO_NEARBY_LICENSE_NOTICE; verify externally'


def inspect_skill(repo_name: str, repo_dir: pathlib.Path, path: str, all_files: set[str],
                  sha: str, max_bytes: int, metadata: dict[str,dict[str,str]]) -> dict[str,Any]:
    resolved=resolve_symlink_blob(repo_dir,path,metadata,max_bytes)
    text,truncated = git_blob(repo_dir,resolved,max_bytes)
    fm = parse_frontmatter(text)
    body = re.sub(r'\A---\s*\n.*?\n---\s*','',text,flags=re.S)
    desc=fm.get('description','')
    extracted_name=fm.get('name') or pathlib.PurePosixPath(path).parent.name
    signals = {name: any(re.search(p,body,re.I|re.M) for p in pats) for name,pats in INDICATORS.items()}
    steps = len(re.findall(r'(?m)^\s*\d+[.)]\s+\S',body))
    headings = re.findall(r'(?m)^#{1,4}\s+(.+)$',body)
    refs,missing=refs_in_text(text,path,all_files)
    word_count=len(re.findall(r'\b[\w-]+\b',body))
    format_issues=[]
    if not fm:
        format_issues.append('Missing parseable YAML frontmatter')
    if not fm.get('name'):
        format_issues.append('Missing name')
    if not desc or desc in ('>', '|'):
        format_issues.append('Missing or unparseable description')
    if fm.get('name') and fm['name'] != pathlib.PurePosixPath(resolved).parent.name:
        format_issues.append('Name does not match resolved parent folder')
    if fm.get('name') and not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*',fm['name']):
        format_issues.append('Non-portable skill name')
    if len(desc)>1024:
        format_issues.append('Description exceeds Agent Skills 1024-character limit')
    if fm.get('name') and len(fm['name'])>64:
        format_issues.append('Name exceeds Agent Skills 64-character limit')
    if truncated:
        format_issues.append('Skill text exceeded configured inspection cap')
    if missing:
        format_issues.append(f'{len(missing)} potentially unresolved local Markdown references')

    score = {
        'activation': int(bool(desc))*2 + int(signals['trigger']) + int(signals['negative_trigger']) + int(bool(fm.get('name'))),
        'execution': int(signals['workflow'])*2 + int(steps>=4) + int(signals['inputs']) + int(signals['outputs']),
        'verification': int(signals['verification'])*2 + int(signals['evidence']) + int('accept' in body.lower()) + int(bool(re.search(r'\bregression\b|\btest cases?\b',body,re.I))),
        'safety': int(signals['security'])*2 + int(signals['constraints']) + int(signals['failure']) + int(bool(re.search(r'\buntrusted\b|\bconsent\b|\buser approval\b',body,re.I))),
        'portability': int(not format_issues)*2 + int(not missing) + int(signals['tools']) + int(signals['failure']),
        'maintainability': int(150<=word_count<=2500)*2 + int(bool(headings)) + int(not truncated) + int(not missing),
    }
    score={k:min(5,v) for k,v in score.items()}
    strengths=[]
    weaknesses=[]
    checks=[
        ('Good task-scoping cues', bool(desc) and signals['trigger'], 'Activation conditions are weak or not explicitly recognizable'),
        ('Explicit negative routing', signals['negative_trigger'], 'No clear anti-trigger; increased false activation risk'),
        ('Actionable ordered procedure', signals['workflow'] and steps>=4, 'Workflow structure or minimum step count is weak'),
        ('Specified input/output contracts', signals['inputs'] and signals['outputs'], 'Inputs or outputs not explicitly described'),
        ('Verification guidance', signals['verification'], 'Observable verification is absent or not recognizable'),
        ('Failure/recovery guidance', signals['failure'], 'Recovery and unavailable-tool behavior are not explicit'),
        ('Safety/authorization signals', signals['security'], 'Limited explicit safety or trust-boundary cues'),
        ('Local references resolve', not missing, f'Potential missing reference paths: {missing[:4]}'),
    ]
    for good,yes,bad in checks:
        (strengths if yes else weaknesses).append(good if yes else bad)
    if format_issues:
        weaknesses.extend(format_issues)
    summary = desc.strip() if desc and desc not in ('|','>') else re.sub(r'[#*_`\n]+',' ',body[:300]).strip()
    return {
        'repository':repo_name,'commit':sha,'path':path,'resolved_path':resolved,'symlink_alias':resolved!=path,'name':extracted_name,
        'category':category_for(extracted_name,desc,path),'summary':summary[:400],
        'usefulness': f"Candidate for {category_for(extracted_name,desc,path)} work when the task matches its stated trigger; practical utility requires an execution trial.",
        'word_count':word_count,'step_count':steps,'headings':headings[:25],
        'signal_flags':signals,'scores':score,'total_score':sum(score.values()),
        'strengths':strengths,'weaknesses':weaknesses,'format_issues':format_issues,
        'relative_references_checked':refs,'missing_references':missing,
        'license':fm.get('license','') or license_hint(repo_dir,resolved,all_files,max_bytes),
        'sha256_excerpt':hashlib.sha256(text.encode()).hexdigest(),
        'truncated':truncated,
        'review_method':'automated source-text heuristic; not a behavioral, legal or expert security audit',
    }


def do_audit(names: list[str], offline: dict[str,str], clone_dir: pathlib.Path,
             out: pathlib.Path, max_bytes: int, timeout: int) -> dict[str,Any]:
    out.mkdir(parents=True,exist_ok=True)
    manifest=[]
    details=[]
    for index,name in enumerate(names,1):
        entry={'repository':name,'url':f'https://github.com/{name}',
               'kind':'application / specialized tooling' if name in APP_REPOS else 'agent skill library / hybrid',
               'status':'STARTED','skills':0,'guidance_files':0,'commit':None,'error':None}
        print(f'[{index}/{len(names)}] Auditing {name}',flush=True)
        try:
            dest = pathlib.Path(offline[name]).expanduser().resolve() if name in offline else clone_repository(name,clone_dir,timeout)
            sha=git_text(dest,'rev-parse','HEAD').strip()
            metadata = list_tracked_file_metadata(dest)
            tracked = list(metadata)
            files=set(tracked)
            skill_paths=sorted(x for x in tracked if pathlib.PurePosixPath(x).name=='SKILL.md')
            auxiliary=sorted(x for x in tracked if pathlib.PurePosixPath(x).name in ('AGENTS.md','CLAUDE.md') or x.endswith('/.claude/commands'))
            entry.update(commit=sha,skills=len(skill_paths),guidance_files=len(auxiliary),status='COMPLETE',
                         auxiliary_examples=auxiliary[:20])
            for p in skill_paths:
                try:
                    row=inspect_skill(name,dest,p,files,sha,max_bytes,metadata)
                    details.append(row)
                except (OSError,ValueError,subprocess.CalledProcessError,subprocess.TimeoutExpired) as exc:
                    details.append({'repository':name,'path':p,'status':'ERROR','error':str(exc),'commit':sha})
                    entry['status']='PARTIAL'
        except (OSError,ValueError,subprocess.CalledProcessError,subprocess.TimeoutExpired) as exc:
            entry['status']='ERROR'
            entry['error']=str(exc)
        manifest.append(entry)

    completed = sum(x['status']=='COMPLETE' for x in manifest)
    result = {
        'schema_version': 1,
        'method': 'Tracked git HEAD SKILL.md files only, including arbitrarily nested paths; the tool does not execute repositories.',
        'generated_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'repositories_requested':len(names), 'repositories_complete':completed,
        'skills_scored':sum('scores' in x for x in details),
        'audit_is_exhaustive':completed==len(names) and all('scores' in x for x in details),
        'caveats':['Git submodule content is not recursively traversed unless supplied as separate repos.',
                   'Ignored/untracked working tree files are not part of source HEAD.',
                   'Regex-based scores are signals, not validated human or runtime judgments.',
                   'Licensing is advisory; consult full license and per-file notices.'],
        'repositories':manifest,'skills':details,
    }
    (out/'source-inventory.json').write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    csv_fields=['repository','commit','path','name','category','word_count','step_count','total_score',
                'activation','execution','verification','safety','portability','maintainability',
                'license','summary','strengths','weaknesses','review_method']
    with (out/'source-skills.csv').open('w',newline='',encoding='utf-8') as fh:
        writer=csv.DictWriter(fh,fieldnames=csv_fields)
        writer.writeheader()
        for row in details:
            if 'scores' not in row:
                continue
            flattened={k:row.get(k,'') for k in csv_fields}
            flattened.update(row['scores'])
            flattened['strengths']=' | '.join(row['strengths'])
            flattened['weaknesses']=' | '.join(row['weaknesses'])
            writer.writerow(flattened)
    md=['# Individual upstream skill audit','',
        f"Run at {result['generated_utc']}; {completed}/{len(names)} repository Git trees fully read; {result['skills_scored']} SKILL.md files heuristically scored.",
        '', '**Important:** This report enumerates tracked `SKILL.md` documents only and treats its text as untrusted data. Scores (0–5 per quality dimension, total 0–30) are heuristic indicators, **not** actual agent performance. See `source-inventory.json` for machine-readable full detail.','']
    for repo in manifest:
        rs=[x for x in details if x['repository']==repo['repository']]
        md += [f"## {repo['repository']}",'', f"- Status: **{repo['status']}**; commit: `{repo.get('commit') or 'UNAVAILABLE'}`; skills found: **{repo['skills']}**; guidance documents: {repo['guidance_files']}."]
        if repo.get('error'):
            md.append(f"- Blocker: `{repo['error'][:700]}`")
        md.append('')
        for skill in rs:
            if 'scores' not in skill:
                md += [f"### `{skill['path']}`",'',f"**Read failure:** {skill.get('error')}",'']
                continue
            md += [f"### {skill['name']} — `{skill['path']}`",'',
                   f"- Usefulness: {skill['usefulness']}",
                   f"- Scores: {', '.join(f'{k}={v}/5' for k,v in skill['scores'].items())}; **total={skill['total_score']}/30** (heuristic).",
                   f"- Strength signals: {'; '.join(skill['strengths'])}.",
                   f"- Weakness signals: {'; '.join(skill['weaknesses'])}.",
                   f"- License notice: {skill['license']}",
                   f"- Original tracked location: `{skill['path']}`; resolved content: `{skill['resolved_path']}`" + (' (symlink alias)' if skill['symlink_alias'] else ''),
                   '']
    (out/'individual-reviews.md').write_text('\n'.join(md),encoding='utf-8')
    summary=['# Source audit summary','',f"Status: {completed} of {len(names)} repositories completed; {result['skills_scored']} source skills inspected.",'',
             '| Repository | Kind | SKILL.md files | Status | SHA |','|---|---|---:|---|---|']
    for rep in manifest:
        summary.append(f"| {rep['repository']} | {rep['kind']} | {rep['skills']} | {rep['status']} | `{(rep.get('commit') or 'n/a')[:12]}` |")
    summary += ['', '## Reproducibility and limits', '',
                'Run `python tools/audit_repositories.py --out source-audit` with Git and network access, or provide 18 offline clones.',
                'Only a COMPLETE result for every repository and every file justifies calling this a full tracked-skill inventory. Check the `audit_is_exhaustive` field.',
                'Do not interpret heuristic scores as validated effectiveness or licensing clearance.', '']
    (out/'README.md').write_text('\n'.join(summary),encoding='utf-8')
    print(f"Done: {completed}/{len(names)} repos complete, {result['skills_scored']} individual skills, files in {out}",flush=True)
    return result


def main() -> int:
    parser=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--repo',action='append',choices=REPOSITORIES,
                        help='One repository to audit (repeat for multiple); defaults to all 18')
    parser.add_argument('--offline-repo',action='append',default=[],metavar='OWNER/REPO=/path/to/clone',
                        help='Reuse a local clone instead of network clone; can repeat')
    parser.add_argument('--clone-dir',type=pathlib.Path,default=pathlib.Path('.skill-audit-clones'))
    parser.add_argument('--out',type=pathlib.Path,default=pathlib.Path('source-audit'))
    parser.add_argument('--max-skill-bytes',type=int,default=400_000)
    parser.add_argument('--clone-timeout',type=int,default=1800)
    args=parser.parse_args()
    offline={}
    for item in args.offline_repo:
        if '=' not in item:
            parser.error(f'Expected OWNER/REPO=/path/to/clone: {item}')
        name,path=item.split('=',1)
        if name not in REPOSITORIES:
            parser.error(f'Unknown repo {name}')
        offline[name]=path
    names=args.repo if args.repo else REPOSITORIES
    result=do_audit(names,offline,args.clone_dir.resolve(),args.out.resolve(),args.max_skill_bytes,args.clone_timeout)
    return 0 if result['audit_is_exhaustive'] else 2


if __name__=='__main__':
    sys.exit(main())
