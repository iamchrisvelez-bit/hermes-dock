"""Viewport renderer, executed *inside* Blender's Python (bpy) by the workshop.

    <blender-python> blender_render.py <model> <out_dir> <views,comma,separated> <size> <samples>

Imports the model into an empty scene, frames an orthographic camera on it
for each requested view, renders with Cycles on the CPU (works headless,
without a GPU or display) and writes <out_dir>/<view>.png plus
<out_dir>/stats.json with geometry facts for QA (triangles, dimensions,
non-manifold edges, materials).

Blender's convention is Z up with the front facing -Y; glTF imports are
converted to it automatically.
"""
import json
import math
import os
import sys

import bpy  # must come first: the pip build of Blender provides bmesh/mathutils once bpy is loaded
import bmesh  # noqa: E402
from mathutils import Vector  # noqa: E402

# camera direction (from the model toward the camera) per view
VIEWS = {
    "front": Vector((0, -1, 0)),
    "back": Vector((0, 1, 0)),
    "side": Vector((1, 0, 0)),          # = right
    "right": Vector((1, 0, 0)),
    "left": Vector((-1, 0, 0)),
    "top": Vector((0, -0.01, 1)),
    "bottom": Vector((0, -0.01, -1)),
    "three_quarter": Vector((0.75, -1, 0.55)),          # front-right, from above
    "three_quarter_left": Vector((-0.75, -1, 0.55)),    # front-left, from above
    "back_three_quarter": Vector((0.75, 1, 0.55)),      # back-right, from above
    "back_three_quarter_left": Vector((-0.75, 1, 0.55)),
}
# every direction: the six axes and the four upper diagonals
ALL_VIEWS = ["front", "back", "left", "right", "top", "bottom", "three_quarter", "three_quarter_left",
             "back_three_quarter", "back_three_quarter_left"]


def import_model(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif ext == ".ply":
        bpy.ops.wm.ply_import(filepath=path)
    elif ext == ".stl":
        bpy.ops.wm.stl_import(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".blend":
        with bpy.data.libraries.load(path) as (src, dst):
            dst.objects = src.objects
        for o in dst.objects:
            if o is not None:
                bpy.context.scene.collection.objects.link(o)
    else:
        raise SystemExit("unsupported model format %r (glb, gltf, obj, ply, stl, fbx, blend)" % ext)


def stats(meshes):
    tris, nonmanifold, loose, mats = 0, 0, 0, set()
    lo, hi = Vector((1e18,) * 3), Vector((-1e18,) * 3)
    deps = bpy.context.evaluated_depsgraph_get()
    for o in meshes:
        me = o.evaluated_get(deps).to_mesh()
        me.calc_loop_triangles()
        tris += len(me.loop_triangles)
        bm = bmesh.new()
        bm.from_mesh(me)
        # importers split vertices at hard edges / UV seams; weld them first so
        # only real holes and fins count as non-manifold
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
        nonmanifold += sum(1 for e in bm.edges if not e.is_manifold)
        # loose parts: connected pieces of geometry (a stray triangle shows up here)
        seen, parts = set(), 0
        for v in bm.verts:
            if v.index in seen:
                continue
            parts += 1
            stack = [v]
            seen.add(v.index)
            while stack:
                for e in stack.pop().link_edges:
                    for w in e.verts:
                        if w.index not in seen:
                            seen.add(w.index)
                            stack.append(w)
        loose += parts
        bm.free()
        for v in me.vertices:
            w = o.matrix_world @ v.co
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
        mats |= {m.name for m in o.data.materials if m}
        o.evaluated_get(deps).to_mesh_clear()
    return {"objects": len(meshes), "triangles": tris, "non_manifold_edges": nonmanifold, "loose_parts": loose,
            "dimensions": [round(x, 4) for x in (hi - lo)], "bounds_min": [round(x, 4) for x in lo],
            "bounds_max": [round(x, 4) for x in hi], "materials": sorted(mats)}, lo, hi


def main():
    model, out_dir, views, size, samples = sys.argv[1], sys.argv[2], sys.argv[3].split(","), int(sys.argv[4]), \
        int(sys.argv[5])
    if views == ["all"]:
        views = ALL_VIEWS
    os.makedirs(out_dir, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    import_model(model)
    sc = bpy.context.scene
    meshes = [o for o in sc.objects if o.type == "MESH"]
    if not meshes:
        raise SystemExit("the model contains no mesh objects")
    info, lo, hi = stats(meshes)
    centre, ext = (lo + hi) / 2, max((hi - lo).length, 1e-6)

    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.16, 0.17, 0.19, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.9
    sc.world = world
    for name, rot, energy in (("key", (math.radians(50), 0, math.radians(-35)), 3.5),
                              ("fill", (math.radians(65), 0, math.radians(140)), 1.2)):
        light = bpy.data.objects.new(name, bpy.data.lights.new(name, "SUN"))
        light.data.energy = energy
        light.rotation_euler = rot
        sc.collection.objects.link(light)

    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = ext * 1.15
    cam.data.clip_end = ext * 20
    sc.collection.objects.link(cam)
    sc.camera = cam
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.cycles.use_denoising = False
    sc.render.resolution_x = sc.render.resolution_y = size
    sc.render.film_transparent = False
    sc.view_settings.view_transform = "Standard"

    written = []
    for view in views:
        d = VIEWS.get(view)
        if d is None:
            raise SystemExit("unknown view %r (use %s)" % (view, ", ".join(VIEWS)))
        cam.location = centre + d.normalized() * ext * 3
        cam.rotation_euler = (centre - cam.location).to_track_quat("-Z", "Y").to_euler()
        sc.render.filepath = os.path.join(out_dir, view + ".png")
        bpy.ops.render.render(write_still=True)
        written.append(view + ".png")
    info["views"] = written
    with open(os.path.join(out_dir, "stats.json"), "w") as f:
        json.dump(info, f, indent=1)
    print("rendered", ", ".join(written))


if __name__ == "__main__":
    main()
