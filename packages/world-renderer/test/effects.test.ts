import { describe, expect, it } from 'vitest';
import { CREATE_DURATION, REDUCED_DURATION, createFrame, duration, isDone, nextDpr, removeFrame } from '../src/effects.ts';

describe('lifecycle animation timing', () => {
  it('creation runs beacon -> fragments -> rise -> structures -> label -> agents', () => {
    const at = (t: number) => createFrame(t, false);
    expect(at(0.5).beacon).toBeGreaterThan(0);
    expect(at(0.5).rise).toBe(0);
    expect(at(2.0).fragments).toBeGreaterThan(at(1.0).fragments);
    expect(at(3.2).structures).toBeGreaterThan(0);
    expect(at(3.2).label).toBe(0);
    expect(at(CREATE_DURATION)).toMatchObject({ fragments: 1, rise: 1, structures: 1, label: 1, agents: 1 });
  });

  it('removal presets end fully hidden', () => {
    for (const p of ['demolition', 'earthquake', 'dissolve'] as const) {
      expect(removeFrame(p, duration({ kind: 'archive', preset: p }, false), false).opacity).toBeCloseTo(0);
    }
  });

  it('reduced motion replaces shake and flashes with a short fade, keeping the meaning', () => {
    for (const p of ['demolition', 'earthquake', 'dissolve'] as const) {
      for (let t = 0; t <= REDUCED_DURATION; t += 0.1) {
        const f = removeFrame(p, t, true);
        expect(f.shake).toBe(0);
        expect(f.flash).toBe(0);
      }
      expect(removeFrame(p, REDUCED_DURATION, true).opacity).toBeCloseTo(0);
    }
    expect(createFrame(REDUCED_DURATION, true).opacity).toBeCloseTo(1);
    expect(duration({ kind: 'create', preset: null }, true)).toBe(REDUCED_DURATION);
  });

  it('flashes at most once and caps flash intensity', () => {
    let peaks = 0;
    let prev = 0;
    let rising = false;
    for (let t = 0; t <= 3.2; t += 0.01) {
      const f = removeFrame('demolition', t, false).flash;
      expect(f).toBeLessThanOrEqual(0.6);
      if (f > prev) rising = true;
      else if (rising && f < prev) {
        peaks += 1;
        rising = false;
      }
      prev = f;
    }
    expect(peaks).toBeLessThanOrEqual(1);
  });

  it('earthquake shake stays at a low frequency (2 Hz)', () => {
    let crossings = 0;
    for (let t = 0.5; t < 1.5; t += 0.005) {
      if (Math.sign(removeFrame('earthquake', t, false).shake) !== Math.sign(removeFrame('earthquake', t + 0.005, false).shake)) crossings += 1;
    }
    expect(crossings).toBeLessThanOrEqual(5);
  });

  it('is time-based, not frame-based', () => {
    const l = { kind: 'create' as const, preset: null, startedAt: 1000, replay: false };
    expect(isDone(l, 1000 + CREATE_DURATION * 1000 - 1, false)).toBe(false);
    expect(isDone(l, 1000 + CREATE_DURATION * 1000, false)).toBe(true);
  });
});

describe('adaptive resolution', () => {
  it('steps down when slow, up when there is headroom, within quality bounds', () => {
    expect(nextDpr(1.5, 50, 'medium', 30)).toBeLessThan(1.5);
    expect(nextDpr(0.75, 50, 'medium', 30)).toBe(0.75);
    expect(nextDpr(1.0, 10, 'medium', 30)).toBeGreaterThan(1.0);
    expect(nextDpr(1.5, 10, 'medium', 30)).toBe(1.5);
    expect(nextDpr(1.0, 30, 'medium', 30)).toBe(1.0);
  });
});
