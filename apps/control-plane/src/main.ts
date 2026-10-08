import { loadConfig } from './config.ts';
import { createContext } from './context.ts';
import { buildServer } from './server.ts';

const config = loadConfig();
const ctx = await createContext(config);
const app = await buildServer(ctx);

if (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1') {
  console.warn(
    `[warning] Listening on ${config.host}. Only bind beyond localhost on a private network (e.g. your Tailscale address). ` +
      'Never forward a router port to this service.',
  );
}

await app.listen({ host: config.host, port: config.port });
await ctx.runner.recover();

const mode = ctx.adapter.live ? `LIVE Hermes (${config.hermesApiUrl})` : 'DEMO (deterministic mock adapter, no AI model)';
console.log(`\n${config.worldName} control plane on http://${config.host}:${config.port}  [${mode}]`);
console.log(`Adapter: ${ctx.world.adapterHealth.state} — ${ctx.world.adapterHealth.detail}`);
if (!config.clientDist) console.log('Client not built: run `npm run build:client`, or use `npm run dev` for the Vite dev server.');

// No default credentials: print a one-time pairing code only on THIS terminal.
const { code, expiresAt } = ctx.auth.createPairingCode('startup');
console.log(`\nOne-time pairing code: ${code}  (expires ${new Date(expiresAt).toLocaleTimeString()})`);
console.log('Open the app, enter this code, and the device becomes an owner session. Run `npm run pair` for a new code.\n');

const shutdown = async (sig: string) => {
  console.log(`Received ${sig}; shutting down (Hermes runs keep running and are reconciled on restart).`);
  await app.close();
  await ctx.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
