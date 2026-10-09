import { useEffect, useState } from 'react';
import type { AgentIdentity, Artifact, DestructionPreset, IntakeResponse, Project } from '@hdw/contracts';
import { abilityBadges, islandActivity } from '@hdw/world-projection';
import { fileToBase64, get, post } from './api.ts';
import { Confirm, Sheet, StatusChip, fmtTime, type World } from './ui.tsx';
import { handleError, notify, useWorld } from './worldStore.ts';

const PRESETS: Array<{ id: DestructionPreset; label: string }> = [
  { id: 'dissolve', label: 'Pixel dissolve' },
  { id: 'earthquake', label: 'Earthquake' },
  { id: 'demolition', label: 'Controlled demolition' },
];

// ---------- Project ----------

export function ProjectPanel({ projectId, onClose, onAgent }: { projectId: string; onClose: () => void; onAgent: (id: string) => void }) {
  const w = useWorld((s) => s.world);
  const progress = useWorld((s) => s.progress);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [confirm, setConfirm] = useState<null | { text: string; run: () => Promise<unknown>; danger?: boolean }>(null);
  const [preset, setPreset] = useState<DestructionPreset>('dissolve');
  const project = w?.projects.find((p) => p.id === projectId);
  if (!w || !project) return null;
  const island = w.islands.find((i) => i.projectId === projectId);
  const tasks = w.tasks.filter((t) => t.projectId === projectId);
  const taskIds = new Set(tasks.map((t) => t.id));
  const attempts = w.attempts.filter((a) => taskIds.has(a.taskId));
  const reviews = w.reviews.filter((r) => taskIds.has(r.taskId));
  const artifacts = w.artifacts.filter((a) => a.projectId === projectId);
  const agents = w.agents.filter((a) => a.projectId === projectId);
  const running = tasks.some((t) => t.status === 'running' || t.status === 'waiting_for_approval');
  const act = (fn: () => Promise<unknown>) => () => fn().catch(handleError);

  return (
    <Sheet title={project.title} onClose={onClose}>
      <div className="kv">
        <StatusChip status={project.status} />
        <span className="muted">Island: {island ? island.state : 'none'}</span>
        <span className="muted">Activity: {islandActivity(project, w.tasks)}</span>
      </div>

      <h3>Brief</h3>
      <p>{project.brief.summary}</p>
      <BriefList title="Goals" items={project.brief.goals} />
      <BriefList title="Constraints" items={project.brief.constraints} />
      <BriefList title="Risks" items={project.brief.risks} />
      <BriefList title="Missing information" items={project.brief.missingInformation} />

      <h3>Acceptance criteria</h3>
      <ul className="plain">
        {project.acceptanceCriteria.map((c) => (
          <li key={c.id}>{c.description}</li>
        ))}
      </ul>

      <h3>Tasks</h3>
      {tasks.map((t) => (
        <div key={t.id} className="card">
          <div className="row between">
            <strong>{t.title}</strong>
            <StatusChip status={t.status} />
          </div>
          <div className="muted small">
            Iteration {t.iteration}/{t.maxIterations} · timeout {Math.round(t.timeoutMs / 60000)} min
          </div>
          {t.statusReason && <div className="small">{t.statusReason}</div>}
          {progress[t.id] && (t.status === 'running' || t.status === 'waiting_for_approval') && (
            <div className="small activity">
              ▸ {progress[t.id]!.summary} <span className="muted">({fmtTime(progress[t.id]!.ts)})</span>
            </div>
          )}
          <div className="row">
            {!['completed', 'cancelled'].includes(t.status) && (
              <button className="btn" onClick={() => setConfirm({ text: 'Cancel this task? It is marked cancelled only after the runtime confirms it stopped.', run: () => post(`/api/tasks/${t.id}/cancel`) })}>
                Cancel task
              </button>
            )}
            {(t.status === 'failed' || t.status === 'blocked') && (
              <button className="btn" onClick={act(() => post(`/api/tasks/${t.id}/retry`))}>
                Retry
              </button>
            )}
          </div>
          {attempts
            .filter((a) => a.taskId === t.id)
            .map((a) => (
              <div key={a.id} className="sub">
                Attempt {a.number}: <StatusChip status={a.status} /> <span className="muted small">{a.adapter}{a.externalRunId ? ` · ${a.externalRunId.slice(0, 18)}` : ''}</span>
                {a.error && <div className="small err">{a.error}</div>}
              </div>
            ))}
        </div>
      ))}

      <h3>Reviews</h3>
      {reviews.length === 0 && <p className="muted">No reviews yet.</p>}
      {reviews.map((r) => (
        <div key={r.id} className="card">
          <div className="row between">
            <span>{r.reviewer}</span>
            <StatusChip status={r.verdict} />
          </div>
          <ul className="findings">
            {r.findings.map((f) => (
              <li key={f.criterionId} className={f.met ? 'ok' : 'bad'}>
                {f.met ? '✓' : '✗'} {f.note}
              </li>
            ))}
          </ul>
        </div>
      ))}

      <h3>Artifacts</h3>
      {artifacts.length === 0 && <p className="muted">{project.dataDeletedAt ? 'Project data was permanently deleted.' : 'None yet.'}</p>}
      {artifacts.map((a) => (
        <button key={a.id} className="list-btn" onClick={() => setArtifact(a)}>
          <span className={`tag tag-${a.kind}`}>{a.kind}</span> {a.displayName} <span className="muted small">{a.sizeBytes} B</span>
        </button>
      ))}
      <p className="muted small">An animation is never proof of completion — the review and the deliverable file are.</p>

      <h3>Agents</h3>
      {agents.map((a) => (
        <button key={a.id} className="list-btn" onClick={() => onAgent(a.id)}>
          {a.name} · {a.role} <StatusChip status={a.status} />
        </button>
      ))}

      <h3>Island</h3>
      {project.status !== 'archived' ? (
        <>
          <label className="field">
            Archive animation
            <select value={preset} onChange={(e) => setPreset(e.target.value as DestructionPreset)}>
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn"
            disabled={running}
            onClick={() => setConfirm({ text: 'Archive this project? Its island is retired with the chosen animation. All files stay on your Mac.', run: () => post(`/api/projects/${projectId}/archive`, { preset }) })}
          >
            Archive project
          </button>
          {running && <p className="muted small">Cancel running tasks before archiving.</p>}
        </>
      ) : (
        <>
          {island && island.state !== 'destroyed' && (
            <button className="btn" onClick={act(() => post(`/api/projects/${projectId}/destroy-island`, { preset }).then(() => notify('Destruction requested — approve it in the Inbox.')))}>
              Request island destruction (visual only)
            </button>
          )}
          {!project.dataDeletedAt && (
            <button
              className="btn danger"
              onClick={act(() => post(`/api/projects/${projectId}/delete-data`).then(() => notify('Permanent deletion requested — it needs a separate approval in the Inbox.')))}
            >
              Request PERMANENT data deletion…
            </button>
          )}
        </>
      )}
      {confirm && (
        <Confirm
          text={confirm.text}
          danger={confirm.danger}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const c = confirm;
            setConfirm(null);
            c.run().catch(handleError);
          }}
        />
      )}
      {artifact && <ArtifactViewer artifact={artifact} onClose={() => setArtifact(null)} />}
    </Sheet>
  );
}

function BriefList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <>
      <h4>{title}</h4>
      <ul className="plain">
        {items.map((g, i) => (
          <li key={i}>{g}</li>
        ))}
      </ul>
    </>
  );
}

export function ArtifactViewer({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const [data, setData] = useState<{ preview: string | null; truncated: boolean; available: boolean } | null>(null);
  useEffect(() => {
    get<{ preview: string | null; truncated: boolean; available: boolean }>(`/api/artifacts/${artifact.id}`).then(setData, handleError);
  }, [artifact.id]);
  return (
    <Sheet title={artifact.displayName} onClose={onClose}>
      <div className="muted small">
        {artifact.kind} · {artifact.mediaType} · {artifact.sizeBytes} bytes · sha256 {artifact.sha256.slice(0, 12)}… · {artifact.provenance.source}
        {artifact.provenance.adapter ? ` via ${artifact.provenance.adapter}` : ''}
      </div>
      {data === null ? <p>Loading…</p> : !data.available ? <p className="err">File no longer exists on the Mac.</p> : <pre className="preview">{data.preview}</pre>}
      {data?.truncated && <p className="muted small">Preview truncated; download for the full file.</p>}
      {/* Rendered as plain text: deliverables are untrusted content and never executed. */}
      <a className="btn" href={`/api/artifacts/${artifact.id}/download`} download>
        Download
      </a>
    </Sheet>
  );
}

// ---------- Agent ----------

export function AgentPanel({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const w = useWorld((s) => s.world);
  const [detail, setDetail] = useState<{ runtimeSessions: Array<Record<string, string | null>> } | null>(null);
  useEffect(() => {
    get<{ runtimeSessions: Array<Record<string, string | null>> }>(`/api/agents/${agentId}`).then(setDetail, handleError);
  }, [agentId]);
  const agent: AgentIdentity | undefined = w?.agents.find((a) => a.id === agentId);
  if (!agent) return null;
  const project = agent.projectId ? w?.projects.find((p) => p.id === agent.projectId) : null;
  const task = agent.currentTaskId ? w?.tasks.find((t) => t.id === agent.currentTaskId) : null;
  const badges = abilityBadges(agent);
  return (
    <Sheet title={`${agent.name} · ${agent.role}`} onClose={onClose}>
      <div className="kv">
        <StatusChip status={agent.status} />
        <span className="muted">Home: {project ? project.title : 'Hermes Headquarters'}</span>
      </div>
      {agent.activity && <p className="activity">▸ {agent.activity}</p>}
      <h3>Configured capabilities</h3>
      <div className="row wrap">
        {badges.length === 0 ? <span className="muted">none</span> : badges.map((b) => <span key={b} className="tag">{b}</span>)}
      </div>
      <p className="muted small">
        Abilities shown in the world come from this backend configuration. This worker {agent.capabilities.executeCode ? 'can' : 'cannot'} execute code and{' '}
        {agent.capabilities.browseWeb ? 'can' : 'cannot'} browse the web.
      </p>
      <div className="kv small">
        <span>Delegation depth {agent.delegationDepth}</span>
        <span>Palette {agent.appearance.palette}</span>
        <span>Emblem {agent.appearance.emblem}</span>
      </div>
      {task && (
        <>
          <h3>Current task</h3>
          <p>
            {task.title} <StatusChip status={task.status} />
          </p>
        </>
      )}
      <h3>Runtime sessions</h3>
      <p className="muted small">The character identity persists; each runtime session is one execution attempt.</p>
      {detail?.runtimeSessions.length === 0 && <p className="muted">None.</p>}
      {detail?.runtimeSessions.map((s) => (
        <div key={String(s.id)} className="sub small">
          {String(s.adapter)} · <StatusChip status={String(s.status)} /> · {fmtTime(s.started_at as string)}
          {s.ended_at ? ` → ${fmtTime(s.ended_at as string)}` : ''}
        </div>
      ))}
    </Sheet>
  );
}

// ---------- Intake ----------

export function IntakeSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (projectId: string) => void }) {
  const [prompt, setPrompt] = useState('Read this provided project brief and create a Markdown implementation plan with milestones, risks, and acceptance criteria.');
  const [title, setTitle] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IntakeResponse | null>(null);
  const [key] = useState(() => `intake-${crypto.randomUUID()}`);
  const live = useWorld((s) => s.world?.adapter.live ?? false);

  const submit = async () => {
    setBusy(true);
    try {
      const payload = await Promise.all(files.map(async (f) => ({ name: f.name, contentBase64: await fileToBase64(f) })));
      const r = await post<IntakeResponse>('/api/intake', { prompt, ...(title.trim() ? { title } : {}), files: payload, idempotencyKey: key });
      setResult(r);
      if (r.outcome === 'project_created' && r.projectId) onCreated(r.projectId);
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="New request for Hermes" onClose={onClose}>
      {!live && <p className="banner demo-banner">Demo mode: the mock adapter writes a deterministic plan. No AI model runs.</p>}
      {live && <p className="muted small">Hermes uses the model provider configured on your Mac; project text may be processed by that provider.</p>}
      <label className="field">
        Title (optional)
        <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="Derived from the brief if empty" />
      </label>
      <label className="field">
        Prompt
        <textarea rows={5} value={prompt} maxLength={20000} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <label className="field">
        Files (.txt, .md, .json · max 5 · 512 KB each)
        <input type="file" multiple accept=".txt,.md,.markdown,.json,text/plain,text/markdown,application/json" onChange={(e) => setFiles([...(e.target.files ?? [])].slice(0, 5))} />
      </label>
      {files.length > 0 && <p className="muted small">{files.map((f) => f.name).join(', ')}</p>}
      <button className="btn primary" disabled={busy || (!prompt.trim() && files.length === 0)} onClick={submit}>
        {busy ? 'Submitting…' : 'Send to Hermes'}
      </button>
      {result && (
        <div className="card">
          <strong>{result.outcome.replace(/_/g, ' ')}</strong>
          <p>{result.message}</p>
          {result.questions.length > 0 && (
            <ul className="plain">
              {result.questions.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Sheet>
  );
}

export function projectByIsland(w: World, islandId: string): Project | undefined {
  const i = w.islands.find((x) => x.id === islandId);
  return i?.projectId ? w.projects.find((p) => p.id === i.projectId) : undefined;
}
