"""Model backends.

Every agent in the dock thinks through a ``Backend``. The default is Claude via
the Anthropic SDK; ``OfflineBackend`` is a deterministic stand-in used by tests
and dry runs so the whole station can be exercised without an API key.

A different brain (for example a self-hosted Nous Research Hermes model) can be
plugged in by implementing ``Backend.step``.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Protocol

DEFAULT_MODEL = os.environ.get("HERMES_DOCK_MODEL", "claude-opus-5-5")

# Anthropic-hosted web search; used by Hermes for online research.
WEB_SEARCH_TOOL = {"type": "web_search_20260209", "name": "web_search", "max_uses": 5}


@dataclass
class ToolCall:
    id: str
    name: str
    input: dict[str, Any]


@dataclass
class Step:
    """One model turn, normalised across backends."""

    text: str
    tool_calls: list[ToolCall]
    stop_reason: str
    # Content to append verbatim as the assistant turn (keeps thinking blocks intact).
    assistant_content: Any
    usage: dict[str, int] = field(default_factory=dict)


class Backend(Protocol):
    def step(
        self,
        *,
        system: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        effort: str,
        web: bool,
    ) -> Step: ...


class ClaudeBackend:
    def __init__(self, model: str = DEFAULT_MODEL, client: Any = None):
        import anthropic

        self.model = model
        self.client = client or anthropic.Anthropic()

    def step(self, *, system, messages, tools, effort, web) -> Step:
        all_tools = list(tools) + ([WEB_SEARCH_TOOL] if web else [])
        response = self.client.beta.messages.create(
            model=self.model,
            max_tokens=16000,
            system=system,
            messages=messages,
            tools=all_tools,
            thinking={"type": "adaptive"},
            output_config={"effort": effort},
            # Route policy declines to a fallback model instead of stopping the agent.
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
        text = "".join(b.text for b in response.content if b.type == "text")
        calls = [
            ToolCall(b.id, b.name, dict(b.input))
            for b in response.content
            if b.type == "tool_use"
        ]
        usage = {
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
        }
        return Step(text, calls, response.stop_reason, response.content, usage)


class OfflineBackend:
    """Deterministic backend for tests and dry runs.

    ``script`` maps an agent role to a list of canned turns. Each turn is either
    a string (final text) or ``{"tool": name, "input": {...}}``. Roles without a
    script answer with a short JSON acknowledgement so pipelines keep flowing.
    """

    def __init__(self, script: dict[str, list[Any]] | None = None):
        self.script = {k: list(v) for k, v in (script or {}).items()}
        self.calls: list[dict[str, Any]] = []
        self._n = 0

    def step(self, *, system, messages, tools, effort, web) -> Step:
        self.calls.append({"system": system, "messages": messages, "tools": tools})
        role = _role_from_system(system)
        queue = self.script.get(role)
        turn = queue.pop(0) if queue else _default_reply(system)
        if isinstance(turn, dict) and "tool" in turn:
            self._n += 1
            call = ToolCall(f"call_{self._n}", turn["tool"], turn.get("input", {}))
            content = [{"type": "tool_use", "id": call.id, "name": call.name, "input": call.input}]
            return Step("", [call], "tool_use", content)
        text = turn if isinstance(turn, str) else json.dumps(turn)
        return Step(text, [], "end_turn", [{"type": "text", "text": text}])


def _role_from_system(system: str) -> str:
    for line in system.splitlines():
        if line.startswith("ROLE:"):
            return line.split(":", 1)[1].strip()
    return ""


def _default_reply(system: str) -> str:
    if "Respond with JSON" in system:
        return json.dumps({"score": 0.7, "verdict": "viable", "notes": "offline backend"})
    return "Acknowledged (offline backend)."


def make_backend(offline: bool | None = None) -> Backend:
    if offline is None:
        offline = os.environ.get("HERMES_DOCK_OFFLINE") == "1"
    return OfflineBackend() if offline else ClaudeBackend()
