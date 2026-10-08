import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseWorldEvent } from '@hdw/contracts';
import { MOCK_DISCLOSURE } from '@hdw/hermes-adapter';
import { harness, intakeBody, pair, snapshot, waitFor, type Harness } from './helpers.ts';

/**
 * End-to-end MOCK smoke test of the first real workflow:
 * brief -> project + island -> worker -> bounded task -> artifact -> review -> revision -> result.
 * Uses the deterministic mock adapter; this does NOT verify a live Hermes integration.
 */
describe('end-to-end mock workflow', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('turns a brief into a reviewed deliverable, with one revision, labeled as demo', async () => {
    h = await harness({ scenario: 'revise_once' });
    const c = await pair(h);

    const before = await snapshot(c);
    expect(before.adapter.live).toBe(false);
    expect(before.adapter.adapter).toBe('mock');
    expect(before.islands.map((i) => i.kind)).toEqual(['headquarters']);
    expect(before.agents.map((a) => a.role).sort()).toEqual(['administrator', 'reviewer']);

    const res = await c.post('/api/intake', intakeBody());
    expect(res.status).toBe(200);
    expect(res.json.outcome).toBe('project_created');
    const projectId = res.json.projectId as string;

    const world = await waitFor(() => snapshot(c), (w) => w.projects.find((p) => p.id === projectId)?.status === 'completed');
    const project = world.projects.find((p) => p.id === projectId)!;
    expect(project.title).toBe('Garden Planner');
    expect(project.brief.inputArtifactIds).toHaveLength(2);

    // Island created deterministically in the first ring slot.
    const island = world.islands.find((i) => i.projectId === projectId)!;
    expect(island).toMatchObject({ kind: 'project', slot: 1, state: 'active', position: { x: 16, z: 0 } });

    // One worker assigned; capabilities reflect real configuration (no browsing/exec on mock).
    const worker = world.agents.find((a) => a.projectId === projectId)!;
    expect(worker.role).toBe('builder');
    expect(worker.capabilities).toMatchObject({ writeDeliverables: true, executeCode: false, browseWeb: false });
    expect(worker.status).toBe('idle');

    const task = world.tasks.find((t) => t.projectId === projectId)!;
    expect(task.status).toBe('completed');
    expect(task.iteration).toBe(2);

    const attempts = world.attempts.filter((a) => a.taskId === task.id);
    expect(attempts.map((a) => a.status)).toEqual(['succeeded', 'succeeded']);
    expect(attempts[1]!.revisionNotes).toContain('ac-risks');

    const reviews = world.reviews.filter((r) => r.taskId === task.id);
    expect(reviews.map((r) => r.verdict)).toEqual(['revise', 'pass']);

    // Real deliverable files exist, carry the demo disclosure and hashes.
    const deliverables = world.artifacts.filter((a) => a.projectId === projectId && a.kind === 'deliverable');
    expect(deliverables).toHaveLength(2);
    const final = await c.get(`/api/artifacts/${attempts[1]!.outputArtifactId}`);
    expect(final.status).toBe(200);
    expect(final.json.preview).toContain('## Risks');
    expect(final.json.preview).toContain(MOCK_DISCLOSURE);
    const dl = await c.get(`/api/artifacts/${attempts[1]!.outputArtifactId}/download`);
    expect(dl.status).toBe(200);
    expect(String(dl.headers['content-disposition'])).toContain('attachment');

    // Events are valid against the contracts and strictly ordered.
    const ev = await c.get('/api/events?after=0&limit=1000');
    const events = ev.json.events.map(parseWorldEvent);
    const seqs = events.map((e: { seq: number }) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const types = events.map((e: { type: string }) => e.type);
    for (const t of ['project.proposed', 'island.creation_requested', 'island.created', 'agent.assigned', 'task.started', 'artifact.created', 'review.completed', 'project.completed']) {
      expect(types).toContain(t);
    }
    expect(types.indexOf('island.creation_requested')).toBeLessThan(types.lastIndexOf('island.created'));

    // Project inspection endpoint.
    const detail = await c.get(`/api/projects/${projectId}`);
    expect(detail.json.tasks).toHaveLength(1);
    expect(detail.json.agents).toHaveLength(1);
  });

  it('preserves projects and world state across a control-plane restart', async () => {
    h = await harness({ scenario: 'pass' });
    const c = await pair(h);
    const res = await c.post('/api/intake', intakeBody());
    await waitFor(() => snapshot(c), (w) => w.projects[0]?.status === 'completed');
    const before = await snapshot(c);
    const dataDir = h.dataDir;
    await h.close({ keepData: true });

    h = await harness({ dataDir, scenario: 'pass' });
    const c2 = await pair(h);
    const after = await snapshot(c2);
    expect(after.projects.map((p) => [p.id, p.status])).toEqual(before.projects.map((p) => [p.id, p.status]));
    expect(after.islands.map((i) => i.id)).toEqual(before.islands.map((i) => i.id));
    expect(after.cursor).toBeGreaterThan(before.cursor); // recovery event appended
    const art = after.artifacts.find((a) => a.kind === 'deliverable')!;
    const raw = h.ctx.store.rawArtifact(art.id)!;
    expect(existsSync(path.join(dataDir, raw.relPath))).toBe(true);
    expect(readFileSync(path.join(dataDir, raw.relPath), 'utf8')).toContain('## Milestones');
    expect(res.json.projectId).toBe(after.projects[0]!.id);
  });
});
