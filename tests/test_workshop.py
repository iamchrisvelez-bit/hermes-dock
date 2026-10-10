"""Workshop tools: running Blender scripts, RS conversion, images for agents."""
import json
import os
import sys
from pathlib import Path

import pytest
from PIL import Image

from hermes_dock.agents import Content
from hermes_dock.cli import main as cli_main
from hermes_dock.llm import OfflineBackend
from hermes_dock.station import Station
from hermes_dock.store import SiloBreach
from hermes_dock.workshop import Workshop

RSPS = os.environ.get("HERMES_RSPS_DIR") or "/home/user/rsps---reimagined"
HAS_RSPS = (Path(RSPS) / "pipeline" / "stage3_models_to_rs.py").is_file()

CUBE_SCRIPT = """
import os
assert 'ANTHROPIC_API_KEY' not in os.environ, 'secrets must not reach scripts'
out = os.environ['HERMES_OUTPUT_DIR']
v = [(x, y, z) for x in (0, 10) for y in (0, 10) for z in (0, 10)]
f = [(1,3,4,2),(5,6,8,7),(1,2,6,5),(3,7,8,4),(1,5,7,3),(2,4,8,6)]
with open(os.path.join(out, 'cube.mtl'), 'w') as m:
    m.write('newmtl red\\nKd 0.8 0.1 0.1\\n')
with open(os.path.join(out, 'cube.obj'), 'w') as o:
    o.write('mtllib cube.mtl\\nusemtl red\\n')
    o.writelines('v %d %d %d\\n' % p for p in v)
    o.writelines('f %d %d %d %d\\n' % q for q in f)
print('built cube')
"""


@pytest.fixture
def station(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "must-not-leak")
    ws = Workshop(blender_python=sys.executable, rsps_dir=RSPS if HAS_RSPS else "")
    st = Station(str(tmp_path / "state"), backend=OfflineBackend(), workshop=ws)
    st.install_templates()
    return st


def test_forge_deck_installed_with_scoped_tools(station):
    deck = station.deck("rsps-forge")
    crew = deck.worker_specs
    assert "run_blender_script" in crew["procedural-modeler"].tools
    assert "convert_to_rs" in crew["procedural-modeler"].tools
    assert "run_blender_script" not in crew["render-qa"].tools  # QA judges; it does not build
    assert "run_blender_script" not in deck.manager_spec.tools


def test_run_script_collects_outputs_without_secrets(station):
    deck = station.deck("rsps-forge")
    deck.silo.write("artifacts/scripts/cube.py", CUBE_SCRIPT)
    r = station.workshop.run_blender_script(deck.silo, "scripts/cube.py")
    assert r["returncode"] == 0, r["stderr"]
    assert "built cube" in r["stdout"]
    assert sorted(r["outputs"]) == ["builds/cube/cube.mtl", "builds/cube/cube.obj"]
    assert deck.silo.exists("artifacts/builds/cube/cube.obj")
    assert deck.silo.ledger()[-1]["event"] == "blender_run"


def test_failures_and_timeouts_are_reported(station):
    silo = station.deck("rsps-forge").silo
    silo.write("artifacts/bad.py", "raise SystemExit('boom')")
    assert station.workshop.run_blender_script(silo, "bad.py")["returncode"] != 0
    silo.write("artifacts/slow.py", "import time; time.sleep(5)")
    r = station.workshop.run_blender_script(silo, "slow.py", timeout=0.5)
    assert r["returncode"] == -1 and "timed out" in r["stderr"]
    assert "error" in station.workshop.run_blender_script(silo, "missing.py")
    silo.write("artifacts/quiet.py", "print('nothing exported')")
    assert "hint" in station.workshop.run_blender_script(silo, "quiet.py")


def test_paths_cannot_escape_the_silo(station):
    silo = station.deck("rsps-forge").silo
    with pytest.raises(SiloBreach):
        station.workshop.run_blender_script(silo, "../../../station/approvals.json")
    with pytest.raises(SiloBreach):
        station.workshop.view_image(silo, "canon/../../emittime-lab/spec.json")


def test_unconfigured_workshop_explains_itself(tmp_path):
    st = Station(str(tmp_path / "s"), backend=OfflineBackend(), workshop=Workshop(blender_python="", rsps_dir=""))
    st.install_templates()
    silo = st.deck("rsps-forge").silo
    silo.write("artifacts/a.py", "print(1)")
    assert "HERMES_BLENDER_PYTHON" in st.workshop.run_blender_script(silo, "a.py")["error"]
    silo.write("artifacts/m.obj", "v 0 0 0\n")
    assert "HERMES_RSPS_DIR" in st.workshop.convert_to_rs(silo, "m.obj", "shield")["error"]


def test_view_image_reaches_the_agent_as_an_image(station):
    deck = station.deck("rsps-forge")
    p = deck.silo.root / "canon" / "B14_3" / "color.png"
    p.parent.mkdir(parents=True)
    Image.new("RGBA", (40, 50), (220, 170, 60, 255)).save(p)
    out = station.workshop.view_image(deck.silo, "canon/B14_3/color.png")
    assert isinstance(out, Content) and out[1]["type"] == "image"
    station.backend.script = {
        "deck-manager": [{"tool": "assign_task", "input": {"agent": "asset-designer", "task": "spec B14_3"}},
                         "done"],
        "concept-and-spec": [{"tool": "view_image", "input": {"path": "canon/B14_3/color.png"}}, "looked"],
    }
    station.run_cycle("rsps-forge")
    sent = [c for c in station.backend.calls if any(
        isinstance(m.get("content"), list) and any(isinstance(b, dict) and b.get("type") == "tool_result"
                                                     and isinstance(b.get("content"), list) for b in m["content"])
        for m in c["messages"])]
    assert sent, "the image tool result should be passed to the model as content blocks"


def test_binary_canon_via_cli(tmp_path):
    root = tmp_path / "state"
    st = Station(str(root), backend=OfflineBackend())
    st.install_templates()
    src = tmp_path / "designs" / "B01_1"
    src.mkdir(parents=True)
    Image.new("RGB", (8, 8), (1, 2, 3)).save(src / "color.png")
    (src / "meta.json").write_text(json.dumps({"code": "B01_1", "slot": "body"}))
    assert cli_main(["--root", str(root), "--offline", "canon", "rsps-forge", str(tmp_path / "designs")]) == 0
    silo = st.store.silo("rsps-forge")
    assert silo.read_bytes("canon/B01_1/color.png")[:4] == b"\x89PNG"
    assert json.loads(silo.read("canon/B01_1/meta.json"))["slot"] == "body"


@pytest.mark.skipif(not HAS_RSPS, reason="RSPS---reimagined checkout not available")
def test_full_forge_cycle_builds_and_converts(station):
    station.backend.script = {
        "deck-manager": [
            {"tool": "assign_task", "input": {"agent": "procedural-modeler", "task": "build the cube test item"}},
            {"tool": "report_to_hermes", "input": {"summary": "1 model built and verified",
                                                    "kpis": {"designs_passing_qa_per_cycle": 1}}},
            "cycle done",
        ],
        "blender-scripter": [
            {"tool": "write_artifact", "input": {"path": "scripts/cube.py", "content": CUBE_SCRIPT}},
            {"tool": "run_blender_script", "input": {"script": "scripts/cube.py"}},
            {"tool": "convert_to_rs", "input": {"model": "builds/cube/cube.obj", "slot": "shield"}},
            "built and converted",
        ],
    }
    report = station.run_cycle("rsps-forge")
    assert report.summary == "1 model built and verified"
    silo = station.deck("rsps-forge").silo
    files = silo.list("artifacts/rs")
    assert any(f.endswith(".dat") for f in files) and any(f.endswith("preview.png") for f in files)
    rep = json.loads(silo.read(next(f for f in files if f.endswith("report.json"))))
    assert rep[0]["slot"] == "shield" and rep[0]["faces"] == 12
