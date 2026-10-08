import { z } from 'zod';

/** Bumped whenever an entity, event, or API shape changes incompatibly. */
export const SCHEMA_VERSION = 1 as const;

export const Id = z.string().min(1).max(80).regex(/^[a-z]+_[A-Za-z0-9]+$/, 'expected <prefix>_<token>');
export type Id = z.infer<typeof Id>;

export const IsoTime = z.string().datetime({ offset: true });
export type IsoTime = z.infer<typeof IsoTime>;

/** Short, display-safe text. Untrusted input is clipped before it reaches these fields. */
export const Label = z.string().min(1).max(200);
export const Text = z.string().max(20_000);

export const Role = z.enum(['owner', 'operator', 'viewer']);
export type Role = z.infer<typeof Role>;

/**
 * Which execution adapter produced a piece of state. The client uses this to label
 * DEMO versus LIVE state; it must never be inferred from animation.
 */
export const AdapterKind = z.enum(['mock', 'hermes-runs']);
export type AdapterKind = z.infer<typeof AdapterKind>;

export const AutonomyTier = z.enum(['observe', 'assist', 'bounded_autonomous']);
export type AutonomyTier = z.infer<typeof AutonomyTier>;

export const ActorRef = z.object({
  kind: z.enum(['owner', 'system', 'hermes', 'agent', 'adapter']),
  id: z.string().max(80).optional(),
});
export type ActorRef = z.infer<typeof ActorRef>;

export const EntityKind = z.enum([
  'user',
  'project',
  'island',
  'agent',
  'agent_session',
  'task',
  'task_attempt',
  'artifact',
  'review',
  'approval',
  'research_note',
  'skill_proposal',
  'budget',
  'system',
]);
export type EntityKind = z.infer<typeof EntityKind>;

export const EntityRef = z.object({ kind: EntityKind, id: z.string().min(1).max(80) });
export type EntityRef = z.infer<typeof EntityRef>;

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Random, URL-safe entity id with a readable type prefix (e.g. `prj_X3k9...`). */
export function newId(prefix: string, length = 16): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return `${prefix}_${out}`;
}
