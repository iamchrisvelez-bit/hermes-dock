import * as THREE from 'three';

/**
 * Shared geometry, pixel textures and materials. Every island and avatar reuses these,
 * so a world with many islands still uses a handful of GPU buffers. `disposeShared()`
 * frees them when the 3D view unmounts (e.g. switching to the 2D list).
 */

export const PALETTES = {
  aurum: { base: '#f2c45a', accent: '#fff3c4', glow: '#ffd76a', dark: '#7a5a1c' },
  ember: { base: '#e8743b', accent: '#ffd0a8', glow: '#ff9a4d', dark: '#6e2d12' },
  tide: { base: '#3bb6d6', accent: '#c9f3ff', glow: '#5ee0ff', dark: '#11475a' },
  jade: { base: '#3fcf8e', accent: '#c8ffe3', glow: '#5dffb0', dark: '#145a3a' },
  violet: { base: '#9b6cf0', accent: '#e6d9ff', glow: '#b994ff', dark: '#3d2470' },
  rock: { base: '#4a4f6b', accent: '#7c83a8', glow: '#9aa3d6', dark: '#262a3d' },
  grass: { base: '#2f9d74', accent: '#7fe0b2', glow: '#58f0b0', dark: '#1a5440' },
  circuit: { base: '#1d2a44', accent: '#38e1ff', glow: '#38e1ff', dark: '#0b1222' },
} as const;
export type PaletteName = keyof typeof PALETTES;

let cache: {
  box: THREE.BoxGeometry;
  sphere: THREE.SphereGeometry;
  octa: THREE.OctahedronGeometry;
  icosa: THREE.IcosahedronGeometry;
  cone: THREE.ConeGeometry;
  cylinder: THREE.CylinderGeometry;
  torus: THREE.TorusGeometry;
  plane: THREE.PlaneGeometry;
  textures: Map<string, THREE.Texture>;
  materials: Map<string, THREE.Material>;
} | null = null;

function c() {
  if (!cache) {
    cache = {
      box: new THREE.BoxGeometry(1, 1, 1),
      sphere: new THREE.SphereGeometry(1, 12, 8),
      octa: new THREE.OctahedronGeometry(1, 0),
      icosa: new THREE.IcosahedronGeometry(1, 0),
      cone: new THREE.ConeGeometry(1, 1, 6),
      cylinder: new THREE.CylinderGeometry(1, 1, 1, 8),
      torus: new THREE.TorusGeometry(1, 0.08, 6, 24),
      plane: new THREE.PlaneGeometry(1, 1),
      textures: new Map(),
      materials: new Map(),
    };
  }
  return cache;
}

export const geo = {
  get box() {
    return c().box;
  },
  get sphere() {
    return c().sphere;
  },
  get octa() {
    return c().octa;
  },
  get icosa() {
    return c().icosa;
  },
  get cone() {
    return c().cone;
  },
  get cylinder() {
    return c().cylinder;
  },
  get torus() {
    return c().torus;
  },
  get plane() {
    return c().plane;
  },
};

/** Deterministic PRNG (mulberry32) for procedural detail. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 16x16 pixel texture with dithered noise: the retro "pixel-textured surface" look. */
export function pixelTexture(palette: PaletteName): THREE.Texture {
  const key = `px:${palette}`;
  const hit = c().textures.get(key);
  if (hit) return hit;
  const size = 16;
  const data = new Uint8Array(size * size * 4);
  const p = PALETTES[palette];
  const base = new THREE.Color(p.base);
  const acc = new THREE.Color(p.accent);
  const dark = new THREE.Color(p.dark);
  const r = rng(palette.length * 7919);
  for (let i = 0; i < size * size; i++) {
    const v = r();
    const col = v > 0.86 ? acc : v < 0.18 ? dark : base;
    const edge = i % size === 0 || i < size ? 0.82 : 1;
    data[i * 4] = Math.round(col.r * 255 * edge);
    data[i * 4 + 1] = Math.round(col.g * 255 * edge);
    data[i * 4 + 2] = Math.round(col.b * 255 * edge);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  c().textures.set(key, tex);
  return tex;
}

export function surface(palette: PaletteName): THREE.MeshStandardMaterial {
  const key = `surf:${palette}`;
  const hit = c().materials.get(key) as THREE.MeshStandardMaterial | undefined;
  if (hit) return hit;
  const m = new THREE.MeshStandardMaterial({ map: pixelTexture(palette), roughness: 0.85, metalness: 0.05, flatShading: true });
  c().materials.set(key, m);
  return m;
}

export function glow(color: string): THREE.MeshBasicMaterial {
  const key = `glow:${color}`;
  const hit = c().materials.get(key) as THREE.MeshBasicMaterial | undefined;
  if (hit) return hit;
  const m = new THREE.MeshBasicMaterial({ color, toneMapped: false });
  c().materials.set(key, m);
  return m;
}

/** Per-instance material (needed when opacity animates independently). Caller disposes. */
export function fadeable(palette: PaletteName): THREE.MeshStandardMaterial {
  const m = surface(palette).clone();
  m.transparent = true;
  return m;
}

/** Text label rendered to a small canvas texture with a pixel font look. Caller disposes. */
export function labelTexture(text: string, color = '#e8f6ff', bg = 'rgba(8,14,30,0.78)'): { texture: THREE.CanvasTexture; aspect: number } {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const fontPx = 28;
  ctx.font = `600 ${fontPx}px ui-monospace, Menlo, Consolas, monospace`;
  const clipped = text.length > 28 ? `${text.slice(0, 27)}…` : text;
  const w = Math.ceil(ctx.measureText(clipped).width) + 28;
  canvas.width = w;
  canvas.height = fontPx + 20;
  ctx.font = `600 ${fontPx}px ui-monospace, Menlo, Consolas, monospace`;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.6;
  ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(clipped, 14, canvas.height / 2 + 1);
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, aspect: canvas.width / canvas.height };
}

export function disposeShared(): void {
  if (!cache) return;
  for (const g of [cache.box, cache.sphere, cache.octa, cache.icosa, cache.cone, cache.cylinder, cache.torus, cache.plane]) g.dispose();
  for (const t of cache.textures.values()) t.dispose();
  for (const m of cache.materials.values()) m.dispose();
  cache = null;
}
