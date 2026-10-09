# Hermes integration notes

## What was verified, and how

Source: `NousResearch/hermes-agent`, shallow clone at commit `38880bd2f1e90dbc9a1aeec03af62539ee64719a`
(2026-10-08). Files read:

- `gateway/platforms/api_server.py` — route table, `/v1/capabilities`, `/v1/toolsets`, bearer auth,
  default bind `127.0.0.1:8642`, `API_SERVER_KEY` required (refuses to start without a strong key).
- `gateway/platforms/api_server_runs.py` — `POST /v1/runs`, `GET /v1/runs/{id}`,
  `GET /v1/runs/{id}/events`, `POST /v1/runs/{id}/stop`, `POST /v1/runs/{id}/approval`.
- `website/docs/user-guide/features/api-server.md` — the public documentation of the same.
- `website/docs/user-guide/security.md` — approvals, YOLO mode, container backends.
- `hermes_cli/tools_config.py` — configurable toolset names.

**Not verified:** the Hermes version installed on the owner's Mac (this session ran in a cloud
container without access to the Mac), and a live end-to-end run. The live adapter has been tested
only against a fake HTTP server that reproduces the documented wire format
(`packages/hermes-adapter/test/adapter.test.ts`).

## Contract used by `HermesRunsAdapter`

| Call | Request | Response used |
|---|---|---|
| `GET /v1/capabilities` | Bearer | `features.run_submission`, `run_status`, `run_events_sse`, `run_stop` must all be `true`, else adapter state `degraded` |
| `GET /v1/toolsets` | Bearer | `data[].name` where `enabled: true` (toolsets resolved for the `api_server` platform) |
| `POST /v1/runs` | Bearer, `Idempotency-Key: <attempt id>`, body `{input, instructions}` | `202 {run_id, status}`; an identical retry returns the same `run_id` |
| `GET /v1/runs/{id}/events` | Bearer, `Last-Event-ID` to resume | SSE frames `id: <seq>` + `data: {event, run_id, timestamp, ...}`; `: keepalive` comments |
| `GET /v1/runs/{id}` | Bearer | `status` ∈ queued, running, waiting_for_approval, stopping, completed, failed, cancelled, interrupted; `output`, `error`, `usage` |
| `POST /v1/runs/{id}/stop` | Bearer | `{status: "stopping"}` — **not** termination; the run later settles `cancelled` |
| `POST /v1/runs/{id}/approval` | Bearer, `{choice, request_id}` | We only ever send `once` or `deny` (never `session`/`always`, which would widen authority) |

Event mapping (`mapRunEvent`): `message.delta` → partial text; `message.interim` → progress;
`tool.started`/`tool.completed` → tool status; `subagent.*` → progress; `approval.request` → owner
approval (`hermes_tool_action`); `run.completed|failed|cancelled|interrupted` → terminal.
**`reasoning.available` is dropped**: hidden reasoning is never stored or shown. Unknown events are
ignored (lenient decoding).

## Cancellation semantics

The owner's "Cancel" sends `stop`, records `task.cancel_requested`, then polls `GET /v1/runs/{id}`.
The task becomes `cancelled` (with `terminationVerified: true`) only when Hermes reports a terminal
state. If Hermes has not confirmed within 15 s, the task stays `running` with the reason
"Stop requested, but the runtime has not confirmed termination yet". Partial output is saved as a
`partial` artifact. Note: Hermes interrupts "at the next safe interruption point"; a tool call
already executing on the host may complete. With the toolset gate below, no host-mutating tools
should be enabled.

## Tool restrictions and subagent inheritance

`/v1/runs` has no per-request toolset override. Restrictions are therefore enforced by
**checking the runtime's actual configuration before every attempt**:

- refused always (host execution, no verified sandbox): `terminal`, `code_execution`, `file`,
  `browser`, `computer_use`;
- refused always (outward actions, scheduling, delegation — subagents inherit tools):
  `discord`, `discord_admin`, `spotify`, `connections`, `yuanbao`, `cronjob`, `delegation`, `kanban`;
- anything else must be in the owner's `allowedHermesToolsets` (default: empty).

Recommended Hermes configuration for this milestone (`~/.hermes/config.yaml`), giving a text-only
`api_server` platform:

```yaml
platform_toolsets:
  api_server: []
```

If your Hermes version does not accept an empty list, allow one harmless toolset explicitly (e.g.
`["clarify"]`) and add the same name to `allowedHermesToolsets` in an owner policy file. This
path is **unverified live**; the gate itself is unit-tested. Do not enable YOLO mode or
`approvals.mode: off`.

## Enabling the live adapter on the Mac

1. Install Hermes per its official README (review any install script before running it; this
   project never runs remote install scripts for you).
2. In `~/.hermes/.env`: `API_SERVER_ENABLED=true` and `API_SERVER_KEY=<openssl rand -hex 32>`.
   Keep the default bind (`127.0.0.1`). Do not set `API_SERVER_CORS_ORIGINS`: the phone never
   talks to Hermes directly.
3. Set `platform_toolsets.api_server` as above, then `hermes gateway`.
4. In this repo's `.env`: `HDW_ADAPTER=hermes-runs`, `HERMES_API_URL=http://127.0.0.1:8642`,
   `HERMES_API_KEY=<same key>`.
5. Run the documented live test: `npm run smoke:live` (see `docs/testing.md`).

Data note: local orchestration does not mean local inference. Hermes sends prompts and project
content to whatever model provider it is configured with (which may be remote). Point Hermes at a
local provider (e.g. the Ollama instance from `Ai-platform`) if project data must stay on the Mac.
