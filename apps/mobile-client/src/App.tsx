import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildViewModel, detectWebGL, type RenderStats, type Selection } from '@hdw/world-renderer';
import { AgentPanel, IntakeSheet, ProjectPanel, projectByIsland } from './panels.tsx';
import { ConnectionPill, ControlsBanner, ModeBadge } from './ui.tsx';
import { ApprovalsView, ListView, PairScreen, SettingsView, TimelineView, type ViewPrefs } from './views.tsx';
import { lifecycleDone, notify, useWorld } from './worldStore.ts';

// The 3D bundle (three.js + R3F) loads only when the 3D view is shown.
const WorldCanvas = lazy(() => import('@hdw/world-renderer/canvas').then((m) => ({ default: m.WorldCanvas })));

type Tab = 'world' | 'projects' | 'inbox' | 'timeline' | 'settings';

const PREFS_KEY = 'hdw.viewPrefs';
const DEFAULT_PREFS: ViewPrefs = { view3d: true, quality: 'medium', reducedMotion: 'system', perfHud: false };

/** Display preferences are per-viewer conveniences; storage failures fall back silently. */
function loadPrefs(): ViewPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

function useSystemReducedMotion() {
  const [rm, setRm] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const on = () => setRm(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return rm;
}

export function App() {
  const auth = useWorld((s) => s.auth);
  const world = useWorld((s) => s.world);
  const conn = useWorld((s) => s.conn);
  const lifecycles = useWorld((s) => s.lifecycles);
  const notice = useWorld((s) => s.notice);
  const worldName = useWorld((s) => s.worldName);
  const [tab, setTab] = useState<Tab>('world');
  const [selection, setSelection] = useState<Selection>(null);
  const [panel, setPanel] = useState<{ kind: 'project' | 'agent'; id: string } | null>(null);
  const [intake, setIntake] = useState(false);
  const [prefs, setPrefsState] = useState<ViewPrefs>(loadPrefs);
  const webgl = useMemo(detectWebGL, []);
  const sysRm = useSystemReducedMotion();
  const reducedMotion = prefs.reducedMotion === 'on' || (prefs.reducedMotion === 'system' && sysRm);
  const hud = useRef<HTMLDivElement>(null);

  const setPrefs = (p: ViewPrefs) => {
    setPrefsState(p);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(p));
    } catch {
      /* private mode: keep in memory */
    }
  };

  const model = useMemo(() => (world ? buildViewModel(world, { connected: conn === 'live' }) : null), [world, conn]);
  const pending = world?.approvals.filter((a) => a.status === 'pending').length ?? 0;

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => notify(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  // Stats go straight to the DOM (no React state updates from the render loop).
  const onStats = useCallback((s: RenderStats) => {
    if (hud.current) hud.current.textContent = s.continuous
        ? `${s.fps} fps · ${s.frameMs} ms · dpr ${s.dpr} · ${s.drawCalls} draws · ${s.triangles} tris · continuous`
        : `idle: rendering on demand (0 fps) · dpr ${s.dpr} · ${s.drawCalls} draws · ${s.triangles} tris`;
  }, []);

  if (auth === 'unknown') return <main className="pair">Connecting to your Mac…</main>;
  if (auth === 'unpaired') return <PairScreen />;

  const onSelect = (s: Selection) => {
    setSelection(s);
    if (!s || !world) return;
    if (s.kind === 'agent') setPanel({ kind: 'agent', id: s.id });
    else {
      const p = projectByIsland(world, s.id);
      if (p) setPanel({ kind: 'project', id: p.id });
    }
  };


  const show3d = tab === 'world' && prefs.view3d && webgl;

  return (
    <div className="app">
      <header className="topbar">
        <div className="title">
          <span className="name">{worldName}</span>
          <ModeBadge />
        </div>
        <ConnectionPill />
      </header>
      <ControlsBanner />
      {notice && (
        <div className="toast" role="alert" onClick={() => notify(null)}>
          {notice}
        </div>
      )}

      <main className="content">
        {tab === 'world' &&
          (show3d && model ? (
            <div className="world">
              <Suspense fallback={<div className="pad muted">Loading 3D world…</div>}>
                <WorldCanvas
                  model={model}
                  lifecycles={lifecycles}
                  onLifecycleDone={lifecycleDone}
                  selection={selection}
                  onSelect={onSelect}
                  quality={prefs.quality}
                  reducedMotion={reducedMotion}
                  onStats={prefs.perfHud ? onStats : undefined}
                />
              </Suspense>
              {prefs.perfHud && <div ref={hud} className="hud" />}
              <div className="legend small">Tap an island or agent · drag to orbit · pinch to zoom</div>
            </div>
          ) : (
            <>
              {tab === 'world' && prefs.view3d && !webgl && <p className="pad muted small">WebGL is unavailable on this device; showing the 2D view.</p>}
              <ListView onProject={(id) => setPanel({ kind: 'project', id })} onAgent={(id) => setPanel({ kind: 'agent', id })} />
            </>
          ))}
        {tab === 'projects' && <ListView onProject={(id) => setPanel({ kind: 'project', id })} onAgent={(id) => setPanel({ kind: 'agent', id })} />}
        {tab === 'inbox' && <ApprovalsView />}
        {tab === 'timeline' && <TimelineView onReplay={() => setTab('world')} />}
        {tab === 'settings' && <SettingsView prefs={prefs} setPrefs={setPrefs} webgl={webgl} />}
      </main>

      {(tab === 'world' || tab === 'projects') && (
        <button className="fab" aria-label="New request" onClick={() => setIntake(true)} disabled={!world || world.controls.newWorkDisabled}>
          +
        </button>
      )}

      <nav className="tabs">
        {(
          [
            ['world', 'World'],
            ['projects', 'Projects'],
            ['inbox', pending > 0 ? `Inbox (${pending})` : 'Inbox'],
            ['timeline', 'Timeline'],
            ['settings', 'Controls'],
          ] as Array<[Tab, string]>
        ).map(([id, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>

      {panel?.kind === 'project' && (
        <ProjectPanel
          projectId={panel.id}
          onClose={() => {
            setPanel(null);
            setSelection(null);
          }}
          onAgent={(id) => setPanel({ kind: 'agent', id })}
        />
      )}
      {panel?.kind === 'agent' && (
        <AgentPanel
          agentId={panel.id}
          onClose={() => {
            setPanel(null);
            setSelection(null);
          }}
        />
      )}
      {intake && (
        <IntakeSheet
          onClose={() => setIntake(false)}
          onCreated={() => {
            setIntake(false);
            setTab('world');
          }}
        />
      )}
    </div>
  );
}
