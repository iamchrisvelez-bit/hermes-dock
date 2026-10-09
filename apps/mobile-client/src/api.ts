import type { SessionInfo } from '@hdw/contracts';

/**
 * Same-origin API client. The session lives in an HttpOnly cookie the page cannot read;
 * the only token held in memory is the per-session CSRF token. Nothing is persisted in
 * browser storage.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let csrf: string | null = null;

export function setCsrf(token: string | null) {
  csrf = token;
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export async function get<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  } catch {
    throw new ApiError(0, 'offline', 'The Mac could not be reached.');
  }
  return parse<T>(res);
}

export async function send<T>(method: 'POST' | 'DELETE', url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(csrf ? { 'X-HDW-CSRF': csrf } : {}) },
      body: body === undefined ? (method === 'POST' ? '{}' : undefined) : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'offline', 'The Mac could not be reached; nothing was sent.');
  }
  return parse<T>(res);
}

export const post = <T>(url: string, body?: unknown) => send<T>('POST', url, body);

export async function pair(code: string, deviceName: string): Promise<SessionInfo> {
  const s = await post<SessionInfo>('/api/auth/pair', { code: code.trim().toUpperCase(), deviceName });
  setCsrf(s.csrfToken);
  return s;
}

export async function currentSession(): Promise<SessionInfo | null> {
  try {
    const s = await get<SessionInfo>('/api/auth/session');
    setCsrf(s.csrfToken);
    return s;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

/** Read a File as base64 of its raw bytes (server validates the encoding itself). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
