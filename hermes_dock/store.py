"""On-disk state: the station's own records and one sealed silo per deck.

Layout under the state root (default ``./.hermes``)::

    station/
        hermes_memory.json     lessons, strategy, playbook revisions
        approvals.json         actions waiting on a human
        audit_log.jsonl        every auditor finding
        ledger.jsonl           station-level event log
        archive/<deck>-<ts>/   erased decks are archived here first
    decks/<deck_id>/
        spec.json              current deck definition (versioned in history/)
        history/               every previous spec, for evolution lineage
        ledger.jsonl           this deck's events
        artifacts/             this deck's work product

A ``DeckSilo`` can only read and write inside its own ``decks/<deck_id>``
directory; anything else raises ``SiloBreach``.
"""

from __future__ import annotations

import json
import shutil
import time
from pathlib import Path
from typing import Any


class SiloBreach(PermissionError):
    """A deck tried to reach outside its silo."""


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _append_jsonl(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        f.write(json.dumps({"at": _now(), **record}) + "\n")


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


class DeckSilo:
    def __init__(self, root: Path, deck_id: str):
        self.deck_id = deck_id
        self.root = (root / "decks" / deck_id).resolve()

    def _resolve(self, rel: str) -> Path:
        path = (self.root / rel).resolve()
        if path != self.root and self.root not in path.parents:
            raise SiloBreach(f"deck {self.deck_id!r} cannot access {rel!r}")
        return path

    def write(self, rel: str, content: str) -> Path:
        path = self._resolve(rel)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        return path

    def read(self, rel: str) -> str:
        return self._resolve(rel).read_text()

    def exists(self, rel: str) -> bool:
        return self._resolve(rel).exists()

    def list(self, rel: str = "artifacts") -> list[str]:
        base = self._resolve(rel)
        if not base.exists():
            return []
        return sorted(str(p.relative_to(self.root)) for p in base.rglob("*") if p.is_file())

    def log(self, event: str, **data: Any) -> None:
        _append_jsonl(self._resolve("ledger.jsonl"), {"event": event, **data})

    def ledger(self) -> list[dict[str, Any]]:
        return _read_jsonl(self._resolve("ledger.jsonl"))


class StationStore:
    def __init__(self, root: str | Path = ".hermes"):
        self.root = Path(root).resolve()
        self.station = self.root / "station"
        self.station.mkdir(parents=True, exist_ok=True)
        (self.root / "decks").mkdir(parents=True, exist_ok=True)

    # --- decks -------------------------------------------------------------
    def silo(self, deck_id: str) -> DeckSilo:
        return DeckSilo(self.root, deck_id)

    def deck_ids(self) -> list[str]:
        return sorted(p.name for p in (self.root / "decks").iterdir() if (p / "spec.json").exists())

    def archive_deck(self, deck_id: str) -> Path:
        src = self.root / "decks" / deck_id
        dest = self.station / "archive" / f"{deck_id}-{int(time.time())}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), dest)
        return dest

    # --- station records ---------------------------------------------------
    def log(self, event: str, **data: Any) -> None:
        _append_jsonl(self.station / "ledger.jsonl", {"event": event, **data})

    def ledger(self) -> list[dict[str, Any]]:
        return _read_jsonl(self.station / "ledger.jsonl")

    def record_audit(self, finding: dict[str, Any]) -> None:
        _append_jsonl(self.station / "audit_log.jsonl", finding)

    def audits(self, deck_id: str | None = None) -> list[dict[str, Any]]:
        rows = _read_jsonl(self.station / "audit_log.jsonl")
        return [r for r in rows if deck_id is None or r.get("deck") == deck_id]

    def load_json(self, name: str, default: Any) -> Any:
        path = self.station / name
        return json.loads(path.read_text()) if path.exists() else default

    def save_json(self, name: str, data: Any) -> None:
        (self.station / name).write_text(json.dumps(data, indent=2))
