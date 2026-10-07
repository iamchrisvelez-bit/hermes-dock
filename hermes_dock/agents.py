"""Agent runtime: a spec, a scoped toolbox, and a tool-use loop.

Tiers:
    0  Hermes administrator (station)
    0  Auditors (station, report only to Hermes)
    1  Deck manager (one per deck, reports to Hermes)
    2  Deck workers (report to their manager)
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Any, Callable

from .llm import Backend

TIER_STATION = 0
TIER_MANAGER = 1
TIER_WORKER = 2

MAX_STEPS = 12


@dataclass
class AgentSpec:
    name: str
    role: str
    brief: str
    tier: int = TIER_WORKER
    tools: list[str] = field(default_factory=list)
    effort: str = "medium"
    # Bumped every time Hermes rewrites or supplants this agent.
    generation: int = 1

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AgentSpec":
        known = {k: data[k] for k in cls.__dataclass_fields__ if k in data}
        return cls(**known)


@dataclass
class Tool:
    name: str
    description: str
    schema: dict[str, Any]
    fn: Callable[..., Any]

    def definition(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": {"type": "object", "additionalProperties": False, **self.schema},
        }


class Toolbox:
    def __init__(self, tools: list[Tool] | None = None):
        self._tools = {t.name: t for t in tools or []}

    def add(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def scoped(self, names: list[str]) -> "Toolbox":
        return Toolbox([self._tools[n] for n in names if n in self._tools])

    def names(self) -> list[str]:
        return list(self._tools)

    def definitions(self) -> list[dict[str, Any]]:
        return [t.definition() for t in self._tools.values()]

    def call(self, name: str, args: dict[str, Any]) -> tuple[str, bool]:
        tool = self._tools.get(name)
        if tool is None:
            return f"Unknown or unpermitted tool: {name}", True
        try:
            result = tool.fn(**args)
        except Exception as exc:  # surfaced to the model as a tool error
            return f"{type(exc).__name__}: {exc}", True
        return result if isinstance(result, str) else json.dumps(result, default=str), False


@dataclass
class RunResult:
    text: str
    steps: int
    tool_log: list[dict[str, Any]]
    stop_reason: str


class Agent:
    def __init__(self, spec: AgentSpec, backend: Backend, toolbox: Toolbox, context: str = ""):
        self.spec = spec
        self.backend = backend
        self.toolbox = toolbox.scoped(spec.tools)
        self.context = context

    @property
    def system(self) -> str:
        tools = ", ".join(self.toolbox.names()) or "none"
        return (
            f"ROLE: {self.spec.role}\n"
            f"NAME: {self.spec.name}\n"
            f"TIER: {self.spec.tier}\n\n"
            f"{self.spec.brief}\n\n"
            f"{self.context}\n\n"
            f"Tools available to you: {tools}. Use only these; you have no other access."
        ).strip()

    def run(self, task: str, *, web: bool = False, system_suffix: str = "") -> RunResult:
        system = self.system + (f"\n\n{system_suffix}" if system_suffix else "")
        messages: list[dict[str, Any]] = [{"role": "user", "content": task}]
        tool_log: list[dict[str, Any]] = []
        step = None
        for n in range(1, MAX_STEPS + 1):
            step = self.backend.step(
                system=system,
                messages=messages,
                tools=self.toolbox.definitions(),
                effort=self.spec.effort,
                web=web,
            )
            messages.append({"role": "assistant", "content": step.assistant_content})
            if step.stop_reason == "pause_turn":
                continue
            if step.stop_reason != "tool_use" or not step.tool_calls:
                return RunResult(step.text, n, tool_log, step.stop_reason)
            results = []
            for call in step.tool_calls:
                output, is_error = self.toolbox.call(call.name, call.input)
                tool_log.append({"tool": call.name, "input": call.input, "error": is_error})
                results.append(
                    {"type": "tool_result", "tool_use_id": call.id, "content": output, "is_error": is_error}
                )
            messages.append({"role": "user", "content": results})
        return RunResult(step.text if step else "", MAX_STEPS, tool_log, "max_steps")


def parse_json(text: str) -> dict[str, Any]:
    """Pull the first JSON object out of a model reply."""
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return {}
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return {}
