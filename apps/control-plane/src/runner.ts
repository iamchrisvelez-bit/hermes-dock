import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { newId, type AgentIdentity, type ApprovalRequest, type Task, type TaskAttempt } from '@hdw/contracts';
import { TERMINAL_RUN_STATUSES, type AdapterRunEvent, type HermesAdapter, type RunState } from '@hdw/hermes-adapter';
import { buildRunRequest, reviewMarkdown, revisionNotes } from '@hdw/orchestration';
import type { WorldService } from './world.ts';

type StopIntent = 'cancel' | 'pause' | 'timeout';

interface Handle {
  taskId: string;
  attemptId: string;
  runId: string;
  abort: AbortController;
  stopIntent: StopIntent | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  partial: string;
  finalized: boolean;
  lastActivity: string | null;
}

export interface RunnerOptions {
  /** How long to wait for the runtime to confirm a stop before reporting it unconfirmed. */
  verifyTimeoutMs: number;
  verifyPollMs: number;
  /** Visible review stage length (the review itself is computed, not simulated). */
  reviewDelayMs: number;
  log: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };
}

const MAX_PARTIAL = 1_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * Durable task execution. All state lives in SQLite; this class only holds in-flight
 * transport handles, so a restart can rebuild everything via `recover()`.
 */
export class TaskRunner {
  private readonly handles = new Map<string, Handle>();
  private ticking = false;
  private tickAgain = false;
  private stopped = false;
  private readonly background = new Set<Promise<unknown>>();

  constructor(
    private readonly world: WorldService,
    private readonly adapter: HermesAdapter,
    private readonly opts: RunnerOptions,
  ) {}

  private get store() {
    return this.world.store;
  }

  private track<T>(p: Promise<T>): void {
    this.background.add(p);
    p.catch((e) => this.opts.log.error({ err: String(e) }, 'runner background task failed')).finally(() => this.background.delete(p));
  }

  /** Wait for in-flight background work (tests). */
  async idle(): Promise<void> {
    while (this.background.size > 0 || this.ticking) await Promise.allSettled([...this.background, sleep(5)]);
  }

  activeHandles(): number {
    return this.handles.size;
  }

  kick(): void {
    this.track(this.tick());
  }

  async tick(): Promise<void> {
    if (this.ticking) {
      this.tickAgain = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.tickAgain = false;
        await this.startEligible();
      } while (this.tickAgain && !this.stopped);
    } finally {
      this.ticking = false;
    }
  }

  private emitMeta(task: Task, cor: string, extra: Array<{ kind: 'agent' | 'task_attempt' | 'artifact' | 'review'; id: string }> = []) {
    return {
      actor: { kind: 'hermes' as const },
      refs: [this.world.ref('project', task.projectId), this.world.ref('task', task.id), ...extra.map((e) => this.world.ref(e.kind, e.id))],
      correlationId: cor,
    };
  }

  private async startEligible(): Promise<void> {
    if (this.stopped) return;
    const queued = this.store.list('tasks', "status = 'queued'");
    for (const task of queued) {
      const running = this.store.list('task_attempts', "status = 'running'").length;
      const deps = task.dependsOn.map((d) => this.store.get('tasks', d));
      if (deps.some((d) => d?.status !== 'completed')) continue;
      if (task.iteration >= task.maxIterations) {
        this.failTask(task, `Stopped at the review iteration limit (${task.maxIterations}). Escalated to the owner.`);
        continue;
      }
      const decision = this.world.decide({ kind: 'start_task', runningWorkers: running, iteration: task.iteration + 1, planApproved: true });
      if (decision.outcome !== 'allow') return; // paused / concurrency / emergency: stay queued

      if (this.adapter.live) {
        const probe = await this.adapter.probe();
        this.world.enabledToolsets = probe.enabledToolsets;
        this.world.setAdapterHealth(probe.health);
        if (probe.health.state !== 'ready') {
          this.noteReason(task, `Waiting: Hermes is ${probe.health.state} (${probe.health.detail})`);
          return;
        }
        const run = this.world.decide({ kind: 'run_hermes', enabledToolsets: probe.enabledToolsets ?? [] });
        if (run.outcome !== 'allow') {
          this.blockTask(task, run.reason);
          continue;
        }
      }
      await this.startAttempt(task);
    }
  }

  private noteReason(task: Task, reason: string) {
    if (task.statusReason === reason) return;
    this.store.commit(() => {
      const t = this.world.taskTo(task, task.status, reason);
      this.store.emit('task.updated', { task: t }, this.emitMeta(t, newId('cor')));
    });
  }

  private agentFor(task: Task): AgentIdentity | undefined {
    return task.assignedAgentId ? this.store.get('agents', task.assignedAgentId) : undefined;
  }

  private moveAgent(task: Task, to: AgentIdentity['status'], activity: string | null, cor: string, patch: Partial<AgentIdentity> = {}) {
    let a = this.agentFor(task);
    if (!a || a.status === 'retired' || a.status === to) {
      if (a && a.status === to && a.activity !== activity) {
        a = this.world.agentTo(a, to, activity, patch);
        this.store.emit('agent.updated', { agent: a }, this.emitMeta(task, cor, [{ kind: 'agent', id: a.id }]));
      }
      return;
    }
    a = this.world.agentTo(a, to, activity, patch);
    this.store.emit('agent.updated', { agent: a }, this.emitMeta(task, cor, [{ kind: 'agent', id: a.id }]));
  }

  private blockTask(task: Task, reason: string) {
    const cor = newId('cor');
    this.store.commit(() => {
      const t = this.world.taskTo(task, 'blocked', reason);
      this.store.emit('task.updated', { task: t }, this.emitMeta(t, cor));
      this.moveAgent(t, 'blocked', `Blocked: ${reason}`, cor);
    });
    this.opts.log.warn({ taskId: task.id, reason }, 'task blocked by policy');
  }

  private failTask(task: Task, reason: string) {
    const cor = newId('cor');
    this.store.commit(() => {
      const t = this.world.taskTo(task, 'failed', reason);
      this.store.emit('task.updated', { task: t }, this.emitMeta(t, cor));
      this.moveAgent(t, 'idle', null, cor, { currentTaskId: null });
      this.escalateProject(t, cor);
    });
  }

  private escalateProject(task: Task, cor: string) {
    const p = this.store.get('projects', task.projectId);
    if (!p || p.status === 'blocked' || p.status === 'archived') return;
    const next = this.world.projectTo(p, 'blocked');
    this.store.emit('project.updated', { project: next }, this.emitMeta(task, cor));
  }

  private inputsFor(projectId: string) {
    return this.store.list('artifacts', "project_id = ? AND kind = 'input'", projectId).map((a) => {
      const raw = this.store.rawArtifact(a.id)!;
      return { displayName: a.displayName, text: readFileSync(this.world.artifactPath(raw.relPath), 'utf8') };
    });
  }

  private async startAttempt(task: Task): Promise<void> {
    const project = this.store.get('projects', task.projectId)!;
    const lastReview = this.store.db
      .prepare('SELECT id FROM reviews WHERE task_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(task.id) as { id: string } | undefined;
    const review = lastReview ? this.store.get('reviews', lastReview.id) : undefined;
    const notes = review && review.verdict === 'revise' ? revisionNotes(review) : null;
    const cor = newId('cor');
    // Attempt numbers are monotonic history; `iteration` is the review budget counter
    // (a pause refunds budget but never reuses an attempt number).
    const iteration = task.iteration + 1;
    const maxRow = this.store.db.prepare('SELECT COALESCE(MAX(number), 0) AS m FROM task_attempts WHERE task_id = ?').get(task.id) as { m: number };
    const number = Number(maxRow.m) + 1;
    const attempt: TaskAttempt = {
      id: newId('att'),
      taskId: task.id,
      number,
      status: 'running',
      adapter: this.adapter.kind,
      externalRunId: null,
      revisionNotes: notes,
      startedAt: new Date().toISOString(),
      endedAt: null,
      error: null,
      outputArtifactId: null,
      usage: null,
    };
    const sessionId = newId('ses');
    let running!: Task;
    this.store.commit(() => {
      this.store.save('task_attempts', attempt);
      running = this.world.taskTo(task, 'running', null, { iteration });
      this.store.emit('task.started', { task: running, attempt }, this.emitMeta(running, cor, [{ kind: 'task_attempt', id: attempt.id }]));
      const agent = this.agentFor(task);
      if (agent) {
        this.store.db
          .prepare('INSERT INTO agent_sessions (id, agent_id, attempt_id, adapter, status, started_at) VALUES (?,?,?,?,?,?)')
          .run(sessionId, agent.id, attempt.id, this.adapter.kind, 'starting', attempt.startedAt);
      }
      this.moveAgent(running, 'working', `${notes ? 'Revising' : 'Writing'}: ${task.title} (iteration ${iteration}/${task.maxIterations})`, cor, { currentTaskId: task.id });
    });

    const req = buildRunRequest({
      title: project.title,
      brief: project.brief,
      inputs: this.inputsFor(project.id),
      criteria: project.acceptanceCriteria,
      attempt: iteration,
      revisionNotes: notes,
    });
    let runId: string;
    try {
      ({ runId } = await this.adapter.startRun({ idempotencyKey: attempt.id, ...req }));
    } catch (e) {
      const msg = `Could not start the run: ${(e as Error).message}`.slice(0, 1000);
      this.store.commit(() => {
        const a = { ...attempt, status: 'failed' as const, endedAt: new Date().toISOString(), error: msg };
        this.store.save('task_attempts', a);
        this.store.emit('attempt.finished', { attempt: a }, this.emitMeta(running, cor, [{ kind: 'task_attempt', id: a.id }]));
        const t = this.world.taskTo(running, 'blocked', msg);
        this.store.emit('task.updated', { task: t }, this.emitMeta(t, cor));
        this.moveAgent(t, 'blocked', 'Blocked: run could not start', cor);
        this.store.db.prepare("UPDATE agent_sessions SET status = 'failed', ended_at = ? WHERE id = ?").run(a.endedAt, sessionId);
      });
      this.opts.log.warn({ taskId: task.id, err: msg }, 'run start failed');
      return;
    }
    this.store.commit(() => {
      const a = { ...attempt, externalRunId: runId };
      this.store.save('task_attempts', a);
      this.store.db.prepare("UPDATE agent_sessions SET status = 'running', external_run_id = ? WHERE id = ?").run(runId, sessionId);
    });
    this.attach(task.id, attempt.id, runId, task.timeoutMs);
  }

  private attach(taskId: string, attemptId: string, runId: string, timeoutMs: number, afterSeq?: number) {
    const handle: Handle = {
      taskId,
      attemptId,
      runId,
      abort: new AbortController(),
      stopIntent: null,
      timeoutTimer: null,
      partial: '',
      finalized: false,
      lastActivity: null,
    };
    handle.timeoutTimer = setTimeout(() => {
      if (handle.finalized) return;
      handle.stopIntent ??= 'timeout';
      this.track(this.requestStop(handle));
    }, timeoutMs);
    handle.timeoutTimer.unref?.();
    this.handles.set(attemptId, handle);
    this.track(this.consume(handle, afterSeq));
  }

  private async consume(handle: Handle, afterSeq?: number): Promise<void> {
    let lastSeq = afterSeq;
    let failures = 0;
    while (!handle.finalized && !this.stopped) {
      try {
        for await (const ev of this.adapter.events(handle.runId, { signal: handle.abort.signal, afterSeq: lastSeq })) {
          if (ev.seq !== null) {
            lastSeq = ev.seq;
            this.store.db.prepare('UPDATE task_attempts SET last_adapter_seq = ? WHERE id = ?').run(ev.seq, handle.attemptId);
          }
          failures = 0;
          if (ev.type === 'terminal') {
            await this.finalize(handle, ev.state);
            return;
          }
          this.onEvent(handle, ev);
        }
      } catch (e) {
        if (handle.abort.signal.aborted || this.stopped) return;
        this.opts.log.warn({ runId: handle.runId, err: (e as Error).message }, 'event stream error; reconciling');
      }
      if (handle.finalized || this.stopped) return;
      // Stream ended without a terminal event: ask for the authoritative status.
      try {
        const st = await this.adapter.getRun(handle.runId);
        if (st === null) {
          await this.finalize(handle, { runId: handle.runId, status: 'interrupted', output: null, error: 'The runtime no longer knows this run', usage: null });
          return;
        }
        if (TERMINAL_RUN_STATUSES.includes(st.status)) {
          await this.finalize(handle, st);
          return;
        }
      } catch (e) {
        this.opts.log.warn({ runId: handle.runId, err: (e as Error).message }, 'status poll failed');
      }
      failures += 1;
      await sleep(Math.min(10_000, 250 * 2 ** Math.min(failures, 6)));
    }
  }

  private onEvent(handle: Handle, ev: Exclude<AdapterRunEvent, { type: 'terminal' }>) {
    const task = this.store.get('tasks', handle.taskId);
    if (!task) return;
    const cor = newId('cor');
    if (ev.type === 'delta') {
      if (handle.partial.length < MAX_PARTIAL) handle.partial += ev.text.slice(0, MAX_PARTIAL - handle.partial.length);
      return;
    }
    if (ev.type === 'progress' || ev.type === 'tool') {
      const summary = ev.type === 'progress' ? ev.summary : `Tool ${ev.name} ${ev.phase}${ev.error ? ' (error)' : ''}`;
      this.store.commit(() => {
        this.store.emit(
          'task.progress',
          {
            taskId: task.id,
            attemptId: handle.attemptId,
            summary: summary.slice(0, 300),
            ...(ev.type === 'tool' ? { tool: { name: ev.name, phase: ev.phase, error: ev.error } } : {}),
          },
          this.emitMeta(task, cor, [{ kind: 'task_attempt', id: handle.attemptId }]),
        );
        if (handle.lastActivity !== summary && task.status === 'running') {
          handle.lastActivity = summary;
          this.moveAgent(task, 'working', summary, cor);
        }
      });
      return;
    }
    if (ev.type === 'approval_requested') {
      this.store.commit(() => {
        const t = this.world.taskTo(task, 'waiting_for_approval', 'Hermes requested approval for a tool action');
        this.store.emit('task.updated', { task: t }, this.emitMeta(t, cor));
        this.moveAgent(t, 'blocked', 'Waiting for owner approval', cor);
        this.world.requestApproval(
          'hermes_tool_action',
          `Hermes asks to run a tool action: ${ev.summary}`,
          { kind: 'task', id: task.id },
          { runId: handle.runId, requestId: ev.requestId, attemptId: handle.attemptId },
          'hermes',
          cor,
        );
      });
    }
  }

  /** Called after the owner decides a `hermes_tool_action` approval. */
  resolveToolApproval(approval: ApprovalRequest, choice: 'once' | 'deny'): void {
    this.track(
      (async () => {
        const runId = String(approval.detail.runId ?? '');
        const requestId = typeof approval.detail.requestId === 'string' ? approval.detail.requestId : null;
        const res = await this.adapter.resolveApproval(runId, requestId, choice);
        const task = this.store.get('tasks', approval.subject.id);
        if (!task || task.status !== 'waiting_for_approval') return;
        const cor = newId('cor');
        this.store.commit(() => {
          const t = this.world.taskTo(task, 'running', res.resolved ? null : `Approval not delivered: ${res.detail}`);
          this.store.emit('task.updated', { task: t }, this.emitMeta(t, cor));
          this.moveAgent(t, 'working', choice === 'once' ? 'Continuing after approval' : 'Continuing after denial', cor);
        });
      })(),
    );
  }

  private async requestStop(handle: Handle): Promise<void> {
    let detail: string;
    try {
      const r = await this.adapter.stopRun(handle.runId);
      detail = r.detail;
    } catch (e) {
      detail = `Stop request failed: ${(e as Error).message}`;
    }
    const deadline = Date.now() + this.opts.verifyTimeoutMs;
    while (!handle.finalized && Date.now() < deadline) {
      try {
        const st = await this.adapter.getRun(handle.runId);
        if (st === null || TERMINAL_RUN_STATUSES.includes(st.status)) {
          await this.finalize(handle, st ?? { runId: handle.runId, status: 'interrupted', output: null, error: 'Run unknown to runtime after stop', usage: null });
          return;
        }
      } catch {
        // keep polling until the deadline
      }
      await sleep(this.opts.verifyPollMs);
    }
    if (!handle.finalized) {
      const task = this.store.get('tasks', handle.taskId);
      if (task) this.noteReason(task, `Stop requested, but the runtime has not confirmed termination yet (${detail}).`);
    }
  }

  /** Owner cancellation. Returns whether termination is already verified. */
  async cancelTask(taskId: string, actorId: string): Promise<{ state: 'cancelled' | 'cancel_requested' }> {
    const task = this.store.get('tasks', taskId);
    if (!task) throw Object.assign(new Error('Task not found'), { code: 'not_found' });
    if (task.status === 'completed' || task.status === 'cancelled') throw Object.assign(new Error(`Task already ${task.status}`), { code: 'conflict' });
    const handle = [...this.handles.values()].find((h) => h.taskId === taskId);
    const cor = newId('cor');
    if (!handle) {
      this.store.commit(() => {
        const t = this.world.taskTo(task, 'cancelled', 'Cancelled by owner before it ran');
        this.store.emit('task.cancelled', { task: t, attemptId: null, terminationVerified: true }, { ...this.emitMeta(t, cor), actor: { kind: 'owner', id: actorId } });
        this.moveAgent(t, 'idle', null, cor, { currentTaskId: null });
      });
      this.store.audit(actorId, 'task.cancel', 'ok', taskId);
      return { state: 'cancelled' };
    }
    handle.stopIntent = 'cancel';
    this.store.commit(() => {
      const t = this.world.taskTo(task, task.status, 'Cancellation requested; waiting for the runtime to confirm');
      this.store.emit('task.cancel_requested', { task: t, attemptId: handle.attemptId }, { ...this.emitMeta(t, cor), actor: { kind: 'owner', id: actorId } });
    });
    this.store.audit(actorId, 'task.cancel', 'ok', taskId, { pending: true });
    // Never report success early: the response says "requested"; `task.cancelled` follows
    // only once the runtime confirms termination.
    this.track(this.requestStop(handle));
    return { state: 'cancel_requested' };
  }

  retryTask(taskId: string, actorId: string): Task {
    const task = this.store.get('tasks', taskId);
    if (!task) throw Object.assign(new Error('Task not found'), { code: 'not_found' });
    if (task.status !== 'failed' && task.status !== 'blocked') throw Object.assign(new Error('Only failed or blocked tasks can be retried'), { code: 'conflict' });
    const cor = newId('cor');
    const out = this.store.commit(() => {
      // A retry grants a fresh iteration budget only by owner action, never automatically.
      const t = this.world.taskTo(task, 'queued', 'Retry requested by owner', { iteration: 0 });
      this.store.emit('task.updated', { task: t }, { ...this.emitMeta(t, cor), actor: { kind: 'owner', id: actorId } });
      const p = this.store.get('projects', t.projectId);
      if (p && p.status === 'blocked') {
        const np = this.world.projectTo(p, 'active');
        this.store.emit('project.updated', { project: np }, this.emitMeta(t, cor));
      }
      this.moveAgent(t, 'assigned', `Assigned: ${t.title}`, cor, { currentTaskId: t.id });
      return t;
    });
    this.store.audit(actorId, 'task.retry', 'ok', taskId);
    this.kick();
    return out;
  }

  /** Pause: ask every running attempt to stop; tasks return to the queue once confirmed. */
  pauseAll(): void {
    for (const h of this.handles.values()) {
      if (h.finalized) continue;
      h.stopIntent ??= 'pause';
      this.track(this.requestStop(h));
    }
  }

  private async finalize(handle: Handle, state: RunState): Promise<void> {
    if (handle.finalized) return;
    handle.finalized = true;
    if (handle.timeoutTimer) clearTimeout(handle.timeoutTimer);
    handle.abort.abort();
    this.handles.delete(handle.attemptId);
    const task = this.store.get('tasks', handle.taskId)!;
    const attempt = this.store.get('task_attempts', handle.attemptId)!;
    const cor = newId('cor');
    const ended = new Date().toISOString();
    const usage = state.usage ? { inputTokens: state.usage.inputTokens, outputTokens: state.usage.outputTokens, costUsd: state.usage.costUsd } : null;

    if (state.status === 'completed') {
      const text = state.output ?? handle.partial;
      const bytes = Buffer.from(text, 'utf8');
      let reviewing!: Task;
      let artifactId: string | null = null;
      this.store.commit(() => {
        let artifact = null;
        if (bytes.length > 0) {
          artifact = this.world.recordArtifact({
            projectId: task.projectId,
            taskId: task.id,
            attemptId: attempt.id,
            kind: 'deliverable',
            displayName: `plan-attempt-${attempt.number}.md`,
            mediaType: 'text/markdown',
            bytes,
            sha256: sha256(bytes),
            provenance: { source: 'agent_output', adapter: this.adapter.kind, note: `run ${handle.runId}` },
          });
          artifactId = artifact.id;
          this.store.emit('artifact.created', { artifact }, this.emitMeta(task, cor, [{ kind: 'artifact', id: artifact.id }]));
        }
        const a: TaskAttempt = { ...attempt, status: 'succeeded', endedAt: ended, outputArtifactId: artifactId, usage };
        this.store.save('task_attempts', a);
        this.store.emit('attempt.finished', { attempt: a }, this.emitMeta(task, cor, [{ kind: 'task_attempt', id: a.id }]));
        this.store.db.prepare("UPDATE agent_sessions SET status = 'completed', ended_at = ? WHERE attempt_id = ?").run(ended, attempt.id);
        const note = handle.stopIntent ? `Run finished before the ${handle.stopIntent} took effect; output recorded.` : null;
        reviewing = this.world.taskTo(task, 'review', note);
        this.store.emit('task.updated', { task: reviewing }, this.emitMeta(reviewing, cor));
        this.moveAgent(reviewing, 'reviewing', 'Deliverable submitted for review', cor);
        this.setReviewer('reviewing', `Reviewing "${task.title}" against acceptance criteria`, reviewing, cor);
        const p = this.store.get('projects', task.projectId);
        if (p && p.status === 'active') {
          const np = this.world.projectTo(p, 'review');
          this.store.emit('project.updated', { project: np }, this.emitMeta(task, cor));
        }
      });
      if (this.opts.reviewDelayMs > 0) await sleep(this.opts.reviewDelayMs);
      this.review(reviewing, attempt, text, artifactId, handle.stopIntent);
      return;
    }

    // Not completed: record partial output, then settle the task per the stop intent.
    const partialText = state.output ?? handle.partial;
    this.store.commit(() => {
      let partialId: string | null = null;
      if (partialText.length > 0) {
        const bytes = Buffer.from(partialText, 'utf8');
        const art = this.world.recordArtifact({
          projectId: task.projectId,
          taskId: task.id,
          attemptId: attempt.id,
          kind: 'partial',
          displayName: `partial-attempt-${attempt.number}.md`,
          mediaType: 'text/markdown',
          bytes,
          sha256: sha256(bytes),
          provenance: { source: 'partial_output', adapter: this.adapter.kind, note: `run ${handle.runId} ended ${state.status}` },
        });
        partialId = art.id;
        this.store.emit('artifact.created', { artifact: art }, this.emitMeta(task, cor, [{ kind: 'artifact', id: art.id }]));
      }
      const attemptStatus = handle.stopIntent === 'timeout' ? 'timed_out' : state.status === 'cancelled' ? 'cancelled' : state.status === 'interrupted' ? 'interrupted' : 'failed';
      const a: TaskAttempt = { ...attempt, status: attemptStatus, endedAt: ended, error: state.error, outputArtifactId: partialId, usage };
      this.store.save('task_attempts', a);
      this.store.emit('attempt.finished', { attempt: a }, this.emitMeta(task, cor, [{ kind: 'task_attempt', id: a.id }]));
      this.store.db.prepare('UPDATE agent_sessions SET status = ?, ended_at = ? WHERE attempt_id = ?').run(state.status === 'failed' ? 'failed' : 'stopped', ended, attempt.id);

      const verified = state.status === 'cancelled' || state.status === 'failed' || state.status === 'interrupted';
      if (handle.stopIntent === 'cancel') {
        const t = this.world.taskTo(task, 'cancelled', `Cancelled by owner; runtime reported "${state.status}"${partialId ? '; partial output recorded' : ''}`);
        this.store.emit('task.cancelled', { task: t, attemptId: attempt.id, terminationVerified: verified }, this.emitMeta(t, cor));
        this.moveAgent(t, 'idle', null, cor, { currentTaskId: null });
      } else if (handle.stopIntent === 'pause') {
        const t = this.world.taskTo(task, 'queued', 'Paused by owner; will resume when work is resumed', { iteration: Math.max(0, task.iteration - 1) });
        this.store.emit('task.updated', { task: t }, this.emitMeta(t, cor));
        this.moveAgent(t, 'assigned', 'Paused', cor);
      } else if (handle.stopIntent === 'timeout') {
        const t = this.world.taskTo(task, 'failed', `Timed out after ${Math.round(task.timeoutMs / 1000)}s`);
        this.store.emit('task.updated', { task: t }, this.emitMeta(t, cor));
        this.moveAgent(t, 'idle', null, cor, { currentTaskId: null });
        this.escalateProject(t, cor);
      } else if (state.status === 'interrupted' && task.iteration < task.maxIterations) {
        const t = this.world.taskTo(task, 'queued', `Previous attempt interrupted (${state.error ?? 'runtime restart'}); it will be retried`);
        this.store.emit('task.updated', { task: t }, this.emitMeta(t, cor));
        this.moveAgent(t, 'assigned', 'Waiting to retry', cor);
      } else {
        const t = this.world.taskTo(task, 'failed', `Run ${state.status}: ${state.error ?? 'no detail'}`.slice(0, 500));
        this.store.emit('task.updated', { task: t }, this.emitMeta(t, cor));
        this.moveAgent(t, 'error', `Run ${state.status}`, cor);
        this.escalateProject(t, cor);
      }
    });
    this.kick();
  }

  private review(task: Task, attempt: TaskAttempt, text: string, artifactId: string | null, stopIntent: StopIntent | null) {
    const project = this.store.get('projects', task.projectId)!;
    const finalAttempt = task.iteration >= task.maxIterations || stopIntent !== null;
    const result = reviewMarkdown(text, project.acceptanceCriteria, { finalAttempt });
    const reviewer = this.store.list('agents', "role = 'reviewer' AND project_id IS NULL")[0];
    const cor = newId('cor');
    this.store.commit(() => {
      const review = {
        id: newId('rev'),
        taskId: task.id,
        attemptId: attempt.id,
        artifactId,
        verdict: result.verdict,
        findings: result.findings,
        reviewer: reviewer ? `${reviewer.name} (automated acceptance check)` : 'automated acceptance check',
        createdAt: new Date().toISOString(),
      };
      this.store.save('reviews', review);
      this.setReviewer('idle', null, task, cor);
      this.store.emit('review.completed', { review }, this.emitMeta(task, cor, [{ kind: 'review', id: review.id }]));
      const p = this.store.get('projects', task.projectId)!;

      if (result.verdict === 'pass') {
        const t = this.world.taskTo(task, 'completed', `Passed review on attempt ${attempt.number}`);
        this.store.emit('task.updated', { task: t }, this.emitMeta(t, cor));
        this.moveAgent(t, 'idle', `Delivered: ${t.title}`, cor, { currentTaskId: null });
        const open = this.store.list('tasks', "project_id = ? AND status NOT IN ('completed','cancelled')", p.id);
        if (open.length === 0 && p.status === 'review') {
          const done = this.world.projectTo(p, 'completed');
          this.store.emit('project.completed', { project: done }, this.emitMeta(t, cor));
        }
      } else if (result.verdict === 'revise') {
        const t = this.world.taskTo(task, 'queued', `Revision requested after iteration ${task.iteration} of ${task.maxIterations}`);
        this.store.emit('task.updated', { task: t }, this.emitMeta(t, cor));
        this.moveAgent(t, 'assigned', `Revising: ${t.title}`, cor);
        if (p.status === 'review') {
          const np = this.world.projectTo(p, 'active');
          this.store.emit('project.updated', { project: np }, this.emitMeta(t, cor));
        }
      } else {
        const t = this.world.taskTo(task, 'failed', `Did not pass review after ${task.iteration} iteration(s); escalated to the owner`);
        this.store.emit('task.updated', { task: t }, this.emitMeta(t, cor));
        this.moveAgent(t, 'idle', null, cor, { currentTaskId: null });
        this.escalateProject(t, cor);
      }
    });
    this.kick();
  }

  /** The HQ reviewer is shown reviewing only while a review is actually pending. */
  private setReviewer(to: 'reviewing' | 'idle', activity: string | null, task: Task, cor: string) {
    const r = this.store.list('agents', "role = 'reviewer' AND project_id IS NULL")[0];
    if (!r || r.status === to || r.status === 'retired') return;
    const next = this.world.agentTo(r, to, activity);
    this.store.emit('agent.updated', { agent: next }, this.emitMeta(task, cor, [{ kind: 'agent', id: r.id }]));
  }

  /** Reconcile durable state with the runtime after a control-plane restart. */
  async recover(): Promise<number> {
    let reconciled = 0;
    const cor = newId('cor');
    for (const attempt of this.store.list('task_attempts', "status = 'running'")) {
      reconciled += 1;
      const task = this.store.get('tasks', attempt.taskId)!;
      let st: RunState | null | 'unreachable' = null;
      if (attempt.externalRunId) {
        try {
          st = await this.adapter.getRun(attempt.externalRunId);
        } catch {
          st = 'unreachable';
        }
      }
      const lastSeqRow = this.store.db.prepare('SELECT last_adapter_seq AS s FROM task_attempts WHERE id = ?').get(attempt.id) as { s: number | null };
      if (attempt.externalRunId && st === 'unreachable') {
        // Cannot know yet: keep it running and let the consumer reconcile when Hermes is back.
        this.attach(task.id, attempt.id, attempt.externalRunId, task.timeoutMs, lastSeqRow.s ?? undefined);
        continue;
      }
      if (attempt.externalRunId && st && st !== 'unreachable' && !TERMINAL_RUN_STATUSES.includes(st.status)) {
        this.attach(task.id, attempt.id, attempt.externalRunId, task.timeoutMs, lastSeqRow.s ?? undefined);
        continue;
      }
      const handle: Handle = {
        taskId: task.id,
        attemptId: attempt.id,
        runId: attempt.externalRunId ?? 'none',
        abort: new AbortController(),
        stopIntent: null,
        timeoutTimer: null,
        partial: '',
        finalized: false,
        lastActivity: null,
      };
      await this.finalize(
        handle,
        st && st !== 'unreachable'
          ? st
          : { runId: handle.runId, status: 'interrupted', output: null, error: 'Control plane restarted; the runtime no longer has this run', usage: null },
      );
    }
    // Agents shown as working with nothing running are reset, so the world never fakes activity.
    const runningTasks = new Set(this.store.list('task_attempts', "status = 'running'").map((a) => a.taskId));
    this.store.commit(() => {
      for (const a of this.store.list('agents', "status IN ('working','reviewing')")) {
        if (a.currentTaskId && runningTasks.has(a.currentTaskId)) continue;
        reconciled += 1;
        const next = this.world.agentTo(a, 'idle', null);
        this.store.emit('agent.updated', { agent: next }, { actor: { kind: 'system' }, refs: [this.world.ref('agent', a.id)], correlationId: cor });
      }
      for (const t of this.store.list('tasks', "status = 'review'")) {
        // A review interrupted by restart is re-run from the recorded deliverable.
        reconciled += 1;
        const next = this.world.taskTo(t, 'queued', 'Review interrupted by restart; the task will run again');
        this.store.emit('task.updated', { task: next }, { actor: { kind: 'system' }, refs: [this.world.ref('task', t.id)], correlationId: cor });
      }
      this.store.emit(
        'system.recovered',
        { summary: `Control plane started; reconciled ${reconciled} item(s) with the runtime.`, reconciled },
        { actor: { kind: 'system' }, refs: [{ kind: 'system', id: 'runner' }], correlationId: cor },
      );
    });
    this.kick();
    return reconciled;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const h of this.handles.values()) {
      h.abort.abort();
      if (h.timeoutTimer) clearTimeout(h.timeoutTimer);
    }
    this.handles.clear();
    await Promise.allSettled([...this.background]);
  }
}
