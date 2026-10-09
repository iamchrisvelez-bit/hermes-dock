import { useEffect, useState, type ReactNode } from 'react';
import type { WorldSnapshot } from '@hdw/contracts';
import { useWorld, type ConnStatus } from './worldStore.ts';

export function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtAgo(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/** Re-render periodically so "x seconds ago" stays honest without per-frame state. */
export function useTick(ms = 5000) {
  const [, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

const CONN_TEXT: Record<ConnStatus, string> = {
  live: 'Connected',
  connecting: 'Reconnecting…',
  stale: 'Mac not responding',
  offline: 'Offline',
};

/**
 * Mode badge: LIVE only for a real Hermes runtime with a live link; DEMO for the mock
 * adapter; CACHED whenever the link is not live, regardless of adapter.
 */
export function ModeBadge() {
  const live = useWorld((s) => s.world?.adapter.live ?? false);
  const conn = useWorld((s) => s.conn);
  if (conn !== 'live') return <span className="badge cached" title="Showing the last confirmed state, not live">CACHED</span>;
  return live ? (
    <span className="badge live" title="Connected to a real Hermes runtime">LIVE</span>
  ) : (
    <span className="badge demo" title="Deterministic mock adapter: no AI model is running">DEMO</span>
  );
}

export function ConnectionPill() {
  useTick(5000);
  const conn = useWorld((s) => s.conn);
  const last = useWorld((s) => s.lastConfirmedAt);
  return (
    <div className={`conn conn-${conn}`} role="status" aria-live="polite">
      <span className="dot" aria-hidden />
      <span>{CONN_TEXT[conn]}</span>
      <span className="muted"> · last update {conn === 'live' ? fmtTime(last) : `${fmtTime(last)} (${fmtAgo(last)})`}</span>
    </div>
  );
}

export function ControlsBanner() {
  const c = useWorld((s) => s.world?.controls);
  const adapter = useWorld((s) => s.world?.adapter);
  const conn = useWorld((s) => s.conn);
  if (!c) return null;
  const items: ReactNode[] = [];
  if (c.emergencyStop) items.push(<div key="e" className="banner danger">EMERGENCY STOP active — no work runs until you clear it in Controls.</div>);
  else if (c.pauseAll) items.push(<div key="p" className="banner warn">All work is paused.</div>);
  if (!c.emergencyStop && c.newWorkDisabled) items.push(<div key="n" className="banner warn">New work is disabled.</div>);
  if (adapter && adapter.state !== 'ready') items.push(<div key="a" className="banner warn">Hermes adapter {adapter.state}: {adapter.detail}</div>);
  if (conn === 'stale' || conn === 'offline')
    items.push(
      <div key="c" className="banner muted-banner">
        The Mac may be asleep or off the network. Nothing shown here is updating, and no agent work runs on this phone.
      </div>,
    );
  return <>{items}</>;
}

export function StatusChip({ status }: { status: string }) {
  return <span className={`chip chip-${status}`}>{status.replace(/_/g, ' ')}</span>;
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="sheet-body">{children}</div>
      </section>
    </div>
  );
}

export function Confirm({ text, onConfirm, onCancel, danger }: { text: string; onConfirm: () => void; onCancel: () => void; danger?: boolean }) {
  return (
    <div className="confirm">
      <p>{text}</p>
      <div className="row">
        <button className={danger ? 'btn danger' : 'btn primary'} onClick={onConfirm}>
          Confirm
        </button>
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export type World = WorldSnapshot;
