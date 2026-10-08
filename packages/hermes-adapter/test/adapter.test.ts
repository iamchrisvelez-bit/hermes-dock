import { describe, expect, it } from 'vitest';
import { HermesRunsAdapter, MockHermesAdapter, mapRunEvent, parseSse, renderPlan, type AdapterRunEvent } from '../src/index.ts';

async function* chunks(...parts: string[]) {
  for (const p of parts) yield new TextEncoder().encode(p);
}

describe('SSE parser', () => {
  it('handles ids, comments, multi-line data and split chunks', async () => {
    const frames = [];
    for await (const f of parseSse(chunks(': open\n\n', 'id: 3\ndata: {"a":', '1}\n\n', 'data: x\ndata: y\n\n', ': keepalive\n\n'))) frames.push(f);
    expect(frames).toEqual([
      { id: '3', event: null, data: '{"a":1}' },
      { id: null, event: null, data: 'x\ny' },
    ]);
  });
});

describe('Hermes run event mapping', () => {
  it('maps documented events and drops hidden reasoning', () => {
    expect(mapRunEvent('r', { event: 'reasoning.available', text: 'secret thoughts' }, 1)).toBeNull();
    expect(mapRunEvent('r', { event: 'message.delta', delta: 'hi' }, 2)).toEqual({ type: 'delta', text: 'hi', seq: 2 });
    expect(mapRunEvent('r', { event: 'tool.completed', tool: 'web_search', error: true }, 3)).toMatchObject({ type: 'tool', phase: 'completed', error: true });
    expect(mapRunEvent('r', { event: 'approval.request', request_id: 'q1', description: 'rm file', choices: ['once', 'deny'] }, 4)).toMatchObject({
      type: 'approval_requested',
      requestId: 'q1',
      choices: ['once', 'deny'],
    });
    expect(mapRunEvent('r', { event: 'run.completed', output: 'done', usage: { input_tokens: 5, output_tokens: 7 } }, 5)).toMatchObject({
      type: 'terminal',
      state: { status: 'completed', output: 'done', usage: { inputTokens: 5, outputTokens: 7, costUsd: null } },
    });
    expect(mapRunEvent('r', { event: 'something.new' }, 6)).toBeNull();
  });
});

function fakeFetch(routes: Record<string, (init: RequestInit) => Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const key = `${init.method ?? 'GET'} ${new URL(url).pathname}`;
    const h = routes[key];
    if (!h) return new Response('{"error":"nope"}', { status: 404 });
    return h(init);
  }) as unknown as typeof fetch;
  return { f, calls };
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

describe('HermesRunsAdapter (against a fake Hermes API server)', () => {
  const caps = { features: { run_submission: true, run_status: true, run_events_sse: true, run_stop: true } };

  it('probes capabilities and enabled toolsets', async () => {
    const { f } = fakeFetch({
      'GET /v1/capabilities': () => json(caps),
      'GET /v1/toolsets': () => json({ data: [{ name: 'web', enabled: true }, { name: 'terminal', enabled: false }] }),
    });
    const a = new HermesRunsAdapter({ baseUrl: 'http://h:8642/', apiKey: 'k', fetch: f });
    const p = await a.probe();
    expect(p.health).toMatchObject({ adapter: 'hermes-runs', live: true, state: 'ready' });
    expect(p.enabledToolsets).toEqual(['web']);
  });

  it('reports degraded when required run features are missing, unreachable when down', async () => {
    const { f } = fakeFetch({ 'GET /v1/capabilities': () => json({ features: { run_submission: true } }) });
    expect((await new HermesRunsAdapter({ baseUrl: 'http://h', apiKey: 'k', fetch: f }).probe()).health.state).toBe('degraded');
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect((await new HermesRunsAdapter({ baseUrl: 'http://h', apiKey: 'k', fetch: down }).probe()).health.state).toBe('unreachable');
  });

  it('starts runs with bearer auth and an Idempotency-Key, and parses SSE events', async () => {
    const sse = 'id: 0\ndata: {"event":"tool.started","tool":"read"}\n\nid: 1\ndata: {"event":"reasoning.available","text":"x"}\n\nid: 2\ndata: {"event":"run.completed","output":"# Plan"}\n\n';
    const { f, calls } = fakeFetch({
      'POST /v1/runs': () => json({ run_id: 'run_1', status: 'started' }, 202),
      'GET /v1/runs/run_1/events': () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      'POST /v1/runs/run_1/stop': () => json({ run_id: 'run_1', status: 'stopping' }),
      'GET /v1/runs/run_1': () => json({ run_id: 'run_1', status: 'cancelled' }),
    });
    const a = new HermesRunsAdapter({ baseUrl: 'http://h', apiKey: 'secret', fetch: f });
    expect(await a.startRun({ idempotencyKey: 'att_1', instructions: 'i', input: 'x' })).toEqual({ runId: 'run_1' });
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer secret');
    expect(h['Idempotency-Key']).toBe('att_1');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ input: 'x', instructions: 'i' });

    const got: AdapterRunEvent[] = [];
    for await (const e of a.events('run_1', { signal: new AbortController().signal, afterSeq: 5 })) got.push(e);
    expect(got.map((e) => e.type)).toEqual(['tool', 'terminal']);
    expect((calls[1]!.init.headers as Record<string, string>)['Last-Event-ID']).toBe('5');

    expect((await a.stopRun('run_1')).accepted).toBe(true);
    expect((await a.getRun('run_1'))!.status).toBe('cancelled');
    expect(await a.getRun('run_missing')).toBeNull();
  });

  it('surfaces auth failures distinctly', async () => {
    const { f } = fakeFetch({ 'POST /v1/runs': () => json({}, 401) });
    await expect(new HermesRunsAdapter({ baseUrl: 'http://h', apiKey: 'bad', fetch: f }).startRun({ idempotencyKey: 'k1', instructions: '', input: 'x' })).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe('mock adapter', () => {
  it('is deterministic and never claims to be live', async () => {
    const req = { idempotencyKey: 'k', instructions: '', input: 'Project title: Demo\n--- BRIEF ---\nGoal: build a thing\n--- END BRIEF ---' };
    expect(renderPlan(req, { omitRisks: false })).toBe(renderPlan(req, { omitRisks: false }));
    const m = new MockHermesAdapter({ stepMs: 0, scenario: 'pass' });
    expect(m.live).toBe(false);
    expect((await m.probe()).health.live).toBe(false);
    const a = await m.startRun(req);
    const b = await m.startRun(req);
    expect(a.runId).toBe(b.runId); // idempotent
    const events: AdapterRunEvent[] = [];
    for await (const e of m.events(a.runId, { signal: new AbortController().signal })) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: 'terminal', state: { status: 'completed' } });
  });
});
