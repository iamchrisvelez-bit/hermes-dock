import { describe, expect, it } from 'vitest';
import type { AgentIdentity, WorldEvent, WorldSnapshot } from '@hdw/contracts';
import { abilityBadges, foldEvent, hermesPose, islandActivity, nextFreeSlot, seedFrom, slotPosition, workerAnimation } from '../src/index.ts';

const T = '2026-10-08T12:00:00.000Z';

function emptyWorld(cursor = 0): WorldSnapshot {
  return {
    schemaVersion: 1,
    cursor,
    generatedAt: T,
    adapter: { adapter: 'mock', live: false, state: 'ready', detail: '', hermesVersion: null, checkedAt: T },
    controls: { pauseAll: false, newWorkDisabled: false, emergencyStop: false, updatedAt: T },
    projects: [],
    islands: [],
    agents: [],
    tasks: [],
    attempts: [],
    artifacts: [],
    reviews: [],
    approvals: [],
  };
}

const island = (id: string, slot: number): WorldSnapshot['islands'][number] => ({
  id,
  kind: 'project' as const,
  projectId: 'prj_1',
  name: 'x',
  slot,
  position: slotPosition(slot),
  seed: 1,
  state: 'active' as const,
  removalPreset: null,
  createdAt: T,
  updatedAt: T,
});

const ev = (seq: number, i = island('isl_a', 1)): WorldEvent =>
  ({ id: `evt_${seq}`, schemaVersion: 1, seq, ts: T, type: 'island.created', actor: { kind: 'hermes' }, refs: [], correlationId: 'c', payload: { island: i } }) as WorldEvent;

describe('island placement', () => {
  it('is deterministic and collision-free', () => {
    expect(slotPosition(0)).toEqual({ x: 0, z: 0 });
    expect(slotPosition(1)).toEqual(slotPosition(1));
    const keys = new Set(Array.from({ length: 60 }, (_, i) => JSON.stringify(slotPosition(i))));
    expect(keys.size).toBe(60);
    for (let i = 1; i < 60; i++) {
      const p = slotPosition(i);
      expect(Math.hypot(p.x, p.z)).toBeGreaterThanOrEqual(15.9);
    }
  });

  it('reuses only slots freed by destroyed islands', () => {
    expect(nextFreeSlot([{ slot: 0, state: 'active' }])).toBe(1);
    expect(nextFreeSlot([{ slot: 0, state: 'active' }, { slot: 1, state: 'archived' }])).toBe(2);
    expect(nextFreeSlot([{ slot: 0, state: 'active' }, { slot: 1, state: 'destroyed' }])).toBe(1);
  });

  it('derives stable seeds', () => {
    expect(seedFrom('prj_abc')).toBe(seedFrom('prj_abc'));
    expect(seedFrom('prj_abc')).not.toBe(seedFrom('prj_abd'));
  });
});

describe('event folding', () => {
  it('applies in order, ignores duplicates, flags gaps', () => {
    let w = emptyWorld(0);
    const r1 = foldEvent(w, ev(1));
    expect(r1.result).toBe('applied');
    w = r1.world;
    expect(w.islands).toHaveLength(1);
    expect(foldEvent(w, ev(1)).result).toBe('duplicate');
    expect(foldEvent(w, ev(3)).result).toBe('gap');
    const r2 = foldEvent(w, ev(2, { ...island('isl_a', 1), state: 'archived' }));
    expect(r2.world.islands).toHaveLength(1);
    expect(r2.world.islands[0]!.state).toBe('archived');
    expect(r2.world.cursor).toBe(2);
  });
});

describe('visual state is derived from real state', () => {
  const agent = (status: AgentIdentity['status'], caps: Partial<AgentIdentity['capabilities']> = {}): AgentIdentity => ({
    id: 'agt_1',
    name: 'Rivet',
    role: 'builder',
    status,
    capabilities: { writeDeliverables: true, readProjectInputs: true, browseWeb: false, executeCode: false, editWorkspaceFiles: false, delegate: false, ...caps },
    appearance: { palette: 'ember', emblem: 'hex-bolt' },
    projectId: null,
    currentTaskId: null,
    activity: null,
    delegationDepth: 1,
    createdAt: T,
    updatedAt: T,
    retiredAt: null,
  });

  it('only animates work while the backend says working and the link is up', () => {
    expect(workerAnimation(agent('working'), true)).toBe('work');
    expect(workerAnimation(agent('working'), false)).toBe('idle');
    expect(workerAnimation(agent('idle'), true)).toBe('idle');
    expect(workerAnimation(agent('blocked'), true)).toBe('blocked');
  });

  it('shows abilities only when granted', () => {
    expect(abilityBadges(agent('idle'))).toEqual(['reads inputs', 'writes deliverables']);
    expect(abilityBadges(agent('idle', { browseWeb: true }))).toContain('browses web');
    expect(abilityBadges(agent('idle'))).not.toContain('executes code');
  });

  it('Hermes is alert when disconnected or stopped, blocked on pending approvals', () => {
    const w = emptyWorld();
    expect(hermesPose(w, { connected: false, emergencyStop: false, pauseAll: false })).toBe('alert');
    expect(hermesPose(w, { connected: true, emergencyStop: true, pauseAll: true })).toBe('alert');
    expect(hermesPose(w, { connected: true, emergencyStop: false, pauseAll: false })).toBe('idle');
    const withApproval = { ...w, approvals: [{ status: 'pending' } as WorldSnapshot['approvals'][number]] };
    expect(hermesPose(withApproval, { connected: true, emergencyStop: false, pauseAll: false })).toBe('blocked');
  });

  it('island activity reflects tasks, not animation', () => {
    const p = { id: 'prj_1', status: 'active' } as WorldSnapshot['projects'][number];
    expect(islandActivity(p, [])).toBe('idle');
    expect(islandActivity(p, [{ projectId: 'prj_1', status: 'running' } as WorldSnapshot['tasks'][number]])).toBe('working');
    expect(islandActivity({ ...p, status: 'archived' }, [])).toBe('archived');
  });
});
