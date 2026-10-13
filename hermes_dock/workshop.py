"""Deck workshop: let 3D decks execute and inspect their work.

Tools (granted per agent in the deck spec; Hermes can grant them too):

  run_blender_script  run a Blender Python script from the deck's artifacts
                      with real Blender (bpy) and collect what it exports
  render_viewport     render a model from several angles in Blender and return
                      the images plus geometry stats (triangles, dimensions,
                      non-manifold edges), so QA can judge what was built
  view_image          show any image in the silo to the agent as an image

Configuration (environment; each tool explains itself if its part is missing):
  HERMES_BLENDER_PYTHON    interpreter with bpy installed (pip install bpy)
  HERMES_WORKSHOP_TIMEOUT  default seconds per Blender process (300)

Isolation: each run gets its own folder inside the deck silo as working
directory and HOME, a minimal environment (no API keys or other secrets are
passed through) and a timeout. Scripts are still ordinary Python processes,
not a sandbox: only grant these tools to decks you trust, as you would any
build script.
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

from .agents import Content, Tool
from .store import DeckSilo

WORKSHOP_TOOLS = ["run_blender_script", "render_viewport", "view_image"]
VIEWS = ["front", "back", "left", "right", "top", "bottom", "three_quarter", "three_quarter_left",
         "back_three_quarter", "back_three_quarter_left", "side"]
ALL_VIEWS = VIEWS[:10]  # every direction: six axes + four upper diagonals
MODEL_EXTS = (".glb", ".gltf", ".obj", ".ply", ".stl", ".fbx", ".blend")
_TAIL = 2500
_RENDER_SCRIPT = Path(__file__).with_name("blender_render.py")


def _tail(text: str) -> str:
    return text if len(text) <= _TAIL else "...\n" + text[-_TAIL:]


def _safe_name(path: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", Path(path).stem)[:60] or "run"


def _png_block(img) -> dict[str, Any]:
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                        "data": base64.b64encode(buf.getvalue()).decode("ascii")}}


class Workshop:
    def __init__(self, blender_python: str | None = None, timeout: float | None = None):
        self.blender_python = blender_python or os.environ.get("HERMES_BLENDER_PYTHON") or ""
        self.timeout = float(timeout or os.environ.get("HERMES_WORKSHOP_TIMEOUT") or 300)

    def _env(self, run_dir: Path, silo: DeckSilo) -> dict[str, str]:
        return {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(run_dir),
            "LANG": "C.UTF-8",
            "HERMES_OUTPUT_DIR": str(run_dir / "out"),
            "HERMES_CANON_DIR": str(silo.root / "canon"),
            "HERMES_ARTIFACTS_DIR": str(silo.root / "artifacts"),
        }

    def _run(self, args: list[str], run_dir: Path, silo: DeckSilo, timeout: float | None) -> tuple[int, str, str]:
        try:
            p = subprocess.run([self.blender_python, *args], cwd=run_dir, env=self._env(run_dir, silo),
                               capture_output=True, text=True, timeout=float(timeout or self.timeout))
            return p.returncode, p.stdout, p.stderr
        except subprocess.TimeoutExpired as e:
            partial = e.stdout.decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
            return -1, partial, f"timed out after {timeout or self.timeout:.0f}s"

    def _no_blender(self) -> dict[str, str] | None:
        if not self.blender_python:
            return {"error": "workshop has no Blender: set HERMES_BLENDER_PYTHON to a Python with bpy installed "
                             "(pip install bpy)"}
        return None

    # --- tools -------------------------------------------------------------------
    def run_blender_script(self, silo: DeckSilo, script: str, timeout: float | None = None) -> dict[str, Any]:
        if (err := self._no_blender()):
            return err
        src = silo._resolve(f"artifacts/{script}")
        if not src.is_file():
            return {"error": f"no script artifacts/{script}; save it with write_artifact first"}
        name = _safe_name(script)
        run_dir = silo._resolve(f"workshop/runs/{time.strftime('%Y%m%d-%H%M%S')}-{name}")
        (run_dir / "out").mkdir(parents=True, exist_ok=True)
        shutil.copy(src, run_dir / "script.py")
        t0 = time.monotonic()
        code, out, err = self._run([str(run_dir / "script.py")], run_dir, silo, timeout)
        produced = []
        for f in sorted((run_dir / "out").rglob("*")):
            if f.is_file():
                rel = f.relative_to(run_dir / "out")
                silo.write_bytes(f"artifacts/builds/{name}/{rel}", f.read_bytes())
                produced.append(f"builds/{name}/{rel}")
        silo.log("blender_run", script=script, returncode=code, outputs=produced,
                 seconds=round(time.monotonic() - t0, 2))
        result = {"returncode": code, "outputs": produced, "stdout": _tail(out), "stderr": _tail(err)}
        if code == 0 and not produced:
            result["hint"] = ("the script ran but exported nothing: write model files (.glb/.obj/...) into "
                              "os.environ['HERMES_OUTPUT_DIR']")
        return result

    def render_viewport(self, silo: DeckSilo, model: str, views: list[str] | None = None, size: int = 384,
                        samples: int = 16) -> Content | dict[str, Any]:
        from PIL import Image

        if (err := self._no_blender()):
            return err
        src = silo._resolve(f"artifacts/{model}")
        if not src.is_file():
            return {"error": f"no model artifacts/{model}"}
        if src.suffix.lower() not in MODEL_EXTS:
            return {"error": f"not a model file; use one of {', '.join(MODEL_EXTS)}"}
        views = views or ["front", "three_quarter", "side", "back"]
        if views == ["all"]:
            views = list(ALL_VIEWS)
        bad = [v for v in views if v not in VIEWS]
        if bad:
            return {"error": f"unknown view(s) {bad}; choose from {VIEWS}"}
        size, samples = max(64, min(int(size), 1024)), max(1, min(int(samples), 128))
        name = _safe_name(model)
        run_dir = silo._resolve(f"workshop/renders/{time.strftime('%Y%m%d-%H%M%S')}-{name}")
        (run_dir / "out").mkdir(parents=True, exist_ok=True)
        t0 = time.monotonic()
        code, out, err = self._run([str(_RENDER_SCRIPT), str(src), str(run_dir / "out"), ",".join(views),
                                    str(size), str(samples)], run_dir, silo, None)
        stats_path = run_dir / "out" / "stats.json"
        if code != 0 or not stats_path.exists():
            silo.log("viewport_failed", model=model, returncode=code)
            return {"error": "viewport render failed", "returncode": code, "stderr": _tail(err),
                    "stdout": _tail(out)}
        stats = json.loads(stats_path.read_text())
        dest = f"artifacts/renders/{name}"
        tiles, saved = [], []
        for v in views:
            png = run_dir / "out" / f"{v}.png"
            silo.write_bytes(f"{dest}/{v}.png", png.read_bytes())
            saved.append(f"renders/{name}/{v}.png")
            tiles.append(Image.open(png).convert("RGB"))
        cols = min(5, len(tiles))
        rows = (len(tiles) + cols - 1) // cols
        sheet = Image.new("RGB", (size * cols, size * rows), (20, 20, 24))
        for i, t in enumerate(tiles):
            sheet.paste(t, ((i % cols) * size, (i // cols) * size))
        buf = io.BytesIO()
        sheet.save(buf, "PNG")
        silo.write_bytes(f"{dest}/viewport.png", buf.getvalue())
        silo.write(f"{dest}/stats.json", json.dumps(stats, indent=1))
        silo.log("viewport_rendered", model=model, views=views, triangles=stats.get("triangles"),
                 seconds=round(time.monotonic() - t0, 2))
        summary = (f"{model}: views {', '.join(views)} (left to right, top to bottom). "
                   f"triangles={stats['triangles']}, loose_parts={stats.get('loose_parts')}, "
                   f"dimensions={stats['dimensions']}, non_manifold_edges={stats['non_manifold_edges']}, "
                   f"objects={stats['objects']}, materials={stats['materials']}. "
                   f"Saved {', '.join(saved)} and renders/{name}/viewport.png.")
        sheet.thumbnail((1536, 1536))
        return Content([{"type": "text", "text": summary}, _png_block(sheet)])

    def view_image(self, silo: DeckSilo, path: str, max_side: int = 768) -> Content | dict[str, Any]:
        from PIL import Image

        rel = path if path.startswith(("canon/", "artifacts/")) else f"artifacts/{path}"
        p = silo._resolve(rel)
        if not p.is_file():
            return {"error": f"no image {rel}"}
        im = Image.open(p)
        im.thumbnail((max_side, max_side))
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA")
        return Content([{"type": "text", "text": f"{rel} ({im.width}x{im.height})"}, _png_block(im)])

    def tools(self, silo: DeckSilo) -> list[Tool]:
        s = {"type": "string"}
        return [
            Tool("run_blender_script",
                 "Run a Blender Python script you saved in artifacts/ with real Blender (import bpy works) and "
                 "collect the files it writes to os.environ['HERMES_OUTPUT_DIR'] into artifacts/builds/<script>/. "
                 "Reference files are under os.environ['HERMES_CANON_DIR']. Returns exit code, outputs, "
                 "stdout/stderr tails.",
                 {"properties": {"script": s, "timeout": {"type": "number"}}, "required": ["script"]},
                 lambda script, timeout=None: self.run_blender_script(silo, script, timeout)),
            Tool("render_viewport",
                 "Render a model in artifacts/ (.glb/.gltf/.obj/.ply/.stl/.fbx/.blend) in Blender from several "
                 "angles and look at it, with geometry stats for QA: triangle count, loose parts, dimensions "
                 "in Blender units, non-manifold edges, materials. views: any of the listed directions, or "
                 "[\"all\"] for every direction (six axes + four upper diagonals).",
                 {"properties": {"model": s,
                                 "views": {"type": "array", "items": {"type": "string", "enum": VIEWS + ["all"]}},
                                 "size": {"type": "integer"}, "samples": {"type": "integer"}},
                  "required": ["model"]},
                 lambda model, views=None, size=384, samples=16:
                     self.render_viewport(silo, model, views, size, samples)),
            Tool("view_image",
                 "Look at an image in this deck: canon/<file> or an artifact (e.g. renders/<model>/front.png).",
                 {"properties": {"path": s}, "required": ["path"]},
                 lambda path: self.view_image(silo, path)),
        ]
