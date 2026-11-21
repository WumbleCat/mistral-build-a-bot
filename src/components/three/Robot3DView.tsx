import { Component, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bounds, ContactShadows, Html, OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { Vector3 } from 'three';
import type { Group, Mesh } from 'three';
import type { AssemblyStep, Part } from '../../types';
import { allInstances3d, type Instance3D } from './layout3d';
import { COLORS, Outline, PartMesh } from './partMeshes';

export interface Robot3DViewProps {
  parts: Part[];
  steps: AssemblyStep[];
  currentStepIndex: number;
  installedIds: string[];
  activeIds: string[];
  onSelect?: (partId: string) => void;
  /** Called when WebGL/canvas fails so the parent can fall back to the 2D drawing. */
  onFallback?: () => void;
}

type Status = 'active' | 'installed' | 'pending';

const GHOST_LIFT = 1.4;

/** Shared fx state: camera nudge impulse on part land. */
interface Fx {
  nudge: number;
}

/** Small orange pixel-particle burst (12-16 cubes, 0.6 s). */
function Burst({ origin, onDone }: { origin: [number, number, number]; onDone: () => void }) {
  const groupRef = useRef<Group>(null);
  const born = useRef(performance.now());
  const seeds = useMemo(() => {
    const v: Vector3[] = [];
    for (let i = 0; i < 14; i++) {
      v.push(
        new Vector3(
          (Math.random() - 0.5) * 3.2,
          Math.random() * 3.0 + 0.8,
          (Math.random() - 0.5) * 3.2,
        ),
      );
    }
    return v;
  }, []);

  useFrame(() => {
    const g = groupRef.current;
    if (!g) return;
    const t = (performance.now() - born.current) / 600; // 0..1 over 0.6s
    if (t >= 1) {
      onDone();
      return;
    }
    g.children.forEach((c, i) => {
      const m = c as Mesh;
      const v = seeds[i];
      m.position.set(origin[0] + v.x * t, origin[1] + v.y * t - 2.2 * t * t, origin[2] + v.z * t);
      const s = 1 - t;
      m.scale.setScalar(Math.max(0.05, s));
      (m.material as { opacity?: number }).opacity = 1 - t;
    });
  });

  return (
    <group ref={groupRef}>
      {seeds.map((_, i) => (
        <mesh key={i}>
          <boxGeometry args={[0.07, 0.07, 0.07]} />
          <meshBasicMaterial color={i % 3 === 0 ? COLORS.flame : i % 3 === 1 ? COLORS.orange : COLORS.amber} transparent />
        </mesh>
      ))}
    </group>
  );
}

/** Decays the nudge impulse and nudges the orthographic zoom slightly. */
function CameraRig({ fx, baseZoom }: { fx: React.MutableRefObject<Fx>; baseZoom: number }) {
  const { camera } = useThree();
  useFrame((_, dt) => {
    if (fx.current.nudge <= 0) return;
    fx.current.nudge = Math.max(0, fx.current.nudge - dt * 2.2);
    const z = baseZoom * (1 + fx.current.nudge * 0.07);
    if (Math.abs(camera.zoom - z) > 0.001) {
      camera.zoom = z;
      camera.updateProjectionMatrix();
    }
  });
  return null;
}

function AnimatedPart({
  inst,
  status,
  explode,
  selected,
  fx,
  onBurst,
  onSelect,
}: {
  inst: Instance3D;
  status: Status;
  explode: number;
  selected: boolean;
  fx: React.MutableRefObject<Fx>;
  onBurst: (pos: [number, number, number], partId: string) => void;
  onSelect?: (partId: string) => void;
}) {
  const ref = useRef<Group>(null);
  const prevStatus = useRef<Status>(status);
  const [hover, setHover] = useState(false);
  const label = useMemo(() => {
    const qty = inst.part.quantity > 1 ? ` ×${inst.part.quantity}` : '';
    const price = inst.part.unit_price != null ? ` · £${inst.part.unit_price.toFixed(2)}` : '';
    return `${inst.part.name}${qty}${price}`;
  }, [inst.part]);

  useFrame((state, delta) => {
    const g = ref.current;
    if (!g) return;
    const [x, y, z] = inst.slot.pos;
    const [nx, ny, nz] = inst.normal;
    const lift = status === 'pending' ? GHOST_LIFT + Math.sin(state.clock.elapsedTime * 1.6 + inst.index) * 0.08 : 0;
    const target = [
      x + nx * explode * 1.6,
      y + lift + ny * explode * 1.6,
      z + nz * explode * 1.6,
    ] as [number, number, number];
    // ease ~0.8 s
    const k = 1 - Math.exp(-delta * 5);
    g.position.x += (target[0] - g.position.x) * k;
    g.position.y += (target[1] - g.position.y) * k;
    g.position.z += (target[2] - g.position.z) * k;
    if (inst.slot.rot) g.rotation.set(...inst.slot.rot);
    // subtle pulse on the active part
    const pulse = status === 'active' ? 1 + Math.sin(state.clock.elapsedTime * 4) * 0.035 : 1;
    g.scale.setScalar(pulse);
    // land detection: pending -> active/installed
    if (prevStatus.current === 'pending' && status !== 'pending') {
      onBurst([x, y + 0.2, z], inst.part.id);
      fx.current.nudge = 1;
    }
    prevStatus.current = status;
  });

  // enable shadows on all child meshes once mounted
  useEffect(() => {
    const g = ref.current;
    if (!g) return;
    g.traverse((o) => {
      if ((o as Mesh).isMesh) {
        (o as Mesh).castShadow = true;
        (o as Mesh).receiveShadow = true;
      }
    });
  }, []);

  const strong = status === 'active' || hover || selected;

  return (
    <group
      ref={ref}
      position={inst.slot.pos}
      onPointerOver={(e) => { e.stopPropagation(); setHover(true); }}
      onPointerOut={() => setHover(false)}
      onClick={(e) => { e.stopPropagation(); onSelect?.(inst.part.id); }}
    >
      <PartMesh kind={inst.kind} status={status} />
      {status !== 'pending' && <Outline strong={strong} />}
      {status === 'active' && (
        <Html position={[0, 0.55, 0]} center className="part3d-label" wrapperClass="part3d-label-wrap">
          <span className="part3d-label-text">{label}</span>
        </Html>
      )}
    </group>
  );
}

function Scene({ parts, installedIds, activeIds, explode, selectedId, fx, onSelect }: {
  parts: Part[];
  installedIds: string[];
  activeIds: string[];
  explode: number;
  selectedId: string | null;
  fx: React.MutableRefObject<Fx>;
  onSelect?: (partId: string) => void;
}) {
  const instances = useMemo(() => allInstances3d(parts), [parts]);
  const installed = useMemo(() => new Set(installedIds), [installedIds]);
  const active = useMemo(() => new Set(activeIds), [activeIds]);
  const [bursts, setBursts] = useState<Array<{ id: string; pos: [number, number, number] }>>([]);
  const burstSeq = useRef(0);
  const wireInst = useMemo(() => instances.filter((i) => i.kind === 'wire'), [instances]);

  const handleBurst = (pos: [number, number, number], partId: string) => {
    burstSeq.current += 1;
    const id = `b${burstSeq.current}`;
    setBursts((b) => [...b.slice(-7), { id, pos }]);
    window.dispatchEvent(new CustomEvent('bfv:land', { detail: { partId } }));
  };

  return (
    <>
      <color attach="background" args={['#0E1016']} />
      <fog attach="fog" args={['#0E1016', 14, 30]} />
      {/* cool fill + key + amber rim from behind */}
      <hemisphereLight args={['#3A4152', '#0E1016', 0.85]} />
      <directionalLight position={[5, 8, 4]} intensity={1.1} castShadow />
      <directionalLight position={[-6, 4, -7]} intensity={1.5} color={COLORS.amber} />
      <gridHelper
        args={[22, 44, '#262C38', '#262C38']}
        position={[0, 0, 0]}
        material-transparent
        material-opacity={0.9}
        material-depthWrite={false}
      />
      <ContactShadows position={[0, 0.002, 0]} opacity={0.5} scale={12} blur={2.4} far={5} resolution={256} color="#000000" />
      <Bounds fit clip margin={1.3}>
        <group>
          {instances.filter((i) => i.kind !== 'wire').map((inst) => {
            const status: Status = active.has(inst.part.id) ? 'active' : installed.has(inst.part.id) ? 'installed' : 'pending';
            return (
              <AnimatedPart
                key={`${inst.part.id}-${inst.index}`}
                inst={inst}
                status={status}
                explode={explode}
                selected={selectedId === inst.part.id}
                fx={fx}
                onBurst={handleBurst}
                onSelect={onSelect}
              />
            );
          })}
          {wireInst.length > 0 && (
            <AnimatedPart
              key={`${wireInst[0].part.id}-wire`}
              inst={{ ...wireInst[0], slot: { pos: [0, 0.1, 0] } }}
              status={active.has(wireInst[0].part.id) ? 'active' : installed.has(wireInst[0].part.id) ? 'installed' : 'pending'}
              explode={explode * 0.4}
              selected={selectedId === wireInst[0].part.id}
              fx={fx}
              onBurst={handleBurst}
              onSelect={onSelect}
            />
          )}
          {bursts.map((b) => (
            <Burst key={b.id} origin={b.pos} onDone={() => setBursts((arr) => arr.filter((x) => x.id !== b.id))} />
          ))}
        </group>
      </Bounds>
    </>
  );
}

class CanvasErrorBoundary extends Component<{ onFallback?: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onFallback?.(); }
  render() { return this.state.failed ? null : this.props.children; }
}

const BASE_ZOOM = 55;

export function Robot3DView(props: Robot3DViewProps) {
  const { parts, installedIds, activeIds, onSelect, onFallback } = props;
  const [explode, setExplode] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const fx = useRef<Fx>({ nudge: 0 });

  // keyboard shortcuts from the app: E toggles explode, R resets the camera
  useEffect(() => {
    const onKey = (e: Event) => {
      const name = (e as CustomEvent).detail?.name;
      if (name === 'explode') setExplode((v) => (v > 0.5 ? 0 : 1));
      if (name === 'resetCam') controlsRef.current?.reset();
    };
    window.addEventListener('bfv:key', onKey);
    return () => window.removeEventListener('bfv:key', onKey);
  }, []);

  return (
    <div className="robot3d-wrap">
      <CanvasErrorBoundary onFallback={onFallback}>
        <Canvas
          orthographic
          dpr={[1, 1.75]}
          camera={{ position: [7, 6, 7], zoom: BASE_ZOOM, near: 0.1, far: 80 }}
          onCreated={(state) => {
            (state.controls as OrbitControlsImpl | null)?.saveState?.();
          }}
          gl={{ antialias: true }}
        >
          <Scene
            parts={parts}
            installedIds={installedIds}
            activeIds={activeIds}
            explode={explode}
            selectedId={selectedId}
            fx={fx}
            onSelect={(id) => { setSelectedId(id); onSelect?.(id); }}
          />
          <CameraRig fx={fx} baseZoom={BASE_ZOOM} />
          <OrbitControls
            makeDefault
            ref={controlsRef}
            minPolarAngle={0.15}
            maxPolarAngle={1.35}
            enableDamping
            dampingFactor={0.08}
            enablePan={false}
            minDistance={3}
            maxDistance={16}
          />
        </Canvas>
      </CanvasErrorBoundary>
      <div className="robot3d-toolbar">
        <label className="robot3d-explode">
          <span>Explode</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={explode}
            onChange={(e) => setExplode(Number(e.target.value))}
          />
        </label>
        <button type="button" className="btn btn-ghost btn-small" onClick={() => controlsRef.current?.reset()}>
          Reset view
        </button>
      </div>
      <span className="illustrative-badge">3D schematic — illustrative, not an engineering model</span>
    </div>
  );
}

export { COLORS };
