#!/usr/bin/env python3
"""Check a JSON state/transition graph's reachability, timing and reduced-motion handling."""
import argparse
import json
import math
from pathlib import Path

def check(data):
    errors=[]
    states=data.get('states',[])
    if not states or len(set(states))!=len(states):errors.append('states missing or duplicate')
    known=set(states);initial=data.get('initial_state')
    if initial not in known:errors.append('initial state unknown')
    edges={s:set() for s in known}
    for i,t in enumerate(data.get('transitions',[])):
        label=f'transition {i}'
        a,b=t.get('from'),t.get('to')
        if a not in known or b not in known:errors.append(label+': unknown endpoint')
        else:edges[a].add(b)
        ms=t.get('duration_ms')
        if isinstance(ms,bool) or not isinstance(ms,(int,float)) or not math.isfinite(ms) or ms<0:
            errors.append(label+': invalid duration')
        if not t.get('trigger'):errors.append(label+': missing trigger')
        if t.get('interrupt') not in {'cancel','reverse','replace','complete','not_interruptible'}:
            errors.append(label+': missing/invalid interruption policy')
        if t.get('reduced_motion') not in {'instant','crossfade','static'}:
            errors.append(label+': reduced-motion fallback missing')
    seen={initial} if initial in known else set();queue=list(seen)
    while queue:
        for dest in edges[queue.pop()]:
            if dest not in seen:seen.add(dest);queue.append(dest)
    for req in data.get('required_states',[]):
        if req not in seen:errors.append(f'required state {req} unreachable')
    return errors

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('spec',type=Path);a=p.parse_args()
    try: failures=check(json.loads(a.spec.read_text(encoding='utf-8')))
    except (OSError,ValueError,TypeError) as exc:print('ERROR:',exc);return 2
    for item in failures:print('FAIL:',item)
    if failures:return 1
    print('PASS: static timeline contracts (visual playback not tested)');return 0
if __name__=='__main__':raise SystemExit(main())
