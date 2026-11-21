import { Component, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Bounds, Html, OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { Group } from 'three';
import type { AssemblyStep, Part } from '../../types';
import { allInstances3d, wirePaths3d, type Instance3D } from './layout3d';
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

function AnimatedPart({
  inst,
  status,
  explode,
  selected,
  onSelect,
}: {
  inst: Instance3D;
  status: Status;
  explode: number;
  selected: boolean;
  onSelect?: (partId: string) => void;
}) {
  const ref = useRef<Group>(null);
  const [hover, setHover] = useState(false);
  const label = useMemo(() => {
    const qty = inst.part.quantity > 1 ? ` ×${inst.part.quantity}` : '';
    const price = inst.part.unit_price != null ? ` · £${inst.part.unit_price.toFixed(2)}` : '';
    return `${inst.part.name}${qty}${price}`;
  }, [inst.part]);

  useFrame((_, delta) => {
    const g = ref.current;
    if (!g) return;
    const [x, y, z] = inst.slot.pos;
    const [nx, ny, nz] = inst.normal;
    const lift = status === 'pending' ? GHOST_LIFT : 0;
    const target = [
      x + nx * explode * 1.6,
      y + lift + ny * explode * 1.6,
      z + nz * explode * 1.6,
    ] as [number, number, number];
    // critically-damped-ish ease (~0.8 s)
    const k = 1 - Math.exp(-delta * 5);
    g.position.x += (target[0] - g.position.x) * k;
    g.position.y += (target[1] - g.position.y) * k;
    g.position.z += (target[2] - g.position.z) * k;
    if (inst.slot.rot) g.rotation.set(...inst.slot.rot);
  });

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
      <Outline strong={strong} />
      {status === 'active' && (
        <Html position={[0, 0.55, 0]} center className="part3d-label" wrapperClass="part3d-label-wrap">
          <span className="part3d-label-text">{label}</span>
        </Html>
      )}
    </group>
  );
}

function Scene({ parts, installedIds, activeIds, explode, selectedId, onSelect }: {
  parts: Part[];
  installedIds: string[];
  activeIds: string[];
  explode: number;
  selectedId: string | null;
  onSelect?: (partId: string) => void;
}) {
  const instances = useMemo(() => allInstances3d(parts), [parts]);
  const installed = useMemo(() => new Set(installedIds), [installedIds]);
  const active = useMemo(() => new Set(activeIds), [activeIds]);
  const hasWires = useMemo(() => instances.some((i) => i.kind === 'wire'), [instances]);
  const wireInst = useMemo(() => instances.filter((i) => i.kind === 'wire'), [instances]);

  return (
    <>
      <hemisphereLight args={['#ffffff', '#d8d4cc', 0.75]} />
      <directionalLight position={[5, 8, 4]} intensity={1.15} />
      <directionalLight position={[-4, 3, -5]} intensity={0.3} />
      <gridHelper
        args={[16, 32, '#17181a', '#17181a']}
        position={[0, 0, 0]}
        material-transparent
        material-opacity={0.08}
        material-depthWrite={false}
      />
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
                onSelect={onSelect}
              />
            );
          })}
          {hasWires && wirePaths3d().length > 0 && (
            <group position={[0, 0, 0]}>
              {wireInst.slice(0, 1).map((inst) => (
                <AnimatedPart
                  key={`${inst.part.id}-wire`}
                  inst={{ ...inst, slot: { pos: [0, 0.1, 0] } }}
                  status={active.has(inst.part.id) ? 'active' : installed.has(inst.part.id) ? 'installed' : 'pending'}
                  explode={explode * 0.4}
                  selected={selectedId === inst.part.id}
                  onSelect={onSelect}
                />
              ))}
            </group>
          )}
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

export function Robot3DView(props: Robot3DViewProps) {
  const { parts, installedIds, activeIds, onSelect, onFallback } = props;
  const [explode, setExplode] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const controlsRef = useRef<OrbitControlsImpl>(null);

  return (
    <div className="robot3d-wrap">
      <CanvasErrorBoundary onFallback={onFallback}>
        <Canvas
          orthographic
          dpr={[1, 1.75]}
          camera={{ position: [7, 6, 7], zoom: 55, near: 0.1, far: 80 }}
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
            onSelect={(id) => { setSelectedId(id); onSelect?.(id); }}
          />
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
