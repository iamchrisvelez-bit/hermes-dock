/**
 * LIVE smoke test against a real Hermes Agent API server (Runs API).
 *
 *   HERMES_API_URL=http://127.0.0.1:8642 HERMES_API_KEY=... npm run smoke:live
 *
 * It does NOT start the control plane. It checks capabilities and enabled toolsets against
 * the default owner policy, refuses to run if the policy would refuse, then runs the
 * suggested smoke task, streams events, and reviews the output against the acceptance
 * criteria. Exit code 0 only if a real Hermes run completed AND passed review.
 */
import { HermesRunsAdapter } from '@hdw/hermes-adapter';
import { buildRunRequest, planForBrief, reviewMarkdown } from '@hdw/orchestration';
import { DEFAULT_POLICY, evaluate, sandboxReport } from '@hdw/workspace-policy';

const url = process.env.HERMES_API_URL ?? 'http://127.0.0.1:8642';
const key = process.env.HERMES_API_KEY;
if (!key) {
  console.error('Set HERMES_API_KEY (the API_SERVER_KEY from ~/.hermes/.env).');
  process.exit(2);
}
const adapter = new HermesRunsAdapter({ baseUrl: url, apiKey: key, requestTimeoutMs: 30_000 });

const probe = await adapter.probe();
console.log('probe:', probe.health.state, '-', probe.health.detail);
console.log('enabled api_server toolsets:', probe.enabledToolsets);
if (probe.health.state !== 'ready') process.exit(1);

const decision = evaluate(
  { kind: 'run_hermes', enabledToolsets: probe.enabledToolsets ?? [] },
  { policy: DEFAULT_POLICY, controls: { pauseAll: false, newWorkDisabled: false, emergencyStop: false }, sandbox: sandboxReport({ dockerCli: false }) },
);
if (decision.outcome !== 'allow') {
  console.error('POLICY REFUSED:', decision.outcome === 'deny' ? decision.reason : decision.reason);
  process.exit(1);
}

const brief = {
  summary: 'Build a small offline-first app that plans a family vegetable garden.',
  goals: ['Plan beds and planting dates', 'Work offline'],
  constraints: ['Free tools only'],
  risks: ['Plant data sources are unclear'],
  missingInformation: [],
  classification: 'new_project' as const,
  relatedProjectIds: [],
  inputArtifactIds: [],
};
const plan = planForBrief('Garden Planner', brief);
const req = buildRunRequest({ title: 'Garden Planner', brief, inputs: [], criteria: plan.acceptanceCriteria, attempt: 1, revisionNotes: null });
const { runId } = await adapter.startRun({ idempotencyKey: `live-smoke-${Date.now()}`, ...req });
console.log('run started:', runId);

const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 10 * 60 * 1000);
let output = '';
let status = 'unknown';
for await (const ev of adapter.events(runId, { signal: ac.signal })) {
  if (ev.type === 'tool') console.log(`  tool ${ev.name} ${ev.phase}${ev.error ? ' (error)' : ''}`);
  else if (ev.type === 'progress') console.log(`  ${ev.summary}`);
  else if (ev.type === 'approval_requested') console.log(`  APPROVAL REQUESTED (resolve in Hermes or via the app): ${ev.summary}`);
  else if (ev.type === 'terminal') {
    status = ev.state.status;
    output = ev.state.output ?? '';
    console.log('terminal:', status, ev.state.error ?? '', 'usage:', ev.state.usage);
  }
}
clearTimeout(timer);
const final = await adapter.getRun(runId);
console.log('authoritative status:', final?.status);
const review = reviewMarkdown(output, plan.acceptanceCriteria, { finalAttempt: true });
console.log('review:', review.verdict);
for (const f of review.findings) console.log(`  ${f.met ? 'PASS' : 'FAIL'} ${f.criterionId}: ${f.note}`);
console.log('\n----- output -----\n' + output.slice(0, 4000));
process.exit(status === 'completed' && review.verdict === 'pass' ? 0 : 1);
