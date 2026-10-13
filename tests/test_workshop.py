"""Workshop tools for the render lab: Blender scripts, viewport renders, images."""
import json
import os
import sys

import pytest
from PIL import Image

from hermes_dock.agents import Content
from hermes_dock.cli import main as cli_main
from hermes_dock.llm import OfflineBackend
from hermes_dock.station import Station
from hermes_dock.store import SiloBreach
from hermes_dock.workshop import Workshop

# A Python with bpy for the real-Blender tests (skipped when absent).
BPY = os.environ.get("HERMES_TEST_BLENDER_PYTHON", "")

CUBE_SCRIPT = """
import os
assert 'ANTHROPIC_API_KEY' not in os.environ, 'secrets must not reach scripts'
out = os.environ['HERMES_OUTPUT_DIR']
v = [(x, y, z) for x in (0, 1) for y in (0, 1) for z in (0, 1)]
f = [(1,2,4,3),(5,7,8,6),(1,5,6,2),(3,4,8,7),(1,3,7,5),(2,6,8,4)]
with open(os.path.join(out, 'crate.obj'), 'w') as o:
    o.writelines('v %d %d %d\\n' % p for p in v)
    o.writelines('f %d %d %d %d\\n' % q for q in f)
print('built crate')
"""

BPY_SCRIPT = """
import os, bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.4, depth=1.2)
bpy.ops.export_scene.gltf(filepath=os.path.join(os.environ['HERMES_OUTPUT_DIR'], 'barrel.glb'))
print('exported barrel')
"""


@pytest.fixture
def station(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "must-not-leak")
    st = Station(str(tmp_path / "state"), backend=OfflineBackend(),
                 workshop=Workshop(blender_python=BPY or sys.executable))
    st.install_templates()
    return st


def test_only_render_lab_gets_workshop_tools(station):
    assert station.store.deck_ids() == ["emittime-lab", "online-sales-lab", "render-lab-3d"]
    crew = station.deck("render-lab-3d").worker_specs
    assert {"run_blender_script", "render_viewport", "view_image"} <= set(crew["procedural-modeler"].tools)
    assert {"render_viewport", "view_image"} <= set(crew["render-qa"].tools)
    assert "run_blender_script" not in crew["render-qa"].tools  # QA judges, it does not build
    assert "run_blender_script" not in crew["demand-scout"].tools
    for other in ("emittime-lab", "online-sales-lab"):
        for spec in station.deck(other).worker_specs.values():
            assert not {"run_blender_script", "render_viewport"} & set(spec.tools)


def test_run_script_collects_outputs_without_secrets(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "must-not-leak")
    st = Station(str(tmp_path / "s"), backend=OfflineBackend(), workshop=Workshop(blender_python=sys.executable))
    st.install_templates()
    silo = st.deck("render-lab-3d").silo
    silo.write("artifacts/scripts/crate.py", CUBE_SCRIPT)
    r = st.workshop.run_blender_script(silo, "scripts/crate.py")
    assert r["returncode"] == 0, r["stderr"]
    assert r["outputs"] == ["builds/crate/crate.obj"] and "built crate" in r["stdout"]
    assert silo.ledger()[-1]["event"] == "blender_run"


def test_failures_timeouts_and_bad_inputs(tmp_path):
    st = Station(str(tmp_path / "s"), backend=OfflineBackend(), workshop=Workshop(blender_python=sys.executable))
    st.install_templates()
    silo = st.deck("render-lab-3d").silo
    silo.write("artifacts/bad.py", "raise SystemExit('boom')")
    assert st.workshop.run_blender_script(silo, "bad.py")["returncode"] != 0
    silo.write("artifacts/slow.py", "import time; time.sleep(5)")
    r = st.workshop.run_blender_script(silo, "slow.py", timeout=0.5)
    assert r["returncode"] == -1 and "timed out" in r["stderr"]
    assert "error" in st.workshop.run_blender_script(silo, "missing.py")
    silo.write("artifacts/quiet.py", "print('nothing exported')")
    assert "hint" in st.workshop.run_blender_script(silo, "quiet.py")
    silo.write("artifacts/notes.txt", "x")
    assert "not a model" in st.workshop.render_viewport(silo, "notes.txt")["error"]
    silo.write("artifacts/m.obj", "v 0 0 0\n")
    assert "unknown view" in st.workshop.render_viewport(silo, "m.obj", ["upside_down"])["error"]


def test_paths_cannot_escape_the_silo(station):
    silo = station.deck("render-lab-3d").silo
    with pytest.raises(SiloBreach):
        station.workshop.run_blender_script(silo, "../../../station/approvals.json")
    with pytest.raises(SiloBreach):
        station.workshop.render_viewport(silo, "../../emittime-lab/spec.json")
    with pytest.raises(SiloBreach):
        station.workshop.view_image(silo, "canon/../../emittime-lab/spec.json")


def test_unconfigured_workshop_explains_itself(tmp_path, monkeypatch):
    monkeypatch.delenv("HERMES_BLENDER_PYTHON", raising=False)
    st = Station(str(tmp_path / "s"), backend=OfflineBackend(), workshop=Workshop(blender_python=""))
    st.install_templates()
    silo = st.deck("render-lab-3d").silo
    silo.write("artifacts/a.py", "print(1)")
    assert "HERMES_BLENDER_PYTHON" in st.workshop.run_blender_script(silo, "a.py")["error"]
    assert "HERMES_BLENDER_PYTHON" in st.workshop.render_viewport(silo, "a.glb")["error"]


def test_images_reach_the_agent_as_images(station):
    deck = station.deck("render-lab-3d")
    p = deck.silo.root / "canon" / "ref.png"
    p.parent.mkdir(parents=True)
    Image.new("RGB", (40, 50), (220, 170, 60)).save(p)
    out = station.workshop.view_image(deck.silo, "canon/ref.png")
    assert isinstance(out, Content) and out[1]["type"] == "image"
    station.backend.script = {
        "deck-manager": [{"tool": "assign_task", "input": {"agent": "render-qa", "task": "look at ref"}}, "done"],
        "technical-qa": [{"tool": "view_image", "input": {"path": "canon/ref.png"}}, "looked"],
    }
    station.run_cycle("render-lab-3d")
    assert any(isinstance(b, dict) and b.get("type") == "tool_result" and isinstance(b.get("content"), list)
               for c in station.backend.calls for m in c["messages"] if isinstance(m.get("content"), list)
               for b in m["content"])


def test_binary_canon_via_cli(tmp_path):
    root = tmp_path / "state"
    st = Station(str(root), backend=OfflineBackend())
    st.install_templates()
    src = tmp_path / "refs"
    src.mkdir()
    Image.new("RGB", (8, 8), (1, 2, 3)).save(src / "concept.png")
    (src / "brief.md").write_text("low-poly barrel")
    assert cli_main(["--root", str(root), "--offline", "canon", "render-lab-3d", str(src)]) == 0
    silo = st.store.silo("render-lab-3d")
    assert silo.read_bytes("canon/concept.png")[:4] == b"\x89PNG"
    assert silo.read("canon/brief.md") == "low-poly barrel"


@pytest.mark.skipif(not BPY, reason="set HERMES_TEST_BLENDER_PYTHON to a Python with bpy")
def test_real_blender_build_and_viewport_cycle(station):
    station.backend.script = {
        "deck-manager": [
            {"tool": "assign_task", "input": {"agent": "procedural-modeler", "task": "build the barrel"}},
            {"tool": "assign_task", "input": {"agent": "render-qa", "task": "QA the barrel"}},
            {"tool": "report_to_hermes", "input": {"summary": "barrel built and reviewed"}},
            "done"],
        "blender-scripter": [
            {"tool": "write_artifact", "input": {"path": "scripts/barrel.py", "content": BPY_SCRIPT}},
            {"tool": "run_blender_script", "input": {"script": "scripts/barrel.py", "timeout": 300}},
            "built"],
        "technical-qa": [
            {"tool": "render_viewport", "input": {"model": "builds/barrel/barrel.glb", "size": 96, "samples": 2}},
            "reviewed"],
    }
    assert station.run_cycle("render-lab-3d").summary == "barrel built and reviewed"
    silo = station.deck("render-lab-3d").silo
    stats = json.loads(silo.read("artifacts/renders/barrel/stats.json"))
    assert stats["triangles"] == 28  # 8-sided cylinder: 16 side + 2x6 cap triangles
    assert stats["non_manifold_edges"] == 0
    assert abs(stats["dimensions"][2] - 1.2) < 1e-3
    for v in ("front", "three_quarter", "side", "back"):
        assert Image.open(silo.root / f"artifacts/renders/barrel/{v}.png").size == (96, 96)
    assert Image.open(silo.root / "artifacts/renders/barrel/viewport.png").size == (384, 96)
