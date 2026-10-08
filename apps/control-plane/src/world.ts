import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  AGENT_TRANSITIONS,
  assertTransition,
  canTransition,
  newId,
  type AdapterHealth,
  type AgentCapabilities,
  type AgentIdentity,
  type AgentRole,
  type AgentStatus,
  type ApprovalKind,
  type ApprovalRequest,
  type Artifact,
  type Controls,
  type DestructionPreset,
  type EntityRef,
  type IntakeResponse,
  type Island,
  type IslandState,
  type Project,
  type ProjectStatus,
  type Task,
  type TaskStatus,
  type WorldSnapshot,
} from '@hdw/contracts';
import { buildIntake, planForBrief, slugify, validateTaskGraph } from '@hdw/orchestration';
import {
  ensureProjectDirs,
  evaluate,
  resolveInside,
  sandboxReport,
  validateUploads,
  decodeBase64Strict,
  UploadRejected,
  type PolicyAction,
  type PolicyDecision,
  type SandboxReport,
  type ValidatedUpload,
} from '@hdw/workspace-policy';
import { HQ_SLOT, ROLE_APPEARANCE, nextFreeSlot, seedFrom, slotPosition } from '@hdw/world-projection';
import type { AppConfig } from './config.ts';
import type { EmitMeta, Store } from './store.ts';

export class DomainError extends Error {
  constructor(
    readonly code: 'bad_request' | 'not_found' | 'conflict' | 'policy_denied' | 'payload_too_large' | 'unsupported_media',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

const now = () => new Date().toISOString();

const WORKER_NAMES: Record<AgentRole, string[]> = {
  administrator: ['Hermes'],
  builder: ['Rivet', 'Kiln', 'Truss', 'Anvil', 'Flux', 'Girder'],
  researcher: ['Lumen', 'Sonar', 'Atlas', 'Quill'],
  reviewer: ['Verity', 'Plumb', 'Gauge'],
  designer: ['Prism', 'Hue', 'Vellum'],
};

/** Shortest legal path between agent states (BFS over the state machine). */
export function agentPath(from: AgentStatus, to: AgentStatus): AgentStatus[] | null {
  const prev = new Map<AgentStatus, AgentStatus | null>([[from, null]]);
  const queue: AgentStatus[] = [from];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === to) {
      const path: AgentStatus[] = [];
      for (let c: AgentStatus | null = cur; c !== null; c = prev.get(c) ?? null) path.unshift(c);
      return path;
    }
    for (const nxt of AGENT_TRANSITIONS[cur]) {
      if (!prev.has(nxt)) {
        prev.set(nxt, cur);
        queue.push(nxt);
      }
    }
  }
  return null;
}

export interface OwnerActor {
  userId: string;
}

export class WorldService {
  readonly sandbox: SandboxReport;
  adapterHealth: AdapterHealth;
  /** Toolsets Hermes reported for the api_server platform at the last probe. */
  enabledToolsets: string[] | null = [];

  constructor(
    readonly store: Store,
    readonly config: AppConfig,
    initialHealth: AdapterHealth,
    sandbox?: SandboxReport,
  ) {
    this.adapterHealth = initialHealth;
    this.sandbox = sandbox ?? sandboxReport({ dockerCli: false });
  }

  // ---------- Policy ----------

  decide(action: PolicyAction): PolicyDecision {
    return evaluate(action, {
      policy: this.config.policy,
      controls: this.store.controls(),
      sandbox: { executableWorkEnabled: this.sandbox.executableWorkEnabled, reason: this.sandbox.reason },
    });
  }

  private require(action: PolicyAction, actor: string): void {
    const d = this.decide(action);
    if (d.outcome !== 'allow') {
      this.store.audit(actor, `policy.${action.kind}`, 'denied', null, { reason: d.reason });
      throw new DomainError('policy_denied', d.reason, d);
    }
  }

  // ---------- Bootstrap ----------

  bootstrap(): void {
    this.store.controls();
    const meta: EmitMeta = { actor: { kind: 'system' }, refs: [], correlationId: newId('cor') };
    this.store.commit(() => {
      let hq = this.store.list('islands', "kind = 'headquarters'")[0];
      if (!hq) {
        const t = now();
        hq = {
          id: newId('isl'),
          kind: 'headquarters',
          projectId: null,
          name: 'Hermes Headquarters',
          slot: HQ_SLOT,
          position: slotPosition(HQ_SLOT),
          seed: 7,
          state: 'active',
          removalPreset: null,
          createdAt: t,
          updatedAt: t,
        };
        this.store.save('islands', hq);
        this.store.emit('island.created', { island: hq }, { ...meta, refs: [{ kind: 'island', id: hq.id }] });
      }
      if (!this.store.list('agents', "role = 'administrator'")[0]) {
        const admin = this.makeAgent('administrator', null, 'hermes', {
          writeDeliverables: false,
          readProjectInputs: true,
          browseWeb: false,
          executeCode: false,
          editWorkspaceFiles: false,
          delegate: true,
        });
        this.store.save('agents', admin);
        this.store.emit('agent.created', { agent: admin }, { ...meta, refs: [{ kind: 'agent', id: admin.id }] });
        const idle = this.agentTo(admin, 'idle', 'Administering the world');
        this.store.emit('agent.updated', { agent: idle }, { ...meta, refs: [{ kind: 'agent', id: admin.id }] });
      }
      if (!this.store.list('agents', "role = 'reviewer' AND project_id IS NULL")[0]) {
        const rev = this.makeAgent('reviewer', null, 'reviewer', {
          writeDeliverables: false,
          readProjectInputs: true,
          browseWeb: false,
          executeCode: false,
          editWorkspaceFiles: false,
          delegate: false,
        });
        this.store.save('agents', rev);
        this.store.emit('agent.created', { agent: rev }, { ...meta, refs: [{ kind: 'agent', id: rev.id }] });
        const idle = this.agentTo(rev, 'idle', null);
        this.store.emit('agent.updated', { agent: idle }, { ...meta, refs: [{ kind: 'agent', id: rev.id }] });
      }
    });
  }

  private makeAgent(role: AgentRole, projectId: string | null, seedKey: string, capabilities: AgentCapabilities, depth = 0): AgentIdentity {
    const t = now();
    const names = WORKER_NAMES[role];
    const id = newId('agt');
    const look = ROLE_APPEARANCE[role];
    return {
      id,
      name: names[seedFrom(seedKey + id) % names.length]!,
      role,
      status: 'created',
      capabilities,
      appearance: { palette: look.palette, emblem: look.emblem },
      projectId,
      currentTaskId: null,
      activity: null,
      delegationDepth: depth,
      createdAt: t,
      updatedAt: t,
      retiredAt: null,
    };
  }

  /** Capabilities a builder actually has with the current adapter + policy. */
  workerCapabilities(): AgentCapabilities {
    const live = this.config.adapter === 'hermes-runs';
    const allowed = new Set(this.config.policy.allowedHermesToolsets);
    const enabled = new Set(this.enabledToolsets ?? []);
    const has = (t: string) => live && allowed.has(t) && enabled.has(t);
    return {
      writeDeliverables: true,
      readProjectInputs: true,
      browseWeb: has('web'),
      executeCode: false,
      editWorkspaceFiles: false,
      delegate: false,
    };
  }

  // ---------- Transitions (validate + save; caller emits within the same commit) ----------

  projectTo(p: Project, to: ProjectStatus): Project {
    if (p.status === to) return p;
    assertTransition('project', p.status, to);
    const t = now();
    const next: Project = { ...p, status: to, updatedAt: t, archivedAt: to === 'archived' ? t : p.archivedAt };
    this.store.save('projects', next);
    return next;
  }

  taskTo(task: Task, to: TaskStatus, reason: string | null = task.statusReason, patch: Partial<Task> = {}): Task {
    if (task.status !== to) assertTransition('task', task.status, to);
    const next: Task = { ...task, ...patch, status: to, statusReason: reason, updatedAt: now() };
    this.store.save('tasks', next);
    return next;
  }

  /**
   * Move an agent to `to`. When there is no direct edge, the shortest legal path through
   * the agent state machine is required to exist (e.g. idle -> assigned -> working);
   * an unreachable target still throws.
   */
  agentTo(a: AgentIdentity, to: AgentStatus, activity: string | null, patch: Partial<AgentIdentity> = {}): AgentIdentity {
    if (a.status !== to && !canTransition('agent', a.status, to)) {
      if (!agentPath(a.status, to)) assertTransition('agent', a.status, to);
    }
    const t = now();
    const next: AgentIdentity = {
      ...a,
      ...patch,
      status: to,
      activity: activity ? activity.slice(0, 300) : null,
      updatedAt: t,
      retiredAt: to === 'retired' ? t : a.retiredAt,
    };
    this.store.save('agents', next);
    return next;
  }

  islandTo(i: Island, to: IslandState, preset: DestructionPreset | null = i.removalPreset): Island {
    if (i.state !== to) assertTransition('island', i.state, to);
    const next: Island = { ...i, state: to, removalPreset: preset, updatedAt: now() };
    this.store.save('islands', next);
    return next;
  }

  ref(kind: EntityRef['kind'], id: string): EntityRef {
    return { kind, id };
  }

  // ---------- Snapshot ----------

  snapshot(): WorldSnapshot {
    return {
      schemaVersion: 1,
      cursor: this.store.latestSeq(),
      generatedAt: now(),
      adapter: this.adapterHealth,
      controls: this.store.controls(),
      projects: this.store.list('projects'),
      islands: this.store.list('islands', "state <> 'destroyed'"),
      agents: this.store.list('agents', "status <> 'retired'"),
      tasks: this.store.list('tasks'),
      attempts: this.store.list('task_attempts'),
      artifacts: this.store.list('artifacts'),
      reviews: this.store.list('reviews'),
      approvals: this.store.list('approvals'),
    };
  }

  // ---------- Files ----------

  private writeArtifactFile(projectId: string, dir: 'input' | 'deliverables' | 'partial', artifactId: string, ext: string, bytes: Buffer): string {
    const dirs = ensureProjectDirs(this.config.dataDir, projectId);
    const folder = dir === 'input' ? dirs.input : dir === 'deliverables' ? dirs.deliverables : dirs.partial;
    const file = resolveInside(folder, `${artifactId}${ext}`);
    writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    return path.relative(this.config.dataDir, file);
  }

  artifactPath(relPath: string): string {
    const parts = relPath.split(/[\\/]/);
    return resolveInside(this.config.dataDir, ...parts);
  }

  recordArtifact(args: {
    projectId: string;
    taskId: string | null;
    attemptId: string | null;
    kind: Artifact['kind'];
    displayName: string;
    mediaType: Artifact['mediaType'];
    bytes: Buffer;
    sha256: string;
    provenance: Artifact['provenance'];
  }): Artifact {
    const id = newId('art');
    const ext = args.mediaType === 'application/json' ? '.json' : args.mediaType === 'text/markdown' ? '.md' : '.txt';
    const dir = args.kind === 'input' ? 'input' : args.kind === 'deliverable' ? 'deliverables' : 'partial';
    const relPath = this.writeArtifactFile(args.projectId, dir, id, ext, args.bytes);
    const artifact: Artifact = {
      id,
      projectId: args.projectId,
      taskId: args.taskId,
      attemptId: args.attemptId,
      kind: args.kind,
      displayName: args.displayName,
      mediaType: args.mediaType,
      sizeBytes: args.bytes.length,
      sha256: args.sha256,
      provenance: args.provenance,
      createdAt: now(),
    };
    this.store.save('artifacts', { ...artifact, relPath });
    return artifact;
  }

  // ---------- Intake ----------

  intake(
    req: { prompt: string; title?: string | undefined; files: Array<{ name: string; contentBase64: string }>; projectId?: string | undefined; idempotencyKey: string },
    actor: OwnerActor,
  ): IntakeResponse {
    const scope = `intake:${actor.userId}`;
    const prior = this.store.idempotent<IntakeResponse>(scope, req.idempotencyKey);
    if (prior) return prior;

    this.require({ kind: 'intake' }, actor.userId);
    let uploads: ValidatedUpload[];
    try {
      uploads = validateUploads(req.files.map((f) => ({ name: f.name, bytes: decodeBase64Strict(f.contentBase64) })));
    } catch (e) {
      if (e instanceof UploadRejected) {
        this.store.audit(actor.userId, 'intake.upload', 'denied', null, { reason: e.message });
        throw new DomainError(e.code === 'too_large' || e.code === 'too_many' ? 'payload_too_large' : 'unsupported_media', e.message);
      }
      throw e;
    }

    const existing = this.store.list('projects');
    // Build the decision with placeholder artifact ids; real ids are assigned once a project exists.
    const decision = buildIntake(
      {
        prompt: req.prompt,
        files: uploads.map((u, i) => ({ artifactId: `art_pending${i}`, displayName: u.displayName, text: u.text })),
        explicitProjectId: req.projectId,
      },
      existing,
    );

    let response: IntakeResponse;
    if (decision.kind === 'needs_clarification') {
      response = { outcome: 'needs_clarification', projectId: null, taskId: null, questions: decision.questions, message: 'Hermes needs a little more detail before planning.' };
    } else if (decision.kind === 'rejected') {
      response = { outcome: 'rejected', projectId: null, taskId: null, questions: [], message: decision.reason };
    } else if (decision.kind === 'existing_project') {
      response = this.attachToProject(decision.projectId, decision.brief, uploads, req.prompt, actor);
    } else {
      response = this.createProject(req.title?.trim() || decision.title, decision.brief, uploads, req.prompt, actor);
    }
    this.store.rememberIdempotent(scope, req.idempotencyKey, response);
    return response;
  }

  private storeInputs(projectId: string, uploads: ValidatedUpload[], prompt: string): Artifact[] {
    const out: Artifact[] = [];
    if (prompt.trim()) {
      const bytes = Buffer.from(prompt, 'utf8');
      const v = validateUploads([{ name: 'prompt.txt', bytes }], { maxFiles: 1, maxFileBytes: 64 * 1024, maxTotalBytes: 64 * 1024 })[0]!;
      out.push(
        this.recordArtifact({
          projectId,
          taskId: null,
          attemptId: null,
          kind: 'input',
          displayName: 'prompt.txt',
          mediaType: 'text/plain',
          bytes,
          sha256: v.sha256,
          provenance: { source: 'owner_prompt', adapter: null, note: null },
        }),
      );
    }
    for (const u of uploads) {
      out.push(
        this.recordArtifact({
          projectId,
          taskId: null,
          attemptId: null,
          kind: 'input',
          displayName: u.displayName,
          mediaType: u.mediaType,
          bytes: u.bytes,
          sha256: u.sha256,
          provenance: { source: 'owner_upload', adapter: null, note: 'Untrusted content; never executed.' },
        }),
      );
    }
    return out;
  }

  private createProject(title: string, brief: Project['brief'], uploads: ValidatedUpload[], prompt: string, actor: OwnerActor): IntakeResponse {
    this.require({ kind: 'create_project' }, actor.userId);
    this.require({ kind: 'create_island' }, actor.userId);
    this.require({ kind: 'create_worker', delegationDepth: 1 }, actor.userId);
    const plan = planForBrief(title, brief);
    const graph = validateTaskGraph(plan.tasks);
    if (!graph.ok) throw new DomainError('bad_request', `Invalid plan: ${graph.reason}`);

    const cor = newId('cor');
    const owner = { kind: 'owner' as const, id: actor.userId };
    const hermes = { kind: 'hermes' as const };
    const projectId = newId('prj');

    return this.store.commit(() => {
      const t = now();
      let project: Project = {
        id: projectId,
        slug: slugify(title),
        title: title.slice(0, 100),
        status: 'proposed',
        autonomyTier: this.config.policy.autonomyTier,
        brief: { ...brief, inputArtifactIds: [] },
        acceptanceCriteria: plan.acceptanceCriteria,
        islandId: null,
        createdAt: t,
        updatedAt: t,
        archivedAt: null,
        dataDeletedAt: null,
      };
      // The project row must exist before artifacts reference it (FK), so save first.
      this.store.save('projects', project);
      const inputs = this.storeInputs(projectId, uploads, prompt);
      project = { ...project, brief: { ...project.brief, inputArtifactIds: inputs.map((a) => a.id) } };
      this.store.save('projects', project);
      const pref = [this.ref('project', projectId)];
      this.store.emit('project.proposed', { project }, { actor: owner, refs: pref, correlationId: cor });
      for (const a of inputs) this.store.emit('artifact.created', { artifact: a }, { actor: owner, refs: [...pref, this.ref('artifact', a.id)], correlationId: cor });

      project = this.projectTo(project, 'planning');
      this.store.emit('project.created', { project }, { actor: hermes, refs: pref, correlationId: cor });

      // Island: deterministic slot, requested then created (clients animate the sequence).
      const islands = this.store.list('islands');
      const slot = nextFreeSlot(islands);
      let island: Island = {
        id: newId('isl'),
        kind: 'project',
        projectId,
        name: project.title,
        slot,
        position: slotPosition(slot),
        seed: seedFrom(projectId),
        state: 'materializing',
        removalPreset: null,
        createdAt: t,
        updatedAt: t,
      };
      this.store.save('islands', island);
      project = { ...project, islandId: island.id, updatedAt: now() };
      this.store.save('projects', project);
      const iref = [...pref, this.ref('island', island.id)];
      this.store.emit('island.creation_requested', { island }, { actor: hermes, refs: iref, correlationId: cor });
      island = this.islandTo(island, 'active');
      this.store.emit('island.created', { island }, { actor: hermes, refs: iref, correlationId: cor });

      // Worker: role-scoped, owned by this project.
      let worker = this.makeAgent('builder', projectId, projectId, this.workerCapabilities(), 1);
      this.store.save('agents', worker);
      this.store.emit('agent.created', { agent: worker }, { actor: hermes, refs: [...pref, this.ref('agent', worker.id)], correlationId: cor });
      worker = this.agentTo(worker, 'idle', null);

      let firstTask: Task | null = null;
      for (const pt of plan.tasks) {
        const task: Task = {
          id: newId('tsk'),
          projectId,
          title: pt.title,
          kind: pt.kind,
          status: 'queued',
          assignedAgentId: worker.id,
          dependsOn: [],
          iteration: 0,
          maxIterations: this.config.policy.maxReviewIterations,
          timeoutMs: this.config.policy.taskTimeoutMs,
          statusReason: null,
          createdAt: now(),
          updatedAt: now(),
        };
        this.store.save('tasks', task);
        this.store.emit('task.created', { task }, { actor: hermes, refs: [...pref, this.ref('task', task.id)], correlationId: cor });
        firstTask ??= task;
      }
      worker = this.agentTo(worker, 'assigned', `Assigned: ${firstTask!.title}`, { currentTaskId: firstTask!.id });
      this.store.emit('agent.assigned', { agent: worker, taskId: firstTask!.id }, { actor: hermes, refs: [...pref, this.ref('agent', worker.id), this.ref('task', firstTask!.id)], correlationId: cor });

      project = this.projectTo(project, 'active');
      this.store.emit('project.updated', { project }, { actor: hermes, refs: pref, correlationId: cor });
      this.store.audit(actor.userId, 'intake.create_project', 'ok', projectId);
      return {
        outcome: 'project_created' as const,
        projectId,
        taskId: firstTask!.id,
        questions: [],
        message: `Created project "${project.title}" on a new island. ${plan.estimate}.`,
      };
    });
  }

  private attachToProject(projectId: string, brief: Project['brief'], uploads: ValidatedUpload[], prompt: string, actor: OwnerActor): IntakeResponse {
    const project = this.store.get('projects', projectId);
    if (!project || project.status === 'archived') throw new DomainError('not_found', 'Project not found');
    const cor = newId('cor');
    return this.store.commit(() => {
      const inputs = this.storeInputs(projectId, uploads, prompt);
      const pref = [this.ref('project', projectId)];
      for (const a of inputs) this.store.emit('artifact.created', { artifact: a }, { actor: { kind: 'owner', id: actor.userId }, refs: pref, correlationId: cor });
      const merged: Project = {
        ...project,
        brief: {
          ...project.brief,
          goals: [...project.brief.goals, ...brief.goals].slice(0, 20),
          constraints: [...project.brief.constraints, ...brief.constraints].slice(0, 20),
          risks: [...project.brief.risks, ...brief.risks].slice(0, 20),
          inputArtifactIds: [...project.brief.inputArtifactIds, ...inputs.map((a) => a.id)].slice(0, 10),
        },
        updatedAt: now(),
      };
      this.store.save('projects', merged);
      this.store.emit('project.updated', { project: merged }, { actor: { kind: 'hermes' }, refs: pref, correlationId: cor });
      return {
        outcome: 'attached_to_existing' as const,
        projectId,
        taskId: null,
        questions: [],
        message: `Added the input to "${project.title}". Existing tasks were not restarted.`,
      };
    });
  }

  // ---------- Archive / destruction / deletion ----------

  archiveProject(projectId: string, preset: DestructionPreset, actor: OwnerActor): Project {
    const project = this.store.get('projects', projectId);
    if (!project) throw new DomainError('not_found', 'Project not found');
    if (project.status === 'archived') return project;
    const active = this.store.list('tasks', 'project_id = ? AND status IN (?, ?)', projectId, 'running', 'waiting_for_approval');
    if (active.length > 0) throw new DomainError('conflict', 'Cancel running tasks before archiving this project.');
    const cor = newId('cor');
    const owner = { kind: 'owner' as const, id: actor.userId };
    return this.store.commit(() => {
      const pref = [this.ref('project', projectId)];
      for (const t of this.store.list('tasks', 'project_id = ? AND status IN (?, ?)', projectId, 'queued', 'blocked')) {
        const c = this.taskTo(t, 'cancelled', 'Project archived');
        this.store.emit('task.cancelled', { task: c, attemptId: null, terminationVerified: true }, { actor: owner, refs: [...pref, this.ref('task', t.id)], correlationId: cor });
      }
      for (const a of this.store.list('agents', "project_id = ? AND status NOT IN ('retired')", projectId)) {
        let ag = a.status === 'working' || a.status === 'reviewing' ? this.agentTo(a, 'idle', null) : a;
        if (ag.status !== 'retiring') ag = this.agentTo(ag, 'retiring', 'Leaving the island', { currentTaskId: null });
        ag = this.agentTo(ag, 'retired', null);
        this.store.emit('agent.retired', { agent: ag }, { actor: { kind: 'hermes' }, refs: [...pref, this.ref('agent', a.id)], correlationId: cor });
      }
      const archived = this.projectTo(project, 'archived');
      this.store.emit('project.archived', { project: archived }, { actor: owner, refs: pref, correlationId: cor });
      const island = project.islandId ? this.store.get('islands', project.islandId) : undefined;
      if (island && island.state !== 'archived' && island.state !== 'destroyed') {
        const ai = this.islandTo(island, 'archived', preset);
        this.store.emit('island.archived', { island: ai, preset }, { actor: owner, refs: [...pref, this.ref('island', island.id)], correlationId: cor });
      }
      this.store.audit(actor.userId, 'project.archive', 'ok', projectId, { preset });
      return archived;
    });
  }

  requestApproval(kind: ApprovalKind, summary: string, subject: { kind: string; id: string }, detail: Record<string, unknown>, requestedBy: string, cor: string): ApprovalRequest {
    const existing = this.store
      .list('approvals', 'kind = ? AND subject_id = ? AND status = ?', kind, subject.id, 'pending')
      .find((a) => JSON.stringify(a.detail) === JSON.stringify(detail));
    if (existing) return existing;
    const approval: ApprovalRequest = {
      id: newId('apr'),
      kind,
      status: 'pending',
      summary: summary.slice(0, 500),
      subject,
      detail,
      requestedBy,
      createdAt: now(),
      decidedAt: null,
      decidedBy: null,
    };
    this.store.save('approvals', approval);
    this.store.emit('approval.requested', { approval }, { actor: { kind: requestedBy === 'hermes' ? 'hermes' : 'owner' }, refs: [this.ref('approval', approval.id)], correlationId: cor });
    return approval;
  }

  /** Destroying an island is a visual removal; it requires approval and never deletes data. */
  requestIslandDestruction(projectId: string, preset: DestructionPreset, actor: OwnerActor): ApprovalRequest {
    const project = this.store.get('projects', projectId);
    if (!project?.islandId) throw new DomainError('not_found', 'Project island not found');
    if (project.status !== 'archived') throw new DomainError('conflict', 'Archive the project before destroying its island.');
    const island = this.store.get('islands', project.islandId)!;
    if (island.state === 'destroyed') throw new DomainError('conflict', 'Island already destroyed');
    const cor = newId('cor');
    return this.store.commit(() => {
      const approval = this.requestApproval(
        'island_destruction',
        `Destroy the island for "${project.title}" (${preset}). Project records and files are kept.`,
        { kind: 'island', id: island.id },
        { preset, projectId },
        actor.userId,
        cor,
      );
      this.store.emit('island.destruction_requested', { island, approvalId: approval.id, preset }, { actor: { kind: 'owner', id: actor.userId }, refs: [this.ref('island', island.id), this.ref('approval', approval.id)], correlationId: cor });
      return approval;
    });
  }

  /** Permanent data deletion: separate approval, archived projects only. */
  requestDataDeletion(projectId: string, actor: OwnerActor): ApprovalRequest {
    const project = this.store.get('projects', projectId);
    if (!project) throw new DomainError('not_found', 'Project not found');
    if (project.status !== 'archived') throw new DomainError('conflict', 'Only archived projects can have their data deleted.');
    if (project.dataDeletedAt) throw new DomainError('conflict', 'Project data was already deleted.');
    const cor = newId('cor');
    return this.store.commit(() =>
      this.requestApproval(
        'project_data_deletion',
        `PERMANENTLY delete all input, workspace, and deliverable files for "${project.title}". This cannot be undone.`,
        { kind: 'project', id: projectId },
        { projectId },
        actor.userId,
        cor,
      ),
    );
  }

  /** Apply a decided approval's effect. Returns the updated approval. */
  decideApproval(id: string, decision: 'approve' | 'deny', actor: OwnerActor, effects: { onToolApproval?: (a: ApprovalRequest, choice: 'once' | 'deny') => void } = {}): ApprovalRequest {
    const approval = this.store.get('approvals', id);
    if (!approval) throw new DomainError('not_found', 'Approval not found');
    if (approval.status !== 'pending') throw new DomainError('conflict', `Approval already ${approval.status}`);
    const cor = newId('cor');
    const owner = { kind: 'owner' as const, id: actor.userId };
    const decided = this.store.commit(() => {
      const to = decision === 'approve' ? 'approved' : 'denied';
      assertTransition('approval', approval.status, to);
      const next: ApprovalRequest = { ...approval, status: to, decidedAt: now(), decidedBy: actor.userId };
      this.store.save('approvals', next);
      this.store.emit('approval.decided', { approval: next }, { actor: owner, refs: [this.ref('approval', id)], correlationId: cor });
      if (to === 'approved') this.applyApproved(next, cor, actor);
      this.store.audit(actor.userId, `approval.${decision}`, 'ok', id, { kind: approval.kind });
      return next;
    });
    if (approval.kind === 'hermes_tool_action') effects.onToolApproval?.(decided, decision === 'approve' ? 'once' : 'deny');
    return decided;
  }

  private applyApproved(a: ApprovalRequest, cor: string, actor: OwnerActor) {
    const owner = { kind: 'owner' as const, id: actor.userId };
    if (a.kind === 'island_destruction') {
      const island = this.store.get('islands', a.subject.id);
      if (!island || island.state === 'destroyed') return;
      const preset = (a.detail.preset as DestructionPreset) ?? 'dissolve';
      const gone = this.islandTo(island, 'destroyed', preset);
      this.store.emit('island.destroyed', { island: gone, preset }, { actor: owner, refs: [this.ref('island', island.id)], correlationId: cor });
    } else if (a.kind === 'project_data_deletion') {
      const project = this.store.get('projects', a.subject.id);
      if (!project || project.dataDeletedAt) return;
      const artifacts = this.store.list('artifacts', 'project_id = ?', project.id);
      const root = resolveInside(this.config.dataDir, 'projects', project.id);
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true, mode: 0o700 });
      this.store.db.prepare('UPDATE task_attempts SET output_artifact_id = NULL WHERE output_artifact_id IN (SELECT id FROM artifacts WHERE project_id = ?)').run(project.id);
      this.store.db.prepare('UPDATE reviews SET artifact_id = NULL WHERE artifact_id IN (SELECT id FROM artifacts WHERE project_id = ?)').run(project.id);
      this.store.db.prepare('DELETE FROM artifacts WHERE project_id = ?').run(project.id);
      const next: Project = { ...project, dataDeletedAt: now(), updatedAt: now() };
      this.store.save('projects', next);
      this.store.emit('project.data_deleted', { projectId: project.id, removedFiles: artifacts.length }, { actor: owner, refs: [this.ref('project', project.id)], correlationId: cor });
      this.store.emit('project.updated', { project: next }, { actor: owner, refs: [this.ref('project', project.id)], correlationId: cor });
    }
  }

  // ---------- Controls ----------

  setControls(action: 'pause_all' | 'resume_all' | 'disable_new_work' | 'enable_new_work' | 'emergency_stop' | 'clear_emergency_stop', actor: OwnerActor): Controls {
    const c = this.store.controls();
    const next: Controls = { ...c, updatedAt: now() };
    switch (action) {
      case 'pause_all':
        next.pauseAll = true;
        break;
      case 'resume_all':
        if (c.emergencyStop) throw new DomainError('conflict', 'Clear the emergency stop first.');
        next.pauseAll = false;
        break;
      case 'disable_new_work':
        next.newWorkDisabled = true;
        break;
      case 'enable_new_work':
        if (c.emergencyStop) throw new DomainError('conflict', 'Clear the emergency stop first.');
        next.newWorkDisabled = false;
        break;
      case 'emergency_stop':
        next.emergencyStop = true;
        next.pauseAll = true;
        next.newWorkDisabled = true;
        break;
      case 'clear_emergency_stop':
        // Clearing the stop does not silently resume work; pause/new-work stay as they are.
        next.emergencyStop = false;
        break;
    }
    return this.store.commit(() => {
      this.store.saveControls(next);
      this.store.emit('system.controls_changed', { controls: next }, { actor: { kind: 'owner', id: actor.userId }, refs: [{ kind: 'system', id: 'controls' }], correlationId: newId('cor') });
      this.store.audit(actor.userId, `controls.${action}`, 'ok');
      return next;
    });
  }

  setAdapterHealth(h: AdapterHealth) {
    const prev = this.adapterHealth;
    this.adapterHealth = h;
    if (prev.state !== h.state || prev.detail !== h.detail || prev.live !== h.live) {
      this.store.commit(() => {
        this.store.emit('system.adapter_status', { health: h }, { actor: { kind: 'adapter' }, refs: [{ kind: 'system', id: 'adapter' }], correlationId: newId('cor') });
      });
    }
  }
}
