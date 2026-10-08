import { z } from 'zod';
import { AutonomyTier, type ApprovalKind } from '@hdw/contracts';

/**
 * Owner-controlled policy. Only the owner (via config file / env, never via an agent request)
 * can change it, and the control plane never lets Hermes or a worker widen it at runtime.
 */
export const OwnerPolicy = z.object({
  autonomyTier: AutonomyTier,
  /** Hermes toolsets a live run may have enabled. Empty = text-only runs. */
  allowedHermesToolsets: z.array(z.string().max(60)).max(50),
  networkAccess: z.enum(['none', 'model_provider_only']),
  /** Whether project data may be sent to the configured (possibly remote) model provider. */
  modelProviderAccess: z.boolean(),
  maxConcurrentWorkers: z.number().int().min(1).max(4),
  maxDelegationDepth: z.number().int().min(0).max(2),
  maxReviewIterations: z.number().int().min(1).max(5),
  taskTimeoutMs: z.number().int().min(5_000).max(4 * 60 * 60 * 1000),
  maxTokensPerProject: z.number().int().positive().nullable(),
  maxCostUsdPerProject: z.number().positive().nullable(),
  /** Always false in this milestone; the type forbids enabling it. */
  unrestrictedShell: z.literal(false),
  /** Executable agent work needs a verified isolation boundary; see sandbox.ts. */
  executableWorkRequested: z.boolean(),
});
export type OwnerPolicy = z.infer<typeof OwnerPolicy>;

export const DEFAULT_POLICY: OwnerPolicy = Object.freeze({
  autonomyTier: 'bounded_autonomous',
  allowedHermesToolsets: [],
  networkAccess: 'model_provider_only',
  modelProviderAccess: true,
  maxConcurrentWorkers: 1,
  maxDelegationDepth: 1,
  maxReviewIterations: 3,
  taskTimeoutMs: 10 * 60 * 1000,
  maxTokensPerProject: null,
  maxCostUsdPerProject: null,
  unrestrictedShell: false,
  executableWorkRequested: false,
}) as OwnerPolicy;

/**
 * Hermes toolset names (hermes_cli/tools_config.py CONFIGURABLE_TOOLSETS, verified 2026-10-08).
 * Hermes executes tools on the API-server host (GET /v1/capabilities: tool_execution "server"),
 * so anything that runs code or touches host files is refused until a sandbox is verified.
 */
export const HOST_EXECUTION_TOOLSETS: readonly string[] = ['terminal', 'code_execution', 'file', 'browser', 'computer_use'];
/** Toolsets that send messages, schedule work, or spawn subagents (which inherit tools). */
export const EXTERNAL_ACTION_TOOLSETS: readonly string[] = [
  'discord',
  'discord_admin',
  'spotify',
  'connections',
  'yuanbao',
  'cronjob',
  'delegation',
  'kanban',
];

/** Actions that ALWAYS require an explicit owner approval, regardless of tier. */
export const ALWAYS_REQUIRES_APPROVAL: readonly ApprovalKind[] = [
  'project_data_deletion',
  'island_destruction',
  'external_communication',
  'paid_service',
  'host_change',
  'out_of_scope_access',
  'permission_change',
  'administrator_change',
  'shared_access',
];

export type PolicyAction =
  | { kind: 'intake' }
  | { kind: 'create_project' }
  | { kind: 'create_island' }
  | { kind: 'create_worker'; delegationDepth: number }
  | { kind: 'start_task'; runningWorkers: number; iteration: number; planApproved: boolean }
  | { kind: 'run_hermes'; enabledToolsets: readonly string[] }
  | { kind: 'execute_code' }
  | { kind: 'sensitive'; approvalKind: ApprovalKind };

export type PolicyDecision =
  | { outcome: 'allow' }
  | { outcome: 'deny'; reason: string }
  | { outcome: 'requires_approval'; approvalKind: ApprovalKind; reason: string };

export interface PolicyContext {
  policy: OwnerPolicy;
  controls: { pauseAll: boolean; newWorkDisabled: boolean; emergencyStop: boolean };
  sandbox: { executableWorkEnabled: boolean; reason: string };
}

const allow: PolicyDecision = { outcome: 'allow' };
const deny = (reason: string): PolicyDecision => ({ outcome: 'deny', reason });

/**
 * Single policy decision point. Pure: no I/O, so every branch is unit tested.
 * The renderer never calls this; the control plane calls it before every mutation.
 */
export function evaluate(action: PolicyAction, ctx: PolicyContext): PolicyDecision {
  const { policy, controls } = ctx;
  const creatingWork = ['intake', 'create_project', 'create_island', 'create_worker', 'start_task'].includes(action.kind);
  if (controls.emergencyStop && action.kind !== 'sensitive') {
    return deny('Emergency stop is active. The owner must clear it first.');
  }
  if (creatingWork && controls.newWorkDisabled && action.kind !== 'start_task') {
    return deny('New work is disabled by the owner.');
  }

  switch (action.kind) {
    case 'intake':
    case 'create_project':
      return allow;
    case 'create_island':
      return policy.autonomyTier === 'observe' ? deny('Observe tier cannot create islands.') : allow;
    case 'create_worker':
      if (policy.autonomyTier === 'observe') return deny('Observe tier cannot create workers.');
      if (action.delegationDepth > policy.maxDelegationDepth) {
        return deny(`Delegation depth ${action.delegationDepth} exceeds limit ${policy.maxDelegationDepth}.`);
      }
      return allow;
    case 'start_task':
      if (controls.pauseAll) return deny('All work is paused.');
      if (policy.autonomyTier === 'observe') return deny('Observe tier does not execute tasks.');
      if (action.runningWorkers >= policy.maxConcurrentWorkers) {
        return deny(`Concurrency limit reached (${policy.maxConcurrentWorkers} running worker).`);
      }
      if (action.iteration > policy.maxReviewIterations) {
        return deny(`Review iteration limit reached (${policy.maxReviewIterations}).`);
      }
      if (policy.autonomyTier === 'assist' && !action.planApproved) {
        return { outcome: 'requires_approval', approvalKind: 'task_plan', reason: 'Assist tier executes only approved plans.' };
      }
      return allow;
    case 'run_hermes': {
      if (!policy.modelProviderAccess) return deny('Model-provider access is disabled by policy.');
      const hostExec = action.enabledToolsets.filter((t) => HOST_EXECUTION_TOOLSETS.includes(t));
      if (hostExec.length > 0) {
        return deny(
          `Hermes has host-executing toolsets enabled for api_server (${hostExec.join(', ')}). Hermes runs tools on the ` +
            'API-server host, and no sandbox is verified, so these are refused regardless of the allowlist.',
        );
      }
      const external = action.enabledToolsets.filter((t) => EXTERNAL_ACTION_TOOLSETS.includes(t));
      if (external.length > 0) {
        return deny(
          `Hermes has toolsets enabled that act outside the project (${external.join(', ')}). ` +
            'External actions, scheduling and delegation need approval flows this milestone does not implement.',
        );
      }
      const extra = action.enabledToolsets.filter((t) => !policy.allowedHermesToolsets.includes(t));
      if (extra.length > 0) {
        return deny(
          `Hermes has toolsets enabled for the api_server platform that policy does not allow: ${extra.join(', ')}. ` +
            'Restrict platform_toolsets.api_server in ~/.hermes/config.yaml or add them to the allowlist.',
        );
      }
      return allow;
    }
    case 'execute_code':
      if (!policy.executableWorkRequested) return deny('Executable work is not enabled in owner policy.');
      if (!ctx.sandbox.executableWorkEnabled) return deny(`No verified sandbox: ${ctx.sandbox.reason}`);
      return deny('Executable work is not implemented in this milestone.');
    case 'sensitive':
      return {
        outcome: 'requires_approval',
        approvalKind: action.approvalKind,
        reason: 'This action always requires explicit owner approval.',
      };
  }
}
