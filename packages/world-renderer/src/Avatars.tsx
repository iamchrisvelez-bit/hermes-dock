import { useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { AgentCapabilities, AgentRole } from '@hdw/contracts';
import type { HermesPose, WorkerAnimation } from '@hdw/world-projection';
import { PALETTES, geo, glow, surface, type PaletteName } from './shared.ts';

const POSE_COLOR: Record<HermesPose, string> = {
  idle: '#ffd76a',
  planning: '#38e1ff',
  reviewing: '#5dffb0',
  blocked: '#ffb547',
  alert: '#ff5a6a',
};

/**
 * Hermes, the administrator: an original floating figure with a robed body, a visor head,
 * segmented digital wing fins and a floating command orb. Each pose has a distinct read:
 * idle hover, planning (orb projects a rotating ring), reviewing (scanning sweep),
 * blocked (wings folded, amber), alert (wings flared, red, slow pulse <= 1 Hz).
 */
export function HermesAvatar(props: {
  pose: HermesPose;
  reducedMotion: boolean;
  selected: boolean;
  position: [number, number, number];
  onSelect: (e: ThreeEvent<MouseEvent>) => void;
}) {
  const root = useRef<THREE.Group>(null);
  const wingL = useRef<THREE.Group>(null);
  const wingR = useRef<THREE.Group>(null);
  const orb = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  const scan = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Mesh>(null);
  const ringMat = useMemo(() => new THREE.MeshBasicMaterial({ color: POSE_COLOR.idle, transparent: true, opacity: 0.9, toneMapped: false }), []);
  const scanMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#5dffb0', transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }), []);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const pose = props.pose;
    const rm = props.reducedMotion;
    if (root.current) root.current.position.y = props.position[1] + (rm ? 0 : Math.sin(t * 1.2) * 0.12);
    const fold = pose === 'blocked' ? 0.15 : pose === 'alert' ? 1.25 : 0.75;
    const flap = rm || pose === 'blocked' ? 0 : Math.sin(t * 1.6) * 0.08;
    if (wingL.current) wingL.current.rotation.y = fold + flap;
    if (wingR.current) wingR.current.rotation.y = -(fold + flap);
    if (orb.current) {
      const r = pose === 'planning' ? 0.9 : 0.7;
      const a = rm ? 0.6 : t * (pose === 'planning' ? 1.4 : 0.7);
      orb.current.position.set(Math.cos(a) * r, 1.3 + Math.sin(a * 2) * 0.05, Math.sin(a) * r);
      orb.current.rotation.y = t;
    }
    const color = POSE_COLOR[pose];
    ringMat.color.set(color);
    // Alert pulses slowly (1 Hz, never a hard flash); reduced motion holds it steady.
    ringMat.opacity = pose === 'alert' && !rm ? 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2)) : 0.9;
    if (ring.current) {
      ring.current.visible = pose === 'planning' || pose === 'alert' || pose === 'blocked';
      ring.current.rotation.z = rm ? 0 : t * 0.8;
      ring.current.scale.setScalar(pose === 'planning' ? 1.1 : 0.85);
    }
    if (scan.current) {
      scan.current.visible = pose === 'reviewing';
      scan.current.rotation.y = rm ? 0 : t * 1.5;
    }
    if (halo.current) halo.current.rotation.z = rm ? 0 : t * 0.3;
  });

  const robe = surface('aurum');
  const trim = glow(PALETTES.aurum.glow);
  const visor = glow('#38e1ff');
  return (
    <group ref={root} position={props.position} onClick={props.onSelect}>
      {/* robe + torso */}
      <mesh geometry={geo.cone} material={robe} position={[0, 0.55, 0]} scale={[0.55, 1.1, 0.55]} />
      <mesh geometry={geo.box} material={robe} position={[0, 1.15, 0]} scale={[0.5, 0.35, 0.34]} />
      {/* head with visor */}
      <mesh geometry={geo.box} material={surface('rock')} position={[0, 1.55, 0]} scale={[0.34, 0.34, 0.34]} />
      <mesh geometry={geo.box} material={visor} position={[0, 1.57, 0.175]} scale={[0.26, 0.07, 0.02]} />
      {/* crest */}
      <mesh geometry={geo.octa} material={trim} position={[0, 1.85, 0]} scale={[0.07, 0.14, 0.07]} />
      {/* halo */}
      <mesh ref={halo} geometry={geo.torus} material={trim} position={[0, 1.95, -0.1]} rotation={[Math.PI / 2.4, 0, 0]} scale={0.28} />
      {/* digital wing fins: three stepped feathers per side */}
      {[wingL, wingR].map((ref, side) => (
        <group key={side} ref={ref} position={[side === 0 ? -0.2 : 0.2, 1.25, -0.2]}>
          {[0, 1, 2].map((i) => (
            <mesh
              key={i}
              geometry={geo.box}
              material={i === 0 ? trim : robe}
              position={[(side === 0 ? -1 : 1) * (0.32 + i * 0.22), 0.12 - i * 0.12, -0.05]}
              scale={[0.42 - i * 0.06, 0.07, 0.16]}
              rotation={[0, 0, (side === 0 ? 1 : -1) * (0.35 - i * 0.12)]}
            />
          ))}
        </group>
      ))}
      {/* command orb */}
      <mesh ref={orb} geometry={geo.icosa} material={visor} scale={0.13} />
      {/* planning / alert ring */}
      <mesh ref={ring} geometry={geo.torus} material={ringMat} position={[0, 0.05, 0]} rotation={[Math.PI / 2, 0, 0]} scale={1.1} />
      {/* reviewing scan wedge */}
      <mesh ref={scan} geometry={geo.cone} material={scanMat} position={[0, 0.8, 0.9]} rotation={[Math.PI / 2, 0, 0]} scale={[0.5, 1.6, 0.2]} />
      {props.selected && <SelectionMarker />}
    </group>
  );
}

function SelectionMarker() {
  return <mesh geometry={geo.torus} material={glow('#ffffff')} position={[0, 0.03, 0]} rotation={[Math.PI / 2, 0, 0]} scale={0.7} />;
}

const STATUS_COLOR: Partial<Record<WorkerAnimation, string>> = {
  work: '#38e1ff',
  review: '#5dffb0',
  blocked: '#ffb547',
  error: '#ff5a6a',
  walk_to_task: '#c9f3ff',
};

/**
 * Worker identity: silhouette, palette, emblem and prop differ by role. Props appear only
 * when the backend grants the matching capability (hammer = writes deliverables,
 * scanner = browses web); motion plays only for real backend states.
 */
export function WorkerAvatar(props: {
  role: AgentRole;
  palette: PaletteName;
  animation: WorkerAnimation;
  capabilities: AgentCapabilities;
  position: [number, number, number];
  approach: [number, number, number];
  reducedMotion: boolean;
  selected: boolean;
  /** 0..1 arrival scale, read per frame (island creation "agents arrive" stage). */
  appear?: React.MutableRefObject<number>;
  onSelect: (e: ThreeEvent<MouseEvent>) => void;
}) {
  const root = useRef<THREE.Group>(null);
  const prop = useRef<THREE.Group>(null);
  const status = useRef<THREE.Mesh>(null);
  const since = useRef<{ anim: WorkerAnimation; t0: number }>({ anim: props.animation, t0: -1 });
  const body = surface(props.palette);
  const emblem = glow(PALETTES[props.palette].glow);
  const statusColor = STATUS_COLOR[props.animation];

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (since.current.anim !== props.animation || since.current.t0 < 0) since.current = { anim: props.animation, t0: t };
    const local = t - since.current.t0;
    const g = root.current;
    if (!g) return;
    const rm = props.reducedMotion;
    // Walk from the island edge to the workpad once, on assignment.
    if (props.animation === 'walk_to_task' && !rm) {
      const k = Math.min(1, local / 1.8);
      g.position.set(
        props.approach[0] + (props.position[0] - props.approach[0]) * k,
        props.position[1] + Math.abs(Math.sin(local * 8)) * 0.06 * (1 - k),
        props.approach[2] + (props.position[2] - props.approach[2]) * k,
      );
    } else if (props.animation === 'depart') {
      const k = Math.min(1, local / 1.5);
      g.position.set(props.position[0], props.position[1] - k * 1.2, props.position[2]);
    } else {
      g.position.set(props.position[0], props.position[1], props.position[2]);
    }
    g.scale.setScalar(Math.max(0.001, props.appear ? props.appear.current : 1));
    if (prop.current) {
      if (props.animation === 'work' && !rm) prop.current.rotation.x = -0.4 + Math.abs(Math.sin(t * 4)) * 1.1;
      else if (props.animation === 'review' && !rm) prop.current.rotation.y = t * 2;
      else prop.current.rotation.set(0, 0, 0);
    }
    if (status.current) {
      status.current.visible = !!statusColor;
      status.current.rotation.y = rm ? 0 : t * 2;
    }
  });

  return (
    <group ref={root} position={props.position} onClick={props.onSelect}>
      <RoleBody role={props.role} body={body} emblem={emblem} />
      <group ref={prop} position={[0.32, 0.55, 0.1]}>
        <RoleProp role={props.role} capabilities={props.capabilities} palette={props.palette} />
      </group>
      <mesh ref={status} geometry={geo.octa} material={glow(statusColor ?? '#ffffff')} position={[0, 1.45, 0]} scale={0.1} />
      {props.selected && <SelectionMarker />}
    </group>
  );
}

function RoleBody({ role, body, emblem }: { role: AgentRole; body: THREE.Material; emblem: THREE.Material }) {
  switch (role) {
    case 'builder': // stocky, square
      return (
        <>
          <mesh geometry={geo.box} material={body} position={[0, 0.42, 0]} scale={[0.56, 0.62, 0.44]} />
          <mesh geometry={geo.box} material={body} position={[0, 0.95, 0]} scale={[0.4, 0.34, 0.36]} />
          <mesh geometry={geo.cylinder} material={emblem} position={[0, 0.5, 0.23]} rotation={[Math.PI / 2, 0, 0]} scale={[0.1, 0.02, 0.1]} />
          <mesh geometry={geo.box} material={surface('rock')} position={[0, 1.15, 0]} scale={[0.46, 0.06, 0.42]} />
        </>
      );
    case 'researcher': // tall, slim, antenna
      return (
        <>
          <mesh geometry={geo.cylinder} material={body} position={[0, 0.55, 0]} scale={[0.18, 1.1, 0.18]} />
          <mesh geometry={geo.sphere} material={body} position={[0, 1.22, 0]} scale={0.2} />
          <mesh geometry={geo.cylinder} material={emblem} position={[0, 1.5, 0]} scale={[0.015, 0.36, 0.015]} />
          <mesh geometry={geo.sphere} material={emblem} position={[0, 1.7, 0]} scale={0.05} />
        </>
      );
    case 'reviewer': // round, with gauge face
      return (
        <>
          <mesh geometry={geo.sphere} material={body} position={[0, 0.5, 0]} scale={[0.38, 0.42, 0.38]} />
          <mesh geometry={geo.cylinder} material={emblem} position={[0, 0.55, 0.36]} rotation={[Math.PI / 2, 0, 0]} scale={[0.17, 0.02, 0.17]} />
          <mesh geometry={geo.sphere} material={body} position={[0, 1.02, 0]} scale={0.18} />
        </>
      );
    case 'designer': // tapered with a prism head
      return (
        <>
          <mesh geometry={geo.cone} material={body} position={[0, 0.45, 0]} scale={[0.32, 0.9, 0.32]} />
          <mesh geometry={geo.octa} material={emblem} position={[0, 1.08, 0]} scale={[0.2, 0.26, 0.2]} />
        </>
      );
    default:
      return <mesh geometry={geo.box} material={body} position={[0, 0.5, 0]} scale={0.5} />;
  }
}

function RoleProp({ role, capabilities, palette }: { role: AgentRole; capabilities: AgentCapabilities; palette: PaletteName }) {
  const accent = glow(PALETTES[palette].glow);
  const metal = surface('rock');
  if (role === 'builder' && capabilities.writeDeliverables) {
    return (
      <>
        <mesh geometry={geo.cylinder} material={metal} position={[0, 0.18, 0]} scale={[0.03, 0.4, 0.03]} />
        <mesh geometry={geo.box} material={accent} position={[0, 0.4, 0]} scale={[0.2, 0.1, 0.1]} />
      </>
    );
  }
  if (role === 'researcher' && capabilities.browseWeb) {
    return <mesh geometry={geo.torus} material={accent} position={[0, 0.2, 0]} scale={0.14} />;
  }
  if (role === 'reviewer' && capabilities.readProjectInputs) {
    return <mesh geometry={geo.box} material={accent} position={[0, 0.15, 0]} scale={[0.04, 0.22, 0.04]} />;
  }
  if (role === 'designer' && capabilities.writeDeliverables) {
    return <mesh geometry={geo.cylinder} material={accent} position={[0, 0.15, 0]} rotation={[0, 0, 0.5]} scale={[0.025, 0.36, 0.025]} />;
  }
  return null;
}
