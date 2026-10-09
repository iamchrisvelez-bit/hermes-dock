# Continuation document (for the next Claude Code session)

Read this first, then `docs/adr/0001-architecture.md`. Branch: `claude/hermes-digital-world-framework-d7srjt`.

## Where things are

- Control plane entry: `apps/control-plane/src/main.ts` → `context.ts` (wiring) → `server.ts` (HTTP/SSE),
  `world.ts` (domain operations + transitions), `runner.ts` (durable task execution, review,
  cancellation, recovery), `store.ts` (entity mappers + atomic event append), `auth.ts`.
- Schema: `apps/control-plane/migrations/001_init.sql`. Add new migrations as `002_*.sql`; never edit applied ones.
- Contracts: `packages/contracts/src` — add an event type by adding its payload schema to `EVENT_PAYLOADS`,
  then handle it in `world-projection/foldEvent` and the client timeline `describe()`.
- Client: `apps/mobile-client/src/worldStore.ts` (connection state machine) and `App.tsx`.
- Renderer: `packages/world-renderer/src` (`effects.ts` pure timing; `WorldCanvas.tsx` scene).

Invariants to keep: every status change goes through `assertTransition` (world.ts helpers); every
state change + its event happen inside one `store.commit`; nothing claims cancellation before the
runtime confirms; the client labels mock state DEMO and non-live state CACHED; animations derive
only from backend state; hidden reasoning is never stored.

## Status

| Area | Implemented | Tested with mocks | Verified live | Unverified / deferred |
|---|---|---|---|---|
| Contracts, state machines, events | ✓ | ✓ | — | — |
| SQLite migrations, atomic events, restart recovery | ✓ | ✓ | — | — |
| Owner pairing, sessions, revocation, CSRF, rate limits | ✓ | ✓ (HTTP tests + browser) | — | HTTPS deployment unverified |
| Policy decision point, tiers, limits, emergency controls | ✓ | ✓ | — | `assist` approval flow for plans: policy only, no UI |
| Upload validation + per-project directories | ✓ | ✓ | — | — |
| Hermes Runs API adapter | ✓ | ✓ against a fake server | **✗ not run against real Hermes** | installed Hermes version unknown; empty `platform_toolsets.api_server` acceptance unknown |
| Mock adapter + end-to-end workflow | ✓ | ✓ | n/a | — |
| Review against acceptance criteria + bounded revision | ✓ (deterministic structural review) | ✓ | — | model-assisted review deferred |
| Hermes tool-approval bridging | ✓ | adapter mapping only | ✗ | end-to-end with real Hermes |
| SSE stream, reconnect, snapshot recovery | ✓ | ✓ + browser | — | — |
| 3D world (HQ, islands, avatars, lifecycle presets, reduced motion) | ✓ | timing unit tests + browser screenshots | — | real-phone FPS unverified |
| 2D list view with equivalent controls | ✓ | browser | — | — |
| PWA (manifest, shell-only SW) | ✓ | build only | — | install on iOS unverified (needs HTTPS for SW) |
| Research notes, skill proposals, budgets | tables + schemas | schema tests | — | no features/UI yet (deferred) |
| Executable agent work in a sandbox | ✗ (deliberately disabled) | policy denial tested | — | deferred |
| Viewer/operator roles, invitations | contracts only (403) | ✓ (403 path) | — | deferred |

## Known limitations

- Intake classification and briefs are heuristic (no model); "existing project" attaches only when
  explicitly selected (API supports `projectId`; the intake UI has no picker yet).
- Only one task kind (`plan_document`); the task graph validator exists but plans have one node.
- Hermes tool approvals pending at a control-plane restart are not re-validated against the run.
- Destroying an already-archived island replays the full island before the destruction preset.
- Island "restore from archive" is not implemented (state machine allows it).
- Budgets: usage is recorded on attempts when Hermes reports it; no enforcement yet.
- The client keeps world state in memory only (no offline cache); a cold start while the Mac is
  unreachable shows "Mac unreachable" with no data — intentional for privacy.
- Without HTTPS (plain Tailscale IP), the service worker does not register.
- Audit log has no viewer in the UI.

## Prioritized next milestones

1. **Live verification on the Mac**: record `node -v`, `hermes --version`; configure the API server
   and `platform_toolsets.api_server`; run `npm run smoke:live`; then the app with
   `HDW_ADAPTER=hermes-runs`. Fix any wire-format drift in `mapRunEvent`. Update this table.
2. **Measure on the baseline phone** with the perf HUD; tune `QUALITY` presets; record results in `docs/testing.md`.
3. **HTTPS on the tailnet** (`tailscale serve`, verified against current docs) + `launchd` service.
4. Model-assisted planning and review via Hermes (structured JSON output validated by zod), keeping
   the deterministic checks as a floor.
5. Assist-tier plan approval UI; project picker in intake; island restore.
6. Sandboxed executable work: hardened Docker runner (project workspace mount only, no network,
   resource limits), verified before `executableWorkEnabled` can become true.
7. Research backlog, retrospectives and versioned skill proposals with evaluation + rollback.
8. Filtered viewer stream and invitations (separately tested before enabling).

## Environment facts from this session

- Built and tested in a Linux cloud container (Node 22.22.0, npm 10.9.4), not on the owner's Mac.
- `node:sqlite` requires Node ≥ 22.13 (`engines` enforces it). It prints an ExperimentalWarning.
- tailscale.com was blocked by the build environment's egress proxy, so Tailscale CLI details are unverified.
- Hermes source was read from a shallow clone at commit `38880bd2` (2026-10-08).
