import { parseSse } from './sse.ts';
import {
  AdapterError,
  type AdapterRunEvent,
  type HermesAdapter,
  type ProbeResult,
  type RunRequest,
  type RunState,
  type RunStatus,
  type RunUsage,
} from './types.ts';

/**
 * Live adapter for the Hermes Agent API server "Runs API".
 *
 * Verified against NousResearch/hermes-agent source (gateway/platforms/api_server.py,
 * gateway/platforms/api_server_runs.py) and website/docs/user-guide/features/api-server.md
 * at commit 38880bd2 (2026-10-08). Only these documented endpoints are used:
 *   GET  /v1/capabilities          feature detection
 *   GET  /v1/toolsets              toolsets enabled for the api_server platform
 *   POST /v1/runs                  {input, instructions} + Idempotency-Key -> 202 {run_id}
 *   GET  /v1/runs/{id}             status object
 *   GET  /v1/runs/{id}/events      SSE, frames `id: <seq>` + `data: {event, run_id, ...}`
 *   POST /v1/runs/{id}/stop        -> {status: "stopping"}; terminal `cancelled` later
 * Auth: `Authorization: Bearer <API_SERVER_KEY>`.
 */
export interface HermesRunsConfig {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  /** Hermes version string obtained out-of-band (e.g. `hermes --version`), if known. */
  hermesVersion?: string | null;
  requestTimeoutMs?: number;
}

const REQUIRED_FEATURES = ['run_submission', 'run_status', 'run_events_sse', 'run_stop'] as const;

const STATUS_MAP: Record<string, RunStatus> = {
  queued: 'queued',
  started: 'running',
  running: 'running',
  waiting_for_approval: 'waiting_for_approval',
  stopping: 'stopping',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
};

function clip(s: unknown, n: number): string {
  const str = typeof s === 'string' ? s : s == null ? '' : JSON.stringify(s);
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function toUsage(u: unknown): RunUsage | null {
  if (!u || typeof u !== 'object') return null;
  const o = u as Record<string, unknown>;
  return { inputTokens: num(o.input_tokens), outputTokens: num(o.output_tokens), costUsd: num(o.cost_usd) };
}

function toRunState(runId: string, body: Record<string, unknown>, status: RunStatus): RunState {
  return {
    runId,
    status,
    output: typeof body.output === 'string' ? body.output : null,
    error: typeof body.error === 'string' ? clip(body.error, 2000) : null,
    usage: toUsage(body.usage),
  };
}

export class HermesRunsAdapter implements HermesAdapter {
  readonly kind = 'hermes-runs' as const;
  readonly live = true;
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;

  constructor(private readonly cfg: HermesRunsConfig) {
    this.fetchImpl = cfg.fetch ?? fetch;
    this.base = cfg.baseUrl.replace(/\/+$/, '');
  }

  private async request(method: string, path: string, init: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}) {
    const timeout = AbortSignal.timeout(this.cfg.requestTimeoutMs ?? 15_000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        signal,
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          Accept: 'application/json',
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (e) {
      throw new AdapterError(`Hermes API unreachable: ${(e as Error).message}`, 'unreachable');
    }
    if (res.status === 401 || res.status === 403) throw new AdapterError('Hermes rejected API_SERVER_KEY', 'unauthorized', res.status);
    if (res.status === 404) throw new AdapterError(`Hermes returned 404 for ${path}`, 'not_found', 404);
    if (res.status === 409) throw new AdapterError(`Hermes returned 409 for ${path}`, 'conflict', 409);
    if (!res.ok) throw new AdapterError(`Hermes returned HTTP ${res.status} for ${path}`, 'bad_response', res.status);
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      throw new AdapterError(`Hermes returned non-JSON for ${path}`, 'bad_response', res.status);
    }
  }

  async probe(): Promise<ProbeResult> {
    const checkedAt = new Date().toISOString();
    const base = { adapter: this.kind, live: true, hermesVersion: this.cfg.hermesVersion ?? null, checkedAt };
    let caps: Record<string, unknown>;
    try {
      caps = await this.request('GET', '/v1/capabilities');
    } catch (e) {
      const err = e as AdapterError;
      return { health: { ...base, state: 'unreachable', detail: clip(err.message, 400) }, enabledToolsets: null };
    }
    const features = (caps.features ?? {}) as Record<string, unknown>;
    const missing = REQUIRED_FEATURES.filter((f) => features[f] !== true);
    if (missing.length > 0) {
      return {
        health: { ...base, state: 'degraded', detail: `Hermes API server lacks required run features: ${missing.join(', ')}` },
        enabledToolsets: null,
      };
    }
    let enabledToolsets: string[] | null = null;
    try {
      const ts = await this.request('GET', '/v1/toolsets');
      const data = Array.isArray(ts.data) ? ts.data : [];
      enabledToolsets = data
        .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object' && (t as Record<string, unknown>).enabled === true)
        .map((t) => String(t.name));
    } catch (e) {
      return {
        health: { ...base, state: 'degraded', detail: `Could not read enabled toolsets: ${clip((e as Error).message, 300)}` },
        enabledToolsets: null,
      };
    }
    return { health: { ...base, state: 'ready', detail: 'Hermes Runs API reachable' }, enabledToolsets };
  }

  async startRun(req: RunRequest): Promise<{ runId: string }> {
    const body = await this.request('POST', '/v1/runs', {
      body: { input: req.input, instructions: req.instructions },
      headers: { 'Idempotency-Key': req.idempotencyKey },
    });
    if (typeof body.run_id !== 'string' || body.run_id.length === 0) {
      throw new AdapterError('Hermes did not return a run_id', 'bad_response');
    }
    return { runId: body.run_id };
  }

  async getRun(runId: string): Promise<RunState | null> {
    let body: Record<string, unknown>;
    try {
      body = await this.request('GET', `/v1/runs/${encodeURIComponent(runId)}`);
    } catch (e) {
      if (e instanceof AdapterError && e.code === 'not_found') return null;
      throw e;
    }
    const status = STATUS_MAP[String(body.status)];
    if (!status) throw new AdapterError(`Unknown Hermes run status: ${clip(body.status, 40)}`, 'bad_response');
    return toRunState(runId, body, status);
  }

  async stopRun(runId: string): Promise<{ accepted: boolean; detail: string }> {
    try {
      const body = await this.request('POST', `/v1/runs/${encodeURIComponent(runId)}/stop`);
      return { accepted: true, detail: `Hermes reported status "${clip(body.status, 40)}"` };
    } catch (e) {
      if (e instanceof AdapterError && (e.code === 'conflict' || e.code === 'not_found')) {
        return { accepted: false, detail: e.message };
      }
      throw e;
    }
  }

  async resolveApproval(runId: string, requestId: string | null, choice: 'once' | 'deny'): Promise<{ resolved: boolean; detail: string }> {
    try {
      const body = await this.request('POST', `/v1/runs/${encodeURIComponent(runId)}/approval`, {
        body: { choice, ...(requestId ? { request_id: requestId } : {}) },
      });
      return { resolved: Number(body.resolved ?? 0) > 0, detail: `Hermes resolved ${String(body.resolved ?? 0)} request(s)` };
    } catch (e) {
      if (e instanceof AdapterError && (e.code === 'conflict' || e.code === 'not_found')) return { resolved: false, detail: e.message };
      throw e;
    }
  }

  async *events(runId: string, opts: { signal: AbortSignal; afterSeq?: number }): AsyncIterable<AdapterRunEvent> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/v1/runs/${encodeURIComponent(runId)}/events`, {
        signal: opts.signal,
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          Accept: 'text/event-stream',
          ...(opts.afterSeq !== undefined ? { 'Last-Event-ID': String(opts.afterSeq) } : {}),
        },
      });
    } catch (e) {
      throw new AdapterError(`Hermes event stream unreachable: ${(e as Error).message}`, 'unreachable');
    }
    if (res.status === 404) throw new AdapterError(`Run ${runId} not found`, 'not_found', 404);
    if (!res.ok || !res.body) throw new AdapterError(`Hermes event stream HTTP ${res.status}`, 'bad_response', res.status);

    for await (const frame of parseSse(res.body as unknown as AsyncIterable<Uint8Array>)) {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(frame.data) as Record<string, unknown>;
      } catch {
        continue; // lenient: never crash on an unexpected frame
      }
      const seq = frame.id !== null && /^\d+$/.test(frame.id) ? Number(frame.id) : null;
      const mapped = mapRunEvent(runId, ev, seq);
      if (mapped) {
        yield mapped;
        if (mapped.type === 'terminal') return;
      }
    }
  }
}

/** Map one Hermes run event to the normalised shape. Returns null for ignored events. */
export function mapRunEvent(runId: string, ev: Record<string, unknown>, seq: number | null): AdapterRunEvent | null {
  const name = String(ev.event ?? '');
  switch (name) {
    case 'message.delta':
      return typeof ev.delta === 'string' ? { type: 'delta', text: ev.delta, seq } : null;
    case 'message.interim':
      return { type: 'progress', summary: clip(ev.text, 200), seq };
    case 'tool.started':
      return { type: 'tool', name: clip(ev.tool, 100), phase: 'started', error: false, seq };
    case 'tool.completed':
      return { type: 'tool', name: clip(ev.tool, 100), phase: 'completed', error: ev.error === true, seq };
    case 'subagent.start':
      return { type: 'progress', summary: 'Hermes started a delegated subagent', seq };
    case 'subagent.complete':
      return { type: 'progress', summary: `Delegated subagent finished (${clip(ev.status, 30)})`, seq };
    case 'approval.request':
      return {
        type: 'approval_requested',
        requestId: typeof ev.request_id === 'string' ? ev.request_id : null,
        summary: clip(ev.description ?? ev.command ?? 'Hermes requested approval for a tool action', 300),
        choices: Array.isArray(ev.choices) ? ev.choices.map(String) : ['once', 'deny'],
        seq,
      };
    case 'run.completed':
      return { type: 'terminal', state: toRunState(runId, ev, 'completed'), seq };
    case 'run.failed':
      return { type: 'terminal', state: toRunState(runId, ev, 'failed'), seq };
    case 'run.cancelled':
      return { type: 'terminal', state: toRunState(runId, ev, 'cancelled'), seq };
    case 'run.interrupted':
      return { type: 'terminal', state: toRunState(runId, ev, 'interrupted'), seq };
    // Hidden reasoning is deliberately dropped; other control events are informational.
    case 'reasoning.available':
    default:
      return null;
  }
}
