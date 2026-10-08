import type { AdapterHealth, AdapterKind } from '@hdw/contracts';

export interface RunRequest {
  /** Stable per attempt so a retried POST never starts a second run. */
  idempotencyKey: string;
  /** System-level instructions (task framing, policy reminders). */
  instructions: string;
  /** The task input. Treated by Hermes as user content, never as authority. */
  input: string;
}

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_approval'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled', 'interrupted'];

export interface RunUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface RunState {
  runId: string;
  status: RunStatus;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
}

/**
 * Normalised run events. Hidden reasoning is never surfaced: the live adapter drops
 * `reasoning.available` frames before they reach this type.
 */
export type AdapterRunEvent =
  | { type: 'delta'; text: string; seq: number | null }
  | { type: 'progress'; summary: string; seq: number | null }
  | { type: 'tool'; name: string; phase: 'started' | 'completed'; error: boolean; seq: number | null }
  | { type: 'approval_requested'; requestId: string | null; summary: string; choices: string[]; seq: number | null }
  | { type: 'terminal'; state: RunState; seq: number | null };

export interface ProbeResult {
  health: AdapterHealth;
  /** Toolsets enabled for the Hermes `api_server` platform, or null if unknown. */
  enabledToolsets: string[] | null;
}

export interface HermesAdapter {
  readonly kind: AdapterKind;
  /** True only for a real Hermes runtime. */
  readonly live: boolean;
  probe(): Promise<ProbeResult>;
  startRun(req: RunRequest): Promise<{ runId: string }>;
  /** Stream normalised events until the run is terminal or `signal` aborts. */
  events(runId: string, opts: { signal: AbortSignal; afterSeq?: number }): AsyncIterable<AdapterRunEvent>;
  /** Authoritative status; null when the runtime no longer knows the run. */
  getRun(runId: string): Promise<RunState | null>;
  /** Request a stop. Acceptance is NOT termination; poll `getRun` to verify. */
  stopRun(runId: string): Promise<{ accepted: boolean; detail: string }>;
  /** Resolve a pending Hermes approval. Only single-use choices are ever sent. */
  resolveApproval(runId: string, requestId: string | null, choice: 'once' | 'deny'): Promise<{ resolved: boolean; detail: string }>;
}

export class AdapterError extends Error {
  constructor(
    message: string,
    readonly code: 'unreachable' | 'unauthorized' | 'not_found' | 'conflict' | 'bad_response' | 'unsupported',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}
