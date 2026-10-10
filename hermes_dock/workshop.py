"""Deck workshop: real tools for 3D decks.

Gives deck agents the ability to *execute* what they write instead of only
saving it:

  run_blender_script  run a Blender Python script from the deck's artifacts
                      with Blender's Python (bpy) and collect what it exports
  convert_to_rs       turn an exported model into verified RuneScape model
                      files (+ preview and inventory sprite) with the RSPS
                      pipeline's stage 3
  view_image          show an image (a canon design, a preview render) to the
                      agent as an image, so it can compare by eye

Configuration (environment, all optional; a tool reports clearly when its
piece is missing):
  HERMES_BLENDER_PYTHON  interpreter with bpy installed (e.g. the RSPS repo's
                         .venv-blender/bin/python)
  HERMES_RSPS_DIR        path to the RSPS---reimagined checkout
  HERMES_WORKSHOP_TIMEOUT  default seconds per script (300)

Isolation: scripts run with the run folder inside the deck silo as their
working directory and HOME, a minimal environment (no API keys or other
secrets are passed through), and a timeout. They are still ordinary Python
processes, not a sandbox: only grant these tools to decks you trust, as you
would any build script.
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from .agents import Content, Tool
from .store import DeckSilo

WORKSHOP_TOOLS = ["run_blender_script", "convert_to_rs", "view_image"]
RS_SLOTS = ["head", "body", "legs", "feet", "hands", "cape", "neck", "shield", "weapon"]
_TAIL = 2500


def _tail(text: str) -> str:
    return text if len(text) <= _TAIL else "...\n" + text[-_TAIL:]


def _safe_name(path: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", Path(path).stem)[:60] or "run"


class Workshop:
    def __init__(self, blender_python: str | None = None, rsps_dir: str | None = None, timeout: float | None = None):
        self.blender_python = blender_python or os.environ.get("HERMES_BLENDER_PYTHON") or ""
        self.rsps_dir = rsps_dir or os.environ.get("HERMES_RSPS_DIR") or ""
        self.timeout = float(timeout or os.environ.get("HERMES_WORKSHOP_TIMEOUT") or 300)

    # --- helpers -----------------------------------------------------------------
    def _env(self, run_dir: Path, silo: DeckSilo) -> dict[str, str]:
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(run_dir),
            "LANG": "C.UTF-8",
            "HERMES_OUTPUT_DIR": str(run_dir / "out"),
            "HERMES_CANON_DIR": str(silo.root / "canon"),
            "HERMES_ARTIFACTS_DIR": str(silo.root / "artifacts"),
        }
        if self.rsps_dir:
            rs = Path(self.rsps_dir).resolve()
            env["HERMES_RSPS_DIR"] = str(rs)
            env["PYTHONPATH"] = os.pathsep.join([str(rs), str(rs / "pipeline")])
        return env

    def status(self) -> dict[str, Any]:
        return {"blender_python": self.blender_python or None, "rsps_dir": self.rsps_dir or None,
                "timeout_s": self.timeout}

    # --- tools -------------------------------------------------------------------
    def run_blender_script(self, silo: DeckSilo, script: str, timeout: float | None = None) -> dict[str, Any]:
        if not self.blender_python:
            return {"error": "workshop has no Blender: set HERMES_BLENDER_PYTHON to a Python with bpy installed"}
        src = silo._resolve(f"artifacts/{script}")
        if not src.is_file():
            return {"error": f"no script artifacts/{script}; save it with write_artifact first"}
        name = _safe_name(script)
        run_dir = silo._resolve(f"workshop/runs/{time.strftime('%Y%m%d-%H%M%S')}-{name}")
        (run_dir / "out").mkdir(parents=True, exist_ok=True)
        shutil.copy(src, run_dir / "script.py")
        t0 = time.monotonic()
        try:
            proc = subprocess.run([self.blender_python, str(run_dir / "script.py")], cwd=run_dir,
                                  env=self._env(run_dir, silo), capture_output=True, text=True,
                                  timeout=float(timeout or self.timeout))
            code, out, err = proc.returncode, proc.stdout, proc.stderr
        except subprocess.TimeoutExpired as e:
            partial = e.stdout.decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
            code, out, err = -1, partial, f"timed out after {timeout or self.timeout:.0f}s"
        produced = []
        dest_rel = f"artifacts/builds/{name}"
        for f in sorted((run_dir / "out").rglob("*")):
            if f.is_file():
                rel = f.relative_to(run_dir / "out")
                silo.write_bytes(f"{dest_rel}/{rel}", f.read_bytes())
                produced.append(f"builds/{name}/{rel}")
        silo.log("blender_run", script=script, returncode=code, outputs=produced,
                 seconds=round(time.monotonic() - t0, 2))
        result = {"returncode": code, "outputs": produced, "stdout": _tail(out), "stderr": _tail(err)}
        if code == 0 and not produced:
            result["hint"] = "the script ran but exported nothing: write .glb/.obj files into os.environ['HERMES_OUTPUT_DIR']"
        return result

    def convert_to_rs(self, silo: DeckSilo, model: str, slot: str, max_faces: int = 2400,
                      up: str = "y", forward: str = "z") -> dict[str, Any]:
        if not self.rsps_dir:
            return {"error": "workshop has no RSPS pipeline: set HERMES_RSPS_DIR to the RSPS---reimagined checkout"}
        stage3 = Path(self.rsps_dir) / "pipeline" / "stage3_models_to_rs.py"
        if not stage3.is_file():
            return {"error": f"{stage3} not found"}
        if slot not in RS_SLOTS:
            return {"error": f"slot must be one of {RS_SLOTS}"}
        src = silo._resolve(f"artifacts/{model}")
        if not src.is_file():
            return {"error": f"no model artifacts/{model}"}
        name = _safe_name(model)
        out_rel = f"artifacts/rs/{name}"
        out_dir = silo._resolve(out_rel)
        out_dir.mkdir(parents=True, exist_ok=True)
        proc = subprocess.run([sys.executable, str(stage3), "--in", str(src), "--slot", slot, "--out", str(out_dir),
                               "--max-faces", str(int(max_faces)), "--up", up, "--forward", forward],
                              capture_output=True, text=True, timeout=self.timeout)
        if proc.returncode != 0:
            silo.log("rs_convert_failed", model=model)
            return {"error": "stage 3 failed", "stderr": _tail(proc.stderr)}
        report = json.loads((out_dir / "report.json").read_text())
        entry = report[0] if report else {}
        files = [str(p.relative_to(silo.root / "artifacts")) for p in sorted(out_dir.rglob("*")) if p.is_file()]
        silo.log("rs_converted", model=model, slot=slot, faces=entry.get("faces"))
        return {"verified": True, "report": entry, "files": files,
                "preview": next((f for f in files if f.endswith("preview.png")), None),
                "note": "verified = encoded, decoded again and matched exactly"}

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
        buf = io.BytesIO()
        im.save(buf, "PNG")
        return Content([
            {"type": "text", "text": f"{rel} ({im.width}x{im.height})"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                         "data": base64.b64encode(buf.getvalue()).decode("ascii")}},
        ])

    def tools(self, silo: DeckSilo) -> list[Tool]:
        s = {"type": "string"}
        return [
            Tool("run_blender_script",
                 "Run a Blender Python script you saved in artifacts/ (bpy available) and collect the files it "
                 "writes to os.environ['HERMES_OUTPUT_DIR'] into artifacts/builds/<script>/. Design images are "
                 "under os.environ['HERMES_CANON_DIR']. With the RSPS pipeline configured, `import blender_mold` "
                 "and `import rsgen` work too. Returns exit code, outputs, stdout/stderr tails.",
                 {"properties": {"script": s, "timeout": {"type": "number"}}, "required": ["script"]},
                 lambda script, timeout=None: self.run_blender_script(silo, script, timeout)),
            Tool("convert_to_rs",
                 "Convert an exported model (artifacts path, .glb/.obj/.ply) into verified RuneScape model files "
                 "with preview.png and sprite.png, fitted to an equipment slot.",
                 {"properties": {"model": s, "slot": {"type": "string", "enum": RS_SLOTS},
                                 "max_faces": {"type": "integer"}, "up": s, "forward": s},
                  "required": ["model", "slot"]},
                 lambda model, slot, max_faces=2400, up="y", forward="z":
                     self.convert_to_rs(silo, model, slot, max_faces, up, forward)),
            Tool("view_image",
                 "Look at an image: a design in canon/ (e.g. canon/B14_3/color.png) or a render in artifacts/ "
                 "(e.g. rs/<name>/<name>/preview.png).",
                 {"properties": {"path": s}, "required": ["path"]},
                 lambda path: self.view_image(silo, path)),
        ]
