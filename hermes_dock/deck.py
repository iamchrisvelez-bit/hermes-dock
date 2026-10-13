"""Observation decks: one siloed project, one manager, a crew of workers.

A deck has no handle on any other deck. Its only way out is the ``uplink``
the station hands it, which carries reports and external-action requests to
Hermes. Everything it writes lands in its own ``DeckSilo``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable

from .agents import TIER_MANAGER, TIER_WORKER, Agent, AgentSpec, Tool, Toolbox
from .llm import Backend
from .store import DeckSilo
from .workshop import Workshop

WORKER_TOOLS = ["list_canon", "read_canon", "write_artifact", "read_artifact", "list_artifacts", "log_note", "request_external_action"]
MANAGER_TOOLS = ["list_canon", "read_canon", "assign_task", "write_artifact", "read_artifact", "list_artifacts", "log_note", "report_to_hermes"]

Uplink = Callable[[str, dict[str, Any]], str]
"""``uplink(kind, payload)`` -> acknowledgement from the station."""


@dataclass
class DeckReport:
    deck: str
    summary: str
    kpis: dict[str, Any]
    needs: list[str]
    manager_output: str


class ObservationDeck:
    def __init__(self, spec: dict[str, Any], silo: DeckSilo, backend: Backend, uplink: Uplink,
                 workshop: Workshop | None = None):
        self.spec = spec
        self.silo = silo
        self.backend = backend
        self._uplink = uplink
        self.workshop = workshop or Workshop()
        self._report: DeckReport | None = None

    @property
    def id(self) -> str:
        return self.spec["id"]

    @property
    def manager_spec(self) -> AgentSpec:
        spec = AgentSpec.from_dict(self.spec["manager"])
        spec.tier, spec.tools = TIER_MANAGER, spec.tools or MANAGER_TOOLS
        return spec

    @property
    def worker_specs(self) -> dict[str, AgentSpec]:
        out = {}
        for raw in self.spec.get("agents", []):
            spec = AgentSpec.from_dict(raw)
            spec.tier, spec.tools = TIER_WORKER, spec.tools or WORKER_TOOLS
            out[spec.name] = spec
        return out

    def _context(self) -> str:
        kpis = "\n".join(f"- {k['name']}: target {k['target']}" for k in self.spec.get("kpis", []))
        rails = "\n".join(f"- {g}" for g in self.spec.get("guardrails", []))
        canon = self.silo.list("canon")
        canon_note = (
            f"CANON: {len(canon)} owner-supplied reference document(s) — read them with read_canon; "
            "they override anything you or your crew have proposed."
            if canon else "CANON: none supplied yet."
        )
        return (
            f"DECK: {self.spec['name']} (v{self.spec.get('version', 1)})\n"
            f"MISSION: {self.spec['mission']}\n"
            f"KPIs:\n{kpis or '- none set'}\n"
            f"GUARDRAILS:\n{rails or '- none set'}\n"
            f"{canon_note}\n"
            "You work only inside this deck. You cannot see or contact any other deck. "
            "Anything that touches the outside world (spending, publishing, contacting people) "
            "must go through request_external_action and wait for approval."
        )

    # --- tools ---------------------------------------------------------------
    def _toolbox(self) -> Toolbox:
        silo = self.silo

        def write_artifact(path: str, content: str) -> str:
            silo.write(f"artifacts/{path}", content)
            silo.log("artifact_written", path=path, chars=len(content))
            return f"saved artifacts/{path}"

        def read_artifact(path: str) -> str:
            return silo.read(f"artifacts/{path}")

        def list_canon() -> list[str]:
            return [p.removeprefix("canon/") for p in silo.list("canon")]

        def read_canon(name: str) -> str:
            raw = silo.read_bytes(f"canon/{name}")
            try:
                return raw.decode("utf-8")
            except UnicodeDecodeError:
                return (f"canon/{name} is a binary file ({len(raw)} bytes), not text. If it is an image, "
                        f"look at it with view_image('canon/{name}'); Blender scripts can open it from "
                        "os.environ['HERMES_CANON_DIR'].")

        def list_artifacts() -> list[str]:
            return silo.list("artifacts")

        def log_note(note: str) -> str:
            silo.log("note", note=note)
            return "logged"

        def request_external_action(action: str, details: str) -> str:
            silo.log("external_action_requested", action=action)
            return self._uplink("external_action", {"action": action, "details": details})

        def assign_task(agent: str, task: str) -> str:
            workers = self.worker_specs
            if agent not in workers:
                return f"No agent named {agent!r} on this deck. Crew: {', '.join(workers) or 'none'}"
            result = Agent(workers[agent], self.backend, toolbox, self._context()).run(task)
            silo.log("task_done", agent=agent, task=task[:200], steps=result.steps)
            return result.text or "(no text output)"

        def report_to_hermes(summary: str, kpis: dict[str, Any] | None = None, needs: list[str] | None = None) -> str:
            self._report = DeckReport(self.id, summary, kpis or {}, needs or [], "")
            return self._uplink("report", {"summary": summary, "kpis": kpis or {}, "needs": needs or []})

        str_prop = {"type": "string"}
        toolbox = Toolbox(
            [
                Tool("list_canon", "List the owner-supplied reference documents (read-only source of truth).",
                     {"properties": {}}, list_canon),
                Tool("read_canon", "Read one owner-supplied reference document.",
                     {"properties": {"name": str_prop}, "required": ["name"]}, read_canon),
                Tool("write_artifact", "Save a work product inside this deck's silo.",
                     {"properties": {"path": str_prop, "content": str_prop}, "required": ["path", "content"]},
                     write_artifact),
                Tool("read_artifact", "Read a work product from this deck's silo.",
                     {"properties": {"path": str_prop}, "required": ["path"]}, read_artifact),
                Tool("list_artifacts", "List this deck's work products.", {"properties": {}}, list_artifacts),
                Tool("log_note", "Record an observation in the deck ledger.",
                     {"properties": {"note": str_prop}, "required": ["note"]}, log_note),
                Tool("request_external_action",
                     "Ask the station for approval to act outside the deck (spend, publish, contact).",
                     {"properties": {"action": str_prop, "details": str_prop}, "required": ["action", "details"]},
                     request_external_action),
                Tool("assign_task", "Hand a task to one of your crew and get their result.",
                     {"properties": {"agent": str_prop, "task": str_prop}, "required": ["agent", "task"]},
                     assign_task),
                *self.workshop.tools(silo),
                Tool("report_to_hermes", "File this cycle's report with the Hermes administrator.",
                     {"properties": {"summary": str_prop,
                                     "kpis": {"type": "object"},
                                     "needs": {"type": "array", "items": str_prop}},
                      "required": ["summary"]},
                     report_to_hermes),
            ]
        )
        return toolbox

    # --- operations ------------------------------------------------------------
    def run_cycle(self, directive: str) -> DeckReport:
        """Run one operating cycle: the manager plans, delegates and reports."""
        self._report = None
        crew = "\n".join(f"- {s.name}: {s.role}" for s in self.worker_specs.values())
        task = (
            f"Directive from Hermes: {directive}\n\nYour crew:\n{crew or '- (no crew yet)'}\n\n"
            "Plan the cycle, delegate with assign_task, save results as artifacts, "
            "then call report_to_hermes exactly once with a summary, KPI readings and needs."
        )
        result = Agent(self.manager_spec, self.backend, self._toolbox(), self._context()).run(task)
        self.silo.log("cycle_complete", directive=directive[:200], steps=result.steps)
        report = self._report or DeckReport(self.id, result.text, {}, [], "")
        report.manager_output = result.text
        return report

    def probe(self, agent_name: str, prompt: str) -> str:
        """Used by auditors: put one prompt to a named agent, no tools."""
        specs = {self.manager_spec.name: self.manager_spec, **self.worker_specs}
        spec = specs[agent_name]
        bare = AgentSpec(spec.name, spec.role, spec.brief, spec.tier, [], spec.effort, spec.generation)
        return Agent(bare, self.backend, Toolbox(), self._context()).run(prompt).text


def load_spec(silo: DeckSilo) -> dict[str, Any]:
    return json.loads(silo.read("spec.json"))
