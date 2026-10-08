import { afterEach, describe, expect, it } from 'vitest';
import { parseSse } from '@hdw/hermes-adapter';
import { foldEvent } from '@hdw/world-projection';
import type { WorldEvent, WorldSnapshot } from '@hdw/contracts';
import { harness, intakeBody, pair, snapshot, waitFor, type Client, type Harness } from './helpers.ts';

interface Frame {
  event: string | null;
  id: string | null;
  data: any;
}

async function openStream(base: string, c: Client, query = '', headers: Record<string, string> = {}) {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/stream${query}`, { headers: { cookie: c.cookie, ...headers }, signal: ac.signal });
  const frames: Frame[] = [];
  let ended = false;
  const done = (async () => {
    try {
      for await (const f of parseSse(res.body as unknown as AsyncIterable<Uint8Array>)) frames.push({ event: f.event, id: f.id, data: JSON.parse(f.data) });
    } catch {
      /* aborted */
    }
    ended = true;
  })();
  return { res, frames, close: () => ac.abort(), done, isEnded: () => ended };
}

describe('event stream, reconnect and snapshot recovery', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  async function listen(scenario: 'pass' | 'hang' = 'pass') {
    h = await harness({ scenario });
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = h.app.server.address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  }

  it('refuses unauthenticated stream connections', async () => {
    const base = await listen();
    const res = await fetch(`${base}/api/stream`);
    expect(res.status).toBe(401);
  });

  it('streams ordered events that fold into the same state as a fresh snapshot', async () => {
    const base = await listen('pass');
    const c = await pair(h!);
    let world: WorldSnapshot = await snapshot(c);
    const s = await openStream(base, c, `?after=${world.cursor}`);
    expect(s.res.status).toBe(200);
    await c.post('/api/intake', intakeBody());
    await waitFor(() => s.frames, (f) => f.some((x) => x.event === 'world' && x.data.type === 'project.completed'));
    s.close();
    const worldEvents = s.frames.filter((f) => f.event === 'world').map((f) => f.data as WorldEvent);
    const seqs = worldEvents.map((e) => e.seq);
    expect(seqs).toEqual([...new Set(seqs)].sort((a, b) => a - b)); // ordered, no duplicates
    for (const ev of worldEvents) world = foldEvent(world, ev).world;
    const fresh = await snapshot(c);
    const cursorNow = Math.max(...seqs);
    // Compare the entity state at the folded cursor (later events may have arrived since).
    if (fresh.cursor === cursorNow) {
      expect(world.projects).toEqual(fresh.projects);
      expect(world.tasks).toEqual(fresh.tasks);
      expect(world.islands.filter((i) => i.state !== 'destroyed')).toEqual(fresh.islands);
    }
    expect(world.projects[0]!.status).toBe('completed');
  });

  it('resumes after a disconnect from Last-Event-ID without gaps or duplicates', async () => {
    const base = await listen('pass');
    const c = await pair(h!);
    const start = (await snapshot(c)).cursor;
    await c.post('/api/intake', intakeBody());
    await waitFor(() => snapshot(c), (w) => w.projects[0]?.status === 'completed');
    const all = (await c.get(`/api/events?after=${start}&limit=1000`)).json.events as WorldEvent[];
    const mid = all[Math.floor(all.length / 2)]!.seq;

    const s = await openStream(base, c, '', { 'Last-Event-ID': String(mid) });
    await waitFor(() => s.frames, (f) => f.some((x) => x.event === 'ready'));
    s.close();
    const got = s.frames.filter((f) => f.event === 'world').map((f) => (f.data as WorldEvent).seq);
    expect(got).toEqual(all.filter((e) => e.seq > mid).map((e) => e.seq));
  });

  it('tells the client to re-snapshot when its cursor was pruned or is ahead', async () => {
    const base = await listen('pass');
    const c = await pair(h!);
    await c.post('/api/intake', intakeBody());
    await waitFor(() => snapshot(c), (w) => w.projects[0]?.status === 'completed');
    const latest = h!.ctx.store.latestSeq();
    h!.ctx.store.pruneEventsBefore(latest - 3);

    const expired = await openStream(base, c, '?after=1');
    await waitFor(() => expired.isEnded(), (e) => e);
    expect(expired.frames.map((f) => f.event)).toEqual(['snapshot_required']);
    expect(expired.frames[0]!.data.reason).toBe('cursor_expired');

    const ahead = await openStream(base, c, `?after=${latest + 50}`);
    await waitFor(() => ahead.isEnded(), (e) => e);
    expect(ahead.frames[0]!.data.reason).toBe('cursor_ahead');

    const rest = await c.get('/api/events?after=1');
    expect(rest.status).toBe(410);
    expect(rest.json.error.code).toBe('cursor_expired');

    // Snapshot recovery still gives the full current state.
    const w = await snapshot(c);
    expect(w.projects[0]!.status).toBe('completed');
  });

  it('closes the stream when the session is revoked', async () => {
    const base = await listen('pass');
    const c = await pair(h!);
    const s = await openStream(base, c);
    await waitFor(() => s.frames, (f) => f.some((x) => x.event === 'ready'));
    await c.post('/api/auth/logout');
    await waitFor(() => s.isEnded(), (e) => e);
    expect(s.frames.at(-1)!.event).toBe('session_revoked');
  });
});
