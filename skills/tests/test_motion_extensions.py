"""Offline tests for the motion/geometry helpers."""
from __future__ import annotations
import importlib.util
import json
import pathlib
import tempfile
import unittest

ROOT=pathlib.Path(__file__).resolve().parent.parent

def load(name,rel):
    spec=importlib.util.spec_from_file_location(name,ROOT/rel)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

motion=load('motion_check','skills/ui-motion-direction/scripts/check_motion_timeline.py')
kin=load('kin_check','skills/mechanical-animation-kinematics/scripts/validate_kinematics.py')
svg=load('svg_check','skills/isometric-svg-geometry-audit/scripts/inspect_svg.py')

class NewSkillTests(unittest.TestCase):
    def test_motion_valid(self):
        data={'states':['idle','pending','success'],'initial_state':'idle','required_states':['success'],'transitions':[
            {'from':'idle','to':'pending','trigger':'submit','duration_ms':120,'interrupt':'cancel','reduced_motion':'instant'},
            {'from':'pending','to':'success','trigger':'complete','duration_ms':180,'interrupt':'replace','reduced_motion':'crossfade'}]}
        self.assertEqual([],motion.check(data))
    def test_motion_unreachable_and_missing_reduced_motion(self):
        data={'states':['idle','success'],'initial_state':'idle','required_states':['success'],'transitions':[
            {'from':'idle','to':'idle','trigger':'pulse','duration_ms':100,'interrupt':'reverse'}]}
        errors=motion.check(data)
        self.assertTrue(any('unreachable' in x for x in errors))
        self.assertTrue(any('reduced-motion' in x for x in errors))
    def test_gearing_and_screw_valid(self):
        data={'gears':[{'name':'A','teeth':20,'samples':[{'time':0,'angle':0},{'time':1,'angle':2}]},
                       {'name':'B','teeth':40,'samples':[{'time':0,'angle':1},{'time':1,'angle':0}]}],
              'meshes':[{'driver':'A','driven':'B','type':'external'}],
              'screws':[{'name':'s','pitch_mm':1.5,'starts':2,'handedness':1,'samples':[{'turns':0,'travel_mm':0},{'turns':2,'travel_mm':6}]}]}
        self.assertEqual([],kin.check(data))
    def test_gearing_invalid(self):
        data={'gears':[{'name':'A','teeth':20,'samples':[{'time':0,'angle':0},{'time':1,'angle':2}]},
                       {'name':'B','teeth':40,'samples':[{'time':0,'angle':1},{'time':1,'angle':3}]}],
              'meshes':[{'driver':'A','driven':'B','type':'external'}]}
        self.assertTrue(kin.check(data))
    def test_svg_valid(self):
        self.assertEqual([],svg.check('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect id="r" width="5" height="5"/><use href="#r"/></svg>'))
    def test_svg_invalid_and_duplicate(self):
        errors=svg.check('<svg xmlns="http://www.w3.org/2000/svg"><rect id="x"/><rect id="x"/><use href="#missing"/></svg>')
        self.assertEqual(3,len(errors))
    def test_all_new_skill_references_exist(self):
        catalog=json.loads((ROOT/'catalog.json').read_text())
        additions=['ui-motion-direction','brand-motion-system','motion-choreography-review','lottie-animation-delivery','interactive-isometric-explainer','isometric-svg-geometry-audit','webgl-svg-hybrid-scene','blender-cinematic-video-pipeline','animation-benchmark-isolation','mechanical-animation-kinematics']
        for s in catalog:
            if s['name'] in additions:
                self.assertTrue(s['refs'])
                for rel in s['refs']:
                    self.assertTrue((ROOT/'skills'/s['name']/rel).exists())
        self.assertEqual(10,len(set(additions)))
