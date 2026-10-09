/**
 * Pure animation timing for island lifecycles. Kept free of three.js so the timing and
 * the reduced-motion rules are unit-tested and reusable by a future engine client.
 * All functions take elapsed seconds (delta-time driven), never frame counts.
 */

export type LifecycleKind = 'create' | 'archive' | 'destroy';
export type RemovalPreset = 'demolition' | 'earthquake' | 'dissolve';

export interface Lifecycle {
  kind: LifecycleKind;
  preset: RemovalPreset | null;
  /** performance.now() milliseconds when the animation began. */
  startedAt: number;
  /** True when replayed from the timeline rather than triggered by a live event. */
  replay: boolean;
}

/** Creation sequence (seconds): beacon, fragments assemble, rise, structures, label, agents arrive. */
export const CREATE_STAGES = {
  beacon: [0, 0.9],
  fragments: [0.6, 2.2],
  rise: [1.8, 3.0],
  structures: [2.8, 3.9],
  label: [3.7, 4.2],
  agents: [4.0, 5.0],
} as const;
export const CREATE_DURATION = 5.0;
export const REMOVE_DURATION: Record<RemovalPreset, number> = { demolition: 3.2, earthquake: 3.6, dissolve: 3.0 };
/** Reduced motion: a short, gentle fade that preserves the meaning of the event. */
export const REDUCED_DURATION = 0.8;

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function stage(t: number, [a, b]: readonly [number, number]): number {
  return clamp01((t - a) / (b - a));
}

export const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;
export const easeInCubic = (x: number) => x * x * x;
export const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

export function duration(l: Pick<Lifecycle, 'kind' | 'preset'>, reducedMotion: boolean): number {
  if (reducedMotion) return REDUCED_DURATION;
  if (l.kind === 'create') return CREATE_DURATION;
  return REMOVE_DURATION[l.preset ?? 'dissolve'];
}

export interface CreateFrame {
  beacon: number; // 0..1 beam intensity
  fragments: number; // 0..1 fragments converged
  rise: number; // 0..1 island at final height
  structures: number; // 0..1 buildings assembled
  label: number; // 0..1 label opacity
  agents: number; // 0..1 agents arrived
  opacity: number;
}

export function createFrame(t: number, reducedMotion: boolean): CreateFrame {
  if (reducedMotion) {
    const k = easeInOut(clamp01(t / REDUCED_DURATION));
    return { beacon: 0, fragments: 1, rise: 1, structures: 1, label: k, agents: k, opacity: k };
  }
  const beaconIn = stage(t, CREATE_STAGES.beacon);
  const beaconOut = 1 - stage(t, [3.4, 4.4]);
  return {
    beacon: Math.min(beaconIn, beaconOut),
    fragments: easeOutCubic(stage(t, CREATE_STAGES.fragments)),
    rise: easeOutCubic(stage(t, CREATE_STAGES.rise)),
    structures: easeOutCubic(stage(t, CREATE_STAGES.structures)),
    label: stage(t, CREATE_STAGES.label),
    agents: easeInOut(stage(t, CREATE_STAGES.agents)),
    opacity: 1,
  };
}

export interface RemoveFrame {
  /** Overall island visibility 0..1. */
  opacity: number;
  /** Horizontal shake offset in world units (earthquake only, 0 with reduced motion). */
  shake: number;
  /** Downward drop in world units. */
  drop: number;
  /** 0..1 how far fragments have flown/dissolved. */
  scatter: number;
  /** 0..1 emissive flash intensity, capped to stay well below seizure thresholds. */
  flash: number;
}

/**
 * Removal presets. Flash is limited to a single soft pulse (< 3 flashes/second rule) and
 * shake uses a low frequency; reduced motion replaces both with a plain fade.
 */
export function removeFrame(preset: RemovalPreset, t: number, reducedMotion: boolean): RemoveFrame {
  if (reducedMotion) {
    const k = clamp01(t / REDUCED_DURATION);
    return { opacity: 1 - easeInOut(k), shake: 0, drop: 0, scatter: 0, flash: 0 };
  }
  const d = REMOVE_DURATION[preset];
  const k = clamp01(t / d);
  switch (preset) {
    case 'demolition': {
      // Charges glow, one soft pulse, then structured collapse outward.
      const charge = stage(t, [0, 0.9]);
      const pulse = Math.max(0, 1 - Math.abs(t - 1.0) / 0.35) * 0.6;
      const blast = easeOutCubic(stage(t, [1.0, d]));
      return { opacity: 1 - stage(t, [1.6, d]), shake: 0, drop: blast * 2, scatter: blast, flash: Math.max(charge * 0.25, pulse) };
    }
    case 'earthquake': {
      // Low-frequency rumble (2 Hz), cracks, then the pieces fall away.
      const rumble = stage(t, [0, 1.6]) * (1 - stage(t, [2.4, d]));
      const shake = Math.sin(t * Math.PI * 2 * 2) * 0.25 * rumble;
      const fall = easeInCubic(stage(t, [1.4, d]));
      return { opacity: 1 - stage(t, [2.6, d]), shake, drop: fall * 9, scatter: fall * 0.6, flash: 0 };
    }
    case 'dissolve': {
      // Pixel-dust disintegration drifting up and away; no flash, no shake.
      const dust = easeInOut(k);
      return { opacity: 1 - dust, shake: 0, drop: -dust * 1.5, scatter: dust, flash: 0 };
    }
  }
}

/** Seconds elapsed for a lifecycle at time `nowMs`. */
export function elapsed(l: Pick<Lifecycle, 'startedAt'>, nowMs: number): number {
  return Math.max(0, (nowMs - l.startedAt) / 1000);
}

export function isDone(l: Lifecycle, nowMs: number, reducedMotion: boolean): boolean {
  return elapsed(l, nowMs) >= duration(l, reducedMotion);
}

// ---------- Quality ----------

export type QualityLevel = 'low' | 'medium' | 'high';

export const QUALITY: Record<QualityLevel, { maxDpr: number; minDpr: number; particles: number; voxelDetail: number; antialias: boolean }> = {
  low: { maxDpr: 1, minDpr: 0.6, particles: 120, voxelDetail: 0.6, antialias: false },
  medium: { maxDpr: 1.5, minDpr: 0.75, particles: 260, voxelDetail: 0.85, antialias: true },
  high: { maxDpr: 2, minDpr: 1, particles: 420, voxelDetail: 1, antialias: true },
};

/**
 * Adaptive resolution: step the pixel ratio down when frames are slow and back up when
 * there is headroom. Pure so it can be tested with synthetic frame times.
 */
export function nextDpr(current: number, avgFrameMs: number, q: QualityLevel, targetFps: number): number {
  const { maxDpr, minDpr } = QUALITY[q];
  const budget = 1000 / targetFps;
  if (avgFrameMs > budget * 1.25) return Math.max(minDpr, Math.round((current - 0.15) * 100) / 100);
  if (avgFrameMs < budget * 0.6) return Math.min(maxDpr, Math.round((current + 0.1) * 100) / 100);
  return current;
}
