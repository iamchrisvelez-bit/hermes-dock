import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { createFrame, duration, elapsed, removeFrame, type Lifecycle } from './effects.ts';
import { ACTIVITY_COLOR, type IslandView } from './model.ts';
import { PALETTES, fadeable, geo, glow, labelTexture, rng, surface } from './shared.ts';

interface Voxel {
  home: THREE.Vector3;
  scatter: THREE.Vector3;
  scale: number;
}

/** Procedural floating-island voxels: a pixel-textured top and a tapered rock underside. */
export function generateVoxels(seed: number, radius: number, depth: number, detail = 1): { top: Voxel[]; rock: Voxel[] } {
  const r = rng(seed);
  const top: Voxel[] = [];
  const rock: Voxel[] = [];
  const step = detail >= 0.85 ? 1 : 1.25;
  const wobble = Array.from({ length: 8 }, () => 0.82 + r() * 0.22);
  const edge = (x: number, z: number) => {
    const a = (Math.atan2(z, x) + Math.PI) / (Math.PI * 2);
    const i = Math.floor(a * 8) % 8;
    const f = a * 8 - Math.floor(a * 8);
    return radius * (wobble[i]! * (1 - f) + wobble[(i + 1) % 8]! * f);
  };
  const scatterVec = () => new THREE.Vector3((r() - 0.5) * 18, -6 - r() * 10, (r() - 0.5) * 18);
  for (let x = -radius; x <= radius; x += step) {
    for (let z = -radius; z <= radius; z += step) {
      const d = Math.hypot(x, z);
      const e = edge(x, z);
      if (d > e) continue;
      const h = r() < 0.18 ? 0.25 : 0;
      top.push({ home: new THREE.Vector3(x, h, z), scatter: scatterVec(), scale: step });
      for (let L = 1; L <= depth; L++) {
        const rl = e * (1 - L / (depth + 1)) ** 0.85 + (r() - 0.5) * 0.6;
        if (d <= rl) rock.push({ home: new THREE.Vector3(x, -L * step * 0.9, z), scatter: scatterVec(), scale: step * (0.9 + r() * 0.15) });
      }
    }
  }
  return { top, rock };
}

export interface TerrainFrame {
  assemble: number; // 0 = fragments scattered, 1 = assembled
  scatter: number; // 0 = intact, 1 = blown apart (removal)
  animating: boolean;
}

function Terrain({ voxels, material, frame }: { voxels: Voxel[]; material: THREE.Material; frame: React.MutableRefObject<TerrainFrame> }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const last = useRef({ a: -1, s: -1 });
  const m = useMemo(() => new THREE.Matrix4(), []);
  const p = useMemo(() => new THREE.Vector3(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const sc = useMemo(() => new THREE.Vector3(), []);
  const apply = () => {
    const inst = mesh.current;
    if (!inst) return;
    const { assemble, scatter } = frame.current;
    const away = 1 - assemble + scatter;
    for (let i = 0; i < voxels.length; i++) {
      const v = voxels[i]!;
      p.copy(v.home).addScaledVector(v.scatter, away);
      const s = v.scale * (away > 0 ? Math.max(0.2, 1 - away * 0.6) : 1);
      sc.set(s, s * 0.9, s);
      m.compose(p, q, sc);
      inst.setMatrixAt(i, m);
    }
    inst.instanceMatrix.needsUpdate = true;
    last.current = { a: assemble, s: scatter };
  };
  useLayoutEffect(apply, [voxels]);
  useFrame(() => {
    const f = frame.current;
    if (f.assemble !== last.current.a || f.scatter !== last.current.s) apply();
  });
  return <instancedMesh ref={mesh} args={[geo.box, material, voxels.length]} frustumCulled={false} />;
}

function Label({ text, y, opacity = 1, color }: { text: string; y: number; opacity?: number; color?: string }) {
  const { texture, aspect } = useMemo(() => labelTexture(text, color), [text, color]);
  const mat = useMemo(() => new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }), [texture]);
  useEffect(
    () => () => {
      texture.dispose();
      mat.dispose();
    },
    [texture, mat],
  );
  mat.opacity = opacity;
  const h = 0.9;
  return <sprite material={mat} position={[0, y, 0]} scale={[h * aspect, h, 1]} />;
}

/** Bounded instanced particle burst used by removal presets (count capped by quality). */
function RemovalParticles({ count, seed, preset, progress, color }: { count: number; seed: number; preset: Lifecycle['preset']; progress: React.MutableRefObject<number>; color: string }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const parts = useMemo(() => {
    const r = rng(seed ^ 0x9e3779b9);
    return Array.from({ length: count }, () => ({
      o: new THREE.Vector3((r() - 0.5) * 8, r() * 2 - 1, (r() - 0.5) * 8),
      v: preset === 'dissolve' ? new THREE.Vector3((r() - 0.5) * 2, 2 + r() * 4, (r() - 0.5) * 2) : new THREE.Vector3((r() - 0.5) * 12, r() * 6, (r() - 0.5) * 12),
      s: 0.08 + r() * 0.16,
    }));
  }, [count, seed, preset]);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color, transparent: true, toneMapped: false }), [color]);
  useEffect(() => () => mat.dispose(), [mat]);
  const m = useMemo(() => new THREE.Matrix4(), []);
  const p = useMemo(() => new THREE.Vector3(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const sc = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    const inst = mesh.current;
    if (!inst) return;
    const k = progress.current;
    const g = preset === 'dissolve' ? 0 : -6;
    for (let i = 0; i < parts.length; i++) {
      const pt = parts[i]!;
      const t = k * 2.2;
      p.copy(pt.o).addScaledVector(pt.v, t);
      p.y += 0.5 * g * t * t;
      const s = pt.s * (1 - k);
      sc.set(s, s, s);
      m.compose(p, q, sc);
      inst.setMatrixAt(i, m);
    }
    inst.instanceMatrix.needsUpdate = true;
    mat.opacity = 1 - k;
  });
  return <instancedMesh ref={mesh} args={[geo.box, mat, parts.length]} frustumCulled={false} />;
}

export interface IslandProps {
  island: IslandView;
  lifecycle: Lifecycle | null;
  reducedMotion: boolean;
  particleBudget: number;
  voxelDetail: number;
  selected: boolean;
  onSelect: (e: ThreeEvent<MouseEvent>) => void;
  onLifecycleDone: (islandId: string) => void;
  /** Agents rendered on this island; scaled by the creation "agents arrive" stage (ref, read per frame). */
  children?: (appear: React.MutableRefObject<number>) => React.ReactNode;
}

/**
 * A project island. Static islands cost nothing per frame; only an active lifecycle
 * (creation / archive / destruction) writes transforms, driven by elapsed time.
 */
export function ProjectIsland(props: IslandProps) {
  const { island, lifecycle, reducedMotion } = props;
  const voxels = useMemo(() => generateVoxels(island.seed, 4.2, 4, props.voxelDetail), [island.seed, props.voxelDetail]);
  const mats = useMemo(() => ({ top: fadeable('grass'), rock: fadeable('rock'), build: fadeable('circuit') }), []);
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);
  const beaconMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#38e1ff', transparent: true, opacity: 0, depthWrite: false, toneMapped: false }), []);
  const lightMat = useMemo(() => new THREE.MeshBasicMaterial({ color: ACTIVITY_COLOR[island.activity], toneMapped: false, transparent: true }), []);
  useEffect(() => () => {
    beaconMat.dispose();
    lightMat.dispose();
  }, [beaconMat, lightMat]);

  const body = useRef<THREE.Group>(null);
  const structures = useRef<THREE.Group>(null);
  const terrainFrame = useRef<TerrainFrame>({ assemble: 1, scatter: 0, animating: false });
  const particleProgress = useRef(0);
  const appear = useRef(1);
  const labelOpacity = useRef(1);
  const doneFor = useRef<Lifecycle | null>(null);
  const labelGroup = useRef<THREE.Group>(null);

  const activityColor = ACTIVITY_COLOR[island.activity];
  const removing = lifecycle && lifecycle.kind !== 'create';

  useFrame(({ clock }) => {
    const now = performance.now();
    let opacity = 1;
    let rise = 1;
    let build = 1;
    let beacon = 0;
    let label = 1;
    let shake = 0;
    let drop = 0;
    let flash = 0;
    terrainFrame.current.scatter = 0;
    terrainFrame.current.assemble = 1;
    if (lifecycle) {
      const t = elapsed(lifecycle, now);
      if (lifecycle.kind === 'create') {
        const f = createFrame(t, reducedMotion);
        terrainFrame.current.assemble = f.fragments;
        rise = f.rise;
        build = f.structures;
        beacon = f.beacon;
        label = f.label;
        opacity = f.opacity;
        appear.current = f.agents;
      } else {
        const f = removeFrame(lifecycle.preset ?? 'dissolve', t, reducedMotion);
        opacity = f.opacity;
        shake = f.shake;
        drop = f.drop;
        flash = f.flash;
        terrainFrame.current.scatter = lifecycle.preset === 'earthquake' ? f.scatter * 0.25 : f.scatter * 0.6;
        particleProgress.current = Math.min(1, t / duration(lifecycle, reducedMotion));
        label = opacity;
        appear.current = opacity;
      }
      if (t >= duration(lifecycle, reducedMotion) && doneFor.current !== lifecycle) {
        doneFor.current = lifecycle;
        props.onLifecycleDone(island.id);
      }
    } else {
      appear.current = 1;
    }
    if (body.current) {
      body.current.position.set(shake, -6 * (1 - rise) - drop, 0);
    }
    if (structures.current) structures.current.scale.set(1, Math.max(0.001, build), 1);
    mats.top.opacity = mats.rock.opacity = mats.build.opacity = opacity;
    mats.top.emissive.set(flash > 0 ? '#ff9a4d' : '#000000');
    mats.top.emissiveIntensity = flash;
    beaconMat.opacity = beacon * 0.55;
    labelOpacity.current = label;
    lightMat.color.set(activityColor);
    // Only a WORKING island pulses; every other state is a steady light.
    lightMat.opacity = island.activity === 'working' && !reducedMotion ? 0.55 + 0.45 * Math.abs(Math.sin(clock.elapsedTime * 2.2)) : 1;
    if (labelGroup.current) labelGroup.current.visible = label > 0.02;
  });

  const crystals = Math.min(island.deliverables, 6);
  return (
    <group position={[island.x, 0, island.z]}>
      <group ref={body} onClick={props.onSelect}>
        <Terrain voxels={voxels.top} material={mats.top} frame={terrainFrame} />
        <Terrain voxels={voxels.rock} material={mats.rock} frame={terrainFrame} />
        <group ref={structures} position={[0, 0.5, 0]}>
          {/* workshop */}
          <mesh geometry={geo.box} material={mats.build} position={[-1.2, 0.6, -0.8]} scale={[1.8, 1.2, 1.4]} />
          <mesh geometry={geo.cone} material={surface('ember')} position={[-1.2, 1.55, -0.8]} scale={[1.3, 0.7, 1.3]} rotation={[0, Math.PI / 6, 0]} />
          {/* beacon mast + status light (color = real project/task state) */}
          <mesh geometry={geo.cylinder} material={surface('rock')} position={[1.6, 1.1, -1.2]} scale={[0.08, 2.2, 0.08]} />
          <mesh geometry={geo.octa} material={lightMat} position={[1.6, 2.4, -1.2]} scale={0.28} />
          {/* workpad */}
          <mesh geometry={geo.cylinder} material={glow(PALETTES.circuit.accent)} position={[0.6, 0.02, 0.9]} scale={[0.9, 0.04, 0.9]} />
          {/* deliverable crystals: one per recorded deliverable artifact (max 6 shown) */}
          {Array.from({ length: crystals }, (_, i) => (
            <mesh key={i} geometry={geo.octa} material={glow('#ffd76a')} position={[-2.2 + i * 0.35, 0.3, 1.6]} scale={[0.12, 0.26, 0.12]} />
          ))}
        </group>
        {/* creation signal beacon */}
        <mesh geometry={geo.cylinder} material={beaconMat} position={[0, 12, 0]} scale={[0.35, 26, 0.35]} />
        <group ref={labelGroup}>
          <LabelLive text={island.name} y={4.2} opacity={labelOpacity} color={activityColor} />
        </group>
        {props.children?.(appear)}
      </group>
      {removing && props.particleBudget > 0 && (
        <RemovalParticles count={props.particleBudget} seed={island.seed} preset={lifecycle!.preset} progress={particleProgress} color={lifecycle!.preset === 'dissolve' ? '#9ff3ff' : lifecycle!.preset === 'demolition' ? '#ffb070' : '#8a90b8'} />
      )}
      {props.selected && <mesh geometry={geo.torus} material={glow('#ffffff')} position={[0, 0.6, 0]} rotation={[Math.PI / 2, 0, 0]} scale={5} />}
    </group>
  );
}

/** Label whose opacity is driven by a ref (no React re-render per frame). */
function LabelLive({ text, y, opacity, color }: { text: string; y: number; opacity: React.MutableRefObject<number>; color: string }) {
  const { texture, aspect } = useMemo(() => labelTexture(text, color), [text, color]);
  const mat = useMemo(() => new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }), [texture]);
  useEffect(
    () => () => {
      texture.dispose();
      mat.dispose();
    },
    [texture, mat],
  );
  useFrame(() => {
    mat.opacity = opacity.current;
  });
  return <sprite material={mat} position={[0, y, 0]} scale={[0.9 * aspect, 0.9, 1]} />;
}

/** An archived island leaves a dim marker at its slot; data still exists on the Mac. */
export function ArchiveMarker({ island, onSelect, selected }: { island: IslandView; onSelect: (e: ThreeEvent<MouseEvent>) => void; selected: boolean }) {
  return (
    <group position={[island.x, -1.5, island.z]} onClick={onSelect}>
      <mesh geometry={geo.box} material={surface('rock')} position={[0, 0.6, 0]} scale={[0.7, 1.6, 0.7]} />
      <mesh geometry={geo.octa} material={glow('#555b78')} position={[0, 1.7, 0]} scale={0.2} />
      <Label text={`${island.name} · archived`} y={2.6} color="#8a8fa8" />
      {selected && <mesh geometry={geo.torus} material={glow('#ffffff')} position={[0, 0.1, 0]} rotation={[Math.PI / 2, 0, 0]} scale={1.4} />}
    </group>
  );
}

/** Hermes Headquarters: the permanent administrator island. */
export function Headquarters(props: {
  island: IslandView;
  deliverables: number;
  projectTargets: Array<{ x: number; z: number }>;
  selected: boolean;
  voxelDetail: number;
  onSelect: (e: ThreeEvent<MouseEvent>) => void;
  children?: React.ReactNode;
}) {
  const voxels = useMemo(() => generateVoxels(props.island.seed, 7, 6, props.voxelDetail), [props.island.seed, props.voxelDetail]);
  const frame = useRef<TerrainFrame>({ assemble: 1, scatter: 0, animating: false });
  const archive = Math.min(props.deliverables, 12);
  const circuit = glow(PALETTES.circuit.accent);
  const bridgeMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#38e1ff', transparent: true, opacity: 0.28, depthWrite: false, toneMapped: false }), []);
  useEffect(() => () => bridgeMat.dispose(), [bridgeMat]);
  return (
    <group position={[props.island.x, 0, props.island.z]}>
      <group onClick={props.onSelect}>
        <Terrain voxels={voxels.top} material={surface('grass')} frame={frame} />
        <Terrain voxels={voxels.rock} material={surface('rock')} frame={frame} />
        {/* glowing circuit paths radiating from the tower */}
        {[0, 1, 2, 3, 4, 5].map((i) => {
          const a = (i / 6) * Math.PI * 2 + 0.3;
          return <mesh key={i} geometry={geo.box} material={circuit} position={[Math.cos(a) * 3, 0.53, Math.sin(a) * 3]} rotation={[0, -a, 0]} scale={[4.2, 0.04, 0.12]} />;
        })}
        {/* administrator tower */}
        <mesh geometry={geo.box} material={surface('circuit')} position={[0, 2.0, 0]} scale={[2, 3, 2]} />
        <mesh geometry={geo.box} material={surface('circuit')} position={[0, 4.4, 0]} scale={[1.4, 1.8, 1.4]} />
        <mesh geometry={geo.box} material={surface('aurum')} position={[0, 5.6, 0]} scale={[1.6, 0.25, 1.6]} />
        <mesh geometry={geo.octa} material={glow(PALETTES.aurum.glow)} position={[0, 6.5, 0]} scale={[0.5, 0.8, 0.5]} />
        {/* research station */}
        <group position={[-4.2, 0.5, -2]}>
          <mesh geometry={geo.sphere} material={surface('tide')} scale={[1.3, 1, 1.3]} />
          <mesh geometry={geo.cylinder} material={surface('rock')} position={[0.9, 1.1, 0]} scale={[0.05, 1.4, 0.05]} />
          <mesh geometry={geo.cone} material={glow(PALETTES.tide.glow)} position={[0.9, 1.9, 0]} rotation={[Math.PI, 0, 0]} scale={[0.6, 0.25, 0.6]} />
        </group>
        {/* worker spawning platform */}
        <group position={[3.8, 0.55, 2.4]}>
          <mesh geometry={geo.cylinder} material={surface('circuit')} scale={[1.4, 0.15, 1.4]} />
          <mesh geometry={geo.torus} material={circuit} position={[0, 0.1, 0]} rotation={[Math.PI / 2, 0, 0]} scale={1.3} />
        </group>
        {/* artifact archive: one slab per real deliverable (max 12 shown) */}
        <group position={[-3.6, 0.5, 3.2]}>
          <mesh geometry={geo.box} material={surface('rock')} scale={[2.4, 0.3, 1.2]} />
          {Array.from({ length: archive }, (_, i) => (
            <mesh key={i} geometry={geo.box} material={glow('#ffd76a')} position={[-1 + (i % 6) * 0.4, 0.45 + Math.floor(i / 6) * 0.5, 0]} scale={[0.22, 0.4, 0.08]} />
          ))}
        </group>
        {/* portals reserved for project bridges */}
        {[0.9, 2.6, 4.4].map((a, i) => (
          <mesh key={i} geometry={geo.torus} material={circuit} position={[Math.cos(a) * 6.2, 1.6, Math.sin(a) * 6.2]} rotation={[0, -a + Math.PI / 2, 0]} scale={1.3} />
        ))}
        <Label text={props.island.name} y={8} color="#ffd76a" />
      </group>
      {/* light bridges to active project islands */}
      {props.projectTargets.map((t, i) => {
        const len = Math.hypot(t.x - props.island.x, t.z - props.island.z);
        const ang = Math.atan2(t.z - props.island.z, t.x - props.island.x);
        return (
          <mesh key={i} geometry={geo.box} material={bridgeMat} position={[(t.x - props.island.x) / 2, 0.4, (t.z - props.island.z) / 2]} rotation={[0, -ang, 0]} scale={[Math.max(0, len - 11), 0.05, 0.35]} />
        );
      })}
      {props.children}
      {props.selected && <mesh geometry={geo.torus} material={glow('#ffffff')} position={[0, 0.6, 0]} rotation={[Math.PI / 2, 0, 0]} scale={8} />}
    </group>
  );
}
