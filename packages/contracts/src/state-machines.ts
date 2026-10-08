import { z } from 'zod';

/**
 * Explicit state machines. Every status change in the control plane goes through
 * `assertTransition`, so an illegal jump (e.g. queued -> completed) is a bug that fails
 * loudly instead of a silently inconsistent world.
 */

export const ProjectStatus = z.enum([
  'proposed',
  'planning',
  'active',
  'review',
  'completed',
  'paused',
  'blocked',
  'failed',
  'archived',
]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const AgentStatus = z.enum([
  'created',
  'idle',
  'assigned',
  'working',
  'reviewing',
  'blocked',
  'error',
  'retiring',
  'retired',
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const TaskStatus = z.enum([
  'queued',
  'running',
  'review',
  'completed',
  'waiting_for_approval',
  'blocked',
  'failed',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const AttemptStatus = z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'timed_out']);
export type AttemptStatus = z.infer<typeof AttemptStatus>;

export const IslandState = z.enum(['materializing', 'active', 'archived', 'destroyed']);
export type IslandState = z.infer<typeof IslandState>;

export const ApprovalStatus = z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled']);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

type Machine<S extends string> = Readonly<Record<S, readonly S[]>>;

export const PROJECT_TRANSITIONS: Machine<ProjectStatus> = {
  proposed: ['planning', 'archived', 'failed'],
  planning: ['active', 'paused', 'blocked', 'failed', 'archived'],
  active: ['review', 'paused', 'blocked', 'failed', 'archived'],
  review: ['active', 'completed', 'paused', 'blocked', 'failed', 'archived'],
  completed: ['archived', 'active'],
  paused: ['planning', 'active', 'review', 'archived', 'failed'],
  blocked: ['planning', 'active', 'review', 'paused', 'failed', 'archived'],
  failed: ['planning', 'archived'],
  archived: [],
};

export const AGENT_TRANSITIONS: Machine<AgentStatus> = {
  created: ['idle', 'retiring'],
  idle: ['assigned', 'retiring'],
  assigned: ['working', 'idle', 'blocked', 'retiring'],
  working: ['reviewing', 'idle', 'blocked', 'error', 'assigned'],
  reviewing: ['idle', 'working', 'assigned', 'blocked', 'error'],
  blocked: ['assigned', 'working', 'idle', 'error', 'retiring'],
  error: ['idle', 'retiring'],
  retiring: ['retired'],
  retired: [],
};

export const TASK_TRANSITIONS: Machine<TaskStatus> = {
  queued: ['running', 'waiting_for_approval', 'blocked', 'cancelled', 'failed'],
  running: ['review', 'failed', 'cancelled', 'blocked', 'queued', 'waiting_for_approval'],
  review: ['completed', 'queued', 'failed', 'blocked', 'cancelled'],
  waiting_for_approval: ['queued', 'running', 'cancelled', 'blocked'],
  blocked: ['queued', 'cancelled', 'failed'],
  completed: [],
  failed: ['queued'],
  cancelled: [],
};

export const ISLAND_TRANSITIONS: Machine<IslandState> = {
  materializing: ['active', 'archived', 'destroyed'],
  active: ['archived', 'destroyed'],
  archived: ['active', 'destroyed'],
  destroyed: [],
};

export const APPROVAL_TRANSITIONS: Machine<ApprovalStatus> = {
  pending: ['approved', 'denied', 'expired', 'cancelled'],
  approved: [],
  denied: [],
  expired: [],
  cancelled: [],
};

export const MACHINES = {
  project: PROJECT_TRANSITIONS,
  agent: AGENT_TRANSITIONS,
  task: TASK_TRANSITIONS,
  island: ISLAND_TRANSITIONS,
  approval: APPROVAL_TRANSITIONS,
} as const;
export type MachineName = keyof typeof MACHINES;

export class IllegalTransitionError extends Error {
  constructor(
    readonly machine: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal ${machine} transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition<M extends MachineName>(machine: M, from: string, to: string): boolean {
  const table = MACHINES[machine] as Record<string, readonly string[]>;
  return (table[from] ?? []).includes(to);
}

export function assertTransition<M extends MachineName>(machine: M, from: string, to: string): void {
  if (!canTransition(machine, from, to)) throw new IllegalTransitionError(machine, from, to);
}

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'cancelled'];
export const TERMINAL_ATTEMPT_STATUSES: readonly AttemptStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'timed_out',
];
