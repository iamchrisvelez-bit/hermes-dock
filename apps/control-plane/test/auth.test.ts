import { afterEach, describe, expect, it } from 'vitest';
import { harness, intakeBody, pair, type Harness } from './helpers.ts';

describe('authentication and authorization', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('rejects unauthenticated clients on every command, stream and download', async () => {
    h = await harness();
    for (const [method, url] of [
      ['GET', '/api/world/snapshot'],
      ['GET', '/api/stream'],
      ['GET', '/api/events?after=0'],
      ['GET', '/api/approvals'],
      ['GET', '/api/system'],
      ['GET', '/api/artifacts/art_x/download'],
      ['POST', '/api/intake'],
      ['POST', '/api/controls'],
      ['POST', '/api/tasks/tsk_x/cancel'],
    ] as const) {
      const r = await h.app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
    }
    const health = await h.app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(Object.keys(health.json()).sort()).toEqual(['ok', 'time', 'worldName']);
  });

  it('rejects forged session cookies', async () => {
    h = await harness();
    const r = await h.app.inject({ method: 'GET', url: '/api/world/snapshot', headers: { cookie: 'hdw_session=' + 'A'.repeat(43) } });
    expect(r.statusCode).toBe(401);
  });

  it('pairing codes are single-use and expire', async () => {
    let now = Date.now();
    h = await harness({ overrides: { now: () => now, auth: { pairingTtlMs: 60_000, sessionTtlMs: 3_600_000 } } });
    const { code } = h.ctx.auth.createPairingCode('test');
    const ok = await h.app.inject({ method: 'POST', url: '/api/auth/pair', payload: { code, deviceName: 'phone' } });
    expect(ok.statusCode).toBe(200);
    expect(String(ok.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/);
    const reuse = await h.app.inject({ method: 'POST', url: '/api/auth/pair', payload: { code, deviceName: 'phone2' } });
    expect(reuse.statusCode).toBe(401);

    const { code: code2 } = h.ctx.auth.createPairingCode('test');
    now += 61_000;
    const expired = await h.app.inject({ method: 'POST', url: '/api/auth/pair', payload: { code: code2, deviceName: 'late' } });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error.message).toMatch(/expired/i);
  });

  it('sessions expire', async () => {
    let now = Date.now();
    h = await harness({ overrides: { now: () => now, auth: { pairingTtlMs: 60_000, sessionTtlMs: 120_000 } } });
    const c = await pair(h);
    expect((await c.get('/api/world/snapshot')).status).toBe(200);
    now += 121_000;
    expect((await c.get('/api/world/snapshot')).status).toBe(401);
  });

  it('revoked sessions lose access immediately', async () => {
    h = await harness();
    const phone = await pair(h, 'phone');
    const laptop = await pair(h, 'laptop');
    const list = await laptop.get('/api/auth/sessions');
    const phoneSession = list.json.find((s: { deviceName: string }) => s.deviceName === 'phone');
    const del = await h.app.inject({ method: 'DELETE', url: `/api/auth/sessions/${phoneSession.sessionId}`, headers: { cookie: laptop.cookie, 'x-hdw-csrf': laptop.csrf } });
    expect(del.statusCode).toBe(200);
    expect((await phone.get('/api/world/snapshot')).status).toBe(401);
    expect((await laptop.get('/api/world/snapshot')).status).toBe(200);
  });

  it('requires the CSRF token and an allowed origin for mutations', async () => {
    h = await harness();
    const c = await pair(h);
    const noCsrf = await h.app.inject({ method: 'POST', url: '/api/intake', payload: intakeBody(), headers: { cookie: c.cookie } });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe('csrf_failed');
    const badOrigin = await c.post('/api/intake', intakeBody(), { origin: 'https://evil.example' });
    expect(badOrigin.status).toBe(403);
    const good = await c.post('/api/intake', intakeBody());
    expect(good.status).toBe(200);
  });

  it('rate-limits pairing attempts', async () => {
    h = await harness();
    const codes = [];
    for (let i = 0; i < 6; i++) {
      const r = await h.app.inject({ method: 'POST', url: '/api/auth/pair', payload: { code: 'AAAA-BBBB', deviceName: 'x' } });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes[5]).toBe(429);
  });

  it('never exposes secrets in system info', async () => {
    h = await harness({ config: { hermesApiKey: 'super-secret-key-value' } });
    const c = await pair(h);
    const sys = await c.get('/api/system');
    expect(sys.body).not.toContain('super-secret-key-value');
    const snap = await c.get('/api/world/snapshot');
    expect(snap.body).not.toContain('super-secret-key-value');
    expect(snap.body).not.toContain('csrf');
  });

  it('sets security headers', async () => {
    h = await harness();
    const r = await h.app.inject({ method: 'GET', url: '/api/health' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(String(r.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect(r.headers['cache-control']).toBe('no-store');
  });
});
