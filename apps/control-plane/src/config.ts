import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_POLICY, OwnerPolicy } from '@hdw/workspace-policy';
import type { MockScenario } from '@hdw/hermes-adapter';

export interface AppConfig {
  /** Configurable working name; not a final brand. */
  worldName: string;
  host: string;
  port: number;
  dataDir: string;
  dbFile: string;
  adapter: 'mock' | 'hermes-runs';
  hermesApiUrl: string;
  /** Read from env only; never logged, never sent to the client. */
  hermesApiKey: string;
  mockStepMs: number;
  mockScenario: MockScenario;
  /** Set Secure on cookies. Auto-on when the public origin is https. */
  secureCookies: boolean;
  /** Allowed browser origins for mutating requests (defense in depth beyond SameSite + CSRF). */
  allowedOrigins: string[];
  clientDist: string | null;
  policy: OwnerPolicy;
  eventRetention: number;
  logLevel: string;
}

function bool(v: string | undefined, d: boolean) {
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AppConfig {
  const dataDir = path.resolve(cwd, env.HDW_DATA_DIR ?? 'data');
  const port = Number(env.HDW_PORT ?? 8787);
  const host = env.HDW_HOST ?? '127.0.0.1';
  const publicOrigin = env.HDW_PUBLIC_ORIGIN ?? '';
  let policy = DEFAULT_POLICY;
  const policyFile = env.HDW_POLICY_FILE;
  if (policyFile) {
    const p = path.resolve(cwd, policyFile);
    if (!existsSync(p)) throw new Error(`HDW_POLICY_FILE not found: ${p}`);
    policy = OwnerPolicy.parse({ ...DEFAULT_POLICY, ...JSON.parse(readFileSync(p, 'utf8')) });
  }
  const adapter = (env.HDW_ADAPTER ?? 'mock') as AppConfig['adapter'];
  if (adapter !== 'mock' && adapter !== 'hermes-runs') throw new Error(`HDW_ADAPTER must be mock or hermes-runs`);
  if (adapter === 'hermes-runs' && !env.HERMES_API_KEY) {
    throw new Error('HDW_ADAPTER=hermes-runs requires HERMES_API_KEY (the API_SERVER_KEY from ~/.hermes/.env).');
  }
  const defaultDist = path.resolve(cwd, 'apps/mobile-client/dist');
  const clientDist = env.HDW_CLIENT_DIST ? path.resolve(cwd, env.HDW_CLIENT_DIST) : existsSync(defaultDist) ? defaultDist : null;
  return {
    worldName: env.HDW_WORLD_NAME ?? 'HERMES DIGITAL WORLD',
    host,
    port,
    dataDir,
    dbFile: path.join(dataDir, 'world.sqlite'),
    adapter,
    hermesApiUrl: env.HERMES_API_URL ?? 'http://127.0.0.1:8642',
    hermesApiKey: env.HERMES_API_KEY ?? '',
    mockStepMs: Number(env.HDW_MOCK_STEP_MS ?? 700),
    mockScenario: (env.HDW_MOCK_SCENARIO ?? 'revise_once') as MockScenario,
    secureCookies: bool(env.HDW_SECURE_COOKIES, publicOrigin.startsWith('https://')),
    allowedOrigins: [
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      ...(publicOrigin ? [publicOrigin.replace(/\/+$/, '')] : []),
      ...(env.HDW_EXTRA_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    ],
    clientDist,
    policy,
    eventRetention: Number(env.HDW_EVENT_RETENTION ?? 0),
    logLevel: env.HDW_LOG_LEVEL ?? 'info',
  };
}
