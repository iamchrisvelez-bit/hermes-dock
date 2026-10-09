# ADR 0001 — Architecture of the first milestone

Status: accepted (2026-10-08) · Working name: HERMES DIGITAL WORLD (configurable via `HDW_WORLD_NAME`)

## Context

The owner wants a mobile-accessible, animated "digital world" in which Nous Research's Hermes Agent
administers real projects on a home Mac. The session inspected four repositories:

| Repo | What it is | Decision |
|---|---|---|
| `hermes-dock` | Empty (README only) | **Home of this system.** No existing code to preserve. |
| `Ai-platform` | Self-hosted Ollama/MLX platform with a three.js "observation deck" (vanilla JS, Flask) | **Retained, not merged.** It is a separate product (model hosting/training). Reused ideas: on-demand three.js scene, Tailscale access guidance, Mac `launchd` service pattern. Its vanilla three.js deck is not reusable as-is in a React/R3F client. |
| `hermes-mobile` | Native SwiftUI/TCA iOS client for Hermes' **dashboard** WebSocket gateway (chat sessions) | **Retained, untouched.** It drives Hermes chat sessions; this system orchestrates projects. It is the authoritative reference for Hermes' dashboard protocol and auth regimes if a future adapter needs them. |
| `LittleVulkanEngine` | Unrelated C++ Vulkan learning engine | Not used. |

The Mac itself could not be inspected from this cloud session (see "Environment" in
`docs/CONTINUATION.md`): Hermes version, Node version and sandbox availability on the Mac are
**unverified** and are probed at runtime (`hermes --version`, `docker --version`, `/v1/capabilities`).

## Decision

Smallest coherent system, as requested:

```
apps/control-plane     Node 22 + TypeScript + Fastify + SQLite (node:sqlite), migrations, durable runner
apps/mobile-client     React + Vite PWA; R3F 3D world (lazy-loaded) + equivalent 2D list view
packages/contracts     zod schemas: entities, explicit state machines, versioned events, API types
packages/orchestration intake -> brief, plan + acceptance criteria, bounded task graph, review, run instructions
packages/hermes-adapter HermesAdapter interface; live Runs-API adapter; deterministic mock adapter; SSE parser
packages/workspace-policy owner policy + single decision point, path containment, upload validation, sandbox report
packages/world-projection engine-independent world semantics (placement, visual state, event folding)
packages/world-renderer  R3F scene (consumes world-projection only)
```

Key choices:

1. **Hermes integration = the Hermes API server "Runs API"** (`POST /v1/runs`, SSE events, stop,
   approval, status). It is documented, versioned via `/v1/capabilities`, supports idempotency keys,
   cancellation that settles as a terminal state, and approval resolution. Verified against the
   official source (see `docs/hermes-integration.md`). A CLI adapter was rejected: no structured
   events, weaker cancellation semantics. The dashboard WebSocket (used by `hermes-mobile`) was
   rejected for orchestration: it is a chat-session surface tied to dashboard auth.
2. **SQLite via `node:sqlite`** (built into Node ≥ 22.13) — no native build step on the Mac. State
   rows and their `events` rows are written in one `BEGIN IMMEDIATE` transaction; events are
   published to clients only after COMMIT. The `events` table rejects UPDATE (append-only).
3. **Transport: authenticated HTTP + SSE.** SSE resumes from `Last-Event-ID`; a cursor that was
   pruned or is ahead triggers `snapshot_required` so the client re-snapshots instead of guessing.
4. **Auth: one-time pairing codes + opaque HttpOnly SameSite=Strict session cookie + per-session
   CSRF header + Origin allowlist.** No default credentials, no tokens in browser storage.
5. **Executable agent work is disabled** in this milestone: no isolation boundary is verified, and
   Hermes executes tools on the API-server host. The control plane writes all files itself; live
   runs are refused if Hermes has host-executing or outward-acting toolsets enabled.
6. **Renderer authorizes nothing.** All state comes from the backend; animations are derived from
   it; activity animates only while connected and only for real states.
7. **Engine independence.** `contracts` + `world-projection` contain everything a Unity URP client
   would need (placement, visual states, event folding); the web renderer is replaceable.

## Consequences

- One process on the Mac; single concurrent worker by default; restart-safe via `recover()`.
- Intake classification and review are deterministic heuristics in this milestone (auditable,
  testable); the Hermes run produces the deliverable. Model-assisted review is a next step.
- The mock adapter makes the full UI/orchestration path testable without a model, and the UI
  always labels it **DEMO**.
- Not introduced: Kubernetes, microservices, a game engine, WebSockets.
