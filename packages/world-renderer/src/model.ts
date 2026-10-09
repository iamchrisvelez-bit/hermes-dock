import type { AgentCapabilities, AgentRole, WorldSnapshot } from '@hdw/contracts';
import {
  hermesPose,
  islandActivity,
  workerAnimation,
  type HermesPose,
  type IslandActivity,
  type WorkerAnimation,
} from '@hdw/world-projection';
import type { PaletteName } from './shared.ts';

/** Render-ready view of the world. Derived only from backend state + connection status. */
export interface IslandView {
  id: string;
  kind: 'headquarters' | 'project';
  projectId: string | null;
  name: string;
  x: number;
  z: number;
  seed: number;
  state: 'materializing' | 'active' | 'archived' | 'destroyed';
  activity: IslandActivity;
  deliverables: number;
}

export interface AgentView {
  id: string;
  name: string;
  role: AgentRole;
  palette: PaletteName;
  islandId: string;
  animation: WorkerAnimation;
  capabilities: AgentCapabilities;
  /** Stable per-agent index on its island for placement. */
  slotIndex: number;
}

export interface WorldViewModel {
  islands: IslandView[];
  agents: AgentView[];
  hermes: { id: string | null; pose: HermesPose };
  hqId: string | null;
  totalDeliverables: number;
  /** Something real is happening that warrants continuous rendering. */
  busy: boolean;
  connected: boolean;
}

const PALETTE_BY_ROLE: Record<AgentRole, PaletteName> = {
  administrator: 'aurum',
  builder: 'ember',
  researcher: 'tide',
  reviewer: 'jade',
  designer: 'violet',
};

export function buildViewModel(w: WorldSnapshot, conn: { connected: boolean }): WorldViewModel {
  const hq = w.islands.find((i) => i.kind === 'headquarters') ?? null;
  const deliverablesByProject = new Map<string, number>();
  for (const a of w.artifacts) if (a.kind === 'deliverable') deliverablesByProject.set(a.projectId, (deliverablesByProject.get(a.projectId) ?? 0) + 1);

  const islands: IslandView[] = w.islands.map((i) => {
    const project = i.projectId ? w.projects.find((p) => p.id === i.projectId) : undefined;
    return {
      id: i.id,
      kind: i.kind,
      projectId: i.projectId,
      name: i.name,
      x: i.position.x,
      z: i.position.z,
      seed: i.seed,
      state: i.state,
      activity: i.kind === 'headquarters' ? 'idle' : conn.connected ? islandActivity(project, w.tasks) : 'idle',
      deliverables: i.projectId ? (deliverablesByProject.get(i.projectId) ?? 0) : 0,
    };
  });

  const counters = new Map<string, number>();
  const agents: AgentView[] = [];
  for (const a of w.agents) {
    if (a.role === 'administrator' || a.status === 'retired') continue;
    const island = a.projectId ? w.islands.find((i) => i.projectId === a.projectId && i.state !== 'destroyed') : hq;
    if (!island) continue;
    const idx = counters.get(island.id) ?? 0;
    counters.set(island.id, idx + 1);
    agents.push({
      id: a.id,
      name: a.name,
      role: a.role,
      palette: PALETTE_BY_ROLE[a.role],
      islandId: island.id,
      animation: workerAnimation(a, conn.connected),
      capabilities: a.capabilities,
      slotIndex: idx,
    });
  }
  const admin = w.agents.find((a) => a.role === 'administrator') ?? null;
  const pose = hermesPose(w, { connected: conn.connected, emergencyStop: w.controls.emergencyStop, pauseAll: w.controls.pauseAll });
  const busy =
    conn.connected &&
    (agents.some((a) => a.animation === 'work' || a.animation === 'review' || a.animation === 'walk_to_task' || a.animation === 'depart') ||
      islands.some((i) => i.activity === 'working'));
  return {
    islands,
    agents,
    hermes: { id: admin?.id ?? null, pose },
    hqId: hq?.id ?? null,
    totalDeliverables: [...deliverablesByProject.values()].reduce((a, b) => a + b, 0),
    busy,
    connected: conn.connected,
  };
}

export const ACTIVITY_COLOR: Record<IslandActivity, string> = {
  idle: '#7c83a8',
  planning: '#38e1ff',
  working: '#38e1ff',
  review: '#5dffb0',
  blocked: '#ffb547',
  complete: '#ffd76a',
  archived: '#555b78',
  failed: '#ff5a6a',
  paused: '#8a8fa8',
};
