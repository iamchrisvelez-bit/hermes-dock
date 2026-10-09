# Tests and their actual results

Run everything: `npm test` (Vitest). Typecheck: `npm run typecheck`.

## Result at commit time (2026-10-09, cloud Linux container, Node 22.22.0)

```
Test Files  10 passed (10)
     Tests  87 passed (87)
```

| Suite | Covers |
|---|---|
| `packages/contracts/test` | schema validation, event envelope + per-type payload validation, all state machines (legal paths, illegal jumps, terminal states) |
| `packages/workspace-policy/test` | default limits, concurrency/iteration/delegation denial, pause/new-work/emergency, tiers, toolset gate, no exec without sandbox, path traversal, symlink rejection, upload type/size/count/encoding/archive checks, name sanitizing |
| `packages/orchestration/test` | intake brief + clarification + related projects, plan graph validation (cycles, depth, size), review verdicts and revision notes, untrusted fencing |
| `packages/hermes-adapter/test` | SSE parser, event mapping (reasoning dropped), live adapter against a fake Hermes server (auth header, Idempotency-Key, Last-Event-ID, stop, status, 401), mock determinism + idempotency |
| `packages/world-projection/test` | deterministic collision-free placement, slot reuse, seeds, event folding (order, duplicates, gaps), visual state only from real state |
| `packages/world-renderer/test` | creation stage order, removal presets end hidden, reduced motion (no shake/flash), single soft flash, 2 Hz shake, time-based completion, adaptive DPR |
| `apps/control-plane/test/auth` | 401 on every command/stream/download without a session, forged cookies, single-use + expiring pairing, session expiry, revocation, CSRF + Origin, pairing rate limit, no secrets in responses, security headers |
| `apps/control-plane/test/workflow` | iteration limit + escalation, concurrency = 1, verified cancellation + partial artifact, unconfirmed-termination honesty, pause/resume, emergency stop, restart recovery of an interrupted attempt, idempotent intake, upload safety via HTTP, archive vs destruction vs deletion approvals, live-policy gate, demo vs live labeling |
| `apps/control-plane/test/stream` | SSE auth, ordered events fold to the snapshot state, `Last-Event-ID` resume without gaps/duplicates, `snapshot_required` on pruned/ahead cursors, stream closed on revocation |
| `apps/control-plane/test/e2e-mock` | **End-to-end mock smoke test**: brief → project + island (slot 1) → builder assigned → attempt 1 → review "revise" (missing Risks) → attempt 2 → "pass" → project completed; deliverable files, hashes and DEMO disclosure; event ordering; reload/restart preserves state |

## Browser checks (Playwright, Chromium, 390×844 @2x, mobile + touch emulation)

Performed manually from this session with the built client served by the control plane (mock
adapter, `HDW_MOCK_STEP_MS=900`). Observed:

- pairing screen → paired; HQ renders; DEMO badge; "Connected · last update hh:mm:ss";
- intake with an uploaded `brief.md`; island creation sequence captured mid-beam and on arrival;
  camera auto-frames HQ + the new island on a portrait screen;
- worker and reviewer state changes; project list shows progress; completion; review findings
  panel (5/5 criteria); deliverable preview and download;
- archive with the earthquake preset; archived marker afterwards;
- control plane killed → pill "Reconnecting…", badge **CACHED**, "last update … (Ns ago)",
  Hermes alert pose; control plane restarted → client back to live in ~3.5 s without a reload;
  page reload → archived project still listed.

## Performance (measured, but NOT on a phone)

Environment: headless Chromium with **SwiftShader software GL** on a cloud VM (no GPU), 390×844 CSS
px viewport, quality "medium", HQ + 1 project island (~50–63 draw calls, 7–12k triangles).

| State | Measured |
|---|---|
| island creation / worker active (continuous) | 21–27 FPS; adaptive DPR settled at 0.75–1.2 |
| after activity, Hermes posing | ~31 FPS at DPR 0.75 |
| idle | on-demand rendering: 0 frames drawn while nothing changes |

Software rendering is far slower than a phone GPU, so these numbers say nothing about the
30/60 FPS targets. **Mobile performance is unverified**: no physical phone was available. Measure
with Controls → "Show performance HUD" on the baseline phone and record device, browser, quality,
and scene size here.

## Live test (documented, NOT run)

```bash
# On the Mac, with Hermes' API server running (see docs/hermes-integration.md)
HERMES_API_URL=http://127.0.0.1:8642 HERMES_API_KEY=... npm run smoke:live
```

It probes capabilities and enabled toolsets, refuses if owner policy would refuse, runs the smoke
task ("create a Markdown implementation plan with milestones, risks, and acceptance criteria"),
streams events, and exits 0 only if the real run completed and passed review. Then repeat through
the app with `HDW_ADAPTER=hermes-runs` and confirm the badge reads **LIVE**.
