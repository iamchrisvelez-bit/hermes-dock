import { z } from 'zod';
import { Id, IsoTime, Role, SCHEMA_VERSION } from './common.ts';
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
import { AdapterHealth, Controls } from './events.ts';

export const ApiErrorCode = z.enum([
  'bad_request',
  'unauthorized',
  'forbidden',
  'csrf_failed',
  'not_found',
  'conflict',
  'policy_denied',
  'rate_limited',
  'payload_too_large',
  'unsupported_media',
  'cursor_expired',
  'internal',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export const ApiError = z.object({
  error: z.object({ code: ApiErrorCode, message: z.string().max(1_000), detail: z.unknown().optional() }),
});
export type ApiError = z.infer<typeof ApiError>;

// ---------- Auth ----------

export const PairRequest = z.object({
  code: z.string().regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/, 'pairing codes look like ABCD-EF23'),
  deviceName: z.string().min(1).max(60),
});
export type PairRequest = z.infer<typeof PairRequest>;

export const SessionInfo = z.object({
  sessionId: Id,
  userId: Id,
  role: Role,
  deviceName: z.string().max(60),
  /** Double-submit token; send as `X-HDW-CSRF` on every mutating request. */
  csrfToken: z.string().min(32).max(128),
  createdAt: IsoTime,
  expiresAt: IsoTime,
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const SessionListItem = z.object({
  sessionId: Id,
  deviceName: z.string().max(60),
  createdAt: IsoTime,
  lastSeenAt: IsoTime,
  expiresAt: IsoTime,
  current: z.boolean(),
});

// ---------- Intake ----------

export const UploadedFile = z.object({
  /** Untrusted display name; never used to build a path. */
  name: z.string().min(1).max(200),
  /** Base64 of the raw bytes so the server can validate encoding itself. */
  contentBase64: z.string().max(2_000_000),
});
export type UploadedFile = z.infer<typeof UploadedFile>;

export const IntakeRequest = z.object({
  prompt: z.string().max(20_000).default(''),
  title: z.string().max(120).optional(),
  files: z.array(UploadedFile).max(5).default([]),
  /** Explicit target; otherwise intake decides new vs existing. */
  projectId: Id.optional(),
  idempotencyKey: z.string().min(8).max(80),
});
export type IntakeRequest = z.input<typeof IntakeRequest>;

export const IntakeResponse = z.object({
  outcome: z.enum(['project_created', 'attached_to_existing', 'needs_clarification', 'rejected']),
  projectId: Id.nullable(),
  taskId: Id.nullable(),
  questions: z.array(z.string().max(300)).max(5),
  message: z.string().max(500),
});
export type IntakeResponse = z.infer<typeof IntakeResponse>;

// ---------- Commands ----------

export const ArchiveProjectRequest = z.object({ preset: DestructionPreset.default('dissolve') });
export const RequestIslandDestruction = z.object({ preset: DestructionPreset });
export const DecideApprovalRequest = z.object({ decision: z.enum(['approve', 'deny']) });
export const ControlsRequest = z.object({
  action: z.enum(['pause_all', 'resume_all', 'disable_new_work', 'enable_new_work', 'emergency_stop', 'clear_emergency_stop']),
});

// ---------- Snapshot ----------

export const WorldSnapshot = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  /** Last event sequence folded into this snapshot. Resume the stream after it. */
  cursor: z.number().int().nonnegative(),
  generatedAt: IsoTime,
  adapter: AdapterHealth,
  controls: Controls,
  projects: z.array(Project),
  islands: z.array(Island),
  agents: z.array(AgentIdentity),
  tasks: z.array(Task),
  attempts: z.array(TaskAttempt),
  artifacts: z.array(Artifact),
  reviews: z.array(Review),
  approvals: z.array(ApprovalRequest),
});
export type WorldSnapshot = z.infer<typeof WorldSnapshot>;

/** Sent on the SSE stream when the client's cursor predates retained events. */
export const SnapshotRequiredNotice = z.object({
  reason: z.enum(['cursor_expired', 'cursor_ahead', 'schema_changed']),
  latestSeq: z.number().int().nonnegative(),
});
