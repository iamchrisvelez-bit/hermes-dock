import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HermesRunsAdapter, MockHermesAdapter, type HermesAdapter } from '@hdw/hermes-adapter';
import { sandboxReport } from '@hdw/workspace-policy';
import { AuthService, DEFAULT_AUTH, type AuthConfig } from './auth.ts';
import type { AppConfig } from './config.ts';
import { openDb } from './db.ts';
import { TaskRunner, type RunnerOptions } from './runner.ts';
import { EventBus, Store } from './store.ts';
import { WorldService } from './world.ts';

const exec = promisify(execFile);

export interface AppContext {
  config: AppConfig;
  store: Store;
  world: WorldService;
  runner: TaskRunner;
  auth: AuthService;
  adapter: HermesAdapter;
  close(): Promise<void>;
}

async function commandExists(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec(cmd, args, { timeout: 5000 });
    return stdout.trim().split('\n')[0]?.slice(0, 80) ?? '';
  } catch {
    return null;
  }
}

export interface ContextOverrides {
  adapter?: HermesAdapter;
  runner?: Partial<RunnerOptions>;
  auth?: AuthConfig;
  now?: () => number;
  skipHostProbe?: boolean;
}

export async function createContext(config: AppConfig, o: ContextOverrides = {}): Promise<AppContext> {
  const db = openDb(config.dbFile);
  const store = new Store(db, new EventBus());

  // Read-only host probes: version strings only. Nothing is installed or changed.
  const hermesVersion = o.skipHostProbe ? null : await commandExists('hermes', ['--version']);
  const docker = o.skipHostProbe ? null : await commandExists('docker', ['--version']);

  const adapter =
    o.adapter ??
    (config.adapter === 'hermes-runs'
      ? new HermesRunsAdapter({ baseUrl: config.hermesApiUrl, apiKey: config.hermesApiKey, hermesVersion })
      : new MockHermesAdapter({ stepMs: config.mockStepMs, scenario: config.mockScenario }));

  const probe = await adapter.probe();
  const world = new WorldService(store, config, probe.health, sandboxReport({ dockerCli: docker !== null }));
  world.enabledToolsets = probe.enabledToolsets;
  world.bootstrap();
  world.setAdapterHealth(probe.health);

  const log = {
    info: (obj: object, msg?: string) => console.log(JSON.stringify({ level: 'info', msg, ...obj })),
    warn: (obj: object, msg?: string) => console.warn(JSON.stringify({ level: 'warn', msg, ...obj })),
    error: (obj: object, msg?: string) => console.error(JSON.stringify({ level: 'error', msg, ...obj })),
  };
  const runner = new TaskRunner(world, adapter, {
    verifyTimeoutMs: 15_000,
    verifyPollMs: 500,
    reviewDelayMs: 900,
    log,
    ...o.runner,
  });
  const auth = new AuthService(store, o.auth ?? DEFAULT_AUTH, o.now);

  // Periodic adapter health check so the client sees Hermes going away honestly.
  const healthTimer = setInterval(async () => {
    try {
      const p = await adapter.probe();
      world.enabledToolsets = p.enabledToolsets;
      world.setAdapterHealth(p.health);
    } catch {
      /* probe never throws by contract; ignore */
    }
  }, 30_000);
  healthTimer.unref();

  // Optional event retention (state tables remain authoritative).
  if (config.eventRetention > 0) {
    const latest = store.latestSeq();
    if (latest > config.eventRetention) store.pruneEventsBefore(latest - config.eventRetention);
  }

  return {
    config,
    store,
    world,
    runner,
    auth,
    adapter,
    async close() {
      clearInterval(healthTimer);
      await runner.stop();
      db.close();
    },
  };
}
