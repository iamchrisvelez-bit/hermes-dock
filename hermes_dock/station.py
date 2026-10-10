"""The Hermes station: central dock, administrator agent and auditors.

The station is the only node connected to every deck. Decks talk to it through
an uplink; they never receive a reference to one another.
"""

from __future__ import annotations

import copy
import json
import uuid
from importlib import resources
from typing import Any

from .agents import TIER_STATION, Agent, AgentSpec, RunResult, Tool, Toolbox
from .auditors import default_auditors
from .deck import MANAGER_TOOLS, WORKER_TOOLS, DeckReport, ObservationDeck, load_spec
from .llm import Backend, make_backend
from .store import StationStore
from .workshop import WORKSHOP_TOOLS, Workshop

# Actions that wait for a human while the station runs supervised.
GATED = {"erase_deck", "external_action"}
REQUIRED_SPEC_KEYS = {"id", "name", "mission", "manager"}
TEMPLATES = ("emittime_lab", "render_lab_3d", "online_sales_lab", "rsps_forge")

HERMES_CORE = """You are Hermes, administrator of the dock. You run every observation deck through its manager.

Your duties:
- Review each deck's reports and the auditors' findings; decide what changes.
- Build, recruit, supplant or retire agents. When an agent underperforms and you can define a better one, supplant it.
- Create, transform (evolve) or erase decks. Erase only when audits show a deck is not viable and transforming it will not fix that.
- Research online when a decision needs outside facts, and write strategy down.
- Learn: after each review, record what you learned so your future self decides better.

Rules you cannot change:
- Decks stay siloed. Never move data between decks or give one deck's agents knowledge of another.
- External actions (spending, publishing, contacting people) and deck erasure go through the approval queue.
- Prefer small, testable changes; say why for every change you make."""


def _validate(spec: dict[str, Any]) -> None:
    missing = REQUIRED_SPEC_KEYS - spec.keys()
    if missing:
        raise ValueError(f"deck spec missing {sorted(missing)}")
    for agent in [spec["manager"], *spec.get("agents", [])]:
        if not isinstance(agent, dict) or not {"name", "role", "brief"} <= agent.keys():
            raise ValueError("every agent needs name, role and brief")


class Station:
    def __init__(self, root: str = ".hermes", backend: Backend | None = None, autonomy: str | None = None,
                 workshop: Workshop | None = None):
        self.store = StationStore(root)
        self.backend = backend or make_backend()
        self.workshop = workshop or Workshop()
        settings = self.store.load_json("settings.json", {"autonomy": "supervised"})
        if autonomy:
            settings["autonomy"] = autonomy
            self.store.save_json("settings.json", settings)
        self.autonomy = settings["autonomy"]
        self.auditors = default_auditors(self.backend)

    # --- decks -----------------------------------------------------------------
    def deck(self, deck_id: str) -> ObservationDeck:
        silo = self.store.silo(deck_id)
        if not silo.exists("spec.json"):
            raise KeyError(f"no deck {deck_id!r}")
        return ObservationDeck(load_spec(silo), silo, self.backend, self._uplink(deck_id), self.workshop)

    def decks(self) -> list[ObservationDeck]:
        return [self.deck(d) for d in self.store.deck_ids()]

    def _uplink(self, deck_id: str):
        def uplink(kind: str, payload: dict[str, Any]) -> str:
            if kind == "report":
                reports = self.store.load_json("reports.json", {})
                reports[deck_id] = payload
                self.store.save_json("reports.json", reports)
                self.store.log("deck_report", deck=deck_id, summary=payload.get("summary", "")[:300])
                return "Report received by Hermes."
            if kind == "external_action":
                ticket = self._gate("external_action", {"deck": deck_id, **payload})
                return ticket
            return f"Unknown uplink message {kind!r}"

        return uplink

    def create_deck(self, spec: dict[str, Any], *, reason: str = "") -> str:
        _validate(spec)
        deck_id = spec["id"]
        if not deck_id.replace("-", "").isalnum():
            raise ValueError("deck id must be letters, digits and dashes")
        silo = self.store.silo(deck_id)
        if silo.exists("spec.json"):
            raise ValueError(f"deck {deck_id!r} already exists")
        spec = {"version": 1, "kpis": [], "guardrails": [], "agents": [], **spec}
        silo.write("spec.json", json.dumps(spec, indent=2))
        silo.write("history/v1.json", json.dumps(spec, indent=2))
        silo.log("deck_created", reason=reason)
        self.store.log("deck_created", deck=deck_id, reason=reason)
        return deck_id

    def transform_deck(self, deck_id: str, changes: dict[str, Any], *, reason: str) -> int:
        silo = self.store.silo(deck_id)
        spec = load_spec(silo)
        new = copy.deepcopy(spec)
        for key, value in changes.items():
            if key in ("id", "version"):
                continue
            new[key] = value
        _validate(new)
        new["version"] = spec.get("version", 1) + 1
        silo.write("spec.json", json.dumps(new, indent=2))
        silo.write(f"history/v{new['version']}.json", json.dumps(new, indent=2))
        silo.log("deck_transformed", version=new["version"], reason=reason, keys=sorted(changes))
        self.store.log("deck_transformed", deck=deck_id, version=new["version"], reason=reason)
        return new["version"]

    def erase_deck(self, deck_id: str, *, reason: str) -> str:
        self.store.silo(deck_id)  # validates the id resolves inside decks/
        if deck_id not in self.store.deck_ids():
            raise KeyError(f"no deck {deck_id!r}")
        dest = self.store.archive_deck(deck_id)
        self.store.log("deck_erased", deck=deck_id, reason=reason, archive=str(dest))
        return f"Deck {deck_id} erased (archived at {dest})."

    def add_canon(self, deck_id: str, name: str, content: str | bytes) -> str:
        """Owner-supplied reference material (text or binary, e.g. design images).
        Agents can read canon but never write it."""
        if deck_id not in self.store.deck_ids():
            raise KeyError(f"no deck {deck_id!r}")
        silo = self.store.silo(deck_id)
        if isinstance(content, bytes):
            silo.write_bytes(f"canon/{name}", content)
        else:
            silo.write(f"canon/{name}", content)
        silo.log("canon_added", name=name, size=len(content))
        self.store.log("canon_added", deck=deck_id, name=name)
        return f"Added canon/{name} to {deck_id}."

    def install_templates(self) -> list[str]:
        made = []
        for name in TEMPLATES:
            spec = json.loads(resources.files("hermes_dock.deck_templates").joinpath(f"{name}.json").read_text())
            if spec["id"] not in self.store.deck_ids():
                made.append(self.create_deck(spec, reason="initial template"))
        return made

    # --- agents ----------------------------------------------------------------
    def recruit_agent(self, deck_id: str, agent: dict[str, Any], *, reason: str) -> str:
        spec = load_spec(self.store.silo(deck_id))
        AgentSpec.from_dict(agent)  # validates shape
        agents = spec.get("agents", [])
        if any(a["name"] == agent["name"] for a in agents) or spec["manager"]["name"] == agent["name"]:
            return f"{agent['name']} already on {deck_id}; use supplant_agent to replace them."
        agents.append({"generation": 1, **agent})
        self.transform_deck(deck_id, {"agents": agents}, reason=f"recruit {agent['name']}: {reason}")
        return f"Recruited {agent['name']} to {deck_id}."

    def supplant_agent(self, deck_id: str, name: str, replacement: dict[str, Any], *, reason: str) -> str:
        spec = load_spec(self.store.silo(deck_id))
        if spec["manager"]["name"] == name:
            gen = spec["manager"].get("generation", 1) + 1
            manager = {**spec["manager"], **replacement, "generation": gen}
            self.transform_deck(deck_id, {"manager": manager}, reason=f"supplant manager {name}: {reason}")
            return f"Manager {name} supplanted by {manager['name']} (generation {gen})."
        agents = spec.get("agents", [])
        for i, a in enumerate(agents):
            if a["name"] == name:
                agents[i] = {**a, **replacement, "generation": a.get("generation", 1) + 1}
                self.transform_deck(deck_id, {"agents": agents}, reason=f"supplant {name}: {reason}")
                return f"{name} supplanted by {agents[i]['name']} (generation {agents[i]['generation']})."
        return f"No agent {name!r} on {deck_id}."

    def retire_agent(self, deck_id: str, name: str, *, reason: str) -> str:
        spec = load_spec(self.store.silo(deck_id))
        agents = [a for a in spec.get("agents", []) if a["name"] != name]
        if len(agents) == len(spec.get("agents", [])):
            return f"No worker {name!r} on {deck_id} (managers are supplanted, not retired)."
        self.transform_deck(deck_id, {"agents": agents}, reason=f"retire {name}: {reason}")
        return f"Retired {name} from {deck_id}."

    # --- approvals -------------------------------------------------------------
    def _gate(self, action: str, payload: dict[str, Any]) -> str:
        if self.autonomy == "autonomous" and action != "external_action":
            return self._execute(action, payload)
        approvals = self.store.load_json("approvals.json", [])
        ticket = {"id": uuid.uuid4().hex[:8], "action": action, "payload": payload, "status": "pending"}
        approvals.append(ticket)
        self.store.save_json("approvals.json", approvals)
        self.store.log("approval_requested", ticket=ticket["id"], action=action)
        return f"Queued for human approval as ticket {ticket['id']}."

    def _execute(self, action: str, payload: dict[str, Any]) -> str:
        if action == "erase_deck":
            return self.erase_deck(payload["deck"], reason=payload.get("reason", ""))
        if action == "external_action":
            # The dock records the decision; the deck carries the action out next cycle.
            self.store.silo(payload["deck"]).log("external_action_approved", action=payload["action"])
            return f"Approved external action for {payload['deck']}: {payload['action']}"
        raise ValueError(action)

    def pending(self) -> list[dict[str, Any]]:
        return [t for t in self.store.load_json("approvals.json", []) if t["status"] == "pending"]

    def decide(self, ticket_id: str, approve: bool) -> str:
        approvals = self.store.load_json("approvals.json", [])
        for t in approvals:
            if t["id"] == ticket_id and t["status"] == "pending":
                t["status"] = "approved" if approve else "rejected"
                self.store.save_json("approvals.json", approvals)
                self.store.log("approval_decided", ticket=ticket_id, status=t["status"])
                if not approve:
                    deck = t["payload"].get("deck")
                    if deck in self.store.deck_ids():
                        self.store.silo(deck).log("external_action_rejected", action=t["payload"].get("action"))
                    return f"Rejected {ticket_id}."
                return self._execute(t["action"], t["payload"])
        return f"No pending ticket {ticket_id!r}."

    # --- auditing & operations ---------------------------------------------------
    def audit(self, deck_id: str | None = None) -> list[dict[str, Any]]:
        ids = self.store.deck_ids()
        findings = []
        for deck_ in (self.deck(d) for d in ([deck_id] if deck_id else ids)):
            others = [d for d in ids if d != deck_.id]
            for auditor in self.auditors:
                try:
                    finding = auditor.audit(deck_, others)
                except Exception as exc:
                    finding = {"deck": deck_.id, "auditor": auditor.name, "score": 0.0,
                               "verdict": "error", "notes": f"{type(exc).__name__}: {exc}"}
                self.store.record_audit(finding)
                findings.append(finding)
        return findings

    def run_cycle(self, deck_id: str, directive: str | None = None) -> DeckReport:
        deck_ = self.deck(deck_id)
        return deck_.run_cycle(directive or deck_.spec.get("standing_directive", "Advance the mission."))

    def health(self) -> dict[str, dict[str, Any]]:
        """Latest score per auditor per deck."""
        out: dict[str, dict[str, Any]] = {d: {} for d in self.store.deck_ids()}
        for f in self.store.audits():
            if f["deck"] in out:
                out[f["deck"]][f["auditor"]] = f["score"]
        return out

    # --- Hermes ----------------------------------------------------------------
    def memory(self) -> dict[str, Any]:
        return self.store.load_json("hermes_memory.json", {"playbook": "", "playbook_version": 0, "lessons": [], "strategy": []})

    def _hermes_context(self) -> str:
        mem = self.memory()
        lessons = "\n".join(f"- {l}" for l in mem["lessons"][-20:]) or "- none yet"
        strategy = "\n".join(f"- {s}" for s in mem["strategy"][-10:]) or "- none yet"
        return (
            f"AUTONOMY: {self.autonomy}\n"
            f"YOUR PLAYBOOK (v{mem['playbook_version']}, written by you):\n{mem['playbook'] or '(empty)'}\n\n"
            f"STRATEGY NOTES:\n{strategy}\n\nLESSONS LEARNED:\n{lessons}"
        )

    def _hermes_toolbox(self) -> Toolbox:
        s = {"type": "string"}
        obj = {"type": "object"}

        def list_decks() -> list[dict[str, Any]]:
            health = self.health()
            return [{"id": d.id, "name": d.spec["name"], "version": d.spec.get("version"),
                     "crew": [a for a in d.worker_specs], "manager": d.manager_spec.name,
                     "health": health.get(d.id, {})} for d in self.decks()]

        def deck_status(deck_id: str) -> dict[str, Any]:
            d = self.deck(deck_id)
            return {"spec": d.spec, "last_report": self.store.load_json("reports.json", {}).get(deck_id),
                    "recent_audits": self.store.audits(deck_id)[-8:], "artifacts": d.silo.list("artifacts"),
                    "recent_ledger": d.silo.ledger()[-15:]}

        def run_deck_cycle(deck_id: str, directive: str) -> dict[str, Any]:
            r = self.run_cycle(deck_id, directive)
            return {"summary": r.summary, "kpis": r.kpis, "needs": r.needs}

        def run_audits(deck_id: str) -> list[dict[str, Any]]:
            return self.audit(deck_id)

        def create_deck(spec: dict[str, Any], reason: str) -> str:
            return f"Created deck {self.create_deck(spec, reason=reason)}."

        def transform_deck(deck_id: str, changes: dict[str, Any], reason: str) -> str:
            return f"{deck_id} is now v{self.transform_deck(deck_id, changes, reason=reason)}."

        def erase_deck(deck_id: str, reason: str) -> str:
            return self._gate("erase_deck", {"deck": deck_id, "reason": reason})

        def recruit_agent(deck_id: str, agent: dict[str, Any], reason: str) -> str:
            return self.recruit_agent(deck_id, agent, reason=reason)

        def supplant_agent(deck_id: str, name: str, replacement: dict[str, Any], reason: str) -> str:
            return self.supplant_agent(deck_id, name, replacement, reason=reason)

        def retire_agent(deck_id: str, name: str, reason: str) -> str:
            return self.retire_agent(deck_id, name, reason=reason)

        def record_learning(kind: str, text: str) -> str:
            mem = self.memory()
            if kind == "playbook":
                mem["playbook"], mem["playbook_version"] = text, mem["playbook_version"] + 1
            elif kind in ("lessons", "strategy"):
                mem[kind].append(text)
            else:
                return "kind must be lessons, strategy or playbook"
            self.store.save_json("hermes_memory.json", mem)
            self.store.log("hermes_learned", kind=kind, text=text[:300])
            return f"Recorded {kind}."

        agent_schema = {"type": "object", "properties": {
            "name": s, "role": s, "brief": s, "effort": {"type": "string", "enum": ["low", "medium", "high", "xhigh"]},
            "tools": {"type": "array", "items": {"type": "string",
                                                 "enum": sorted(set(WORKER_TOOLS + MANAGER_TOOLS + WORKSHOP_TOOLS))}}},
            "required": ["name", "role", "brief"]}
        return Toolbox([
            Tool("list_decks", "List every deck with crew and latest audit scores.", {"properties": {}}, list_decks),
            Tool("deck_status", "Full status for one deck: spec, last report, audits, artifacts, ledger.",
                 {"properties": {"deck_id": s}, "required": ["deck_id"]}, deck_status),
            Tool("run_deck_cycle", "Have a deck's manager run one operating cycle on a directive.",
                 {"properties": {"deck_id": s, "directive": s}, "required": ["deck_id", "directive"]}, run_deck_cycle),
            Tool("run_audits", "Run every station auditor against one deck now.",
                 {"properties": {"deck_id": s}, "required": ["deck_id"]}, run_audits),
            Tool("create_deck", "Code a new observation deck. spec needs id, name, mission, manager "
                 "{name, role, brief}; optional kpis [{name, target}], guardrails [str], agents [agent], "
                 "standing_directive.", {"properties": {"spec": obj, "reason": s}, "required": ["spec", "reason"]},
                 create_deck),
            Tool("transform_deck", "Evolve a deck: replace top-level spec fields (mission, kpis, guardrails, "
                 "agents, manager, standing_directive). Versioned; history kept.",
                 {"properties": {"deck_id": s, "changes": obj, "reason": s},
                  "required": ["deck_id", "changes", "reason"]}, transform_deck),
            Tool("erase_deck", "Erase a deck (archived first). Goes through the approval queue when supervised.",
                 {"properties": {"deck_id": s, "reason": s}, "required": ["deck_id", "reason"]}, erase_deck),
            Tool("recruit_agent", "Build a new worker agent and add it to a deck's crew.",
                 {"properties": {"deck_id": s, "agent": agent_schema, "reason": s},
                  "required": ["deck_id", "agent", "reason"]}, recruit_agent),
            Tool("supplant_agent", "Replace an underperforming agent (worker or manager) with a better definition.",
                 {"properties": {"deck_id": s, "name": s, "replacement": obj, "reason": s},
                  "required": ["deck_id", "name", "replacement", "reason"]}, supplant_agent),
            Tool("retire_agent", "Remove a worker agent from a deck.",
                 {"properties": {"deck_id": s, "name": s, "reason": s}, "required": ["deck_id", "name", "reason"]},
                 retire_agent),
            Tool("record_learning", "Write to your own memory. kind=lessons|strategy appends; kind=playbook "
                 "replaces your operating playbook with an improved version.",
                 {"properties": {"kind": {"type": "string", "enum": ["lessons", "strategy", "playbook"]}, "text": s},
                  "required": ["kind", "text"]}, record_learning),
        ])

    @property
    def hermes_spec(self) -> AgentSpec:
        tools = self._hermes_toolbox().names()
        return AgentSpec("hermes", "hermes-admin", HERMES_CORE, tier=TIER_STATION, tools=tools, effort="high")

    def hermes(self, instruction: str, *, web: bool = True) -> RunResult:
        agent = Agent(self.hermes_spec, self.backend, self._hermes_toolbox(), self._hermes_context())
        result = agent.run(instruction, web=web)
        self.store.log("hermes_run", instruction=instruction[:300], steps=result.steps,
                       tools=[t["tool"] for t in result.tool_log])
        return result

    def review(self) -> RunResult:
        """Hermes' standing review: audit, read reports, act, learn."""
        self.audit()
        return self.hermes(
            "Run your standing review. For every deck: read its status and audit findings, decide whether "
            "to run a cycle, transform the deck, recruit or supplant agents, or (only if unviable) erase it. "
            "Research online if a decision needs outside facts. Finish by recording at least one lesson, "
            "and rewrite your playbook if what you learned changes how you should operate."
        )
