import type { Project, ProjectBrief } from '@hdw/contracts';

/**
 * Deterministic intake. This milestone does NOT ask a model to classify input: the
 * brief is extracted with transparent heuristics so the owner can predict and audit it.
 * Hermes receives the brief (as untrusted content) when it plans the work.
 */

export interface IntakeInput {
  prompt: string;
  files: ReadonlyArray<{ artifactId: string; displayName: string; text: string }>;
  explicitProjectId?: string | undefined;
}

export type IntakeDecision =
  | { kind: 'needs_clarification'; questions: string[] }
  | { kind: 'rejected'; reason: string }
  | { kind: 'new_project'; title: string; brief: ProjectBrief }
  | { kind: 'existing_project'; projectId: string; title: string; brief: ProjectBrief };

const MAX_ITEMS = 8;

function sentences(text: string): string[] {
  return text
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((s) => s.replace(/^[#>*\-\s\d.)]+/, '').trim())
    .filter((s) => s.length >= 4)
    .map((s) => (s.length > 300 ? `${s.slice(0, 299)}…` : s));
}

const CONSTRAINT = /\b(must|must not|should not|only|never|limit|budget|deadline|by \w+day|no more than|at most|within)\b/i;
const RISK = /\b(risk|concern|unknown|unclear|might fail|uncertain|depend(s|ency|encies)?)\b/i;
const GOAL = /\b(build|create|make|write|design|plan|implement|ship|deliver|produce|research|improve|add|want|need|goal)\b/i;

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
}

export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

export function deriveTitle(prompt: string, files: IntakeInput['files'], explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim().slice(0, 100);
  const heading = /^#\s+(.+)$/m.exec(files[0]?.text ?? '') ?? /^#\s+(.+)$/m.exec(prompt);
  if (heading?.[1]) return heading[1].trim().slice(0, 100);
  const first = sentences(prompt)[0] ?? files[0]?.displayName.replace(/\.[a-z]+$/i, '') ?? 'Untitled project';
  const words = first.split(/\s+/).slice(0, 8).join(' ');
  return words.length > 0 ? words.slice(0, 100) : 'Untitled project';
}

export function buildIntake(input: IntakeInput, existing: readonly Project[]): IntakeDecision {
  const corpus = [input.prompt, ...input.files.map((f) => f.text)].join('\n');
  const meaningful = corpus.replace(/\s+/g, ' ').trim();
  if (meaningful.length === 0) return { kind: 'rejected', reason: 'Empty request: provide a prompt or a supported file.' };
  if (meaningful.length < 20) {
    return {
      kind: 'needs_clarification',
      questions: ['What should the finished deliverable be?', 'Who is it for, and what does "done" look like?'],
    };
  }
  const all = sentences(corpus);
  const goals = all.filter((s) => GOAL.test(s)).slice(0, MAX_ITEMS);
  const constraints = all.filter((s) => CONSTRAINT.test(s)).slice(0, MAX_ITEMS);
  const risks = all.filter((s) => RISK.test(s)).slice(0, MAX_ITEMS);
  const missing: string[] = [];
  if (!/\b(deadline|by \w+|date|week|month)\b/i.test(corpus)) missing.push('No timeline or deadline was given.');
  if (!/\b(user|audience|customer|team|for me|owner)\b/i.test(corpus)) missing.push('The intended audience is not stated.');
  if (goals.length === 0) missing.push('No explicit goal statement was found; the summary is used as the goal.');

  const title = deriveTitle(input.prompt, input.files);
  const live = existing.filter((p) => p.status !== 'archived');
  const related = live
    .map((p) => ({ id: p.id, score: similarity(title + ' ' + p.brief.summary, p.title + ' ' + p.brief.summary) }))
    .filter((r) => r.score >= 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((r) => r.id);

  const brief: ProjectBrief = {
    summary: (sentences(input.prompt)[0] ?? all[0] ?? title).slice(0, 1_000),
    goals: goals.length > 0 ? goals : [all[0] ?? title],
    constraints,
    risks,
    missingInformation: missing,
    classification: input.explicitProjectId ? 'existing_project' : 'new_project',
    relatedProjectIds: related,
    inputArtifactIds: input.files.map((f) => f.artifactId),
  };

  if (input.explicitProjectId) {
    const target = live.find((p) => p.id === input.explicitProjectId);
    if (!target) return { kind: 'rejected', reason: 'The selected project does not exist or is archived.' };
    return { kind: 'existing_project', projectId: target.id, title: target.title, brief };
  }
  return { kind: 'new_project', title, brief };
}

export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s.length > 0 ? s : 'project';
}
