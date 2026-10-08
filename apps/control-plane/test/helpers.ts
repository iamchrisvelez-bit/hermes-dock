import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { WorldSnapshot } from '@hdw/contracts';
import { MockHermesAdapter, type HermesAdapter, type MockScenario } from '@hdw/hermes-adapter';
import { DEFAULT_POLICY, type OwnerPolicy } from '@hdw/workspace-policy';
import { loadConfig, type AppConfig } from '../src/config.ts';
import { createContext, type AppContext, type ContextOverrides } from '../src/context.ts';
import { buildServer } from '../src/server.ts';

export interface Harness {
  ctx: AppContext;
  app: FastifyInstance;
  dataDir: string;
  close(opts?: { keepData?: boolean }): Promise<void>;
}

export function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'hdw-test-'));
}

export async function harness(
  opts: {
    dataDir?: string;
    scenario?: MockScenario;
    adapter?: HermesAdapter;
    policy?: Partial<OwnerPolicy>;
    overrides?: ContextOverrides;
    config?: Partial<AppConfig>;
    skipRecover?: boolean;
  } = {},
): Promise<Harness> {
  const dataDir = opts.dataDir ?? tempDir();
  const base = loadConfig({ HDW_DATA_DIR: dataDir, HDW_LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv, process.cwd());
  const config: AppConfig = { ...base, clientDist: null, policy: { ...DEFAULT_POLICY, ...opts.policy }, ...opts.config };
  const ctx = await createContext(config, {
    adapter: opts.adapter ?? new MockHermesAdapter({ stepMs: 2, scenario: opts.scenario ?? 'revise_once' }),
    runner: { reviewDelayMs: 0, verifyPollMs: 10, verifyTimeoutMs: 2_000, log: { info() {}, warn() {}, error: (o: object, m?: string) => process.env.HDW_TEST_DEBUG && console.error(m, o) } },
    skipHostProbe: true,
    ...opts.overrides,
  });
  const app = await buildServer(ctx);
  await app.ready();
  // Same startup sequence as main.ts: reconcile with the runtime before serving work.
  if (!opts.skipRecover) await ctx.runner.recover();
  return {
    ctx,
    app,
    dataDir,
    async close(o = {}) {
      await app.close();
      await ctx.close();
      if (!o.keepData) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export interface Client {
  cookie: string;
  csrf: string;
  get(url: string): Promise<{ status: number; json: any; body: string; headers: Record<string, unknown> }>;
  post(url: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<{ status: number; json: any }>;
}

export async function pair(h: Harness, deviceName = 'test-phone'): Promise<Client> {
  const { code } = h.ctx.auth.createPairingCode('test');
  const res = await h.app.inject({ method: 'POST', url: '/api/auth/pair', payload: { code, deviceName } });
  if (res.statusCode !== 200) throw new Error(`pair failed: ${res.body}`);
  const setCookie = String(res.headers['set-cookie']);
  const cookie = setCookie.split(';')[0]!;
  const csrf = res.json().csrfToken as string;
  return clientFor(h, cookie, csrf);
}

export function clientFor(h: Harness, cookie: string, csrf: string): Client {
  return {
    cookie,
    csrf,
    async get(url) {
      const r = await h.app.inject({ method: 'GET', url, headers: { cookie } });
      let json: unknown = null;
      try {
        json = r.json();
      } catch {
        /* non-JSON */
      }
      return { status: r.statusCode, json, body: r.body, headers: r.headers };
    },
    async post(url, body = {}, extra = {}) {
      const r = await h.app.inject({ method: 'POST', url, payload: body as object, headers: { cookie, 'x-hdw-csrf': csrf, ...extra } });
      return { status: r.statusCode, json: r.json() };
    },
  };
}

export const BRIEF = [
  '# Garden Planner',
  '',
  'I want to build a small app that plans a vegetable garden for my family.',
  'It must work offline. Budget is limited to free tools.',
  'Risk: plant data sources are unclear.',
].join('\n');

export function b64(s: string) {
  return Buffer.from(s, 'utf8').toString('base64');
}

let keyCounter = 0;
export function intakeBody(extra: Record<string, unknown> = {}) {
  keyCounter += 1;
  return {
    prompt: 'Read this provided project brief and create a Markdown implementation plan with milestones, risks, and acceptance criteria.',
    files: [{ name: 'brief.md', contentBase64: b64(BRIEF) }],
    idempotencyKey: `idem-key-${Date.now()}-${keyCounter}`,
    ...extra,
  };
}

export async function waitFor<T>(fn: () => T | Promise<T>, pred: (v: T) => boolean, timeoutMs = 8_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await fn();
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 15));
  } while (Date.now() < end);
  throw new Error(`waitFor timed out; last value: ${JSON.stringify(last).slice(0, 600)}`);
}

export async function snapshot(c: Client): Promise<WorldSnapshot> {
  const r = await c.get('/api/world/snapshot');
  if (r.status !== 200) throw new Error(`snapshot ${r.status}`);
  return r.json as WorldSnapshot;
}
