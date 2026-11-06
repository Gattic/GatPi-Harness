"""Deterministically create a simple, lit procedural product display in Blender 4.x.

Standalone invocation:
  blender --background --python build_product_stage.py -- \
    --output /tmp/skill-product-stage.blend \
    --render /tmp/skill-product-stage.png \
    --radius 1.5 --height 0.24 --samples 32

The named demo collection is replaced, but unrelated objects/collections are
not deleted. Blender itself is required; this file is not runnable in CPython.
"""
from __future__ import annotations

import argparse
import math
import pathlib
import sys

import bpy
from mathutils import Vector

COLLECTION_NAME = 'SkillFoundry_Procedural_Stage'


def parse_cli() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=pathlib.Path,required=True)
    parser.add_argument('--render',type=pathlib.Path,required=True)
    parser.add_argument('--radius',type=float,default=1.5)
    parser.add_argument('--height',type=float,default=0.24)
    parser.add_argument('--samples',type=int,default=32)
    parser.add_argument('--resolution',type=int,default=800)
    args = parser.parse_args(argv)
    if not 0.25 <= args.radius <= 20.0:
        parser.error('radius must be between 0.25 and 20 meters')
    if not 0.02 <= args.height <= 4.0:
        parser.error('height must be between 0.02 and 4 meters')
    if not 1 <= args.samples <= 512:
        parser.error('samples must be between 1 and 512')
    if not 128 <= args.resolution <= 4096:
        parser.error('resolution must be between 128 and 4096')
    return args


def remove_demo_collection() -> None:
    old = bpy.data.collections.get(COLLECTION_NAME)
    if old is not None:
        for obj in list(old.objects):
            bpy.data.objects.remove(obj,do_unlink=True)
        bpy.data.collections.remove(old)


def new_collection() -> bpy.types.Collection:
    remove_demo_collection()
    col=bpy.data.collections.new(COLLECTION_NAME)
    bpy.context.scene.collection.children.link(col)
    return col


def relocate(obj: bpy.types.Object, col: bpy.types.Collection) -> None:
    for owner in list(obj.users_collection):
        owner.objects.unlink(obj)
    col.objects.link(obj)


def pbr(name: str, rgb: tuple[float,float,float], metallic: float, roughness: float) -> bpy.types.Material:
    mat=bpy.data.materials.new(name)
    mat.use_nodes=True
    node=mat.node_tree.nodes.get('Principled BSDF')
    if node is None:
        raise RuntimeError('Principled BSDF missing in pinned Blender build')
    node.inputs['Base Color'].default_value=(*rgb,1.0)
    node.inputs['Metallic'].default_value=metallic
    node.inputs['Roughness'].default_value=roughness
    return mat


def cylinder(name: str, radius: float, depth: float, z: float,
             mat: bpy.types.Material, collection: bpy.types.Collection, bevel: float) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=radius, depth=depth, location=(0,0,z))
    obj=bpy.context.object
    obj.name=name
    relocate(obj,collection)
    obj.data.materials.append(mat)
    modifier=obj.modifiers.new('Controlled bevel','BEVEL')
    modifier.width=bevel
    modifier.segments=3
    obj.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
    return obj


def add_light(name: str, collection: bpy.types.Collection, location: tuple,
              energy: float, size: float, color: tuple) -> bpy.types.Object:
    data=bpy.data.lights.new(name,'AREA')
    data.energy=energy
    data.shape='DISK'
    data.size=size
    data.color=color
    obj=bpy.data.objects.new(name,data)
    collection.objects.link(obj)
    obj.location=location
    direction=Vector((0,0,0.25))-obj.location
    obj.rotation_euler=direction.to_track_quat('-Z','Y').to_euler()
    return obj


def add_camera(collection: bpy.types.Collection) -> bpy.types.Object:
    data=bpy.data.cameras.new('SkillFoundry Camera')
    obj=bpy.data.objects.new('SkillFoundry Camera',data)
    collection.objects.link(obj)
    obj.location=(5.6,-6.8,5.0)
    point=Vector((0,0,0.45))
    obj.rotation_euler=(point-obj.location).to_track_quat('-Z','Y').to_euler()
    data.type='ORTHO'
    data.ortho_scale=7.8
    return obj


def create_scene(args: argparse.Namespace) -> bpy.types.Collection:
    scene=bpy.context.scene
    scene.unit_settings.system='METRIC'
    scene.unit_settings.scale_length=1.0
    col=new_collection()

    stage_mat=pbr('SF Stage - Brushed graphite',(0.07,0.095,0.11),0.62,0.29)
    accent_mat=pbr('SF Stage - Brushed copper',(0.53,0.23,0.09),0.76,0.22)
    hero_mat=pbr('SF Stage - Ceramic hero',(0.78,0.79,0.73),0.0,0.32)
    ground_mat=pbr('SF Stage - Dark ground',(0.036,0.041,0.05),0.04,0.64)

    base=cylinder('Pedestal - base',args.radius,args.height,args.height/2.0,
                  stage_mat,col,min(0.04,args.height*0.22))
    trim=cylinder('Pedestal - metallic reveal',args.radius*0.986,args.height*0.15,
                  args.height*0.67,accent_mat,col,args.height*0.012)
    second=cylinder('Pedestal - upper',args.radius*0.83,args.height*0.23,
                    args.height*0.97,stage_mat,col,args.height*0.02)

    # Procedural placeholder hero object, fully editable mesh with meaningful scale.
    bpy.ops.mesh.primitive_uv_sphere_add(segments=64,ring_count=32,radius=args.radius*0.52,
                                        location=(0,0,args.height*1.2+args.radius*0.52))
    hero=bpy.context.object
    hero.name='Hero - neutral ceramic sphere'
    relocate(hero,col)
    hero.data.materials.append(hero_mat)
    for polygon in hero.data.polygons:
        polygon.use_smooth=True

    ground=cylinder('Ground - broad disc',args.radius*6,0.075,-0.095,
                    ground_mat,col,0.012)
    add_light('Key - soft neutral',col,(3,-4,7),900,5.0,(1,0.96,0.89))
    add_light('Rim - cool',col,(-3.5,2.5,4.2),1250,3.0,(0.67,0.80,1.0))
    add_light('Fill - warm',col,(1.6,4.0,2.7),450,2.8,(1.0,0.84,0.70))
    scene.camera=add_camera(col)
    scene.render.engine='CYCLES'
    scene.cycles.samples=args.samples
    scene.render.resolution_x=args.resolution
    scene.render.resolution_y=args.resolution
    scene.render.resolution_percentage=100
    scene.render.image_settings.file_format='PNG'
    scene.render.image_settings.color_mode='RGBA'
    scene.render.film_transparent=False
    scene.view_settings.view_transform='AgX'

    # Hard geometry acceptance checks; separate render inspection still required.
    expected={'Pedestal - base','Pedestal - metallic reveal','Pedestal - upper',
              'Hero - neutral ceramic sphere','Ground - broad disc'}
    meshes=[o for o in col.objects if o.type=='MESH']
    assert set(o.name for o in meshes)==expected, 'Unexpected or missing demo mesh objects'
    assert all(len(obj.data.vertices)>0 and len(obj.data.polygons)>0 for obj in meshes)
    assert abs(base.dimensions.x-2.0*args.radius)<1e-3
    assert second.dimensions.z>0.0 and trim.dimensions.z>0.0
    assert math.isfinite(hero.location.z) and hero.location.z>args.height
    return col


def main() -> None:
    args=parse_cli()
    args.output=args.output.expanduser().resolve()
    args.render=args.render.expanduser().resolve()
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.render.parent.mkdir(parents=True,exist_ok=True)
    col=create_scene(args)
    bpy.ops.wm.save_as_mainfile(filepath=str(args.output))
    bpy.context.scene.render.filepath=str(args.render)
    bpy.ops.render.render(write_still=True)
    if not args.output.is_file() or not args.render.is_file():
        raise RuntimeError('Blender save or render did not produce the required files')
    print(f"PASS: {len(col.objects)} demo objects; blend={args.output}; render={args.render}")


if __name__=='__main__':
    main()
