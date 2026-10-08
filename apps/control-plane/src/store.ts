import { EventEmitter } from 'node:events';
import {
  AgentIdentity,
  ApprovalRequest,
  Artifact,
  Controls,
  Island,
  Project,
  Review,
  SCHEMA_VERSION,
  Task,
  TaskAttempt,
  newId,
  parsePayload,
  type ActorRef,
  type EntityRef,
  type EventPayload,
  type WorldEvent,
  type WorldEventType,
} from '@hdw/contracts';
import { inTransaction, transaction, type Db } from './db.ts';

type Row = Record<string, unknown>;
type SqlValue = string | number | null;

/** In-process fan-out of committed events (SSE streams subscribe here). */
export class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
  }
}

export interface EmitMeta {
  actor: ActorRef;
  refs: EntityRef[];
  correlationId: string;
}

const j = (v: unknown) => JSON.stringify(v);
const pj = <T>(v: unknown): T => JSON.parse(String(v)) as T;
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
const n = (v: unknown) => Number(v);

// ---------- Row mappers (DB <-> validated entity) ----------

const mappers = {
  projects: {
    to: (p: Project): Record<string, SqlValue> => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      status: p.status,
      autonomy_tier: p.autonomyTier,
      brief_json: j(p.brief),
      criteria_json: j(p.acceptanceCriteria),
      island_id: p.islandId,
      created_at: p.createdAt,
      updated_at: p.updatedAt,
      archived_at: p.archivedAt,
      data_deleted_at: p.dataDeletedAt,
    }),
    from: (r: Row): Project =>
      Project.parse({
        id: r.id,
        slug: r.slug,
        title: r.title,
        status: r.status,
        autonomyTier: r.autonomy_tier,
        brief: pj(r.brief_json),
        acceptanceCriteria: pj(r.criteria_json),
        islandId: s(r.island_id),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        archivedAt: s(r.archived_at),
        dataDeletedAt: s(r.data_deleted_at),
      }),
  },
  islands: {
    to: (i: Island): Record<string, SqlValue> => ({
      id: i.id,
      kind: i.kind,
      project_id: i.projectId,
      name: i.name,
      slot: i.slot,
      x: i.position.x,
      z: i.position.z,
      seed: i.seed,
      state: i.state,
      removal_preset: i.removalPreset,
      created_at: i.createdAt,
      updated_at: i.updatedAt,
    }),
    from: (r: Row): Island =>
      Island.parse({
        id: r.id,
        kind: r.kind,
        projectId: s(r.project_id),
        name: r.name,
        slot: n(r.slot),
        position: { x: n(r.x), z: n(r.z) },
        seed: n(r.seed),
        state: r.state,
        removalPreset: s(r.removal_preset),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }),
  },
  agents: {
    to: (a: AgentIdentity): Record<string, SqlValue> => ({
      id: a.id,
      name: a.name,
      role: a.role,
      status: a.status,
      capabilities_json: j(a.capabilities),
      appearance_json: j(a.appearance),
      project_id: a.projectId,
      current_task_id: a.currentTaskId,
      activity: a.activity,
      delegation_depth: a.delegationDepth,
      created_at: a.createdAt,
      updated_at: a.updatedAt,
      retired_at: a.retiredAt,
    }),
    from: (r: Row): AgentIdentity =>
      AgentIdentity.parse({
        id: r.id,
        name: r.name,
        role: r.role,
        status: r.status,
        capabilities: pj(r.capabilities_json),
        appearance: pj(r.appearance_json),
        projectId: s(r.project_id),
        currentTaskId: s(r.current_task_id),
        activity: s(r.activity),
        delegationDepth: n(r.delegation_depth),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        retiredAt: s(r.retired_at),
      }),
  },
  tasks: {
    to: (t: Task): Record<string, SqlValue> => ({
      id: t.id,
      project_id: t.projectId,
      title: t.title,
      kind: t.kind,
      status: t.status,
      assigned_agent_id: t.assignedAgentId,
      depends_on_json: j(t.dependsOn),
      iteration: t.iteration,
      max_iterations: t.maxIterations,
      timeout_ms: t.timeoutMs,
      status_reason: t.statusReason,
      created_at: t.createdAt,
      updated_at: t.updatedAt,
    }),
    from: (r: Row): Task =>
      Task.parse({
        id: r.id,
        projectId: r.project_id,
        title: r.title,
        kind: r.kind,
        status: r.status,
        assignedAgentId: s(r.assigned_agent_id),
        dependsOn: pj(r.depends_on_json),
        iteration: n(r.iteration),
        maxIterations: n(r.max_iterations),
        timeoutMs: n(r.timeout_ms),
        statusReason: s(r.status_reason),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }),
  },
  task_attempts: {
    to: (a: TaskAttempt): Record<string, SqlValue> => ({
      id: a.id,
      task_id: a.taskId,
      number: a.number,
      status: a.status,
      adapter: a.adapter,
      external_run_id: a.externalRunId,
      revision_notes: a.revisionNotes,
      started_at: a.startedAt,
      ended_at: a.endedAt,
      error: a.error,
      output_artifact_id: a.outputArtifactId,
      usage_json: a.usage ? j(a.usage) : null,
    }),
    from: (r: Row): TaskAttempt =>
      TaskAttempt.parse({
        id: r.id,
        taskId: r.task_id,
        number: n(r.number),
        status: r.status,
        adapter: r.adapter,
        externalRunId: s(r.external_run_id),
        revisionNotes: s(r.revision_notes),
        startedAt: r.started_at,
        endedAt: s(r.ended_at),
        error: s(r.error),
        outputArtifactId: s(r.output_artifact_id),
        usage: r.usage_json ? pj(r.usage_json) : null,
      }),
  },
  artifacts: {
    to: (a: Artifact & { relPath: string }): Record<string, SqlValue> => ({
      id: a.id,
      project_id: a.projectId,
      task_id: a.taskId,
      attempt_id: a.attemptId,
      kind: a.kind,
      display_name: a.displayName,
      media_type: a.mediaType,
      size_bytes: a.sizeBytes,
      sha256: a.sha256,
      rel_path: a.relPath,
      provenance_json: j(a.provenance),
      created_at: a.createdAt,
    }),
    from: (r: Row): Artifact =>
      Artifact.parse({
        id: r.id,
        projectId: r.project_id,
        taskId: s(r.task_id),
        attemptId: s(r.attempt_id),
        kind: r.kind,
        displayName: r.display_name,
        mediaType: r.media_type,
        sizeBytes: n(r.size_bytes),
        sha256: r.sha256,
        provenance: pj(r.provenance_json),
        createdAt: r.created_at,
      }),
  },
  reviews: {
    to: (v: Review): Record<string, SqlValue> => ({
      id: v.id,
      task_id: v.taskId,
      attempt_id: v.attemptId,
      artifact_id: v.artifactId,
      verdict: v.verdict,
      findings_json: j(v.findings),
      reviewer: v.reviewer,
      created_at: v.createdAt,
    }),
    from: (r: Row): Review =>
      Review.parse({
        id: r.id,
        taskId: r.task_id,
        attemptId: r.attempt_id,
        artifactId: s(r.artifact_id),
        verdict: r.verdict,
        findings: pj(r.findings_json),
        reviewer: r.reviewer,
        createdAt: r.created_at,
      }),
  },
  approvals: {
    to: (a: ApprovalRequest): Record<string, SqlValue> => ({
      id: a.id,
      kind: a.kind,
      status: a.status,
      summary: a.summary,
      subject_kind: a.subject.kind,
      subject_id: a.subject.id,
      detail_json: j(a.detail),
      requested_by: a.requestedBy,
      created_at: a.createdAt,
      decided_at: a.decidedAt,
      decided_by: a.decidedBy,
    }),
    from: (r: Row): ApprovalRequest =>
      ApprovalRequest.parse({
        id: r.id,
        kind: r.kind,
        status: r.status,
        summary: r.summary,
        subject: { kind: r.subject_kind, id: r.subject_id },
        detail: pj(r.detail_json),
        requestedBy: r.requested_by,
        createdAt: r.created_at,
        decidedAt: s(r.decided_at),
        decidedBy: s(r.decided_by),
      }),
  },
} as const;

type TableName = keyof typeof mappers;
type EntityOf<T extends TableName> = ReturnType<(typeof mappers)[T]['from']>;

export class Store {
  private pending: WorldEvent[] | null = null;

  constructor(
    readonly db: Db,
    readonly bus: EventBus = new EventBus(),
  ) {}

  /**
   * Run `fn` atomically. Every `emit` inside is inserted in the same transaction as the
   * state change, and published to live subscribers only after COMMIT succeeds.
   */
  commit<T>(fn: () => T): T {
    if (inTransaction(this.db)) return fn();
    this.pending = [];
    let events: WorldEvent[] = [];
    try {
      const out = transaction(this.db, () => {
        const r = fn();
        events = this.pending ?? [];
        return r;
      });
      for (const ev of events) this.bus.emit('event', ev);
      return out;
    } finally {
      this.pending = null;
    }
  }

  emit<T extends WorldEventType>(type: T, payload: EventPayload<T>, meta: EmitMeta): WorldEvent<T> {
    if (!inTransaction(this.db) || !this.pending) throw new Error('emit() must be called inside store.commit()');
    const valid = parsePayload(type, payload);
    const id = newId('evt');
    const ts = new Date().toISOString();
    const res = this.db
      .prepare(
        'INSERT INTO events (id, schema_version, ts, type, actor_json, refs_json, correlation_id, payload_json) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(id, SCHEMA_VERSION, ts, type, j(meta.actor), j(meta.refs), meta.correlationId, j(valid));
    const ev = {
      id,
      schemaVersion: SCHEMA_VERSION,
      seq: Number(res.lastInsertRowid),
      ts,
      type,
      actor: meta.actor,
      refs: meta.refs,
      correlationId: meta.correlationId,
      payload: valid,
    } as WorldEvent<T>;
    this.pending.push(ev);
    return ev;
  }

  // ---------- Generic entity access ----------

  save<T extends TableName>(table: T, entity: Parameters<(typeof mappers)[T]['to']>[0]): void {
    const row = (mappers[table].to as (e: unknown) => Record<string, SqlValue>)(entity);
    const cols = Object.keys(row);
    const updates = cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`);
    this.db
      .prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${updates.join(', ')}`)
      .run(...cols.map((c) => row[c] ?? null));
  }

  get<T extends TableName>(table: T, id: string): EntityOf<T> | undefined {
    const r = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Row | undefined;
    return r ? (mappers[table].from(r) as EntityOf<T>) : undefined;
  }

  list<T extends TableName>(table: T, where = '1=1', ...params: SqlValue[]): EntityOf<T>[] {
    const rows = this.db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY rowid`).all(...params) as Row[];
    return rows.map((r) => mappers[table].from(r) as EntityOf<T>);
  }

  rawArtifact(id: string): { artifact: Artifact; relPath: string } | undefined {
    const r = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Row | undefined;
    return r ? { artifact: mappers.artifacts.from(r), relPath: String(r.rel_path) } : undefined;
  }

  // ---------- Controls ----------

  controls(): Controls {
    let r = this.db.prepare('SELECT * FROM controls WHERE id = 1').get() as Row | undefined;
    if (!r) {
      this.db.prepare('INSERT OR IGNORE INTO controls (id, updated_at) VALUES (1, ?)').run(new Date().toISOString());
      r = this.db.prepare('SELECT * FROM controls WHERE id = 1').get() as Row;
    }
    return Controls.parse({
      pauseAll: n(r.pause_all) === 1,
      newWorkDisabled: n(r.new_work_disabled) === 1,
      emergencyStop: n(r.emergency_stop) === 1,
      updatedAt: r.updated_at,
    });
  }

  saveControls(c: Controls): void {
    this.controls();
    this.db
      .prepare('UPDATE controls SET pause_all = ?, new_work_disabled = ?, emergency_stop = ?, updated_at = ? WHERE id = 1')
      .run(c.pauseAll ? 1 : 0, c.newWorkDisabled ? 1 : 0, c.emergencyStop ? 1 : 0, c.updatedAt);
  }

  // ---------- Events ----------

  latestSeq(): number {
    const r = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM events').get() as Row;
    return n(r.m);
  }

  oldestSeq(): number {
    const r = this.db.prepare('SELECT COALESCE(MIN(seq), 0) AS m FROM events').get() as Row;
    return n(r.m);
  }

  eventsAfter(seq: number, limit: number): WorldEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(seq, limit) as Row[];
    return rows.map(
      (r) =>
        ({
          id: String(r.id),
          schemaVersion: n(r.schema_version),
          seq: n(r.seq),
          ts: String(r.ts),
          type: String(r.type),
          actor: pj(r.actor_json),
          refs: pj(r.refs_json),
          correlationId: String(r.correlation_id),
          payload: pj(r.payload_json),
        }) as WorldEvent,
    );
  }

  /** Retention: drop old events (state tables stay authoritative; clients re-snapshot). */
  pruneEventsBefore(seq: number): number {
    return Number(this.db.prepare('DELETE FROM events WHERE seq < ?').run(seq).changes);
  }

  audit(actor: string, action: string, outcome: 'ok' | 'denied' | 'error', target: string | null = null, detail: unknown = null) {
    this.db
      .prepare('INSERT INTO audit_log (ts, actor, action, target, outcome, detail_json) VALUES (?,?,?,?,?,?)')
      .run(new Date().toISOString(), actor, action, target, outcome, detail === null ? null : j(detail));
  }

  // ---------- Idempotency ----------

  idempotent<T>(scope: string, key: string): T | undefined {
    const r = this.db.prepare('SELECT response_json FROM idempotency WHERE key = ? AND scope = ?').get(key, scope) as Row | undefined;
    return r ? pj<T>(r.response_json) : undefined;
  }

  rememberIdempotent(scope: string, key: string, response: unknown) {
    this.db
      .prepare('INSERT OR IGNORE INTO idempotency (key, scope, response_json, created_at) VALUES (?,?,?,?)')
      .run(key, scope, j(response), new Date().toISOString());
  }
}
