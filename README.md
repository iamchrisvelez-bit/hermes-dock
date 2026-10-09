# HERMES DIGITAL WORLD (working name)

A home-Mac control plane and a mobile PWA for observing and directing a
[Hermes Agent](https://github.com/NousResearch/hermes-agent) administrator. Each project is a
floating island in an animated digital archipelago; Hermes runs Headquarters. Every animation is
driven by real backend state — when the Mac is idle, asleep or unreachable, the world says so.

> Status: first milestone. The full workflow is implemented and tested with a **deterministic mock
> adapter**. The live Hermes integration (Runs API) is implemented and tested against a fake
> server but **has not been verified against a real Hermes install**. See
> [`docs/CONTINUATION.md`](docs/CONTINUATION.md) for the exact status.

## Quick start (demo mode, no AI model)

Requires Node ≥ 22.13 and npm.

```bash
npm install
npm start                    # builds the client, starts the control plane on http://127.0.0.1:8787
```

The terminal prints a **one-time pairing code**. Open http://127.0.0.1:8787, enter it, then tap
**+** and send the default prompt with a `.md` brief. You will see an island assemble, a builder
work, the reviewer request one revision, and a completed plan you can preview and download.
Everything is labelled **DEMO**.

```bash
npm run pair                 # new pairing code for another device
npm run dev                  # control plane (watch) + Vite dev server on http://127.0.0.1:5173
npm test                     # 87 tests
npm run typecheck
npm run smoke:mock           # end-to-end mock smoke test only
```

Configuration lives in `.env` (copy `.env.example`). Runtime data goes to `./data` (gitignored).

## Live mode (Hermes on the Mac)

Follow [`docs/hermes-integration.md`](docs/hermes-integration.md): enable the Hermes API server with
a strong `API_SERVER_KEY`, restrict `platform_toolsets.api_server`, then set
`HDW_ADAPTER=hermes-runs` and `HERMES_API_KEY`. Verify first with `npm run smoke:live`.
Hermes uses its configured model provider; project text may leave the Mac unless that provider is local.

## Phone access

Private only — see [`docs/private-access.md`](docs/private-access.md) (Tailscale recommended).
Never forward a router port.

## Documentation

| Doc | Contents |
|---|---|
| [`docs/adr/0001-architecture.md`](docs/adr/0001-architecture.md) | Architecture decision record, what was retained from the other repos |
| [`docs/hermes-integration.md`](docs/hermes-integration.md) | Verified Hermes API contract, source references, toolset gate |
| [`docs/security-and-autonomy.md`](docs/security-and-autonomy.md) | Auth, tiers, limits, approvals, emergency controls, sandboxing |
| [`docs/private-access.md`](docs/private-access.md) | Reaching the Mac from the phone |
| [`docs/art-direction.md`](docs/art-direction.md) | World, Hermes, workers, lifecycle animations |
| [`docs/testing.md`](docs/testing.md) | Test coverage, actual results, browser checks, perf measurements |
| [`docs/CONTINUATION.md`](docs/CONTINUATION.md) | Status matrix, limitations, next milestones |

## Layout

```
apps/control-plane      Fastify + SQLite control plane (auth, policy, runner, SSE)
apps/mobile-client      React/Vite PWA (3D world + 2D list)
packages/contracts      zod schemas, state machines, events, API types
packages/orchestration  intake, planning, review, run instructions
packages/hermes-adapter live Hermes Runs API adapter + deterministic mock
packages/workspace-policy policy decisions, path containment, upload validation
packages/world-projection engine-independent world semantics
packages/world-renderer React Three Fiber scene
```
