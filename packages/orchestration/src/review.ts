import type { AcceptanceCriterion } from '@hdw/contracts';

export interface Finding {
  criterionId: string;
  met: boolean;
  note: string;
}

export interface ReviewResult {
  verdict: 'pass' | 'revise' | 'fail';
  findings: Finding[];
}

interface Section {
  heading: string;
  body: string;
}

function sections(md: string): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const line of md.split(/\r?\n/)) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      cur = { heading: m[1]!.trim(), body: '' };
      out.push(cur);
    } else if (cur) {
      cur.body += `${line}\n`;
    }
  }
  return out;
}

function headingRegex(pattern: string): RegExp {
  // Patterns are owner/plan-defined (not from deliverable content); anchor to whole heading words.
  return new RegExp(`(^|\\b)${pattern}(\\b|$)`, 'i');
}

/**
 * Deterministic review of a Markdown deliverable against acceptance criteria.
 * `manual` criteria are reported as unmet-pending so they are never silently passed.
 */
export function reviewMarkdown(md: string, criteria: readonly AcceptanceCriterion[], opts: { finalAttempt: boolean }): ReviewResult {
  const secs = sections(md);
  const findings: Finding[] = criteria.map((c) => {
    switch (c.check.kind) {
      case 'heading': {
        const re = headingRegex(c.check.pattern);
        const hit = secs.find((s) => re.test(s.heading));
        return { criterionId: c.id, met: !!hit, note: hit ? `Found section "${hit.heading}"` : `Missing a section matching "${c.description}"` };
      }
      case 'list_items_under_heading': {
        const re = headingRegex(c.check.pattern);
        const sec = secs.find((s) => re.test(s.heading));
        const items = sec ? sec.body.split('\n').filter((l) => /^\s*([-*+]|\d+[.)])\s+\S/.test(l)).length : 0;
        return {
          criterionId: c.id,
          met: items >= c.check.min,
          note: sec ? `${items} list item(s) under "${sec.heading}" (need ${c.check.min})` : 'Section not found',
        };
      }
      case 'min_length':
        return { criterionId: c.id, met: md.trim().length >= c.check.chars, note: `${md.trim().length} characters (need ${c.check.chars})` };
      case 'manual':
        return { criterionId: c.id, met: false, note: `Needs owner review: ${c.check.note}` };
    }
  });
  const automatic = criteria.filter((c) => c.check.kind !== 'manual');
  const allAutoMet = findings.filter((f) => automatic.some((c) => c.id === f.criterionId)).every((f) => f.met);
  if (allAutoMet) return { verdict: 'pass', findings };
  return { verdict: opts.finalAttempt ? 'fail' : 'revise', findings };
}

export function revisionNotes(result: ReviewResult): string {
  const unmet = result.findings.filter((f) => !f.met);
  return unmet.map((f) => `- ${f.criterionId}: ${f.note}`).join('\n');
}
