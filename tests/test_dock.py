import json

import pytest

from hermes_dock.llm import OfflineBackend
from hermes_dock.station import Station
from hermes_dock.store import SiloBreach


@pytest.fixture
def station(tmp_path):
    st = Station(str(tmp_path / "state"), backend=OfflineBackend())
    st.install_templates()
    return st


def test_init_installs_three_siloed_decks(station):
    assert station.store.deck_ids() == ["emittime-lab", "online-sales-lab", "render-lab-3d"]
    for deck in station.decks():
        assert deck.manager_spec.tier == 1
        assert all(w.tier == 2 for w in deck.worker_specs.values())


def test_silo_blocks_escape(station):
    silo = station.deck("render-lab-3d").silo
    for path in ("../online-sales-lab/spec.json", "../../station/approvals.json", "/etc/passwd"):
        with pytest.raises(SiloBreach):
            silo.read(path)


def test_cycle_manager_delegates_worker_writes_and_reports(station):
    station.backend.script = {
        "deck-manager": [
            {"tool": "assign_task", "input": {"agent": "demand-scout", "task": "rank categories"}},
            {"tool": "report_to_hermes", "input": {"summary": "demand list done", "kpis": {"assets_passing_qa_per_cycle": 0}}},
            "cycle finished",
        ],
        "market-scout": [
            {"tool": "write_artifact", "input": {"path": "demand.md", "content": "1. low-poly props"}},
            "saved demand list",
        ],
    }
    report = station.run_cycle("render-lab-3d")
    deck = station.deck("render-lab-3d")
    assert report.summary == "demand list done"
    assert deck.silo.read("artifacts/demand.md") == "1. low-poly props"
    assert station.store.load_json("reports.json", {})["render-lab-3d"]["summary"] == "demand list done"
    # Nothing leaked into the other decks.
    assert station.deck("online-sales-lab").silo.list() == []


def test_worker_cannot_use_manager_tools(station):
    station.backend.script = {
        "deck-manager": [{"tool": "assign_task", "input": {"agent": "market-researcher", "task": "x"}}, "done"],
        "product-research": [{"tool": "assign_task", "input": {"agent": "offer-builder", "task": "y"}}, "tried"],
    }
    station.run_cycle("online-sales-lab")
    tasks = [e for e in station.deck("online-sales-lab").silo.ledger() if e["event"] == "task_done"]
    assert [t["agent"] for t in tasks] == ["market-researcher"]


def test_external_action_is_gated(station):
    station.backend.script = {
        "deck-manager": [{"tool": "assign_task", "input": {"agent": "offer-builder", "task": "publish"}}, "done"],
        "listing-copywriter": [
            {"tool": "request_external_action", "input": {"action": "publish listing", "details": "etsy"}},
            "waiting",
        ],
    }
    station.run_cycle("online-sales-lab")
    [ticket] = station.pending()
    assert ticket["action"] == "external_action" and ticket["payload"]["deck"] == "online-sales-lab"
    station.decide(ticket["id"], approve=True)
    events = [e["event"] for e in station.deck("online-sales-lab").silo.ledger()]
    assert "external_action_approved" in events
    assert station.pending() == []


def test_hermes_creates_transforms_supplants_and_learns(station):
    new_deck = {"id": "test-deck", "name": "Test", "mission": "m",
                "manager": {"name": "tm", "role": "deck-manager", "brief": "b"}}
    station.backend.script = {"hermes-admin": [
        {"tool": "create_deck", "input": {"spec": new_deck, "reason": "trial"}},
        {"tool": "recruit_agent", "input": {"deck_id": "test-deck", "reason": "need help",
                                            "agent": {"name": "w1", "role": "worker", "brief": "do"}}},
        {"tool": "supplant_agent", "input": {"deck_id": "test-deck", "name": "w1", "reason": "weak",
                                             "replacement": {"brief": "do better"}}},
        {"tool": "transform_deck", "input": {"deck_id": "test-deck", "changes": {"mission": "m2"}, "reason": "pivot"}},
        {"tool": "record_learning", "input": {"kind": "playbook", "text": "audit before acting"}},
        "done",
    ]}
    result = station.hermes("set up a test deck", web=False)
    assert not any(t["error"] for t in result.tool_log), result.tool_log
    spec = station.deck("test-deck").spec
    assert spec["mission"] == "m2" and spec["version"] == 4
    assert spec["agents"][0]["brief"] == "do better" and spec["agents"][0]["generation"] == 2
    assert station.deck("test-deck").silo.exists("history/v1.json")
    assert station.memory()["playbook"] == "audit before acting"
    assert "audit before acting" in station._hermes_context()


def test_erase_requires_approval_when_supervised(station):
    station.backend.script = {"hermes-admin": [
        {"tool": "erase_deck", "input": {"deck_id": "emittime-lab", "reason": "unviable"}}, "queued"]}
    station.hermes("erase emittime", web=False)
    assert "emittime-lab" in station.store.deck_ids()
    [ticket] = station.pending()
    station.decide(ticket["id"], approve=True)
    assert "emittime-lab" not in station.store.deck_ids()
    assert any((station.store.station / "archive").iterdir())


def test_erase_runs_directly_when_autonomous(tmp_path):
    st = Station(str(tmp_path / "s"), backend=OfflineBackend(), autonomy="autonomous")
    st.install_templates()
    st.backend.script = {"hermes-admin": [
        {"tool": "erase_deck", "input": {"deck_id": "render-lab-3d", "reason": "x"}}, "ok"]}
    st.hermes("erase", web=False)
    assert "render-lab-3d" not in st.store.deck_ids()


def test_audits_cover_every_deck_and_flag_cross_deck_leaks(station):
    station.deck("render-lab-3d").silo.write("artifacts/leak.md", "copied from online-sales-lab")
    findings = station.audit()
    assert {f["deck"] for f in findings} == set(station.store.deck_ids())
    silo = next(f for f in findings if f["deck"] == "render-lab-3d" and f["auditor"] == "silo-integrity")
    assert silo["score"] < 1 and "online-sales-lab" in silo["notes"]
    assert set(station.health()["render-lab-3d"]) == {"silo-integrity", "operations", "viability", "adversarial"}


def test_create_deck_rejects_bad_ids(station):
    with pytest.raises(ValueError):
        station.create_deck({"id": "../escape", "name": "x", "mission": "x",
                             "manager": {"name": "m", "role": "r", "brief": "b"}})


def test_claude_backend_request_shape():
    from types import SimpleNamespace as NS

    from hermes_dock.llm import ClaudeBackend

    sent = {}

    class Messages:
        def create(self, **kw):
            sent.update(kw)
            return NS(content=[NS(type="text", text="hi"),
                               NS(type="tool_use", id="t1", name="log_note", input={"note": "n"})],
                      stop_reason="tool_use", usage=NS(input_tokens=1, output_tokens=2))

    backend = ClaudeBackend(client=NS(beta=NS(messages=Messages())))
    step = backend.step(system="s", messages=[{"role": "user", "content": "x"}], tools=[], effort="high", web=True)
    assert sent["model"] == "claude-opus-5-5"
    assert sent["thinking"] == {"type": "adaptive"} and sent["output_config"] == {"effort": "high"}
    assert sent["fallbacks"] == "default" and sent["betas"] == ["server-side-fallback-2026-07-01"]
    assert sent["tools"][-1]["type"] == "web_search_20260209"
    assert step.text == "hi" and step.tool_calls[0].name == "log_note"


def test_canon_is_readable_but_not_writable_by_agents(station):
    station.add_canon("emittime-lab", "emittime.md", "The twin suns never set.")
    station.backend.script = {
        "deck-manager": [{"tool": "assign_task", "input": {"agent": "lore-keeper", "task": "index canon"}}, "done"],
        "canon-archivist": [
            {"tool": "read_canon", "input": {"name": "emittime.md"}},
            {"tool": "write_artifact", "input": {"path": "bible/world.md", "content": "Twin suns (canon)"}},
            "indexed",
        ],
    }
    station.run_cycle("emittime-lab")
    deck = station.deck("emittime-lab")
    assert "CANON: 1" in deck._context()
    assert deck.silo.read("artifacts/bible/world.md") == "Twin suns (canon)"
    assert deck.silo.read("canon/emittime.md") == "The twin suns never set."
    assert "canon/" not in "".join(deck.silo.list("artifacts"))
    with pytest.raises(KeyError):
        station.add_canon("no-such-deck", "x.md", "x")
