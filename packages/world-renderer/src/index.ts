// Light entry: view-model and animation timing only (no three.js). The 3D scene lives in
// `@hdw/world-renderer/canvas` so apps can lazy-load it.
export * from './effects.ts';
export * from './model.ts';
export type { RenderStats, Selection, WorldCanvasProps } from './WorldCanvas.tsx';

/** True if WebGL can be created; apps fall back to a 2D view otherwise. */
export function detectWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}
