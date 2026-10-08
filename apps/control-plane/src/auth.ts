import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { newId, type Role } from '@hdw/contracts';
import type { Store } from './store.ts';

/**
 * Owner authentication.
 *  - No default credentials: the first device pairs with a one-time code printed on the
 *    Mac's terminal (or created with `npm run pair`). Codes expire and are single-use.
 *  - Sessions are opaque random tokens in an HttpOnly, SameSite=Strict cookie; only a
 *    SHA-256 hash is stored, so a database leak does not leak live sessions.
 *  - Mutations additionally require a per-session CSRF token header (double submit).
 *  - Non-owner roles exist in the contracts but cannot be created in this milestone.
 */

export const SESSION_COOKIE = 'hdw_session';
export const CSRF_HEADER = 'x-hdw-csrf';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface AuthConfig {
  pairingTtlMs: number;
  sessionTtlMs: number;
}

export const DEFAULT_AUTH: AuthConfig = { pairingTtlMs: 10 * 60 * 1000, sessionTtlMs: 30 * 24 * 60 * 60 * 1000 };

export interface AuthedSession {
  sessionId: string;
  userId: string;
  role: Role;
  deviceName: string;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export class AuthService {
  constructor(
    private readonly store: Store,
    private readonly cfg: AuthConfig = DEFAULT_AUTH,
    private readonly now: () => number = Date.now,
  ) {}

  private iso(ms: number) {
    return new Date(ms).toISOString();
  }

  ownerExists(): boolean {
    return !!this.store.db.prepare("SELECT 1 FROM users WHERE role = 'owner'").get();
  }

  /** Create a one-time pairing code. Returns the plaintext once; only its hash is stored. */
  createPairingCode(createdBy: string): { code: string; expiresAt: string } {
    let raw = '';
    for (let i = 0; i < 8; i++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    const now = this.now();
    const expiresAt = this.iso(now + this.cfg.pairingTtlMs);
    this.store.db
      .prepare('INSERT INTO pairing_codes (code_hash, created_at, expires_at, created_by) VALUES (?,?,?,?)')
      .run(sha256(code), this.iso(now), expiresAt, createdBy);
    this.store.audit(createdBy, 'pairing_code.created', 'ok');
    return { code, expiresAt };
  }

  /** Redeem a pairing code for a new owner session. Single-use; expired codes fail. */
  pair(code: string, deviceName: string): { token: string; session: AuthedSession } | { error: 'invalid' | 'expired' } {
    const now = this.now();
    const row = this.store.db.prepare('SELECT * FROM pairing_codes WHERE code_hash = ?').get(sha256(code)) as
      | { expires_at: string; used_at: string | null }
      | undefined;
    if (!row || row.used_at) {
      this.store.audit('anonymous', 'pair', 'denied', null, { reason: 'invalid' });
      return { error: 'invalid' };
    }
    if (Date.parse(row.expires_at) <= now) {
      this.store.audit('anonymous', 'pair', 'denied', null, { reason: 'expired' });
      return { error: 'expired' };
    }
    return this.store.commit(() => {
      const used = this.store.db
        .prepare('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL')
        .run(this.iso(now), sha256(code));
      if (Number(used.changes) !== 1) return { error: 'invalid' as const };
      let owner = this.store.db.prepare("SELECT id FROM users WHERE role = 'owner'").get() as { id: string } | undefined;
      if (!owner) {
        owner = { id: newId('usr') };
        this.store.db
          .prepare('INSERT INTO users (id, display_name, role, created_at) VALUES (?,?,?,?)')
          .run(owner.id, 'Owner', 'owner', this.iso(now));
      }
      const token = randomBytes(32).toString('base64url');
      const session: AuthedSession = {
        sessionId: newId('ses'),
        userId: owner.id,
        role: 'owner',
        deviceName: deviceName.slice(0, 60),
        csrfToken: randomBytes(24).toString('base64url'),
        createdAt: this.iso(now),
        expiresAt: this.iso(now + this.cfg.sessionTtlMs),
      };
      this.store.db
        .prepare(
          'INSERT INTO sessions (id, user_id, token_hash, csrf_token, device_name, created_at, last_seen_at, expires_at) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(session.sessionId, owner.id, sha256(token), session.csrfToken, session.deviceName, session.createdAt, session.createdAt, session.expiresAt);
      this.store.audit(owner.id, 'pair', 'ok', session.sessionId, { deviceName: session.deviceName });
      return { token, session };
    });
  }

  /** Resolve a session token. Revoked or expired sessions are rejected. */
  verify(token: string | undefined): AuthedSession | null {
    if (!token || token.length < 20 || token.length > 100) return null;
    const r = this.store.db
      .prepare(
        'SELECT s.*, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.revoked_at IS NULL',
      )
      .get(sha256(token)) as Record<string, string> | undefined;
    if (!r) return null;
    const now = this.now();
    if (Date.parse(r.expires_at!) <= now) return null;
    // Touch at most once a minute to keep writes low.
    if (now - Date.parse(r.last_seen_at!) > 60_000) {
      this.store.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(this.iso(now), r.id!);
    }
    return {
      sessionId: r.id!,
      userId: r.user_id!,
      role: r.role as Role,
      deviceName: r.device_name!,
      csrfToken: r.csrf_token!,
      createdAt: r.created_at!,
      expiresAt: r.expires_at!,
    };
  }

  checkCsrf(session: AuthedSession, header: string | undefined): boolean {
    return !!header && safeEqual(header, session.csrfToken);
  }

  listSessions(userId: string) {
    return this.store.db
      .prepare(
        'SELECT id, device_name, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at',
      )
      .all(userId) as Array<Record<string, string>>;
  }

  revoke(userId: string, sessionId: string, actor: string): boolean {
    const res = this.store.db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
      .run(this.iso(this.now()), sessionId, userId);
    const ok = Number(res.changes) === 1;
    this.store.audit(actor, 'session.revoke', ok ? 'ok' : 'denied', sessionId);
    if (ok) this.store.bus.emit('session_revoked', sessionId);
    return ok;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

export function sessionCookie(token: string, opts: { secure: boolean; maxAgeSec: number }): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${opts.maxAgeSec}`,
    ...(opts.secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  return [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0', ...(secure ? ['Secure'] : [])].join('; ');
}

/** Fixed-window limiter keyed by caller; small and in-memory (single-process control plane). */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): { ok: boolean; retryAfterSec: number } {
    const t = this.now();
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
      return { ok: true, retryAfterSec: 0 };
    }
    cur.count += 1;
    if (cur.count > this.limit) return { ok: false, retryAfterSec: Math.ceil((cur.resetAt - t) / 1000) };
    return { ok: true, retryAfterSec: 0 };
  }
}
