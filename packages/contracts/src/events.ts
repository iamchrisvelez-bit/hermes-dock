import { z } from 'zod';
import { ActorRef, AdapterKind, EntityRef, Id, IsoTime, SCHEMA_VERSION } from './common.ts';
import {
  AgentIdentity,
  ApprovalRequest,
  Artifact,
  DestructionPreset,
  Island,
  Project,
  Review,
  Task,
  TaskAttempt,
} from './entities.ts';

export const Controls = z.object({
  /** Running work is asked to stop and no queued work starts. */
  pauseAll: z.boolean(),
  /** Queued/running work continues but nothing new is accepted. */
  newWorkDisabled: z.boolean(),
  /** Emergency stop: everything paused, new work refused, until the owner clears it. */
  emergencyStop: z.boolean(),
  updatedAt: IsoTime,
});
export type Controls = z.infer<typeof Controls>;

export const AdapterHealth = z.object({
  adapter: AdapterKind,
  /** True only for a real Hermes runtime. The mock adapter is always `live: false`. */
  live: z.boolean(),
  state: z.enum(['ready', 'degraded', 'unreachable', 'refused_by_policy', 'unknown']),
  detail: z.string().max(500),
  hermesVersion: z.string().max(80).nullable(),
  checkedAt: IsoTime,
});
export type AdapterHealth = z.infer<typeof AdapterHealth>;

const ToolStatus = z.object({
  name: z.string().max(120),
  phase: z.enum(['started', 'completed']),
  error: z.boolean().optional(),
});

/** Payload schema per event type. An event whose payload fails validation is never stored. */
export const EVENT_PAYLOADS = {
  'project.proposed': z.object({ project: Project }),
  'project.created': z.object({ project: Project }),
  'project.updated': z.object({ project: Project }),
  'project.completed': z.object({ project: Project }),
  'project.archived': z.object({ project: Project }),
  'project.data_deleted': z.object({ projectId: Id, removedFiles: z.number().int().nonnegative() }),
  'island.creation_requested': z.object({ island: Island }),
  'island.created': z.object({ island: Island }),
  'island.updated': z.object({ island: Island }),
  'island.archived': z.object({ island: Island, preset: DestructionPreset }),
  'island.destruction_requested': z.object({ island: Island, approvalId: Id, preset: DestructionPreset }),
  'island.destroyed': z.object({ island: Island, preset: DestructionPreset }),
  'agent.created': z.object({ agent: AgentIdentity }),
  'agent.assigned': z.object({ agent: AgentIdentity, taskId: Id }),
  'agent.updated': z.object({ agent: AgentIdentity }),
  'agent.retired': z.object({ agent: AgentIdentity }),
  'task.created': z.object({ task: Task }),
  'task.updated': z.object({ task: Task }),
  'task.started': z.object({ task: Task, attempt: TaskAttempt }),
  'task.progress': z.object({
    taskId: Id,
    attemptId: Id,
    summary: z.string().max(300),
    tool: ToolStatus.optional(),
  }),
  'task.cancel_requested': z.object({ task: Task, attemptId: Id.nullable() }),
  'task.cancelled': z.object({ task: Task, attemptId: Id.nullable(), terminationVerified: z.boolean() }),
  'attempt.finished': z.object({ attempt: TaskAttempt }),
  'artifact.created': z.object({ artifact: Artifact }),
  'review.completed': z.object({ review: Review }),
  'approval.requested': z.object({ approval: ApprovalRequest }),
  'approval.decided': z.object({ approval: ApprovalRequest }),
  'system.controls_changed': z.object({ controls: Controls }),
  'system.adapter_status': z.object({ health: AdapterHealth }),
  'system.recovered': z.object({ summary: z.string().max(500), reconciled: z.number().int().nonnegative() }),
} as const;

export type WorldEventType = keyof typeof EVENT_PAYLOADS;
export const WORLD_EVENT_TYPES = Object.keys(EVENT_PAYLOADS) as WorldEventType[];
export const WorldEventTypeSchema = z.enum(WORLD_EVENT_TYPES as [WorldEventType, ...WorldEventType[]]);

export type EventPayload<T extends WorldEventType> = z.infer<(typeof EVENT_PAYLOADS)[T]>;

export const WorldEventEnvelope = z.object({
  id: Id,
  schemaVersion: z.literal(SCHEMA_VERSION),
  /** Monotonic world sequence; doubles as the replay cursor. */
  seq: z.number().int().positive(),
  ts: IsoTime,
  type: WorldEventTypeSchema,
  actor: ActorRef,
  refs: z.array(EntityRef).max(10),
  correlationId: z.string().min(1).max(80),
  payload: z.unknown(),
});

export type WorldEvent<T extends WorldEventType = WorldEventType> = Omit<
  z.infer<typeof WorldEventEnvelope>,
  'type' | 'payload'
> & { type: T; payload: EventPayload<T> };

/** Validate an envelope and its type-specific payload. Throws on any mismatch. */
export function parseWorldEvent(raw: unknown): WorldEvent {
  const env = WorldEventEnvelope.parse(raw);
  const payload = EVENT_PAYLOADS[env.type].parse(env.payload);
  return { ...env, payload } as WorldEvent;
}

export function parsePayload<T extends WorldEventType>(type: T, payload: unknown): EventPayload<T> {
  return EVENT_PAYLOADS[type].parse(payload) as EventPayload<T>;
}
