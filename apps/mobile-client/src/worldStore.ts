import { useSyncExternalStore } from 'react';
import type { SessionInfo, WorldEvent, WorldSnapshot } from '@hdw/contracts';
import { foldEvent } from '@hdw/world-projection';
import type { Lifecycle } from '@hdw/world-renderer';
import { ApiError, currentSession, get, pair as apiPair, setCsrf } from './api.ts';

/**
 * Client-side world state. The server is authoritative: this store holds the last
 * snapshot plus live events folded in order. Connection status is explicit so the UI
 * never labels cached state as live:
 *   live      – stream open and a heartbeat/event arrived recently
 *   connecting– (re)connecting; showing the last confirmed state
 *   stale     – stream open but silent too long (Mac asleep, network gone)
 *   offline   – the device itself is offline or the Mac refused the connection
 */
export type ConnStatus = 'connecting' | 'live' | 'stale' | 'offline';

export interface TimelineItem {
  seq: number;
  ts: string;
  type: WorldEvent['type'];
  summary: string;
  islandId?: string;
  preset?: Lifecycle['preset'];
}

export interface State {
  auth: 'unknown' | 'unpaired' | 'paired';
  session: SessionInfo | null;
  worldName: string;
  world: WorldSnapshot | null;
  conn: ConnStatus;
  /** Server time of the last confirmed message (event or heartbeat). */
  lastConfirmedAt: string | null;
  lifecycles: Record<string, Lifecycle>;
  timeline: TimelineItem[];
  progress: Record<string, { summary: string; ts: string; tool?: string }>;
  notice: string | null;
}

const STALE_AFTER_MS = 25_000;
const TIMELINE_MAX = 250;

let state: State = {
  auth: 'unknown',
  session: null,
  worldName: 'HERMES DIGITAL WORLD',
  world: null,
  conn: 'connecting',
  lastConfirmedAt: null,
  lifecycles: {},
  timeline: [],
  progress: {},
  notice: null,
};
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useWorld<T>(select: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(state),
  );
}

export const getState = () => state;

// ---------- Event descriptions (concise, no hidden reasoning) ----------

function describe(ev: WorldEvent): string {
  const p = ev.payload as Record<string, any>;
  switch (ev.type) {
    case 'project.proposed':
      return `Project proposed: ${p.project.title}`;
    case 'project.created':
      return `Hermes accepted "${p.project.title}" and started planning`;
    case 'project.updated':
      return `Project "${p.project.title}" is ${p.project.status}`;
    case 'project.completed':
      return `Project "${p.project.title}" completed`;
    case 'project.archived':
      return `Project "${p.project.title}" archived (files kept)`;
    case 'project.data_deleted':
      return `Project data permanently deleted (${p.removedFiles} files)`;
    case 'island.creation_requested':
      return `Island requested for "${p.island.name}"`;
    case 'island.created':
      return `Island created: ${p.island.name}`;
    case 'island.updated':
      return `Island updated: ${p.island.name}`;
    case 'island.archived':
      return `Island archived: ${p.island.name} (${p.preset})`;
    case 'island.destruction_requested':
      return `Destruction requested for ${p.island.name} — awaiting approval`;
    case 'island.destroyed':
      return `Island destroyed: ${p.island.name} (${p.preset})`;
    case 'agent.created':
      return `${p.agent.name} (${p.agent.role}) joined the world`;
    case 'agent.assigned':
      return `${p.agent.name} assigned to a task`;
    case 'agent.updated':
      return `${p.agent.name}: ${p.agent.status}${p.agent.activity ? ` — ${p.agent.activity}` : ''}`;
    case 'agent.retired':
      return `${p.agent.name} retired`;
    case 'task.created':
      return `Task queued: ${p.task.title}`;
    case 'task.updated':
      return `Task ${p.task.status}${p.task.statusReason ? ` — ${p.task.statusReason}` : ''}`;
    case 'task.started':
      return `Task started (attempt ${p.attempt.number}) via ${p.attempt.adapter}`;
    case 'task.progress':
      return p.summary;
    case 'task.cancel_requested':
      return 'Cancellation requested — waiting for the runtime to confirm';
    case 'task.cancelled':
      return `Task cancelled${p.terminationVerified ? ' (termination verified)' : ' (termination NOT verified)'}`;
    case 'attempt.finished':
      return `Attempt ${p.attempt.number} ${p.attempt.status}`;
    case 'artifact.created':
      return `${p.artifact.kind === 'input' ? 'Input stored' : p.artifact.kind === 'partial' ? 'Partial output recorded' : 'Deliverable recorded'}: ${p.artifact.displayName}`;
    case 'review.completed':
      return `Review: ${p.review.verdict} (${p.review.findings.filter((f: { met: boolean }) => f.met).length}/${p.review.findings.length} criteria met)`;
    case 'approval.requested':
      return `Approval needed: ${p.approval.summary}`;
    case 'approval.decided':
      return `Approval ${p.approval.status}: ${p.approval.kind}`;
    case 'system.controls_changed':
      return `Controls: ${p.controls.emergencyStop ? 'EMERGENCY STOP' : p.controls.pauseAll ? 'paused' : 'running'}${p.controls.newWorkDisabled ? ', new work disabled' : ''}`;
    case 'system.adapter_status':
      return `Hermes adapter ${p.health.state}: ${p.health.detail}`;
    case 'system.recovered':
      return p.summary;
  }
}

function toTimeline(ev: WorldEvent): TimelineItem {
  const p = ev.payload as Record<string, any>;
  return {
    seq: ev.seq,
    ts: ev.ts,
    type: ev.type,
    summary: describe(ev),
    ...(p.island ? { islandId: p.island.id } : {}),
    ...(p.preset ? { preset: p.preset } : {}),
  };
}

// ---------- Connection ----------

let es: EventSource | null = null;
let lastMessageAt = 0;
let watchdog: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoff = 1000;
let liveSinceReady = false;

export async function boot() {
  try {
    const h = await get<{ worldName: string }>('/api/health');
    set({ worldName: h.worldName });
  } catch {
    set({ conn: 'offline', notice: 'The Mac is unreachable. Check that it is awake and on your private network.' });
  }
  try {
    const s = await currentSession();
    if (!s) {
      set({ auth: 'unpaired' });
      return;
    }
    set({ auth: 'paired', session: s });
    await resnapshot();
    openStream();
  } catch {
    set({ conn: 'offline' });
    scheduleReconnect();
  }
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', () => openStream());
  window.addEventListener('offline', () => set({ conn: 'offline' }));
}

export async function pairDevice(code: string, deviceName: string) {
  const s = await apiPair(code, deviceName);
  set({ auth: 'paired', session: s, notice: null });
  await resnapshot();
  openStream();
}

export async function resnapshot() {
  const w = await get<WorldSnapshot>('/api/world/snapshot');
  set({ world: w, lastConfirmedAt: w.generatedAt });
  if (state.timeline.length === 0) {
    try {
      const after = Math.max(0, w.cursor - 120);
      const r = await get<{ events: WorldEvent[] }>(`/api/events?after=${after}&limit=200`);
      set({ timeline: r.events.map(toTimeline).reverse().slice(0, TIMELINE_MAX) });
    } catch {
      /* older events pruned; timeline starts from now */
    }
  }
}

function closeStream() {
  es?.close();
  es = null;
  if (watchdog) clearInterval(watchdog);
  watchdog = null;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      const s = await currentSession();
      if (!s) {
        unpaired();
        return;
      }
      await resnapshot();
      backoff = 1000;
      openStream();
    } catch {
      set({ conn: navigator.onLine ? 'stale' : 'offline' });
      backoff = Math.min(backoff * 2, 30_000);
      scheduleReconnect();
    }
  }, backoff);
}

function unpaired() {
  closeStream();
  setCsrf(null);
  set({ auth: 'unpaired', session: null, world: null, conn: 'offline', notice: 'This device is no longer paired.' });
}

export function openStream() {
  if (state.auth !== 'paired' || !state.world || document.hidden) return;
  closeStream();
  set({ conn: 'connecting' });
  liveSinceReady = false;
  const source = new EventSource(`/api/stream?after=${state.world.cursor}`);
  es = source;
  const touch = (serverTime?: string) => {
    lastMessageAt = Date.now();
    set({ conn: 'live', ...(serverTime ? { lastConfirmedAt: serverTime } : {}) });
  };
  source.addEventListener('ready', (e) => {
    liveSinceReady = true;
    backoff = 1000;
    touch(JSON.parse((e as MessageEvent).data).serverTime);
  });
  source.addEventListener('heartbeat', (e) => touch(JSON.parse((e as MessageEvent).data).serverTime));
  source.addEventListener('world', (e) => {
    const ev = JSON.parse((e as MessageEvent).data) as WorldEvent;
    onWorldEvent(ev);
    touch(ev.ts);
  });
  source.addEventListener('snapshot_required', () => {
    closeStream();
    void resnapshot().then(openStream, () => scheduleReconnect());
  });
  source.addEventListener('session_revoked', () => unpaired());
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) {
      closeStream();
      set({ conn: navigator.onLine ? 'stale' : 'offline' });
      scheduleReconnect();
    } else {
      set({ conn: 'connecting' }); // browser retries with Last-Event-ID automatically
    }
  };
  watchdog = setInterval(() => {
    if (!navigator.onLine) set({ conn: 'offline' });
    else if (state.conn === 'live' && Date.now() - lastMessageAt > STALE_AFTER_MS) set({ conn: 'stale' });
  }, 5000);
}

function onVisibility() {
  // Hidden: drop the stream entirely (no background work on the phone). Visible: resume.
  if (document.hidden) closeStream();
  else if (state.auth === 'paired') openStream();
}

function onWorldEvent(ev: WorldEvent) {
  if (!state.world) return;
  const { world, result } = foldEvent(state.world, ev);
  if (result === 'duplicate') return;
  if (result === 'gap') {
    closeStream();
    void resnapshot().then(openStream, () => scheduleReconnect());
    return;
  }
  const patch: Partial<State> = { world };
  const p = ev.payload as Record<string, any>;
  // Animate only events that arrive live; backlog after a reconnect jumps to final state.
  if (liveSinceReady) {
    const now = performance.now();
    if (ev.type === 'island.created' && p.island.kind === 'project') {
      patch.lifecycles = { ...state.lifecycles, [p.island.id]: { kind: 'create', preset: null, startedAt: now, replay: false } };
    } else if (ev.type === 'island.archived') {
      patch.lifecycles = { ...state.lifecycles, [p.island.id]: { kind: 'archive', preset: p.preset, startedAt: now, replay: false } };
    } else if (ev.type === 'island.destroyed') {
      patch.lifecycles = { ...state.lifecycles, [p.island.id]: { kind: 'destroy', preset: p.preset, startedAt: now, replay: false } };
    }
  }
  if (ev.type === 'task.progress') {
    patch.progress = { ...state.progress, [p.taskId]: { summary: p.summary, ts: ev.ts, ...(p.tool ? { tool: `${p.tool.name} ${p.tool.phase}` } : {}) } };
  }
  patch.timeline = [toTimeline(ev), ...state.timeline].slice(0, TIMELINE_MAX);
  set(patch);
}

export function lifecycleDone(islandId: string) {
  if (!state.lifecycles[islandId]) return;
  const next = { ...state.lifecycles };
  delete next[islandId];
  set({ lifecycles: next });
}

/** Observation-only replay of a creation/removal animation from the timeline. */
export function replay(item: TimelineItem) {
  if (!item.islandId) return;
  const kind = item.type === 'island.created' ? 'create' : item.type === 'island.archived' ? 'archive' : item.type === 'island.destroyed' ? 'destroy' : null;
  if (!kind) return;
  set({ lifecycles: { ...state.lifecycles, [item.islandId]: { kind, preset: item.preset ?? null, startedAt: performance.now(), replay: true } } });
}

export function notify(msg: string | null) {
  set({ notice: msg });
}

export function handleError(e: unknown) {
  if (e instanceof ApiError && e.status === 401) unpaired();
  else notify(e instanceof Error ? e.message : String(e));
}
