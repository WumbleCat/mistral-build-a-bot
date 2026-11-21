import { Component, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bounds, ContactShadows, Environment, Html, Line, OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { ACESFilmicToneMapping, SRGBColorSpace, Vector3 } from 'three';
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
  onFallback?: () => void;
  /** Part id highlighted from the photo panel (hover sync). */
  highlightId?: string | null;
  /** Hover callback so the photo panel can highlight the matching box. */
  onHoverPart?: (partId: string | null) => void;
}

type Status = 'active' | 'installed' | 'pending';

const FLY_IN = { height: 2.4, dur: 0.7, stagger: 0.08 };

interface Fx {
  nudge: number;
}

const easeOutBack = (p: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
};

/** Orange pixel burst on land (12-16 cubes, 0.6 s). */
function Burst({ origin, onDone }: { origin: [number, number, number]; onDone: () => void }) {
  const groupRef = useRef<Group>(null);
  const born = useRef(performance.now());
  const seeds = useMemo(() => {
    const v: Vector3[] = [];
    for (let i = 0; i < 14; i++) {
      v.push(new Vector3((Math.random() - 0.5) * 2.6, Math.random() * 2.4 + 0.6, (Math.random() - 0.5) * 2.6));
    }
    return v;
  }, []);
  useFrame(() => {
    const g = groupRef.current;
    if (!g) return;
    const t = (performance.now() - born.current) / 600;
    if (t >= 1) { onDone(); return; }
    g.children.forEach((c, i) => {
      const m = c as Mesh;
      const v = seeds[i];
      m.position.set(origin[0] + v.x * t, origin[1] + v.y * t - 1.8 * t * t, origin[2] + v.z * t);
      m.scale.setScalar(Math.max(0.05, 1 - t));
      (m.material as { opacity?: number }).opacity = 1 - t;
    });
  });
  return (
    <group ref={groupRef}>
      {seeds.map((_, i) => (
        <mesh key={i}>
          <boxGeometry args={[0.06, 0.06, 0.06]} />
          <meshBasicMaterial color={[COLORS.flame, COLORS.orange, COLORS.amber][i % 3]} transparent />
        </mesh>
      ))}
    </group>
  );
}

/** Faint dotted slot marker where a not-yet-installed part will land. */
function SlotMarker({ pos }: { pos: [number, number, number] }) {
  return (
    <mesh position={[pos[0], 0.012, pos[2]]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.07, 0.095, 32]} />
      <meshBasicMaterial color={COLORS.orange} transparent opacity={0.16} depthWrite={false} />
    </mesh>
  );
}

function AnimatedPart({
  inst,
  status,
  explode,
  selected,
  highlighted,
  fx,
  onBurst,
  onSelect,
  onHover,
}: {
  inst: Instance3D;
  status: Status;
  explode: number;
  selected: boolean;
  highlighted: boolean;
  fx: React.MutableRefObject<Fx>;
  onBurst: (pos: [number, number, number], partId: string) => void;
  onSelect?: (partId: string) => void;
  onHover?: (partId: string | null) => void;
}) {
  const ref = useRef<Group>(null);
  const prevStatus = useRef<Status>(status);
  const flyStart = useRef<number | null>(null);
  const [hover, setHover] = useState(false);

  useFrame((state, delta) => {
    const g = ref.current;
    if (!g) return;
    const [x, y, z] = inst.slot.pos;
    const [nx, ny, nz] = inst.normal;
    const target: [number, number, number] = [
      x + nx * explode * 1.1,
      y + ny * explode * 1.1,
      z + nz * explode * 1.1,
    ];
    const now = state.clock.elapsedTime;
    if (prevStatus.current === 'pending' && status !== 'pending') {
      onBurst([x, y + 0.15, z], inst.part.id);
      fx.current.nudge = 1;
      flyStart.current = now + inst.index * FLY_IN.stagger;
    }
    prevStatus.current = status;

    if (status !== 'pending' && flyStart.current !== null && now < flyStart.current + FLY_IN.dur) {
      // spring fly-in from above along a smooth arc, then settle bounce (easeOutBack)
      const p = Math.min(1, Math.max(0, (now - flyStart.current) / FLY_IN.dur));
      const e = easeOutBack(p);
      const sx = x + nx * 0.4;
      const sy = y + FLY_IN.height;
      g.position.set(
        sx + (target[0] - sx) * e,
        sy + (target[1] - sy) * e,
        z + nz * 0.4 + (target[2] - (z + nz * 0.4)) * e,
      );
    } else {
      flyStart.current = null;
      const k = 1 - Math.exp(-delta * 6);
      g.position.x += (target[0] - g.position.x) * k;
      g.position.y += (target[1] - g.position.y) * k;
      g.position.z += (target[2] - g.position.z) * k;
    }
    if (inst.slot.rot) g.rotation.set(...inst.slot.rot);
    const pulse = status === 'active' ? 1 + Math.sin(state.clock.elapsedTime * 4) * 0.04 : 1;
    g.scale.setScalar(pulse);
  });

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

  const isActive = status === 'active';
  const strong = isActive || hover || selected || highlighted;

  return (
    <group
      ref={ref}
      position={inst.slot.pos}
      onPointerOver={(e) => { e.stopPropagation(); setHover(true); onHover?.(inst.part.id); }}
      onPointerOut={() => { setHover(false); onHover?.(null); }}
      onClick={(e) => { e.stopPropagation(); onSelect?.(inst.part.id); }}
    >
      {status === 'pending' ? (
        <SlotMarker pos={inst.slot.pos} />
      ) : (
        <>
          <PartMesh kind={inst.kind} part={inst.part} status={status} />
          <Outline active={isActive} />
        </>
      )}
      {strong && status !== 'pending' && (
        <Html position={[0, 0.3, 0]} center className="part3d-label" wrapperClass="part3d-label-wrap">
          <span className="part3d-label-text">{inst.part.name.toUpperCase()}{inst.part.quantity > 1 ? ` ×${inst.part.quantity}` : ''}</span>
        </Html>
      )}
    </group>
  );
}

/** One mono label per part TYPE with a thin leader line to the first instance. */
function TypeLabels({ instances, activeIds, highlightId }: {
  instances: Instance3D[];
  activeIds: string[];
  highlightId: string | null;
}) {
  const byPart = useMemo(() => {
    const m = new Map<string, Instance3D[]>();
    for (const i of instances) {
      if (i.kind === 'wire') continue;
      const arr = m.get(i.part.id) ?? [];
      arr.push(i);
      m.set(i.part.id, arr);
    }
    return m;
  }, [instances]);
  const active = new Set(activeIds);
  return (
    <>
      {[...byPart.entries()].map(([partId, arr]) => {
        const first = arr[0];
        const show = active.has(partId) || highlightId === partId;
        if (!show) return null;
        const [x, y, z] = first.slot.pos;
        const labelPos: [number, number, number] = [x, y + 0.42, z];
        return (
          <group key={partId}>
            <Line points={[labelPos, [x, y + 0.12, z]]} color={COLORS.orange} lineWidth={1} transparent opacity={0.8} />
            <Html position={labelPos} center className="part3d-label" wrapperClass="part3d-label-wrap">
              <span className="part3d-label-text">
                {first.part.name.toUpperCase()}{first.part.quantity > 1 ? ` ×${first.part.quantity}` : ''}
                {first.part.unit_price != null ? ` · £${first.part.unit_price.toFixed(2)}` : ''}
              </span>
            </Html>
          </group>
        );
      })}
    </>
  );
}

/** Slow idle turntable; stops while the user drags. */
function Turntable({ children, interacting }: { children: ReactNode; interacting: React.MutableRefObject<boolean> }) {
  const ref = useRef<Group>(null);
  useFrame((_, dt) => {
    if (ref.current && !interacting.current) ref.current.rotation.y += dt * 0.12;
  });
  return <group ref={ref}>{children}</group>;
}

/** Damped camera glide toward the active parts' centroid. */
function CameraFocus({ instances, activeIds }: { instances: Instance3D[]; activeIds: string[] }) {
  const { controls } = useThree();
  const active = useMemo(() => new Set(activeIds), [activeIds]);
  useFrame((_, dt) => {
    const c = controls as unknown as { target: Vector3 } | null;
    if (!c?.target) return;
    const act = instances.filter((i) => active.has(i.part.id) && i.kind !== 'wire');
    const desired = act.length
      ? new Vector3(
          act.reduce((s, i) => s + i.slot.pos[0], 0) / act.length,
          0.15,
          act.reduce((s, i) => s + i.slot.pos[2], 0) / act.length,
        )
      : new Vector3(0, 0.1, 0);
    const k = 1 - Math.exp(-dt * 2.2);
    c.target.lerp(desired, k);
  });
  return null;
}

function CameraNudge({ fx, baseZoom }: { fx: React.MutableRefObject<Fx>; baseZoom: number }) {
  const { camera } = useThree();
  useFrame((_, dt) => {
    if (fx.current.nudge <= 0) return;
    fx.current.nudge = Math.max(0, fx.current.nudge - dt * 2.2);
    const z = baseZoom * (1 + fx.current.nudge * 0.06);
    if (Math.abs(camera.zoom - z) > 0.001) {
      camera.zoom = z;
      camera.updateProjectionMatrix();
    }
  });
  return null;
}

function Scene({ parts, installedIds, activeIds, explode, selectedId, highlightId, fx, controlsRef, interacting, onSelect, onHover }: {
  parts: Part[];
  installedIds: string[];
  activeIds: string[];
  explode: number;
  selectedId: string | null;
  highlightId: string | null;
  fx: React.MutableRefObject<Fx>;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
  interacting: React.MutableRefObject<boolean>;
  onSelect?: (partId: string) => void;
  onHover?: (partId: string | null) => void;
}) {
  const instances = useMemo(() => allInstances3d(parts), [parts]);
  const installed = useMemo(() => new Set(installedIds), [installedIds]);
  const active = useMemo(() => new Set(activeIds), [activeIds]);
  const [bursts, setBursts] = useState<Array<{ id: string; pos: [number, number, number] }>>([]);
  const burstSeq = useRef(0);

  const handleBurst = (pos: [number, number, number], partId: string) => {
    burstSeq.current += 1;
    const id = `b${burstSeq.current}`;
    setBursts((b) => [...b.slice(-7), { id, pos }]);
    window.dispatchEvent(new CustomEvent('bfv:land', { detail: { partId } }));
  };

  return (
    <>
      <color attach="background" args={['#1B1F28']} />
      <fog attach="fog" args={['#1B1F28', 10, 24]} />
      {/* three-point lighting: warm key, cool fill, amber rim */}
      <directionalLight position={[4, 7, 3]} intensity={1.35} color="#FFF1DC" castShadow />
      <hemisphereLight args={['#9AA3B8', '#1B1F28', 0.5]} />
      <directionalLight position={[-3.5, 2.5, -4]} intensity={0.7} color="#B9C4D8" />
      <directionalLight position={[-5, 5, -6]} intensity={1.6} color={COLORS.amber} />
      <Suspense fallback={null}>
        <Environment preset="warehouse" />
      </Suspense>
      <gridHelper
        args={[16, 32, '#262C38', '#262C38']}
        position={[0, 0, 0]}
        material-transparent
        material-opacity={0.85}
        material-depthWrite={false}
      />
      <ContactShadows position={[0, 0.002, 0]} opacity={0.55} scale={8} blur={2.6} far={4.5} resolution={512} color="#000000" />
      <Bounds fit clip margin={1.12}>
        <Turntable interacting={interacting}>
          <group>
            {instances.map((inst) => {
              const status: Status = active.has(inst.part.id) ? 'active' : installed.has(inst.part.id) ? 'installed' : 'pending';
              return (
                <AnimatedPart
                  key={`${inst.part.id}-${inst.index}`}
                  inst={inst}
                  status={status}
                  explode={explode}
                  selected={selectedId === inst.part.id}
                  highlighted={highlightId === inst.part.id}
                  fx={fx}
                  onBurst={handleBurst}
                  onSelect={onSelect}
                  onHover={onHover}
                />
              );
            })}
            <TypeLabels instances={instances} activeIds={activeIds} highlightId={highlightId} />
            {bursts.map((b) => (
              <Burst key={b.id} origin={b.pos} onDone={() => setBursts((arr) => arr.filter((x) => x.id !== b.id))} />
            ))}
          </group>
        </Turntable>
      </Bounds>
      <CameraFocus instances={instances} activeIds={activeIds} />
      <OrbitControls
        makeDefault
        ref={controlsRef}
        minPolarAngle={0.15}
        maxPolarAngle={1.35}
        enableDamping
        dampingFactor={0.08}
        enablePan={false}
        minDistance={2.2}
        maxDistance={12}
        onStart={() => { interacting.current = true; }}
        onEnd={() => { interacting.current = false; }}
      />
    </>
  );
}

class CanvasErrorBoundary extends Component<{ onFallback?: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onFallback?.(); }
  render() { return this.state.failed ? null : this.props.children; }
}

const BASE_ZOOM = 78; // robot fills ~70% of the canvas

export function Robot3DView(props: Robot3DViewProps) {
  const { parts, installedIds, activeIds, onSelect, onFallback, highlightId, onHoverPart } = props;
  const [explode, setExplode] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const fx = useRef<Fx>({ nudge: 0 });
  const interacting = useRef(false);

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
      <div className="robot3d-vignette" aria-hidden />
      <CanvasErrorBoundary onFallback={onFallback}>
        <Canvas
          orthographic
          dpr={[1, 2]}
          camera={{ position: [4.6, 4.0, 4.6], zoom: BASE_ZOOM, near: 0.1, far: 60 }}
          onCreated={(state) => {
            (state.controls as OrbitControlsImpl | null)?.saveState?.();
            state.scene.environmentIntensity = 0.35;
            state.gl.toneMapping = ACESFilmicToneMapping;
            state.gl.outputColorSpace = SRGBColorSpace;
          }}
          gl={{ antialias: true }}
        >
          <Scene
            parts={parts}
            installedIds={installedIds}
            activeIds={activeIds}
            explode={explode}
            selectedId={selectedId}
            highlightId={highlightId ?? null}
            fx={fx}
            controlsRef={controlsRef}
            interacting={interacting}
            onSelect={(id) => { setSelectedId(id); onSelect?.(id); }}
            onHover={onHoverPart}
          />
          <CameraNudge fx={fx} baseZoom={BASE_ZOOM} />
        </Canvas>
      </CanvasErrorBoundary>
      <div className="robot3d-toolbar">
        <label className="robot3d-explode">
          <span>Explode</span>
          <input type="range" min={0} max={1} step={0.01} value={explode} onChange={(e) => setExplode(Number(e.target.value))} />
        </label>
        <button type="button" className="btn btn-ghost btn-small" onClick={() => controlsRef.current?.reset()}>
          Reset view
        </button>
      </div>
      <span className="robot3d-note">3D schematic — illustrative</span>
    </div>
  );
}

export { COLORS };
