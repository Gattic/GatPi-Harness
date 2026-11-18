#!/usr/bin/env python3
"""Static SVG integrity scanner; does NOT prove painter order or collision-free 3D."""
import argparse
import re
from pathlib import Path
from xml.etree import ElementTree as ET

URL=re.compile(r'url\(\s*[\x27\"]?#([\w:.-]+)[\x27\"]?\s*\)')
def check(text):
    try:root=ET.fromstring(text)
    except ET.ParseError as exc:return [f'Invalid XML: {exc}']
    problems=[];ids=set();refs=set()
    if root.tag.split('}')[-1]!='svg':problems.append('Root not SVG')
    if 'viewBox' not in root.attrib:problems.append('Missing viewBox')
    for e in root.iter():
        n=e.attrib.get('id')
        if n:
            if n in ids:problems.append('Duplicate id: '+n)
            ids.add(n)
        if e.tag.split('}')[-1] in {'script','foreignObject'}:problems.append('Review active content')
        for k,v in e.attrib.items():
            if k.startswith('on') and '}' not in k:problems.append('Inline event handler')
            if k in {'href','{http://www.w3.org/1999/xlink}href'}:
                if v.startswith('#'):refs.add(v[1:])
                elif v.startswith(('http:','https:','data:','javascript:')):problems.append('External / executable reference')
            refs.update(URL.findall(v))
            if re.search(r'(?<!\w)(?:NaN|Infinity)(?!\w)',v):problems.append('Nonfinite attribute')
    for ref in sorted(refs-ids):problems.append('Missing local reference #'+ref)
    return problems

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('svg',type=Path);a=p.parse_args()
    try:problems=check(a.svg.read_text(encoding='utf-8'))
    except (OSError,UnicodeError) as exc:print('ERROR:',exc);return 2
    for err in problems:print('FAIL:',err)
    if problems:return 1
    print('PASS: SVG structure (not visual/3D geometry proof)');return 0
if __name__=='__main__':raise SystemExit(main())
