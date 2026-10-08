import type { AcceptanceCriterion, ProjectBrief } from '@hdw/contracts';

export interface PlannedTask {
  key: string;
  title: string;
  kind: 'plan_document';
  dependsOn: string[];
}

export interface Plan {
  deliverable: string;
  acceptanceCriteria: AcceptanceCriterion[];
  tasks: PlannedTask[];
  /** Honest estimate: a range in task count, not invented hours or tokens. */
  estimate: string;
  approvalsRequired: string[];
}

export const MAX_TASKS = 12;
export const MAX_GRAPH_DEPTH = 4;

/** First-milestone plan: one bounded plan-document task with checkable criteria. */
export function planForBrief(title: string, brief: ProjectBrief): Plan {
  return {
    deliverable: `Markdown implementation plan for "${title}"`,
    acceptanceCriteria: [
      { id: 'ac-milestones', description: 'Has a Milestones section', check: { kind: 'heading', pattern: 'milestones?' } },
      {
        id: 'ac-milestone-count',
        description: 'Lists at least 3 milestones',
        check: { kind: 'list_items_under_heading', pattern: 'milestones?', min: 3 },
      },
      { id: 'ac-risks', description: 'Has a Risks section', check: { kind: 'heading', pattern: 'risks?' } },
      {
        id: 'ac-acceptance',
        description: 'Has an Acceptance Criteria section',
        check: { kind: 'heading', pattern: 'acceptance criteria' },
      },
      { id: 'ac-substance', description: 'Is at least 400 characters long', check: { kind: 'min_length', chars: 400 } },
    ],
    tasks: [{ key: 't1', title: 'Write the implementation plan', kind: 'plan_document', dependsOn: [] }],
    estimate: brief.goals.length > 4 ? 'one task, larger brief (several revision rounds possible)' : 'one task',
    approvalsRequired: [],
  };
}

/** Validate a task DAG: bounded size, known dependencies, no cycles, bounded depth. */
export function validateTaskGraph(tasks: readonly PlannedTask[]): { ok: true } | { ok: false; reason: string } {
  if (tasks.length === 0) return { ok: false, reason: 'Plan has no tasks' };
  if (tasks.length > MAX_TASKS) return { ok: false, reason: `Plan exceeds ${MAX_TASKS} tasks` };
  const keys = new Set(tasks.map((t) => t.key));
  if (keys.size !== tasks.length) return { ok: false, reason: 'Duplicate task keys' };
  for (const t of tasks) {
    for (const d of t.dependsOn) if (!keys.has(d)) return { ok: false, reason: `Unknown dependency ${d}` };
  }
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (k: string): number => {
    if (depth.has(k)) return depth.get(k)!;
    if (visiting.has(k)) throw new Error('cycle');
    visiting.add(k);
    const d = 1 + Math.max(0, ...byKey.get(k)!.dependsOn.map(visit));
    visiting.delete(k);
    depth.set(k, d);
    return d;
  };
  try {
    for (const t of tasks) if (visit(t.key) > MAX_GRAPH_DEPTH) return { ok: false, reason: `Dependency depth exceeds ${MAX_GRAPH_DEPTH}` };
  } catch {
    return { ok: false, reason: 'Dependency cycle' };
  }
  return { ok: true };
}
