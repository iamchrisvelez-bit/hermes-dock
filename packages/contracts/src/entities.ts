import { z } from 'zod';
import { AdapterKind, AutonomyTier, Id, IsoTime, Label, Role, Text } from './common.ts';
import {
  AgentStatus,
  ApprovalStatus,
  AttemptStatus,
  IslandState,
  ProjectStatus,
  TaskStatus,
} from './state-machines.ts';

export const User = z.object({
  id: Id,
  displayName: Label,
  role: Role,
  createdAt: IsoTime,
});
export type User = z.infer<typeof User>;

export const RequestClassification = z.enum(['new_project', 'existing_project', 'question', 'unsupported']);

/** Structured brief produced by intake. Every list is bounded so untrusted input stays small. */
export const ProjectBrief = z.object({
  summary: z.string().max(2_000),
  goals: z.array(z.string().max(500)).max(20),
  constraints: z.array(z.string().max(500)).max(20),
  risks: z.array(z.string().max(500)).max(20),
  missingInformation: z.array(z.string().max(500)).max(20),
  classification: RequestClassification,
  relatedProjectIds: z.array(Id).max(10),
  inputArtifactIds: z.array(Id).max(10),
});
export type ProjectBrief = z.infer<typeof ProjectBrief>;

export const AcceptanceCriterion = z.object({
  id: z.string().min(1).max(40),
  description: z.string().max(500),
  /** How the reviewer checks it. `heading` = the deliverable contains a matching Markdown heading. */
  check: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('heading'), pattern: z.string().max(200) }),
    z.object({ kind: z.literal('min_length'), chars: z.number().int().positive() }),
    z.object({ kind: z.literal('list_items_under_heading'), pattern: z.string().max(200), min: z.number().int().positive() }),
    z.object({ kind: z.literal('manual'), note: z.string().max(500) }),
  ]),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

export const Project = z.object({
  id: Id,
  slug: z.string().regex(/^[a-z0-9-]{1,60}$/),
  title: Label,
  status: ProjectStatus,
  autonomyTier: AutonomyTier,
  brief: ProjectBrief,
  acceptanceCriteria: z.array(AcceptanceCriterion).max(20),
  islandId: Id.nullable(),
  createdAt: IsoTime,
  updatedAt: IsoTime,
  archivedAt: IsoTime.nullable(),
  /** Set only after a separately approved permanent data deletion. */
  dataDeletedAt: IsoTime.nullable(),
});
export type Project = z.infer<typeof Project>;

export const DestructionPreset = z.enum(['demolition', 'earthquake', 'dissolve']);
export type DestructionPreset = z.infer<typeof DestructionPreset>;

export const Island = z.object({
  id: Id,
  kind: z.enum(['headquarters', 'project']),
  projectId: Id.nullable(),
  name: Label,
  /** Deterministic slot index; the position is derived from it by world-projection. */
  slot: z.number().int().nonnegative(),
  position: z.object({ x: z.number(), z: z.number() }),
  seed: z.number().int().nonnegative(),
  state: IslandState,
  /** Animation chosen for the archive / destruction event that removed it from view. */
  removalPreset: DestructionPreset.nullable(),
  createdAt: IsoTime,
  updatedAt: IsoTime,
});
export type Island = z.infer<typeof Island>;

export const AgentRole = z.enum(['administrator', 'builder', 'researcher', 'reviewer', 'designer']);
export type AgentRole = z.infer<typeof AgentRole>;

/**
 * Capabilities the backend actually grants. The renderer may only show an ability
 * (browsing, code execution, file editing) when the matching flag is true here.
 */
export const AgentCapabilities = z.object({
  writeDeliverables: z.boolean(),
  readProjectInputs: z.boolean(),
  browseWeb: z.boolean(),
  executeCode: z.boolean(),
  editWorkspaceFiles: z.boolean(),
  delegate: z.boolean(),
});
export type AgentCapabilities = z.infer<typeof AgentCapabilities>;

export const AgentIdentity = z.object({
  id: Id,
  name: Label,
  role: AgentRole,
  status: AgentStatus,
  capabilities: AgentCapabilities,
  /** Persistent character identity; independent of any one runtime session. */
  appearance: z.object({ palette: z.string().max(40), emblem: z.string().max(40) }),
  projectId: Id.nullable(),
  currentTaskId: Id.nullable(),
  /** Concise, owner-visible activity summary. Never hidden reasoning. */
  activity: z.string().max(300).nullable(),
  delegationDepth: z.number().int().nonnegative(),
  createdAt: IsoTime,
  updatedAt: IsoTime,
  retiredAt: IsoTime.nullable(),
});
export type AgentIdentity = z.infer<typeof AgentIdentity>;

export const RuntimeSessionStatus = z.enum(['starting', 'running', 'stopping', 'stopped', 'completed', 'failed', 'unknown']);

export const AgentRuntimeSession = z.object({
  id: Id,
  agentId: Id,
  attemptId: Id,
  adapter: AdapterKind,
  externalRunId: z.string().max(200).nullable(),
  status: RuntimeSessionStatus,
  startedAt: IsoTime,
  endedAt: IsoTime.nullable(),
});
export type AgentRuntimeSession = z.infer<typeof AgentRuntimeSession>;

export const TaskKind = z.enum(['plan_document']);

export const Task = z.object({
  id: Id,
  projectId: Id,
  title: Label,
  kind: TaskKind,
  status: TaskStatus,
  assignedAgentId: Id.nullable(),
  dependsOn: z.array(Id).max(20),
  /** Number of attempts started so far (1-based once running). */
  iteration: z.number().int().nonnegative(),
  maxIterations: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  statusReason: z.string().max(500).nullable(),
  createdAt: IsoTime,
  updatedAt: IsoTime,
});
export type Task = z.infer<typeof Task>;

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
});
export type Usage = z.infer<typeof Usage>;

export const TaskAttempt = z.object({
  id: Id,
  taskId: Id,
  number: z.number().int().positive(),
  status: AttemptStatus,
  adapter: AdapterKind,
  externalRunId: z.string().max(200).nullable(),
  /** Revision instructions derived from the previous review (null on first attempt). */
  revisionNotes: z.string().max(4_000).nullable(),
  startedAt: IsoTime,
  endedAt: IsoTime.nullable(),
  error: z.string().max(2_000).nullable(),
  outputArtifactId: Id.nullable(),
  usage: Usage.nullable(),
});
export type TaskAttempt = z.infer<typeof TaskAttempt>;

export const ArtifactKind = z.enum(['input', 'deliverable', 'partial']);

export const Artifact = z.object({
  id: Id,
  projectId: Id,
  taskId: Id.nullable(),
  attemptId: Id.nullable(),
  kind: ArtifactKind,
  /** Display name only. Storage paths are always derived from `id`, never from this. */
  displayName: z.string().min(1).max(200),
  mediaType: z.enum(['text/plain', 'text/markdown', 'application/json']),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  provenance: z.object({
    source: z.enum(['owner_upload', 'owner_prompt', 'agent_output', 'partial_output']),
    adapter: AdapterKind.nullable(),
    note: z.string().max(500).nullable(),
  }),
  createdAt: IsoTime,
});
export type Artifact = z.infer<typeof Artifact>;

export const ReviewFinding = z.object({
  criterionId: z.string().max(40),
  met: z.boolean(),
  note: z.string().max(500),
});

export const Review = z.object({
  id: Id,
  taskId: Id,
  attemptId: Id,
  artifactId: Id.nullable(),
  verdict: z.enum(['pass', 'revise', 'fail']),
  findings: z.array(ReviewFinding).max(40),
  reviewer: z.string().max(80),
  createdAt: IsoTime,
});
export type Review = z.infer<typeof Review>;

export const ApprovalKind = z.enum([
  'task_plan',
  'island_destruction',
  'project_data_deletion',
  'external_communication',
  'paid_service',
  'host_change',
  'out_of_scope_access',
  'permission_change',
  'administrator_change',
  'shared_access',
  'hermes_tool_action',
]);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

export const ApprovalRequest = z.object({
  id: Id,
  kind: ApprovalKind,
  status: ApprovalStatus,
  summary: z.string().max(500),
  subject: z.object({ kind: z.string().max(40), id: z.string().max(80) }),
  /** Validated per-kind detail (e.g. chosen destruction preset). */
  detail: z.record(z.string(), z.unknown()),
  requestedBy: z.string().max(80),
  createdAt: IsoTime,
  decidedAt: IsoTime.nullable(),
  decidedBy: z.string().max(80).nullable(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

export const ResearchNote = z.object({
  id: Id,
  projectId: Id.nullable(),
  kind: z.enum(['observation', 'hypothesis', 'validated_finding']),
  title: Label,
  body: Text,
  sources: z.array(z.object({ ref: z.string().max(500), note: z.string().max(500) })).max(20),
  createdAt: IsoTime,
});
export type ResearchNote = z.infer<typeof ResearchNote>;

export const SkillProposal = z.object({
  id: Id,
  title: Label,
  description: Text,
  status: z.enum(['proposed', 'evaluating', 'approved', 'rejected', 'promoted', 'rolled_back']),
  version: z.number().int().positive(),
  sourceProjectId: Id.nullable(),
  createdAt: IsoTime,
});
export type SkillProposal = z.infer<typeof SkillProposal>;

export const ResourceBudget = z.object({
  id: Id,
  scope: z.enum(['global', 'project']),
  projectId: Id.nullable(),
  maxTokens: z.number().int().positive().nullable(),
  maxCostUsd: z.number().positive().nullable(),
  usedTokens: z.number().int().nonnegative(),
  usedCostUsd: z.number().nonnegative(),
  /** True when the adapter reports no usage, so the budget cannot be enforced precisely. */
  usageUnreported: z.boolean(),
});
export type ResourceBudget = z.infer<typeof ResourceBudget>;
