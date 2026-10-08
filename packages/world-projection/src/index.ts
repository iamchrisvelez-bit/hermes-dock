import type {
  AgentIdentity,
  AgentRole,
  Island,
  Project,
  Task,
  WorldEvent,
  WorldSnapshot,
} from '@hdw/contracts';

/**
 * Engine-independent projection of backend state into world semantics. Both the web
 * renderer and any future engine client (e.g. Unity) consume these pure functions,
 * so placement and visual state never depend on a particular renderer.
 */

export const HQ_SLOT = 0;
const RING_SPACING = 16;

/** Deterministic hex-ring layout: slot 0 is HQ at the origin; ring r holds 6r islands. */
export function slotPosition(slot: number): { x: number; z: number } {
  if (slot <= 0) return { x: 0, z: 0 };
  let ring = 1;
  let remaining = slot - 1;
  while (remaining >= ring * 6) {
    remaining -= ring * 6;
    ring += 1;
  }
  const count = ring * 6;
  // Offset alternate rings so islands do not line up radially.
  const angle = (remaining / count) * Math.PI * 2 + (ring % 2 === 0 ? Math.PI / count : 0);
  const radius = ring * RING_SPACING;
  return { x: round2(Math.cos(angle) * radius), z: round2(Math.sin(angle) * radius) };
}

/** Lowest slot not held by a non-destroyed island. Archived islands keep their slot. */
export function nextFreeSlot(islands: ReadonlyArray<Pick<Island, 'slot' | 'state'>>): number {
  const taken = new Set(islands.filter((i) => i.state !== 'destroyed').map((i) => i.slot));
  let s = 1;
  while (taken.has(s)) s += 1;
  return s;
}

/** Stable 31-bit seed from an id (FNV-1a), used for procedural terrain variation. */
export function seedFrom(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) & 0x7fffffff;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

// ---------- Visual state derived from real state ----------

/** What an island's beacon/glow shows. Only `working` animates activity. */
export type IslandActivity = 'idle' | 'planning' | 'working' | 'review' | 'blocked' | 'complete' | 'archived' | 'failed' | 'paused';

export function islandActivity(project: Project | undefined, tasks: readonly Task[]): IslandActivity {
  if (!project) return 'idle';
  switch (project.status) {
    case 'archived':
      return 'archived';
    case 'completed':
      return 'complete';
    case 'failed':
      return 'failed';
    case 'paused':
      return 'paused';
    case 'blocked':
      return 'blocked';
    case 'review':
      return 'review';
    case 'proposed':
    case 'planning':
      return 'planning';
    case 'active': {
      const mine = tasks.filter((t) => t.projectId === project.id);
      if (mine.some((t) => t.status === 'running')) return 'working';
      if (mine.some((t) => t.status === 'review')) return 'review';
      if (mine.some((t) => t.status === 'blocked' || t.status === 'waiting_for_approval')) return 'blocked';
      return 'idle';
    }
  }
}

export type HermesPose = 'idle' | 'planning' | 'reviewing' | 'blocked' | 'alert';

export interface WorldConditions {
  connected: boolean;
  emergencyStop: boolean;
  pauseAll: boolean;
}

/**
 * Hermes' pose summarises the world honestly: alert on emergency stop or disconnection,
 * blocked when anything waits on the owner, reviewing/planning only when those states exist.
 */
export function hermesPose(world: Pick<WorldSnapshot, 'projects' | 'tasks' | 'approvals'>, cond: WorldConditions): HermesPose {
  if (cond.emergencyStop || !cond.connected) return 'alert';
  if (world.approvals.some((a) => a.status === 'pending')) return 'blocked';
  if (world.tasks.some((t) => t.status === 'blocked' || t.status === 'waiting_for_approval')) return 'blocked';
  if (world.tasks.some((t) => t.status === 'review')) return 'reviewing';
  if (world.projects.some((p) => p.status === 'planning' || p.status === 'proposed')) return 'planning';
  return 'idle';
}

export type WorkerAnimation = 'idle' | 'walk_to_task' | 'work' | 'review' | 'blocked' | 'error' | 'depart' | 'gone';

/** Worker animation is a pure function of backend agent status; disconnected => idle (frozen). */
export function workerAnimation(agent: AgentIdentity, connected: boolean): WorkerAnimation {
  if (!connected) return agent.status === 'retired' ? 'gone' : 'idle';
  switch (agent.status) {
    case 'created':
    case 'idle':
      return 'idle';
    case 'assigned':
      return 'walk_to_task';
    case 'working':
      return 'work';
    case 'reviewing':
      return 'review';
    case 'blocked':
      return 'blocked';
    case 'error':
      return 'error';
    case 'retiring':
      return 'depart';
    case 'retired':
      return 'gone';
  }
}

/** Visible ability badges. A badge appears only when the backend capability is granted. */
export function abilityBadges(agent: Pick<AgentIdentity, 'capabilities'>): string[] {
  const c = agent.capabilities;
  const out: string[] = [];
  if (c.readProjectInputs) out.push('reads inputs');
  if (c.writeDeliverables) out.push('writes deliverables');
  if (c.editWorkspaceFiles) out.push('edits files');
  if (c.executeCode) out.push('executes code');
  if (c.browseWeb) out.push('browses web');
  if (c.delegate) out.push('delegates');
  return out;
}

export const ROLE_APPEARANCE: Record<AgentRole, { palette: string; emblem: string; prop: string }> = {
  administrator: { palette: 'aurum', emblem: 'caduceus-wing', prop: 'command-orb' },
  builder: { palette: 'ember', emblem: 'hex-bolt', prop: 'forge-hammer' },
  researcher: { palette: 'tide', emblem: 'lens', prop: 'scanner' },
  reviewer: { palette: 'jade', emblem: 'check-sigil', prop: 'gauge' },
  designer: { palette: 'violet', emblem: 'prism', prop: 'stylus' },
};

// ---------- Event folding (client-side live view) ----------

export type FoldResult = 'applied' | 'duplicate' | 'gap';

/** Replace-or-insert by id, preserving order. */
function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const copy = list.slice();
  copy[i] = item;
  return copy;
}

/**
 * Fold one event into a snapshot. Duplicates (seq <= cursor) are ignored; a gap
 * (seq > cursor + 1) tells the caller to fetch a fresh snapshot instead of guessing.
 * Events carry full entity state, so folding never merges partial fields.
 */
export function foldEvent(world: WorldSnapshot, ev: WorldEvent): { world: WorldSnapshot; result: FoldResult } {
  if (ev.seq <= world.cursor) return { world, result: 'duplicate' };
  if (ev.seq > world.cursor + 1) return { world, result: 'gap' };
  let w: WorldSnapshot = { ...world, cursor: ev.seq };
  const p = ev.payload as Record<string, unknown>;
  switch (ev.type) {
    case 'project.proposed':
    case 'project.created':
    case 'project.updated':
    case 'project.completed':
    case 'project.archived':
      w = { ...w, projects: upsert(w.projects, p.project as Project) };
      break;
    case 'project.data_deleted':
      w = {
        ...w,
        artifacts: w.artifacts.filter((a) => a.projectId !== p.projectId),
      };
      break;
    case 'island.creation_requested':
    case 'island.created':
    case 'island.updated':
    case 'island.archived':
    case 'island.destruction_requested':
    case 'island.destroyed':
      w = { ...w, islands: upsert(w.islands, p.island as Island) };
      break;
    case 'agent.created':
    case 'agent.assigned':
    case 'agent.updated':
    case 'agent.retired':
      w = { ...w, agents: upsert(w.agents, p.agent as AgentIdentity) };
      break;
    case 'task.created':
    case 'task.updated':
    case 'task.cancel_requested':
    case 'task.cancelled':
      w = { ...w, tasks: upsert(w.tasks, p.task as Task) };
      break;
    case 'task.started':
      w = {
        ...w,
        tasks: upsert(w.tasks, p.task as Task),
        attempts: upsert(w.attempts, p.attempt as WorldSnapshot['attempts'][number]),
      };
      break;
    case 'attempt.finished':
      w = { ...w, attempts: upsert(w.attempts, p.attempt as WorldSnapshot['attempts'][number]) };
      break;
    case 'artifact.created':
      w = { ...w, artifacts: upsert(w.artifacts, p.artifact as WorldSnapshot['artifacts'][number]) };
      break;
    case 'review.completed':
      w = { ...w, reviews: upsert(w.reviews, p.review as WorldSnapshot['reviews'][number]) };
      break;
    case 'approval.requested':
    case 'approval.decided':
      w = { ...w, approvals: upsert(w.approvals, p.approval as WorldSnapshot['approvals'][number]) };
      break;
    case 'system.controls_changed':
      w = { ...w, controls: p.controls as WorldSnapshot['controls'] };
      break;
    case 'system.adapter_status':
      w = { ...w, adapter: p.health as WorldSnapshot['adapter'] };
      break;
    case 'task.progress':
    case 'system.recovered':
      break;
  }
  return { world: w, result: 'applied' };
}
