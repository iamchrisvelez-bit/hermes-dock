import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { ZodError, z } from 'zod';
import {
  ArchiveProjectRequest,
  ControlsRequest,
  DecideApprovalRequest,
  IntakeRequest,
  PairRequest,
  RequestIslandDestruction,
  type ApiErrorCode,
  type SessionInfo,
  type WorldEvent,
} from '@hdw/contracts';
import { AdapterError } from '@hdw/hermes-adapter';
import { CSRF_HEADER, RateLimiter, SESSION_COOKIE, clearSessionCookie, parseCookies, sessionCookie, type AuthedSession } from './auth.ts';
import type { AppContext } from './context.ts';
import { DomainError } from './world.ts';

declare module 'fastify' {
  interface FastifyRequest {
    session: AuthedSession | null;
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

const PUBLIC_ROUTES = new Set(['GET /api/health', 'POST /api/auth/pair', 'GET /api/auth/session']);
const MAX_REPLAY = 1000;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': CSP,
};

export async function buildServer(ctx: AppContext) {
  const { config, store, world, runner, auth } = ctx;
  const app = Fastify({
    bodyLimit: 8 * 1024 * 1024,
    trustProxy: false,
    logger: {
      level: config.logLevel,
      redact: {
        paths: ['req.headers.cookie', 'req.headers.authorization', `req.headers["${CSRF_HEADER}"]`, 'res.headers["set-cookie"]'],
        censor: '[redacted]',
      },
    },
  });

  const pairLimiter = new RateLimiter(5, 60_000);
  const commandLimiter = new RateLimiter(60, 60_000);
  const intakeLimiter = new RateLimiter(10, 60_000);

  app.decorateRequest('session', null);

  app.addHook('onSend', async (req, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // ---------- Authentication / authorization gate ----------
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const routeKey = `${req.method} ${req.url.split('?')[0]}`;
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    req.session = auth.verify(token);
    if (PUBLIC_ROUTES.has(routeKey)) return;
    if (!req.session) throw new HttpError(401, 'unauthorized', 'Pair this device to continue.');
    if (req.session.role !== 'owner') {
      // Operator/viewer roles exist in contracts but are disabled in this milestone.
      throw new HttpError(403, 'forbidden', 'Only the owner has access in this release.');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && !config.allowedOrigins.includes(origin)) {
        store.audit(req.session.userId, 'origin_check', 'denied', null, { origin });
        throw new HttpError(403, 'csrf_failed', 'Request origin is not allowed.');
      }
      if (!auth.checkCsrf(req.session, req.headers[CSRF_HEADER] as string | undefined)) {
        store.audit(req.session.userId, 'csrf_check', 'denied');
        throw new HttpError(403, 'csrf_failed', 'Missing or invalid CSRF token.');
      }
      const rl = commandLimiter.take(req.session.sessionId);
      if (!rl.ok) throw new HttpError(429, 'rate_limited', `Too many commands; retry in ${rl.retryAfterSec}s.`);
    }
  });

  app.setErrorHandler((rawErr: Error, req, reply) => {
    const err = rawErr as Error & { code?: string; statusCode?: number };
    let status = 500;
    let code: ApiErrorCode = 'internal';
    let message = 'Internal error';
    let detail: unknown;
    if (err instanceof HttpError) {
      ({ status, code, message, detail } = err);
    } else if (err instanceof ZodError) {
      status = 400;
      code = 'bad_request';
      message = 'Request failed validation';
      detail = err.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message }));
    } else if (err instanceof DomainError) {
      code = err.code;
      message = err.message;
      status = { bad_request: 400, not_found: 404, conflict: 409, policy_denied: 403, payload_too_large: 413, unsupported_media: 415 }[err.code];
    } else if (err instanceof AdapterError) {
      status = 502;
      message = `Hermes adapter error: ${err.message}`;
    } else if (err.code === 'not_found' || err.code === 'conflict') {
      const c = err.code;
      status = c === 'not_found' ? 404 : 409;
      code = c;
      message = err.message;
    } else if (err.statusCode === 413) {
      status = 413;
      code = 'payload_too_large';
      message = 'Request body too large';
    } else if (err.statusCode && err.statusCode < 500) {
      status = err.statusCode;
      code = 'bad_request';
      message = err.message;
    }
    if (status >= 500) req.log.error({ err }, 'request failed');
    if (status === 429) reply.header('Retry-After', '60');
    reply.status(status).send({ error: { code, message, ...(detail !== undefined ? { detail } : {}) } });
  });

  const owner = (req: FastifyRequest) => ({ userId: req.session!.userId });
  const idParam = z.object({ id: z.string().min(1).max(80).regex(/^[a-z]+_[A-Za-z0-9]+$/) });

  // ---------- Public ----------
  app.get('/api/health', async () => ({ ok: true, worldName: config.worldName, time: new Date().toISOString() }));

  app.post('/api/auth/pair', async (req, reply) => {
    const rl = pairLimiter.take(req.ip);
    if (!rl.ok) throw new HttpError(429, 'rate_limited', `Too many pairing attempts; retry in ${rl.retryAfterSec}s.`);
    const body = PairRequest.parse(req.body);
    const out = auth.pair(body.code.toUpperCase(), body.deviceName);
    if ('error' in out) throw new HttpError(401, 'unauthorized', out.error === 'expired' ? 'Pairing code expired.' : 'Invalid pairing code.');
    reply.header('Set-Cookie', sessionCookie(out.token, { secure: config.secureCookies, maxAgeSec: Math.floor((Date.parse(out.session.expiresAt) - Date.now()) / 1000) }));
    return toSessionInfo(out.session);
  });

  app.get('/api/auth/session', async (req) => {
    if (!req.session) throw new HttpError(401, 'unauthorized', 'Not paired.');
    return toSessionInfo(req.session);
  });

  // ---------- Session management ----------
  app.post('/api/auth/logout', async (req, reply) => {
    auth.revoke(req.session!.userId, req.session!.sessionId, req.session!.userId);
    reply.header('Set-Cookie', clearSessionCookie(config.secureCookies));
    return { ok: true };
  });

  app.get('/api/auth/sessions', async (req) =>
    auth.listSessions(req.session!.userId).map((s) => ({
      sessionId: s.id,
      deviceName: s.device_name,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      expiresAt: s.expires_at,
      current: s.id === req.session!.sessionId,
    })),
  );

  app.delete('/api/auth/sessions/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    if (!auth.revoke(req.session!.userId, id, req.session!.userId)) throw new HttpError(404, 'not_found', 'Session not found');
    return { ok: true };
  });

  // ---------- World ----------
  app.get('/api/world/snapshot', async () => world.snapshot());

  app.get('/api/system', async () => ({
    worldName: config.worldName,
    adapter: world.adapterHealth,
    sandbox: world.sandbox,
    policy: config.policy,
    enabledHermesToolsets: world.enabledToolsets,
    dataProcessingNotice:
      config.adapter === 'hermes-runs'
        ? 'Hermes uses the model provider configured on this Mac. Project text may be sent to that provider.'
        : 'Mock adapter: no model provider is contacted.',
  }));

  app.get('/api/events', async (req) => {
    const q = z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(MAX_REPLAY).default(200) }).parse(req.query);
    const oldest = store.oldestSeq();
    const latest = store.latestSeq();
    if (q.after > latest) throw new HttpError(410, 'cursor_expired', 'Cursor is ahead of the server; fetch a snapshot.', { latestSeq: latest });
    if (oldest > 0 && q.after < oldest - 1) throw new HttpError(410, 'cursor_expired', 'Events before this cursor were pruned; fetch a snapshot.', { latestSeq: latest });
    return { events: store.eventsAfter(q.after, q.limit), latestSeq: latest, oldestSeq: oldest };
  });

  app.get('/api/stream', (req, reply) => streamEvents(ctx, req, reply));

  // ---------- Intake ----------
  app.post('/api/intake', async (req) => {
    const rl = intakeLimiter.take(req.session!.sessionId);
    if (!rl.ok) throw new HttpError(429, 'rate_limited', `Too many submissions; retry in ${rl.retryAfterSec}s.`);
    const body = IntakeRequest.parse(req.body);
    const res = world.intake(body, owner(req));
    if (res.outcome === 'project_created') runner.kick();
    return res;
  });

  // ---------- Projects ----------
  app.get('/api/projects/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const project = store.get('projects', id);
    if (!project) throw new HttpError(404, 'not_found', 'Project not found');
    const tasks = store.list('tasks', 'project_id = ?', id);
    const taskIds = new Set(tasks.map((t) => t.id));
    return {
      project,
      island: project.islandId ? store.get('islands', project.islandId) ?? null : null,
      tasks,
      attempts: store.list('task_attempts').filter((a) => taskIds.has(a.taskId)),
      reviews: store.list('reviews').filter((r) => taskIds.has(r.taskId)),
      artifacts: store.list('artifacts', 'project_id = ?', id),
      agents: store.list('agents', 'project_id = ?', id),
      approvals: store.list('approvals').filter((a) => a.subject.id === id || a.subject.id === project.islandId || taskIds.has(a.subject.id)),
    };
  });

  app.post('/api/projects/:id/archive', async (req) => {
    const { id } = idParam.parse(req.params);
    const { preset } = ArchiveProjectRequest.parse(req.body ?? {});
    return world.archiveProject(id, preset, owner(req));
  });

  app.post('/api/projects/:id/destroy-island', async (req) => {
    const { id } = idParam.parse(req.params);
    const { preset } = RequestIslandDestruction.parse(req.body);
    return world.requestIslandDestruction(id, preset, owner(req));
  });

  app.post('/api/projects/:id/delete-data', async (req) => {
    const { id } = idParam.parse(req.params);
    return world.requestDataDeletion(id, owner(req));
  });

  // ---------- Tasks ----------
  app.post('/api/tasks/:id/cancel', async (req) => {
    const { id } = idParam.parse(req.params);
    return runner.cancelTask(id, req.session!.userId);
  });

  app.post('/api/tasks/:id/retry', async (req) => {
    const { id } = idParam.parse(req.params);
    return runner.retryTask(id, req.session!.userId);
  });

  // ---------- Agents ----------
  app.get('/api/agents/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const agent = store.get('agents', id);
    if (!agent) throw new HttpError(404, 'not_found', 'Agent not found');
    const sessions = store.db
      .prepare('SELECT id, attempt_id, adapter, external_run_id, status, started_at, ended_at FROM agent_sessions WHERE agent_id = ? ORDER BY rowid DESC LIMIT 20')
      .all(id);
    return { agent, runtimeSessions: sessions, tasks: store.list('tasks', 'assigned_agent_id = ?', id) };
  });

  // ---------- Approvals ----------
  app.get('/api/approvals', async () => store.list('approvals'));

  app.post('/api/approvals/:id/decide', async (req) => {
    const { id } = idParam.parse(req.params);
    const { decision } = DecideApprovalRequest.parse(req.body);
    return world.decideApproval(id, decision, owner(req), { onToolApproval: (a, choice) => runner.resolveToolApproval(a, choice) });
  });

  // ---------- Controls ----------
  app.get('/api/controls', async () => store.controls());

  app.post('/api/controls', async (req) => {
    const { action } = ControlsRequest.parse(req.body);
    const c = world.setControls(action, owner(req));
    if (c.pauseAll) runner.pauseAll();
    else runner.kick();
    return c;
  });

  // ---------- Artifacts ----------
  app.get('/api/artifacts/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const raw = store.rawArtifact(id);
    if (!raw) throw new HttpError(404, 'not_found', 'Artifact not found');
    const file = world.artifactPath(raw.relPath);
    const text = existsSync(file) ? readFileSync(file, 'utf8') : null;
    return { artifact: raw.artifact, preview: text === null ? null : text.slice(0, 64 * 1024), truncated: (text?.length ?? 0) > 64 * 1024, available: text !== null };
  });

  app.get('/api/artifacts/:id/download', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const raw = store.rawArtifact(id);
    if (!raw) throw new HttpError(404, 'not_found', 'Artifact not found');
    const file = world.artifactPath(raw.relPath);
    if (!existsSync(file)) throw new HttpError(404, 'not_found', 'Artifact file no longer exists');
    const safeName = raw.artifact.displayName.replace(/[^A-Za-z0-9._-]/g, '_');
    store.audit(req.session!.userId, 'artifact.download', 'ok', id);
    reply
      .header('Content-Type', raw.artifact.mediaType === 'application/json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${safeName}"`)
      .header('Content-Security-Policy', "sandbox; default-src 'none'");
    return readFileSync(file);
  });

  app.all('/api/*', async () => {
    throw new HttpError(404, 'not_found', 'No such endpoint');
  });

  // ---------- Client (built PWA) ----------
  if (config.clientDist && existsSync(path.join(config.clientDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.clientDist, prefix: '/', index: ['index.html'], wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.type('text/html').sendFile('index.html');
      reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
    });
  }

  return app;
}

function toSessionInfo(s: AuthedSession): SessionInfo {
  return { sessionId: s.sessionId, userId: s.userId, role: s.role, deviceName: s.deviceName, csrfToken: s.csrfToken, createdAt: s.createdAt, expiresAt: s.expiresAt };
}

/**
 * Authenticated SSE stream. Resumes after `Last-Event-ID` / `?after=`; if that cursor is
 * not available it tells the client to re-snapshot instead of silently skipping events.
 * A heartbeat carries `latestSeq` + server time so the client can show the last
 * confirmed update and detect a sleeping/offline Mac.
 */
function streamEvents(ctx: AppContext, req: FastifyRequest, reply: FastifyReply) {
  const { store, auth } = ctx;
  const session = req.session!;
  const q = z.object({ after: z.coerce.number().int().min(0).optional() }).parse(req.query);
  const header = req.headers['last-event-id'];
  const after = header !== undefined && /^\d+$/.test(String(header)) ? Number(header) : (q.after ?? store.latestSeq());

  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...SECURITY_HEADERS,
  });
  const write = (s: string) => {
    if (!res.writableEnded) res.write(s);
  };
  const send = (ev: WorldEvent) => write(`id: ${ev.seq}\nevent: world\ndata: ${JSON.stringify(ev)}\n\n`);
  const control = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  let cursor = after;
  let closed = false;
  let hb: ReturnType<typeof setInterval> | undefined;
  const buffered: WorldEvent[] = [];
  let replaying = true;
  const onEvent = (ev: WorldEvent) => {
    if (replaying) buffered.push(ev);
    else if (ev.seq > cursor) {
      cursor = ev.seq;
      send(ev);
    }
  };
  const onRevoked = (sid: string) => {
    if (sid === session.sessionId) {
      control('session_revoked', {});
      close();
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    if (hb) clearInterval(hb);
    store.bus.off('event', onEvent);
    store.bus.off('session_revoked', onRevoked);
    if (!res.writableEnded) res.end();
  };
  store.bus.on('event', onEvent);
  store.bus.on('session_revoked', onRevoked);
  req.raw.on('close', close);

  write(': connected\n\n');
  const latest = store.latestSeq();
  const oldest = store.oldestSeq();
  if (after > latest) {
    control('snapshot_required', { reason: 'cursor_ahead', latestSeq: latest });
    close();
    return;
  }
  if (oldest > 0 && after < oldest - 1) {
    control('snapshot_required', { reason: 'cursor_expired', latestSeq: latest });
    close();
    return;
  }
  const backlog = store.eventsAfter(after, MAX_REPLAY + 1);
  if (backlog.length > MAX_REPLAY) {
    control('snapshot_required', { reason: 'cursor_expired', latestSeq: latest });
    close();
    return;
  }
  for (const ev of backlog) {
    cursor = ev.seq;
    send(ev);
  }
  replaying = false;
  for (const ev of buffered) if (ev.seq > cursor) {
    cursor = ev.seq;
    send(ev);
  }
  control('ready', { cursor, serverTime: new Date().toISOString() });

  hb = setInterval(() => {
    // Re-validate on every heartbeat: an expired or revoked session loses the stream.
    if (!auth.verify(parseCookies(req.headers.cookie)[SESSION_COOKIE])) {
      control('session_revoked', {});
      close();
      return;
    }
    control('heartbeat', { latestSeq: store.latestSeq(), serverTime: new Date().toISOString() });
  }, 10_000);
  hb.unref();
}
