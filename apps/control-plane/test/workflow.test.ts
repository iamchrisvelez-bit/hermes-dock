import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockHermesAdapter, type HermesAdapter, type ProbeResult } from '@hdw/hermes-adapter';
import { b64, harness, intakeBody, pair, snapshot, waitFor, type Harness } from './helpers.ts';

describe('task execution, limits, cancellation and recovery', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('stops at the review iteration limit and escalates', async () => {
    h = await harness({ scenario: 'never_pass' });
    const c = await pair(h);
    const { json } = await c.post('/api/intake', intakeBody());
    const w = await waitFor(() => snapshot(c), (s) => s.tasks[0]?.status === 'failed');
    const task = w.tasks[0]!;
    expect(task.iteration).toBe(3);
    expect(w.attempts.filter((a) => a.taskId === task.id)).toHaveLength(3);
    expect(w.reviews.map((r) => r.verdict)).toEqual(['revise', 'revise', 'fail']);
    expect(w.projects.find((p) => p.id === json.projectId)!.status).toBe('blocked');
    expect(task.statusReason).toMatch(/escalated/);
  });

  it('runs at most one worker at a time (concurrency limit)', async () => {
    h = await harness({ scenario: 'pass', overrides: { adapter: new MockHermesAdapter({ stepMs: 20, scenario: 'pass' }) } });
    const c = await pair(h);
    await c.post('/api/intake', intakeBody());
    await c.post('/api/intake', intakeBody({ files: [{ name: 'b.md', contentBase64: b64('# Second project\nWrite a plan to build a second thing for the team.') }] }));
    let maxRunning = 0;
    await waitFor(
      async () => {
        const s = await snapshot(c);
        maxRunning = Math.max(maxRunning, s.attempts.filter((a) => a.status === 'running').length);
        return s;
      },
      (s) => s.tasks.length === 2 && s.tasks.every((t) => t.status === 'completed'),
    );
    expect(maxRunning).toBe(1);
  });

  it('cancels a running task only after the runtime confirms, and records partial output', async () => {
    h = await harness({ overrides: { adapter: new MockHermesAdapter({ stepMs: 5, scenario: 'hang' }) } });
    const c = await pair(h);
    const { json } = await c.post('/api/intake', intakeBody());
    await waitFor(() => snapshot(c), (s) => s.tasks[0]?.status === 'running' && s.attempts[0]?.externalRunId !== null);
    const res = await c.post(`/api/tasks/${json.taskId}/cancel`);
    expect(res.status).toBe(200);
    expect(res.json.state).toBe('cancel_requested'); // never claims success before verification
    const w = await waitFor(() => snapshot(c), (s) => s.tasks[0]?.status === 'cancelled');
    expect(w.attempts[0]!.status).toBe('cancelled');
    const partial = w.artifacts.find((a) => a.kind === 'partial');
    expect(partial).toBeDefined();
    const ev = await c.get('/api/events?after=0&limit=1000');
    const cancelled = ev.json.events.find((e: { type: string }) => e.type === 'task.cancelled');
    expect(cancelled.payload.terminationVerified).toBe(true);
    const order = ev.json.events.map((e: { type: string }) => e.type);
    expect(order.indexOf('task.cancel_requested')).toBeLessThan(order.indexOf('task.cancelled'));
    expect(w.agents.find((a) => a.role === 'builder')!.status).toBe('idle');
  });

  it('reports unconfirmed termination honestly when the runtime does not stop', async () => {
    const stubborn = new MockHermesAdapter({ stepMs: 5, scenario: 'hang' });
    stubborn.stopRun = async () => ({ accepted: true, detail: 'pretend accepted' }); // never actually stops
    h = await harness({ overrides: { adapter: stubborn, runner: { reviewDelayMs: 0, verifyPollMs: 10, verifyTimeoutMs: 150, log: { info() {}, warn() {}, error() {} } } } });
    const c = await pair(h);
    const { json } = await c.post('/api/intake', intakeBody());
    await waitFor(() => snapshot(c), (s) => s.attempts[0]?.externalRunId != null);
    await c.post(`/api/tasks/${json.taskId}/cancel`);
    const w = await waitFor(() => snapshot(c), (s) => /not confirmed/.test(s.tasks[0]?.statusReason ?? ''));
    expect(w.tasks[0]!.status).toBe('running');
  });

  it('pause-all stops running work and requeues it; resume continues', async () => {
    h = await harness({ overrides: { adapter: new MockHermesAdapter({ stepMs: 5, scenario: 'hang' }) } });
    const c = await pair(h);
    await c.post('/api/intake', intakeBody());
    await waitFor(() => snapshot(c), (s) => s.attempts[0]?.externalRunId != null);
    await c.post('/api/controls', { action: 'pause_all' });
    const w = await waitFor(() => snapshot(c), (s) => s.tasks[0]?.status === 'queued');
    expect(w.controls.pauseAll).toBe(true);
    expect(w.tasks[0]!.statusReason).toMatch(/Paused/);
    // Still paused: nothing restarts.
    await new Promise((r) => setTimeout(r, 100));
    expect((await snapshot(c)).attempts.filter((a) => a.status === 'running')).toHaveLength(0);
    (h.ctx.adapter as MockHermesAdapter).scenario = 'pass';
    await c.post('/api/controls', { action: 'resume_all' });
    await waitFor(() => snapshot(c), (s) => s.tasks[0]?.status === 'completed');
  });

  it('emergency stop refuses new work until cleared, and clearing does not auto-resume', async () => {
    h = await harness();
    const c = await pair(h);
    await c.post('/api/controls', { action: 'emergency_stop' });
    const refused = await c.post('/api/intake', intakeBody());
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe('policy_denied');
    const cleared = await c.post('/api/controls', { action: 'clear_emergency_stop' });
    expect(cleared.json).toMatchObject({ emergencyStop: false, pauseAll: true, newWorkDisabled: true });
    expect((await c.post('/api/intake', intakeBody())).status).toBe(403); // still disabled
    await c.post('/api/controls', { action: 'enable_new_work' });
    expect((await c.post('/api/intake', intakeBody())).status).toBe(200);
  });

  it('recovers after a restart that interrupted a running attempt', async () => {
    h = await harness({ overrides: { adapter: new MockHermesAdapter({ stepMs: 5, scenario: 'hang' }) } });
    const c = await pair(h);
    await c.post('/api/intake', intakeBody());
    await waitFor(() => snapshot(c), (s) => s.attempts[0]?.externalRunId != null);
    const dataDir = h.dataDir;
    await h.close({ keepData: true }); // simulated crash: the in-process mock run dies with it

    h = await harness({ dataDir, scenario: 'pass' });
    const c2 = await pair(h);
    const w = await waitFor(() => snapshot(c2), (s) => s.tasks[0]?.status === 'completed');
    const attempts = w.attempts.filter((a) => a.taskId === w.tasks[0]!.id);
    expect(attempts[0]!.status).toBe('interrupted');
    expect(attempts.at(-1)!.status).toBe('succeeded');
    const ev = await c2.get('/api/events?after=0&limit=1000');
    expect(ev.json.events.some((e: { type: string }) => e.type === 'system.recovered')).toBe(true);
  });

  it('is idempotent for retried intake submissions', async () => {
    h = await harness({ scenario: 'pass' });
    const c = await pair(h);
    const body = intakeBody();
    const a = await c.post('/api/intake', body);
    const b = await c.post('/api/intake', body);
    expect(b.json).toEqual(a.json);
    expect((await snapshot(c)).projects).toHaveLength(1);
  });
});

describe('uploads and file safety', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('stores uploads under internal ids, never trusting filenames', async () => {
    h = await harness({ scenario: 'pass' });
    const c = await pair(h);
    const r = await c.post('/api/intake', intakeBody({ files: [{ name: '../../../../etc/evil.md', contentBase64: b64('# Evil\nPlease write a plan to build a thing for the team.') }] }));
    expect(r.status).toBe(200);
    const w = await snapshot(c);
    const input = w.artifacts.find((a) => a.provenance.source === 'owner_upload')!;
    expect(input.displayName).toBe('evil.md');
    const raw = h.ctx.store.rawArtifact(input.id)!;
    expect(raw.relPath).toBe(path.join('projects', w.projects[0]!.id, 'input', `${input.id}.md`));
    expect(existsSync(path.join(h.dataDir, raw.relPath))).toBe(true);
  });

  it.each([
    ['payload.exe', 'hello', 415],
    ['a.txt', '\u0000binary', 415],
    ['data.json', '{not json', 415],
  ])('rejects %s', async (name, content, status) => {
    h = await harness();
    const c = await pair(h);
    const r = await c.post('/api/intake', intakeBody({ files: [{ name, contentBase64: b64(content) }] }));
    expect(r.status).toBe(status);
    expect((await snapshot(c)).projects).toHaveLength(0);
  });

  it('rejects archives renamed to .txt and oversized files', async () => {
    h = await harness();
    const c = await pair(h);
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]).toString('base64');
    expect((await c.post('/api/intake', intakeBody({ files: [{ name: 'notes.txt', contentBase64: zip }] }))).status).toBe(415);
    const big = Buffer.alloc(600 * 1024, 'a').toString('base64');
    expect((await c.post('/api/intake', intakeBody({ files: [{ name: 'big.txt', contentBase64: big }] }))).status).toBe(413);
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.txt`, contentBase64: b64('hello world text') }));
    expect((await c.post('/api/intake', intakeBody({ files: many }))).status).toBe(400); // schema max 5
  });

  it('asks for clarification instead of guessing on near-empty input', async () => {
    h = await harness();
    const c = await pair(h);
    const r = await c.post('/api/intake', { prompt: 'do it', files: [], idempotencyKey: 'clarify-0001' });
    expect(r.json.outcome).toBe('needs_clarification');
    expect(r.json.questions.length).toBeGreaterThan(0);
    expect((await snapshot(c)).projects).toHaveLength(0);
  });
});

describe('archive, destruction and permanent deletion', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('archive keeps files; destruction needs approval; deletion needs a separate approval', async () => {
    h = await harness({ scenario: 'pass' });
    const c = await pair(h);
    const { json } = await c.post('/api/intake', intakeBody());
    const pid = json.projectId as string;
    await waitFor(() => snapshot(c), (s) => s.projects[0]?.status === 'completed');
    const files = () => (h!.ctx.store.list('artifacts', 'project_id = ?', pid)).map((a) => path.join(h!.dataDir, h!.ctx.store.rawArtifact(a.id)!.relPath));
    const before = files();
    expect(before.length).toBeGreaterThan(0);

    // Destruction before archive is refused.
    expect((await c.post(`/api/projects/${pid}/destroy-island`, { preset: 'earthquake' })).status).toBe(409);

    const arch = await c.post(`/api/projects/${pid}/archive`, { preset: 'dissolve' });
    expect(arch.status).toBe(200);
    let w = await snapshot(c);
    expect(w.projects[0]!.status).toBe('archived');
    const island = w.islands.find((i) => i.projectId === pid)!;
    expect(island).toMatchObject({ state: 'archived', removalPreset: 'dissolve' });
    expect(before.every(existsSync)).toBe(true); // archive never deletes data
    expect(w.agents.find((a) => a.projectId === pid)).toBeUndefined(); // worker retired

    const req = await c.post(`/api/projects/${pid}/destroy-island`, { preset: 'demolition' });
    expect(req.json.status).toBe('pending');
    w = await snapshot(c);
    expect(w.islands.find((i) => i.id === island.id)!.state).toBe('archived'); // not yet
    await c.post(`/api/approvals/${req.json.id}/decide`, { decision: 'approve' });
    w = await snapshot(c);
    expect(w.islands.find((i) => i.id === island.id)).toBeUndefined();
    expect(before.every(existsSync)).toBe(true); // visual destruction keeps data

    const del = await c.post(`/api/projects/${pid}/delete-data`);
    expect(del.json.kind).toBe('project_data_deletion');
    const deny = await c.post(`/api/approvals/${del.json.id}/decide`, { decision: 'deny' });
    expect(deny.json.status).toBe('denied');
    expect(before.every(existsSync)).toBe(true);

    const del2 = await c.post(`/api/projects/${pid}/delete-data`);
    await c.post(`/api/approvals/${del2.json.id}/decide`, { decision: 'approve' });
    expect(before.some(existsSync)).toBe(false);
    w = await snapshot(c);
    expect(w.projects[0]!.dataDeletedAt).not.toBeNull();
    expect(w.artifacts.filter((a) => a.projectId === pid)).toHaveLength(0);
  });

  it('refuses to archive a project with a running task', async () => {
    h = await harness({ overrides: { adapter: new MockHermesAdapter({ stepMs: 5, scenario: 'hang' }) } });
    const c = await pair(h);
    const { json } = await c.post('/api/intake', intakeBody());
    await waitFor(() => snapshot(c), (s) => s.tasks[0]?.status === 'running');
    expect((await c.post(`/api/projects/${json.projectId}/archive`, { preset: 'dissolve' })).status).toBe(409);
  });
});

describe('live adapter policy gate', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  class FakeLive extends MockHermesAdapter {
    override readonly live = true as unknown as false;
    constructor(private readonly toolsets: string[]) {
      super({ stepMs: 2, scenario: 'pass' });
    }
    override async probe(): Promise<ProbeResult> {
      const p = await super.probe();
      return { health: { ...p.health, adapter: 'hermes-runs', live: true, detail: 'fake live' }, enabledToolsets: this.toolsets };
    }
  }

  it('labels live adapters as live and mock as demo', async () => {
    h = await harness({ overrides: { adapter: new FakeLive([]) as unknown as HermesAdapter } });
    const c = await pair(h);
    expect((await snapshot(c)).adapter.live).toBe(true);
  });

  it('blocks the task when Hermes has host-executing toolsets enabled', async () => {
    h = await harness({ overrides: { adapter: new FakeLive(['terminal', 'file']) as unknown as HermesAdapter } });
    const c = await pair(h);
    await c.post('/api/intake', intakeBody());
    const w = await waitFor(() => snapshot(c), (s) => s.tasks[0]?.status === 'blocked');
    expect(w.tasks[0]!.statusReason).toMatch(/terminal, file/);
    expect(w.attempts).toHaveLength(0); // nothing was started
  });

  it('blocks non-allowlisted toolsets but allows allowlisted ones', async () => {
    h = await harness({ overrides: { adapter: new FakeLive(['clarify']) as unknown as HermesAdapter } });
    const c = await pair(h);
    await c.post('/api/intake', intakeBody());
    await waitFor(() => snapshot(c), (s) => s.tasks[0]?.status === 'blocked');
    await h.close();
    h = await harness({ policy: { allowedHermesToolsets: ['clarify'] }, overrides: { adapter: new FakeLive(['clarify']) as unknown as HermesAdapter } });
    const c2 = await pair(h);
    await c2.post('/api/intake', intakeBody());
    await waitFor(() => snapshot(c2), (s) => s.tasks[0]?.status === 'completed');
  });
});
