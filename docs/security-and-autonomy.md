# Security and autonomy policy

## Trust boundaries

```
phone (viewer/control UI) --HTTPS/HTTP over private network--> control plane (Mac, owns state)
                                                                  |  bearer key, loopback only
                                                                  v
                                                       Hermes API server (Mac) --> model provider
```

- The phone holds no model or Hermes secrets. Its only credential is an HttpOnly session cookie it
  cannot read, plus an in-memory CSRF token.
- The control plane is the only writer of project files. Hermes returns text; the control plane
  validates and stores it.
- Uploaded files, briefs, deliverables, and tool output are **untrusted data**. They are fenced as
  such in run instructions, rendered as plain text in the client, and never executed.

## Authentication and sessions

| Control | Implementation |
|---|---|
| No default credentials | First device pairs with a one-time code printed on the Mac terminal, or created by `npm run pair` (requires shell access to the Mac) |
| Pairing code | 8 chars (≈40 bits), SHA-256 stored, single-use, 10-minute expiry, 5 attempts/min/IP |
| Session | 256-bit random token in `hdw_session` cookie: HttpOnly, SameSite=Strict, `Secure` when the public origin is https; 30-day expiry; only its hash is stored |
| Revocation | Settings → Paired devices; revoking also closes that device's live stream |
| CSRF | `X-HDW-CSRF` header (per-session token) required on every mutation, plus an Origin allowlist |
| Roles | `owner`, `operator`, `viewer` exist in contracts; any non-owner session gets 403 in this release |
| Rate limits | pairing 5/min/IP · commands 60/min/session · intake 10/min/session |
| Logs | cookies, auth headers and CSRF tokens are redacted; request bodies are not logged; prompts are never in the audit log |
| Headers | CSP (`script-src 'self'`, `frame-ancestors 'none'`), nosniff, no-referrer, `Cache-Control: no-store` on the API; downloads are `attachment` with `CSP: sandbox` |

A future viewer role must receive a filtered observation stream (no prompts, artifacts, or tool
detail). That filter is not implemented; non-owner access stays disabled until it is.

## Autonomy tiers

| Tier | Behaviour |
|---|---|
| `observe` | Intake and proposals only. No islands, workers, or task execution. |
| `assist` | Executes only approved plans (`task_plan` approval). |
| `bounded_autonomous` (default) | Creates islands and scoped workers, runs approved tasks, iterates within limits, archives. Never widens its own permissions. |

Defaults (`DEFAULT_POLICY`): 1 running worker · delegation depth 1 · 3 review iterations ·
10-minute task timeout · no unrestricted shell (the schema forbids it) · executable work off.
Override with `HDW_POLICY_FILE=policy.json` (owner-edited file on the Mac; agents cannot write it):

```json
{ "autonomyTier": "assist", "taskTimeoutMs": 300000, "allowedHermesToolsets": [] }
```

## Always requires explicit owner approval

Permanent data deletion · island destruction · external communication · purchases/paid services ·
installing software or host changes · access outside project areas · authentication/permission
changes · promoting administrator prompt/tool/skill changes · enabling shared access · any Hermes
tool action that Hermes itself flags for approval (answered `once`/`deny` only).

Implemented approval flows today: island destruction, project data deletion, Hermes tool actions.
The other kinds are in the contract and policy; their triggering features do not exist yet.

## Emergency controls

- **Pause all**: asks every running attempt to stop; tasks return to the queue once the runtime
  confirms.
- **Cancel task**: honest two-step (`cancel_requested` → `cancelled` only after confirmation).
- **Disable new work**: intake refused; queued work may continue.
- **Emergency stop**: pause + disable new work + refuse everything until cleared. Clearing does
  not resume work by itself.

## Sandboxing

A separate directory or terminal is not isolation. No sandbox has been verified, so executable
agent work is **disabled** and the system says so (`/api/system` → `sandbox.reason`). Hermes
reports `tool_execution: "server"`: its tools run on the Mac, so the toolset gate in
`docs/hermes-integration.md` is the actual enforcement, not prompts.

## Files and uploads

Supported: `.txt`, `.md`, `.json` (≤5 files, ≤512 KB each, ≤1 MB total). Content is checked as
strict UTF-8 with no NUL bytes, JSON must parse, and archive/executable/PDF magic numbers are
refused even when renamed. Storage paths come from internal ids; display names are sanitized and
never used as paths; symlinked project directories are refused. Each project gets `input/`,
`workspace/`, `deliverables/`, `partial/`, `meta/` under `data/projects/<id>/` (mode 0700).
Archive and island destruction never delete files; permanent deletion is a separate approval.

## Never

Fabricate integrations · show simulated progress as real · expose the Mac publicly · give agents
access to personal files · let agents expand their authority · hide errors behind animations.
