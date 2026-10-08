import { describe, expect, it } from 'vitest';
import {
  AGENT_TRANSITIONS,
  IllegalTransitionError,
  PROJECT_TRANSITIONS,
  Project,
  SCHEMA_VERSION,
  TASK_TRANSITIONS,
  assertTransition,
  canTransition,
  newId,
  parseWorldEvent,
} from '../src/index.ts';

const t = '2026-10-08T12:00:00.000Z';
const project = {
  id: 'prj_abc123',
  slug: 'garden',
  title: 'Garden',
  status: 'active',
  autonomyTier: 'bounded_autonomous',
  brief: { summary: 's', goals: [], constraints: [], risks: [], missingInformation: [], classification: 'new_project', relatedProjectIds: [], inputArtifactIds: [] },
  acceptanceCriteria: [{ id: 'a', description: 'd', check: { kind: 'heading', pattern: 'risks' } }],
  islandId: null,
  createdAt: t,
  updatedAt: t,
  archivedAt: null,
  dataDeletedAt: null,
};

describe('schemas', () => {
  it('accepts a valid project and rejects invalid ones', () => {
    expect(Project.parse(project).id).toBe('prj_abc123');
    expect(() => Project.parse({ ...project, status: 'done' })).toThrow();
    expect(() => Project.parse({ ...project, id: '../etc' })).toThrow();
    expect(() => Project.parse({ ...project, slug: 'Has Spaces' })).toThrow();
    expect(() => Project.parse({ ...project, acceptanceCriteria: [{ id: 'a', description: 'd', check: { kind: 'shell', cmd: 'rm -rf' } }] })).toThrow();
  });

  it('validates event envelopes and type-specific payloads', () => {
    const env = {
      id: 'evt_1',
      schemaVersion: SCHEMA_VERSION,
      seq: 1,
      ts: t,
      type: 'project.created',
      actor: { kind: 'hermes' },
      refs: [{ kind: 'project', id: 'prj_abc123' }],
      correlationId: 'cor_1',
      payload: { project },
    };
    expect(parseWorldEvent(env).type).toBe('project.created');
    expect(() => parseWorldEvent({ ...env, payload: { project: { ...project, status: 'nope' } } })).toThrow();
    expect(() => parseWorldEvent({ ...env, type: 'project.exploded' })).toThrow();
    expect(() => parseWorldEvent({ ...env, schemaVersion: 99 })).toThrow();
    expect(() => parseWorldEvent({ ...env, seq: 0 })).toThrow();
  });

  it('generates prefixed ids', () => {
    expect(newId('prj')).toMatch(/^prj_[A-Za-z0-9]{16}$/);
  });
});

describe('state machines', () => {
  it('allows the documented happy paths', () => {
    const path = ['proposed', 'planning', 'active', 'review', 'completed'];
    for (let i = 0; i < path.length - 1; i++) expect(canTransition('project', path[i]!, path[i + 1]!)).toBe(true);
    const agent = ['created', 'idle', 'assigned', 'working', 'reviewing', 'idle'];
    for (let i = 0; i < agent.length - 1; i++) expect(canTransition('agent', agent[i]!, agent[i + 1]!)).toBe(true);
    const task = ['queued', 'running', 'review', 'completed'];
    for (let i = 0; i < task.length - 1; i++) expect(canTransition('task', task[i]!, task[i + 1]!)).toBe(true);
  });

  it('rejects illegal jumps', () => {
    expect(() => assertTransition('task', 'queued', 'completed')).toThrow(IllegalTransitionError);
    expect(() => assertTransition('project', 'archived', 'active')).toThrow();
    expect(() => assertTransition('agent', 'retired', 'idle')).toThrow();
    expect(() => assertTransition('island', 'destroyed', 'active')).toThrow();
    expect(() => assertTransition('approval', 'approved', 'denied')).toThrow();
  });

  it('has terminal states with no exits', () => {
    expect(TASK_TRANSITIONS.completed).toEqual([]);
    expect(TASK_TRANSITIONS.cancelled).toEqual([]);
    expect(AGENT_TRANSITIONS.retired).toEqual([]);
    expect(PROJECT_TRANSITIONS.archived).toEqual([]);
  });
});
