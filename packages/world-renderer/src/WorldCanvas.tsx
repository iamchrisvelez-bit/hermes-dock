import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { HermesAvatar, WorkerAvatar } from './Avatars.tsx';
import { QUALITY, isDone, nextDpr, type Lifecycle, type QualityLevel } from './effects.ts';
import { ArchiveMarker, Headquarters, ProjectIsland } from './Islands.tsx';
import type { AgentView, IslandView, WorldViewModel } from './model.ts';
import { disposeShared, geo, rng } from './shared.ts';

export type Selection = { kind: 'island' | 'agent'; id: string } | null;

export interface RenderStats {
  fps: number;
  frameMs: number;
  dpr: number;
  drawCalls: number;
  triangles: number;
  continuous: boolean;
}

export interface WorldCanvasProps {
  model: WorldViewModel;
  lifecycles: Record<string, Lifecycle>;
  onLifecycleDone: (islandId: string) => void;
  selection: Selection;
  onSelect: (s: Selection) => void;
  quality: QualityLevel;
  reducedMotion: boolean;
  /** Called ~2x/second with measured render stats (never every frame). */
  onStats?: (s: RenderStats) => void;
}

export function WorldCanvas(props: WorldCanvasProps) {
  const q = QUALITY[props.quality];
  useEffect(() => () => disposeShared(), []);
  return (
    <Canvas
      frameloop="demand"
      dpr={Math.min(q.maxDpr, typeof window !== 'undefined' ? window.devicePixelRatio : 1)}
      gl={{ antialias: q.antialias, powerPreference: 'default', alpha: false }}
      camera={{ position: [0, 26, 34], fov: 45, near: 0.5, far: 400 }}
      onPointerMissed={() => props.onSelect(null)}
      style={{ touchAction: 'none' }}
    >
      <Scene {...props} />
    </Canvas>
  );
}

function Scene(props: WorldCanvasProps) {
  const { model, lifecycles, reducedMotion } = props;
  const q = QUALITY[props.quality];
  const animating = Object.keys(lifecycles).length > 0;
  // While disconnected nothing real is happening: render on demand only (saves battery).
  const continuous = animating || (model.connected && (model.busy || model.hermes.pose !== 'idle'));

  const hq = model.islands.find((i) => i.kind === 'headquarters');
  const projectIslands = model.islands.filter((i) => i.kind === 'project');
  const select = (kind: 'island' | 'agent', id: string) => (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    props.onSelect({ kind, id });
  };
  const agentsOn = (islandId: string) => model.agents.filter((a) => a.islandId === islandId);
  const targets = projectIslands.filter((i) => i.state === 'active' || i.state === 'materializing').map((i) => ({ x: i.x, z: i.z }));
  const focus = props.selection?.kind === 'island' ? model.islands.find((i) => i.id === props.selection!.id) : undefined;

  return (
    <>
      <color attach="background" args={['#070b1a']} />
      <fog attach="fog" args={['#0b1430', 60, 220]} />
      <hemisphereLight args={['#9fd8ff', '#1a1030', 0.9]} />
      <directionalLight position={[20, 40, 10]} intensity={1.6} color="#fff1d6" />
      <Sky />
      <Controls focus={focus ? [focus.x, 0, focus.z] : null} frame={model.islands.filter((i) => i.state !== 'destroyed').map((i) => ({ x: i.x, z: i.z, r: i.kind === 'headquarters' ? 8 : 5 }))} />
      <Driver continuous={continuous} quality={props.quality} onStats={props.onStats} />
      <LifecycleSweeper lifecycles={lifecycles} reducedMotion={reducedMotion} onDone={props.onLifecycleDone} />

      {hq && (
        <Headquarters
          island={hq}
          deliverables={model.totalDeliverables}
          projectTargets={targets}
          selected={props.selection?.id === hq.id}
          voxelDetail={q.voxelDetail}
          onSelect={select('island', hq.id)}
        >
          {model.hermes.id && (
            <HermesAvatar
              pose={model.hermes.pose}
              reducedMotion={reducedMotion}
              selected={props.selection?.id === model.hermes.id}
              position={[0, 0.55, 2.4]}
              onSelect={select('agent', model.hermes.id)}
            />
          )}
          {agentsOn(hq.id).map((a, i) => (
            <Worker key={a.id} agent={a} base={[-2.6 + i * 1.2, 0.55, -0.4]} props={props} onSelect={select('agent', a.id)} />
          ))}
        </Headquarters>
      )}

      {projectIslands.map((island) => {
        const lc = lifecycles[island.id] ?? null;
        if (island.state === 'destroyed' && !lc) return null;
        if (island.state === 'archived' && !lc) {
          return <ArchiveMarker key={island.id} island={island} selected={props.selection?.id === island.id} onSelect={select('island', island.id)} />;
        }
        return (
          <ProjectIsland
            key={island.id}
            island={island}
            lifecycle={lc}
            reducedMotion={reducedMotion}
            particleBudget={q.particles}
            voxelDetail={q.voxelDetail}
            selected={props.selection?.id === island.id}
            onSelect={select('island', island.id)}
            onLifecycleDone={props.onLifecycleDone}
          >
            {(appear) =>
              agentsOn(island.id).map((a, i) => (
                <Worker key={a.id} agent={a} base={[0.6 + i * 0.9, 0.55, 0.9]} props={props} appear={appear} onSelect={select('agent', a.id)} />
              ))
            }
          </ProjectIsland>
        );
      })}
    </>
  );
}

function Worker({
  agent,
  base,
  props,
  appear,
  onSelect,
}: {
  agent: AgentView;
  base: [number, number, number];
  props: WorldCanvasProps;
  appear?: React.MutableRefObject<number>;
  onSelect: (e: ThreeEvent<MouseEvent>) => void;
}) {
  return (
    <WorkerAvatar
      role={agent.role}
      palette={agent.palette}
      animation={agent.animation}
      capabilities={agent.capabilities}
      position={base}
      approach={[base[0] + 3, base[1], base[2] + 2.5]}
      reducedMotion={props.reducedMotion}
      selected={props.selection?.id === agent.id}
      appear={appear}
      onSelect={onSelect}
    />
  );
}

/** Ends lifecycles whose animation time has passed even if their island unmounted. */
function LifecycleSweeper({ lifecycles, reducedMotion, onDone }: { lifecycles: Record<string, Lifecycle>; reducedMotion: boolean; onDone: (id: string) => void }) {
  useFrame(() => {
    const now = performance.now();
    for (const [id, l] of Object.entries(lifecycles)) if (isDone(l, now - 2000, reducedMotion)) onDone(id);
  });
  return null;
}

/**
 * Render scheduling: on-demand by default (a static world draws nothing), continuous only
 * while something real is animating. Pauses entirely when the page is hidden. Also adapts
 * the pixel ratio from measured frame times and reports stats for the perf HUD.
 */
function Driver({ continuous, quality, onStats }: { continuous: boolean; quality: QualityLevel; onStats?: (s: RenderStats) => void }) {
  const { invalidate, gl, setDpr, viewport } = useThree();
  const targetFps = quality === 'low' ? 30 : 60;
  const acc = useRef({ frames: 0, time: 0, windowStart: performance.now(), dpr: viewport.dpr });
  useEffect(() => {
    if (!continuous) {
      invalidate();
      // No frames render while idle, so report the on-demand state explicitly.
      const id = setTimeout(() => onStats?.({ fps: 0, frameMs: 0, dpr: acc.current.dpr, drawCalls: gl.info.render.calls, triangles: gl.info.render.triangles, continuous: false }), 600);
      return () => clearTimeout(id);
    }
    let raf = 0;
    let last = 0;
    const minGap = 1000 / targetFps - 2;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden) return;
      if (t - last >= minGap) {
        last = t;
        invalidate();
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [continuous, invalidate, targetFps, gl, onStats]);

  useEffect(() => {
    const onVis = () => {
      if (!document.hidden) invalidate();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [invalidate]);

  useFrame((_, delta) => {
    const a = acc.current;
    if (delta < 0.5) {
      a.frames += 1;
      a.time += delta * 1000;
    }
    const now = performance.now();
    if (now - a.windowStart >= 500) {
      const frameMs = a.frames > 0 ? a.time / a.frames : 0;
      const fps = a.frames > 0 ? (a.frames * 1000) / (now - a.windowStart) : 0;
      if (continuous && a.frames >= 10) {
        const next = nextDpr(a.dpr, frameMs, quality, targetFps);
        if (next !== a.dpr) {
          a.dpr = next;
          setDpr(next);
        }
      }
      onStats?.({ fps: Math.round(fps), frameMs: Math.round(frameMs * 10) / 10, dpr: a.dpr, drawCalls: gl.info.render.calls, triangles: gl.info.render.triangles, continuous });
      a.frames = 0;
      a.time = 0;
      a.windowStart = now;
    }
  });
  return null;
}

/**
 * Touch/mouse orbit + pinch zoom. Renders only when the camera actually moves.
 * Until the owner moves the camera, it auto-frames every live island so a newly created
 * island is visible even on a narrow portrait phone.
 */
function Controls({ focus, frame }: { focus: [number, number, number] | null; frame: Array<{ x: number; z: number; r: number }> }) {
  const { camera, gl, invalidate, size } = useThree();
  const ctrl = useMemo(() => new OrbitControls(camera, gl.domElement), [camera, gl]);
  const goal = useRef(new THREE.Vector3());
  const camGoal = useRef<THREE.Vector3 | null>(null);
  const userMoved = useRef(false);
  useEffect(() => {
    ctrl.enableDamping = false;
    ctrl.maxPolarAngle = Math.PI * 0.46;
    ctrl.minDistance = 10;
    ctrl.maxDistance = 160;
    ctrl.enablePan = true;
    ctrl.screenSpacePanning = false;
    const onChange = () => invalidate();
    const onStart = () => {
      userMoved.current = true;
      camGoal.current = null;
    };
    ctrl.addEventListener('change', onChange);
    ctrl.addEventListener('start', onStart);
    return () => {
      ctrl.removeEventListener('change', onChange);
      ctrl.removeEventListener('start', onStart);
      ctrl.dispose();
    };
  }, [ctrl, invalidate]);

  const frameKey = frame.map((f) => `${f.x},${f.z}`).join('|');
  useEffect(() => {
    if (focus) {
      goal.current.set(...focus);
    } else if (!userMoved.current && frame.length > 0) {
      // Fit the bounding circle of all islands into the narrower view dimension.
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const f of frame) {
        minX = Math.min(minX, f.x - f.r); maxX = Math.max(maxX, f.x + f.r);
        minZ = Math.min(minZ, f.z - f.r); maxZ = Math.max(maxZ, f.z + f.r);
      }
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;
      const radius = Math.max(maxX - minX, maxZ - minZ) / 2 + 2;
      const cam = camera as THREE.PerspectiveCamera;
      const vfov = (cam.fov * Math.PI) / 180;
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * (size.width / Math.max(1, size.height)));
      const dist = Math.min(150, Math.max(30, radius / Math.sin(Math.min(vfov, hfov) / 2)));
      goal.current.set(cx, 0, cz);
      const dir = new THREE.Vector3(0, 0.6, 0.8).normalize();
      camGoal.current = new THREE.Vector3(cx, 0, cz).addScaledVector(dir, dist);
    }
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.[0], focus?.[2], frameKey, size.width, size.height, invalidate]);

  useFrame((_, delta) => {
    const k = 1 - Math.exp(-Math.min(delta, 0.1) * 5);
    let moving = false;
    if (goal.current.distanceTo(ctrl.target) > 0.01) {
      ctrl.target.lerp(goal.current, k);
      moving = true;
    }
    if (camGoal.current) {
      if (camera.position.distanceTo(camGoal.current) > 0.05) {
        camera.position.lerp(camGoal.current, k);
        moving = true;
      } else camGoal.current = null;
    }
    if (moving) {
      ctrl.update();
      invalidate();
    }
  });
  return null;
}

/** Atmospheric digital sky: gradient dome, bounded starfield, distant silhouettes, data sea. */
function Sky() {
  const dome = useMemo(
    () =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: { top: { value: new THREE.Color('#050816') }, mid: { value: new THREE.Color('#1b1450') }, horizon: { value: new THREE.Color('#13406b') } },
        vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader:
          'uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; varying vec3 vP; void main(){ float h = vP.y; vec3 c = h > 0.25 ? mix(mid, top, smoothstep(0.25, 0.9, h)) : mix(horizon, mid, smoothstep(-0.05, 0.25, h)); gl_FragColor = vec4(c, 1.0); }',
      }),
    [],
  );
  const stars = useMemo(() => {
    const r = rng(42);
    const n = 350;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const th = r() * Math.PI * 2;
      const ph = Math.acos(0.15 + r() * 0.85);
      pos[i * 3] = Math.sin(ph) * Math.cos(th) * 300;
      pos[i * 3 + 1] = Math.cos(ph) * 300;
      pos[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * 300;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return g;
  }, []);
  const starMat = useMemo(() => new THREE.PointsMaterial({ color: '#cfe8ff', size: 1.4, sizeAttenuation: false, fog: false }), []);
  const silhouettes = useMemo(() => {
    const r = rng(7);
    return Array.from({ length: 18 }, (_, i) => {
      const a = (i / 18) * Math.PI * 2 + r() * 0.2;
      return { x: Math.cos(a) * 170, z: Math.sin(a) * 170, h: 12 + r() * 30, w: 6 + r() * 10 };
    });
  }, []);
  const silMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#0c1530' }), []);
  const grid = useMemo(() => {
    const g = new THREE.GridHelper(400, 80, '#1f5fa0', '#123a66');
    (g.material as THREE.Material).transparent = true;
    (g.material as THREE.Material).opacity = 0.35;
    return g;
  }, []);
  useEffect(
    () => () => {
      dome.dispose();
      stars.dispose();
      starMat.dispose();
      silMat.dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
    },
    [dome, stars, starMat, silMat, grid],
  );
  return (
    <>
      <mesh material={dome} geometry={geo.sphere} scale={320} />
      <points geometry={stars} material={starMat} />
      {silhouettes.map((s, i) => (
        <mesh key={i} geometry={geo.cone} material={silMat} position={[s.x, -18 + s.h / 2, s.z]} scale={[s.w, s.h, s.w]} />
      ))}
      <primitive object={grid} position={[0, -22, 0]} />
    </>
  );
}

export type { IslandView };
