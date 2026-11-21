import { Component, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
// Imported piece by piece: the whole-library bundle is several megabytes, which is slow to
// pre-bundle and gets removed by some antivirus tools, leaving the 3D view unable to load.
import { ContactShadows } from '@react-three/drei/core/ContactShadows';
import { Environment } from '@react-three/drei/core/Environment';
import { Line } from '@react-three/drei/core/Line';
import { OrbitControls } from '@react-three/drei/core/OrbitControls';
import { Html } from '@react-three/drei/web/Html';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { ACESFilmicToneMapping, OrthographicCamera, SRGBColorSpace, Vector3 } from 'three';
import type { Group, Mesh } from 'three';
import type { AssemblyStep, Part } from '../../types';
import { allInstances3d, type Instance3D } from './layout3d';
import { COLORS, Outline, PartMesh, SceneWireSet } from './partMeshes';

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
        <Outline active={isActive}>
          <PartMesh kind={inst.kind} part={inst.part} status={status} />
        </Outline>
      )}
      {strong && !isActive && status !== 'pending' && inst.kind !== 'wire' && (
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
  const entries = [...byPart.entries()].sort((a, b) => Number(active.has(b[0])) - Number(active.has(a[0]))).slice(0, 3);
  return (
    <>
      {entries.map(([partId, arr]) => {
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

/**
 * Manual framing for the orthographic camera: compute the robot's bounding
 * box from the slot layout, fit it to ~62% of the canvas (whole robot in
 * frame, no wheels cut off), then damp the zoom + target toward it on every
 * step change / resize. Target also glides slightly toward the active parts
 * centroid so the camera "focuses" the current step without losing the robot.
 */
function CameraRig({ instances, activeIds, fx, fittedZoom }: {
  instances: Instance3D[];
  activeIds: string[];
  fx: React.MutableRefObject<Fx>;
  fittedZoom: React.MutableRefObject<number>;
}) {
  const { camera, size, controls } = useThree();
  const active = useMemo(() => new Set(activeIds), [activeIds]);

  const box = useMemo(() => {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, maxY = 0;
    for (const i of instances) {
      const r = i.kind === 'wheel' ? 0.38 : i.kind === 'chassis' ? 0.12 : 0.26;
      const [x, y, z] = i.slot.pos;
      minX = Math.min(minX, x - r); maxX = Math.max(maxX, x + r);
      minZ = Math.min(minZ, z - r); maxZ = Math.max(maxZ, z + r);
      maxY = Math.max(maxY, y + r);
    }
    if (!isFinite(minX)) { minX = -1; maxX = 1; minZ = -1; maxZ = 1; }
    return { minX, maxX, minZ, maxZ, maxY, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
  }, [instances]);

  // zoom needed so the box fills FILL of the limiting canvas dimension
  const targetZoom = useMemo(() => {
    const cam = camera as OrthographicCamera;
    cam.updateMatrixWorld();
    const inv = cam.matrixWorldInverse;
    const v = new Vector3();
    let mx = 0, my = 0;
    const FILL = 0.62;
    for (const cx of [box.minX, box.maxX]) {
      for (const cy of [0, box.maxY]) {
        for (const cz of [box.minZ, box.maxZ]) {
          v.set(cx, cy, cz).applyMatrix4(inv);
          mx = Math.max(mx, Math.abs(v.x));
          my = Math.max(my, Math.abs(v.y));
        }
      }
    }
    const zx = mx > 1e-6 ? (FILL * size.width) / (2 * mx) : 100;
    const zy = my > 1e-6 ? (FILL * size.height) / (2 * my) : 100;
    return Math.min(zx, zy);
  }, [box, size, camera]);

  const savedRef = useRef(false);
  useFrame((_, dt) => {
    const cam = camera as OrthographicCamera;
    const c = controls as unknown as { target: Vector3; minZoom: number; maxZoom: number; saveState?: () => void } | null;
    const k = 1 - Math.exp(-dt * 3.2); // ~0.8 s glide
    if (fx.current.nudge > 0) fx.current.nudge = Math.max(0, fx.current.nudge - dt * 2.2);
    const goal = targetZoom * (1 + fx.current.nudge * 0.05);
    cam.zoom += (goal - cam.zoom) * k;
    cam.updateProjectionMatrix();
    fittedZoom.current = targetZoom;
    if (c) {
      c.minZoom = targetZoom * 0.55;
      c.maxZoom = targetZoom * 2.4;
      const act = instances.filter((i) => active.has(i.part.id) && i.kind !== 'wire');
      const ax = act.length ? act.reduce((s, i) => s + i.slot.pos[0], 0) / act.length : box.cx;
      const az = act.length ? act.reduce((s, i) => s + i.slot.pos[2], 0) / act.length : box.cz;
      // keep the whole robot framed: only 22% of the way toward the active centroid
      const desired = new Vector3(box.cx + (ax - box.cx) * 0.22, 0.12, box.cz + (az - box.cz) * 0.22);
      c.target.lerp(desired, k);
      if (!savedRef.current && Math.abs(cam.zoom - targetZoom) < targetZoom * 0.01) {
        savedRef.current = true;
        c.saveState?.();
      }
    }
  });
  return null;
}

function Scene({ parts, installedIds, activeIds, explode, selectedId, highlightId, fx, fittedZoom, controlsRef, interacting, onSelect, onHover }: {
  parts: Part[];
  installedIds: string[];
  activeIds: string[];
  explode: number;
  selectedId: string | null;
  highlightId: string | null;
  fx: React.MutableRefObject<Fx>;
  fittedZoom: React.MutableRefObject<number>;
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
      <color attach="background" args={['#f0eee9']} />
      <fog attach="fog" args={['#f0eee9', 10, 24]} />
      {/* three-point lighting: warm key, cool fill, amber rim */}
      <directionalLight position={[4, 7, 3]} intensity={1.35} color="#FFF1DC" castShadow />
      <hemisphereLight args={['#ffffff', '#dcd8cf', 0.9]} />
      <directionalLight position={[-3.5, 2.5, -4]} intensity={0.7} color="#B9C4D8" />
      <directionalLight position={[-5, 5, -6]} intensity={1.6} color={COLORS.amber} />
      <Suspense fallback={null}>
        <Environment preset="warehouse" />
      </Suspense>
      <gridHelper
        args={[16, 32, '#bdb7a9', '#dcd8cf']}
        position={[0, 0, 0]}
        material-transparent
        material-opacity={0.85}
        material-depthWrite={false}
      />
      <ContactShadows position={[0, 0.002, 0]} opacity={0.3} scale={8} blur={2.6} far={4.5} resolution={512} color="#000000" />
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
          {instances.some((i) => i.kind === 'wire' && (active.has(i.part.id) || installed.has(i.part.id))) && <SceneWireSet />}
          {bursts.map((b) => (
            <Burst key={b.id} origin={b.pos} onDone={() => setBursts((arr) => arr.filter((x) => x.id !== b.id))} />
          ))}
        </group>
      </Turntable>
      <CameraRig instances={instances} activeIds={activeIds} fx={fx} fittedZoom={fittedZoom} />
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

export function Robot3DView(props: Robot3DViewProps) {
  const { parts, installedIds, activeIds, onSelect, onFallback, highlightId, onHoverPart } = props;
  const [explode, setExplode] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const fx = useRef<Fx>({ nudge: 0 });
  const fittedZoom = useRef(60);
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
      <CanvasErrorBoundary onFallback={onFallback}>
        <Canvas
          orthographic
          dpr={[1, 2]}
          camera={{ position: [4.6, 4.0, 4.6], zoom: 60, near: 0.1, far: 60 }}
          onCreated={(state) => {
            (state.controls as OrbitControlsImpl | null)?.saveState?.();
            state.scene.environmentIntensity = 0.35;
            state.gl.toneMapping = ACESFilmicToneMapping;
            state.gl.outputColorSpace = SRGBColorSpace;
            (window as unknown as { __scene?: unknown }).__scene = state.scene;
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
            fittedZoom={fittedZoom}
            controlsRef={controlsRef}
            interacting={interacting}
            onSelect={(id) => { setSelectedId(id); onSelect?.(id); }}
            onHover={onHoverPart}
          />
        </Canvas>
      </CanvasErrorBoundary>
      <div className="robot3d-toolbar">
        <label className="robot3d-explode">
          <span>Explode</span>
          <input type="range" min={0} max={1} step={0.01} value={explode} onChange={(e) => setExplode(Number(e.target.value))} />
        </label>
        <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={() => controlsRef.current?.reset()}>
          Reset view
        </button>
      </div>
    </div>
  );
}

export { COLORS };
