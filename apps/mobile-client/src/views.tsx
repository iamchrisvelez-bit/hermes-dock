import { useEffect, useState } from 'react';
import type { ApprovalRequest, Controls } from '@hdw/contracts';
import { islandActivity } from '@hdw/world-projection';
import type { QualityLevel } from '@hdw/world-renderer';
import { get, post, send } from './api.ts';
import { Confirm, StatusChip, fmtAgo, fmtTime, useTick } from './ui.tsx';
import { handleError, pairDevice, replay, useWorld } from './worldStore.ts';

// ---------- 2D list view (equivalent essential controls to the 3D world) ----------

export function ListView({ onProject, onAgent }: { onProject: (id: string) => void; onAgent: (id: string) => void }) {
  const w = useWorld((s) => s.world);
  const progress = useWorld((s) => s.progress);
  const [showArchived, setShowArchived] = useState(false);
  if (!w) return <p className="pad muted">No world state yet.</p>;
  const hermes = w.agents.find((a) => a.role === 'administrator');
  const hqAgents = w.agents.filter((a) => a.projectId === null && a.role !== 'administrator');
  const projects = w.projects.filter((p) => (showArchived ? true : p.status !== 'archived')).slice().reverse();
  return (
    <div className="list pad">
      <div className="card hq">
        <div className="row between">
          <strong>Hermes Headquarters</strong>
          <span className="muted small">{w.artifacts.filter((a) => a.kind === 'deliverable').length} deliverables archived</span>
        </div>
        {hermes && (
          <button className="list-btn" onClick={() => onAgent(hermes.id)}>
            Hermes · administrator <StatusChip status={hermes.status} />
          </button>
        )}
        {hqAgents.map((a) => (
          <button key={a.id} className="list-btn" onClick={() => onAgent(a.id)}>
            {a.name} · {a.role} <StatusChip status={a.status} />
            {a.activity && <span className="muted small"> — {a.activity}</span>}
          </button>
        ))}
      </div>
      {projects.length === 0 && <p className="muted">No projects yet. Tap + to send Hermes a brief.</p>}
      {projects.map((p) => {
        const tasks = w.tasks.filter((t) => t.projectId === p.id);
        const worker = w.agents.find((a) => a.projectId === p.id);
        const island = w.islands.find((i) => i.projectId === p.id);
        const running = tasks.find((t) => t.status === 'running');
        return (
          <button key={p.id} className="card project-card" onClick={() => onProject(p.id)}>
            <div className="row between">
              <strong>{p.title}</strong>
              <StatusChip status={p.status} />
            </div>
            <div className="muted small">
              Island {island?.state ?? '—'} · {islandActivity(p, w.tasks)} · {tasks.filter((t) => t.status === 'completed').length}/{tasks.length} tasks done
            </div>
            {worker && (
              <div className="small">
                {worker.name} ({worker.role}): {worker.status}
              </div>
            )}
            {running && progress[running.id] && <div className="small activity">▸ {progress[running.id]!.summary}</div>}
            {tasks.map((t) =>
              t.statusReason ? (
                <div key={t.id} className="small muted">
                  {t.statusReason}
                </div>
              ) : null,
            )}
          </button>
        );
      })}
      <label className="toggle">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived projects
      </label>
    </div>
  );
}

// ---------- Approvals ----------

export function ApprovalsView() {
  const approvals = useWorld((s) => s.world?.approvals ?? []);
  const [confirm, setConfirm] = useState<ApprovalRequest | null>(null);
  const pending = approvals.filter((a) => a.status === 'pending');
  const decided = approvals.filter((a) => a.status !== 'pending').slice(-15).reverse();
  const decide = (a: ApprovalRequest, decision: 'approve' | 'deny') => post(`/api/approvals/${a.id}/decide`, { decision }).catch(handleError);
  return (
    <div className="pad">
      <h2>Approval queue</h2>
      {pending.length === 0 && <p className="muted">Nothing is waiting on you.</p>}
      {pending.map((a) => (
        <div key={a.id} className={`card ${a.kind === 'project_data_deletion' ? 'danger-card' : ''}`}>
          <div className="row between">
            <strong>{a.kind.replace(/_/g, ' ')}</strong>
            <span className="muted small">{fmtAgo(a.createdAt)}</span>
          </div>
          <p>{a.summary}</p>
          <p className="muted small">Requested by {a.requestedBy === 'hermes' ? 'Hermes' : 'you'}.</p>
          <div className="row">
            <button className={a.kind === 'project_data_deletion' ? 'btn danger' : 'btn primary'} onClick={() => (a.kind === 'project_data_deletion' ? setConfirm(a) : decide(a, 'approve'))}>
              Approve
            </button>
            <button className="btn" onClick={() => decide(a, 'deny')}>
              Deny
            </button>
          </div>
        </div>
      ))}
      {confirm && (
        <Confirm
          danger
          text="This PERMANENTLY deletes the project's input, workspace and deliverable files on your Mac. It cannot be undone."
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            void decide(confirm, 'approve');
            setConfirm(null);
          }}
        />
      )}
      <h3>Recent decisions</h3>
      {decided.map((a) => (
        <div key={a.id} className="sub small">
          <StatusChip status={a.status} /> {a.kind.replace(/_/g, ' ')} · {fmtTime(a.decidedAt)}
        </div>
      ))}
    </div>
  );
}

// ---------- Timeline ----------

export function TimelineView({ onReplay }: { onReplay: () => void }) {
  const items = useWorld((s) => s.timeline);
  return (
    <div className="pad">
      <h2>Event timeline</h2>
      <p className="muted small">Replays are visual observation only; they do not change anything.</p>
      <ol className="timeline">
        {items.map((i) => (
          <li key={i.seq}>
            <span className="muted small">
              #{i.seq} · {fmtTime(i.ts)}
            </span>
            <div>{i.summary}</div>
            {i.islandId && ['island.created', 'island.archived', 'island.destroyed'].includes(i.type) && (
              <button
                className="link-btn"
                onClick={() => {
                  replay(i);
                  onReplay();
                }}
              >
                ▶ replay animation
              </button>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------- Settings / controls ----------

export interface ViewPrefs {
  view3d: boolean;
  quality: QualityLevel;
  reducedMotion: 'system' | 'on' | 'off';
  perfHud: boolean;
}

export function SettingsView({ prefs, setPrefs, webgl }: { prefs: ViewPrefs; setPrefs: (p: ViewPrefs) => void; webgl: boolean }) {
  const controls = useWorld((s) => s.world?.controls);
  const [confirmStop, setConfirmStop] = useState(false);
  const [sessions, setSessions] = useState<Array<{ sessionId: string; deviceName: string; lastSeenAt: string; current: boolean }>>([]);
  const [system, setSystem] = useState<Record<string, any> | null>(null);
  const load = () => {
    get<typeof sessions>('/api/auth/sessions').then(setSessions, handleError);
    get<Record<string, any>>('/api/system').then(setSystem, handleError);
  };
  useEffect(load, []);
  const ctl = (action: string) => post<Controls>('/api/controls', { action }).catch(handleError);
  if (!controls) return null;
  return (
    <div className="pad">
      <h2>Controls</h2>
      <div className="grid2">
        {controls.pauseAll ? (
          <button className="btn" onClick={() => ctl('resume_all')} disabled={controls.emergencyStop}>
            Resume work
          </button>
        ) : (
          <button className="btn warn" onClick={() => ctl('pause_all')}>
            Pause all
          </button>
        )}
        {controls.newWorkDisabled ? (
          <button className="btn" onClick={() => ctl('enable_new_work')} disabled={controls.emergencyStop}>
            Enable new work
          </button>
        ) : (
          <button className="btn warn" onClick={() => ctl('disable_new_work')}>
            Disable new work
          </button>
        )}
        {controls.emergencyStop ? (
          <button className="btn" onClick={() => ctl('clear_emergency_stop')}>
            Clear emergency stop
          </button>
        ) : (
          <button className="btn danger" onClick={() => setConfirmStop(true)}>
            EMERGENCY STOP
          </button>
        )}
      </div>
      <p className="muted small">Pausing asks running work to stop; tasks show as paused only after the runtime confirms. Clearing an emergency stop does not resume work by itself.</p>
      {confirmStop && (
        <Confirm
          danger
          text="Stop all running work, pause everything and refuse new work until you clear it?"
          onCancel={() => setConfirmStop(false)}
          onConfirm={() => {
            setConfirmStop(false);
            void ctl('emergency_stop');
          }}
        />
      )}

      <h2>Display</h2>
      <label className="toggle">
        <input type="checkbox" checked={prefs.view3d && webgl} disabled={!webgl} onChange={(e) => setPrefs({ ...prefs, view3d: e.target.checked })} /> 3D world {webgl ? '' : '(WebGL unavailable — using the 2D view)'}
      </label>
      <label className="field">
        Quality
        <select value={prefs.quality} onChange={(e) => setPrefs({ ...prefs, quality: e.target.value as QualityLevel })}>
          <option value="low">Low (battery saver, 30 FPS cap)</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </label>
      <label className="field">
        Reduced motion
        <select value={prefs.reducedMotion} onChange={(e) => setPrefs({ ...prefs, reducedMotion: e.target.value as ViewPrefs['reducedMotion'] })}>
          <option value="system">Follow system setting</option>
          <option value="on">On (gentle fades, no shaking)</option>
          <option value="off">Off</option>
        </select>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={prefs.perfHud} onChange={(e) => setPrefs({ ...prefs, perfHud: e.target.checked })} /> Show performance HUD (measured FPS, DPR, draw calls)
      </label>

      <h2>Hermes runtime</h2>
      {system && (
        <div className="card small">
          <div>
            Adapter: <strong>{system.adapter.adapter}</strong> ({system.adapter.live ? 'live' : 'demo'}) — {system.adapter.state}
          </div>
          <div className="muted">{system.adapter.detail}</div>
          <div>Hermes version: {system.adapter.hermesVersion ?? 'unknown'}</div>
          <div>Enabled Hermes toolsets: {system.enabledHermesToolsets?.length ? system.enabledHermesToolsets.join(', ') : 'none reported'}</div>
          <div>Executable agent work: {system.sandbox.executableWorkEnabled ? 'enabled' : 'disabled'}</div>
          <div className="muted">{system.sandbox.reason}</div>
          <div>
            Policy: tier {system.policy.autonomyTier} · {system.policy.maxConcurrentWorkers} worker · depth {system.policy.maxDelegationDepth} · {system.policy.maxReviewIterations} review iterations · timeout{' '}
            {Math.round(system.policy.taskTimeoutMs / 60000)} min
          </div>
          <div className="muted">{system.dataProcessingNotice}</div>
        </div>
      )}

      <h2>Paired devices</h2>
      {sessions.map((s) => (
        <div key={s.sessionId} className="row between sub">
          <span>
            {s.deviceName} {s.current && <span className="tag">this device</span>}
            <span className="muted small"> · seen {fmtAgo(s.lastSeenAt)}</span>
          </span>
          <button
            className="btn small-btn"
            onClick={() =>
              send('DELETE', `/api/auth/sessions/${s.sessionId}`)
                .then(load)
                .catch(handleError)
            }
          >
            Revoke
          </button>
        </div>
      ))}
      <button className="btn" onClick={() => post('/api/auth/logout').then(() => location.reload(), handleError)}>
        Unpair this device
      </button>
    </div>
  );
}

// ---------- Pairing ----------

export function PairScreen() {
  useTick(10_000);
  const name = useWorld((s) => s.worldName);
  const notice = useWorld((s) => s.notice);
  const [code, setCode] = useState('');
  const [device, setDevice] = useState(() => (/iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android phone' : 'Browser'));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <main className="pair">
      <h1>{name}</h1>
      <p>Pair this device with your Mac. A one-time code is printed in the Mac's terminal when the control plane starts, or run:</p>
      <pre className="preview">npm run pair</pre>
      {notice && <p className="banner warn">{notice}</p>}
      <label className="field">
        Pairing code
        <input value={code} autoCapitalize="characters" autoComplete="one-time-code" placeholder="ABCD-EF23" onChange={(e) => setCode(e.target.value.toUpperCase())} />
      </label>
      <label className="field">
        Device name
        <input value={device} maxLength={60} onChange={(e) => setDevice(e.target.value)} />
      </label>
      <button
        className="btn primary"
        disabled={busy || !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code.trim())}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            await pairDevice(code, device);
          } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Pair
      </button>
      {err && <p className="err">{err}</p>}
      <p className="muted small">Codes are single-use and expire after 10 minutes. Sessions can be revoked from Settings.</p>
    </main>
  );
}
