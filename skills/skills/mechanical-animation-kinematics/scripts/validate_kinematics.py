#!/usr/bin/env python3
"""Validate ideal external/internal gearing and lead-screw sample constraints."""
import argparse
import json
import math
from pathlib import Path

def check(data):
    errors=[];gears={g['name']:g for g in data.get('gears',[])}
    for m in data.get('meshes',[]):
        a,b=m['driver'],m['driven']
        if a not in gears or b not in gears:errors.append(f'{a}->{b}: unknown gear');continue
        x,y=gears[a],gears[b];nx,ny=x['teeth'],y['teeth']
        if type(nx)!=int or type(ny)!=int or min(nx,ny)<1:errors.append('invalid teeth');continue
        if m.get('type','external') not in ('external','internal'):errors.append('invalid mesh type');continue
        sign=-1 if m.get('type','external')=='external' else 1
        xs={float(s['time']):float(s['angle']) for s in x['samples']}
        ys={float(s['time']):float(s['angle']) for s in y['samples']}
        times=sorted(xs.keys()&ys.keys());tol=float(m.get('tolerance_rad',0.001))
        if len(times)<2 or not math.isfinite(tol) or tol<0:errors.append('need two valid samples and tolerance');continue
        first=times[0]
        for t in times[1:]:
            residual=(ys[t]-ys[first])-sign*(nx/ny)*(xs[t]-xs[first])
            if not math.isfinite(residual) or abs(residual)>tol:errors.append(f'{a}->{b}: gearing mismatch at {t}: {residual}')
    for s in data.get('screws',[]):
        pitch=float(s['pitch_mm']);starts=s.get('starts',1);hand=s.get('handedness',1)
        if not math.isfinite(pitch) or pitch<=0 or type(starts)!=int or starts<1 or hand not in (-1,1):errors.append('invalid screw settings');continue
        samples=s['samples'];tol=float(s.get('tolerance_mm',0.001))
        if len(samples)<2 or not math.isfinite(tol) or tol<0:errors.append('invalid screw samples or tolerance');continue
        first=samples[0]
        for p in samples[1:]:
            actual=float(p['travel_mm'])-float(first['travel_mm'])
            expected=hand*pitch*starts*(float(p['turns'])-float(first['turns']))
            if not math.isfinite(actual) or abs(actual-expected)>tol:errors.append(f'{s["name"]}: lead mismatch: {actual} vs {expected}')
    return errors

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('spec',type=Path);a=p.parse_args()
    try: errors=check(json.loads(a.spec.read_text()))
    except (OSError,ValueError,KeyError,TypeError) as e:print('ERROR:',e);return 2
    for err in errors:print('FAIL:',err)
    if errors:return 1
    print('PASS: ideal sample kinematics (not collision or torque proof)');return 0
if __name__=='__main__':raise SystemExit(main())
