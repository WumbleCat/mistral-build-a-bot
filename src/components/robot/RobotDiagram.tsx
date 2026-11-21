import type { JSX } from 'react';
import type { Part } from '../../types';
import {
  BATTERY_POS,
  CHASSIS_RECT,
  CONTROLLER_POS,
  VIEW_BOX,
  WIRE_PATHS,
  allInstances,
  instancesFor,
  type Instance,
} from './layout';

export type PartState = 'ghost' | 'installed' | 'active';

const INK = '#1b1916';
const ACCENT = '#ef6c0b';
const COLORS = {
  installedFill: '#dfe2e7',
  installedStroke: '#828a94',
  detail: '#5c636c',
  tyre: '#43484f',
  activeFill: '#ffe1c2',
  activeStroke: ACCENT,
  ghostFill: '#f4f5f7',
  ghostStroke: '#cfd4da',
  wire: '#7b828b',
};

function stateColors(state: PartState) {
  if (state === 'active') return { fill: COLORS.activeFill, stroke: COLORS.activeStroke };
  if (state === 'ghost') return { fill: COLORS.ghostFill, stroke: COLORS.ghostStroke };
  return { fill: COLORS.installedFill, stroke: COLORS.installedStroke };
}

function Screw({ x, y, state }: { x: number; y: number; state: PartState }) {
  const c = stateColors(state);
  const dash = state === 'ghost' ? '3 3' : undefined;
  return (
    <g>
      <circle cx={x} cy={y} r={5.5} fill={c.fill} stroke={c.stroke} strokeWidth={1.5} strokeDasharray={dash} />
      <line x1={x - 3} y1={y} x2={x + 3} y2={y} stroke={state === 'ghost' ? COLORS.ghostStroke : COLORS.detail} strokeWidth={1.4} />
    </g>
  );
}

function Chassis({ state }: { state: PartState }) {
  const c = stateColors(state);
  const dash = state === 'ghost' ? '6 5' : undefined;
  const r = CHASSIS_RECT;
  return (
    <g>
      <rect x={r.x + 6} y={r.y + 10} width={r.w} height={r.h} rx={r.rx} fill="#000" opacity={state === 'ghost' ? 0.03 : 0.08} />
      <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={r.rx} fill={c.fill} stroke={c.stroke} strokeWidth={2.5} strokeDasharray={dash} />
      <rect x={r.x + 18} y={r.y + 18} width={r.w - 36} height={r.h - 36} rx={10} fill="none" stroke={c.stroke} strokeWidth={1.2} opacity={0.55} strokeDasharray={dash} />
      {[
        [r.x + 25, r.y + 25],
        [r.x + r.w - 25, r.y + 25],
        [r.x + 25, r.y + r.h - 25],
        [r.x + r.w - 25, r.y + r.h - 25],
      ].map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={6} fill={state === 'ghost' ? COLORS.ghostFill : '#fff'} stroke={c.stroke} strokeWidth={1.5} strokeDasharray={dash} />
      ))}
    </g>
  );
}

function Motor({ inst, state }: { inst: Instance; state: PartState }) {
  const c = stateColors(state);
  const dash = state === 'ghost' ? '4 4' : undefined;
  const { x, y } = inst;
  return (
    <g>
      <rect x={x - 26} y={y - 12} width={14} height={24} rx={3} fill={c.fill} stroke={c.stroke} strokeWidth={1.5} strokeDasharray={dash} />
      <rect x={x - 24} y={y - 20} width={48} height={40} rx={7} fill={c.fill} stroke={c.stroke} strokeWidth={2} strokeDasharray={dash} />
      <circle cx={x} cy={y} r={8.5} fill={state === 'ghost' ? COLORS.ghostFill : '#fff'} stroke={c.stroke} strokeWidth={2} strokeDasharray={dash} />
      <circle cx={x} cy={y} r={3} fill={c.stroke} />
      <line x1={x - 14} y1={y} x2={x + 14} y2={y} stroke={c.stroke} strokeWidth={1.2} opacity={0.6} />
    </g>
  );
}

function Wheel({ inst, state, motorTarget }: { inst: Instance; state: PartState; motorTarget: { x: number; y: number } }) {
  const { x, y } = inst;
  const tyre = state === 'ghost' ? COLORS.ghostFill : state === 'active' ? ACCENT : COLORS.tyre;
  const rim = stateColors(state);
  const dash = state === 'ghost' ? '4 4' : undefined;
  // axle from wheel edge toward the motor
  const dx = motorTarget.x - x;
  const dy = motorTarget.y - y;
  const len = Math.hypot(dx, dy) || 1;
  const axleEnd = { x: x + (dx / len) * 46, y: y + (dy / len) * 46 };
  return (
    <g>
      <line x1={x} y1={y} x2={axleEnd.x} y2={axleEnd.y} stroke={rim.stroke} strokeWidth={5} strokeLinecap="round" opacity={state === 'ghost' ? 0.5 : 0.9} />
      <circle cx={x} cy={y} r={40} fill={tyre} stroke={state === 'ghost' ? COLORS.ghostStroke : '#2c3036'} strokeWidth={state === 'active' ? 3.5 : 2} strokeDasharray={dash} />
      <circle cx={x} cy={y} r={25} fill={rim.fill} stroke={rim.stroke} strokeWidth={2} strokeDasharray={dash} />
      {[0, 90, 180, 270].map((deg) => {
        const rad = (deg * Math.PI) / 180;
        return <line key={deg} x1={x} y1={y} x2={x + 22 * Math.cos(rad)} y2={y + 22 * Math.sin(rad)} stroke={rim.stroke} strokeWidth={3} />;
      })}
      <circle cx={x} cy={y} r={8} fill={state === 'ghost' ? COLORS.ghostFill : '#fff'} stroke={rim.stroke} strokeWidth={2} />
    </g>
  );
}

function Controller({ state }: { state: PartState }) {
  const c = stateColors(state);
  const dash = state === 'ghost' ? '5 4' : undefined;
  const { x, y } = CONTROLLER_POS;
  const w = 132;
  const h = 86;
  return (
    <g>
      <rect x={x - w / 2} y={y - h / 2} width={w} height={h} rx={5} fill={c.fill} stroke={c.stroke} strokeWidth={2.2} strokeDasharray={dash} />
      {/* USB port on the left edge */}
      <rect x={x - w / 2 - 8} y={y - 12} width={12} height={24} rx={2} fill={c.fill} stroke={c.stroke} strokeWidth={1.8} strokeDasharray={dash} />
      {/* main chip */}
      <rect x={x - 17} y={y - 12} width={34} height={24} rx={2} fill={state === 'ghost' ? COLORS.ghostFill : '#fff'} stroke={c.stroke} strokeWidth={1.6} />
      {/* pin headers */}
      {Array.from({ length: 7 }, (_, i) => (
        <rect key={`t${i}`} x={x - w / 2 + 14 + i * 14} y={y - h / 2 + 4} width={8} height={6} fill={c.stroke} opacity={state === 'ghost' ? 0.4 : 0.85} />
      ))}
      {Array.from({ length: 7 }, (_, i) => (
        <rect key={`b${i}`} x={x - w / 2 + 14 + i * 14} y={y + h / 2 - 10} width={8} height={6} fill={c.stroke} opacity={state === 'ghost' ? 0.4 : 0.85} />
      ))}
      <circle cx={x + w / 2 - 12} cy={y - h / 2 + 12} r={3.5} fill="none" stroke={c.stroke} strokeWidth={1.5} />
    </g>
  );
}

function Battery({ state }: { state: PartState }) {
  const c = stateColors(state);
  const dash = state === 'ghost' ? '5 4' : undefined;
  const { x, y } = BATTERY_POS;
  const w = 158;
  const h = 58;
  return (
    <g>
      <rect x={x - w / 2} y={y - h / 2} width={w} height={h} rx={8} fill={c.fill} stroke={c.stroke} strokeWidth={2.2} strokeDasharray={dash} />
      <rect x={x + w / 2} y={y - 10} width={10} height={20} rx={2} fill={c.fill} stroke={c.stroke} strokeWidth={1.8} />
      <line x1={x - 8} y1={y - h / 2 + 10} x2={x - 8} y2={y + h / 2 - 10} stroke={c.stroke} strokeWidth={1.6} opacity={0.7} />
      <line x1={x + 8} y1={y - h / 2 + 10} x2={x + 8} y2={y + h / 2 - 10} stroke={c.stroke} strokeWidth={1.6} opacity={0.7} />
      <text x={x - w / 2 + 16} y={y + 5} fontSize={16} fontWeight={700} fill={c.stroke} fontFamily="inherit">+</text>
      <text x={x + w / 2 - 22} y={y + 5} fontSize={16} fontWeight={700} fill={c.stroke} fontFamily="inherit">−</text>
    </g>
  );
}

function Wire({ inst, state }: { inst: Instance; state: PartState }) {
  const d = WIRE_PATHS[inst.index % WIRE_PATHS.length];
  if (state === 'ghost') {
    return <path d={d} fill="none" stroke={COLORS.ghostStroke} strokeWidth={3} strokeDasharray="2 6" strokeLinecap="round" />;
  }
  if (state === 'active') {
    return <path d={d} fill="none" stroke={ACCENT} strokeWidth={4} strokeDasharray="10 7" strokeLinecap="round" className="wire-active" />;
  }
  return <path d={d} fill="none" stroke={COLORS.wire} strokeWidth={3.5} strokeLinecap="round" />;
}

function GenericBox({ inst, state }: { inst: Instance; state: PartState }) {
  const c = stateColors(state);
  const dash = state === 'ghost' ? '4 4' : undefined;
  const label = inst.part.name.length > 12 ? `${inst.part.name.slice(0, 11)}…` : inst.part.name;
  return (
    <g>
      <rect x={inst.x - 30} y={inst.y - 20} width={60} height={40} rx={8} fill={c.fill} stroke={c.stroke} strokeWidth={2} strokeDasharray={dash} />
      <text x={inst.x} y={inst.y + 4} fontSize={10} textAnchor="middle" fill={c.stroke} fontFamily="inherit">{label}</text>
    </g>
  );
}

function renderInstance(inst: Instance, state: PartState, motorTargets: Array<{ x: number; y: number }>): JSX.Element {
  switch (inst.kind) {
    case 'chassis':
      return <Chassis key={inst.part.id} state={state} />;
    case 'motor':
      return <Motor key={`${inst.part.id}-${inst.index}`} inst={inst} state={state} />;
    case 'wheel':
      return <Wheel key={`${inst.part.id}-${inst.index}`} inst={inst} state={state} motorTarget={motorTargets[inst.index % motorTargets.length]} />;
    case 'controller':
      return <Controller key={inst.part.id} state={state} />;
    case 'battery':
      return <Battery key={inst.part.id} state={state} />;
    case 'wire':
      return <Wire key={`${inst.part.id}-${inst.index}`} inst={inst} state={state} />;
    case 'screw':
      return <Screw key={`${inst.part.id}-${inst.index}`} x={inst.x} y={inst.y} state={state} />;
    default:
      return <GenericBox key={`${inst.part.id}-${inst.index}`} inst={inst} state={state} />;
  }
}

export interface RobotDiagramProps {
  parts: Part[];
  /** Part ids installed before or at the current step. */
  installedIds: string[];
  /** Part ids being added in the current step (highlighted). */
  activeIds: string[];
  stepNumber: number;
  totalSteps: number;
  /** Render only callouts/arrows/badge — used as an overlay on AI-generated images. */
  overlayOnly?: boolean;
}

/** Where the callout chip for a group of active instances should sit. */
function labelPosition(instances: Instance[]): { x: number; y: number } {
  const cx = instances.reduce((s, i) => s + i.x, 0) / instances.length;
  const cy = instances.reduce((s, i) => s + i.y, 0) / instances.length;
  const center = { x: VIEW_BOX.width / 2, y: VIEW_BOX.height / 2 + 30 };
  let dx = cx - center.x;
  let dy = cy - center.y;
  if (Math.hypot(dx, dy) < 40) {
    dy = -1;
    dx = 0;
  }
  const len = Math.hypot(dx, dy);
  const dist = 150;
  const x = Math.min(VIEW_BOX.width - 90, Math.max(90, cx + (dx / len) * dist));
  const y = Math.min(VIEW_BOX.height - 40, Math.max(80, cy + (dy / len) * dist));
  return { x, y };
}

export function RobotDiagram({ parts, installedIds, activeIds, stepNumber, totalSteps, overlayOnly = false }: RobotDiagramProps) {
  const installed = new Set(installedIds);
  const active = new Set(activeIds);

  const stateOf = (partId: string): PartState => {
    if (active.has(partId)) return 'active';
    if (installed.has(partId)) return 'installed';
    return 'ghost';
  };

  const motorTargets = instancesFor(parts.find((p) => p.id === 'motor' || /motor|servo/.test(`${p.id} ${p.name}`.toLowerCase())) ?? { id: 'motor', name: 'motor', quantity: 4 }).map((i) => ({ x: i.x, y: i.y }));

  // Order: ghosts first, then wires, then solid parts, then active outlines + callouts.
  const all = allInstances(parts);
  const ghosts = all.filter((i) => stateOf(i.part.id) === 'ghost');
  const solids = all.filter((i) => stateOf(i.part.id) !== 'ghost');
  const activeInstances = all.filter((i) => stateOf(i.part.id) === 'active');

  // Group active instances by part for callouts.
  const activeByPart = new Map<string, Instance[]>();
  for (const inst of activeInstances) {
    const list = activeByPart.get(inst.part.id) ?? [];
    list.push(inst);
    activeByPart.set(inst.part.id, list);
  }

  const activeBoxes: JSX.Element[] = [];
  const callouts: JSX.Element[] = [];
  let calloutIndex = 0;
  for (const [partId, insts] of activeByPart) {
    const part = insts[0].part;
    // dashed bounding box around the whole group
    const xs = insts.map((i) => i.x);
    const ys = insts.map((i) => i.y);
    const minX = Math.min(...xs) - 58;
    const maxX = Math.max(...xs) + 58;
    const minY = Math.min(...ys) - 58;
    const maxY = Math.max(...ys) + 58;
    activeBoxes.push(
      <rect key={`box-${partId}`} x={minX} y={minY} width={maxX - minX} height={maxY - minY} rx={18} fill="none" stroke={ACCENT} strokeWidth={2} strokeDasharray="8 6" className="pulse-outline" />,
    );
    // per-instance halo
    for (const inst of insts) {
      activeBoxes.push(<circle key={`halo-${partId}-${inst.index}`} cx={inst.x} cy={inst.y} r={inst.kind === 'wheel' ? 50 : 42} fill="none" stroke={ACCENT} strokeWidth={2} strokeDasharray="6 5" className="pulse-outline" />);
    }
    // callout chip + arrows
    const lp = labelPosition(insts);
    const qty = part.quantity > 1 ? `  ×${part.quantity}` : '';
    const text = `${part.name}${qty}`;
    const chipW = text.length * 8.2 + 28;
    const chipH = 30;
    const id = `callout-${calloutIndex++}`;
    callouts.push(
      <g key={id}>
        {insts.map((inst) => (
          <line
            key={`${id}-arrow-${inst.index}`}
            x1={lp.x}
            y1={lp.y + chipH / 2}
            x2={inst.x}
            y2={inst.y - (inst.kind === 'wheel' ? 44 : 26)}
            stroke={ACCENT}
            strokeWidth={2.2}
            markerEnd="url(#arrow-accent)"
            className="callout-arrow"
          />
        ))}
        <rect x={lp.x - chipW / 2} y={lp.y - chipH / 2} width={chipW} height={chipH} rx={chipH / 2} fill={INK} />
        <text x={lp.x} y={lp.y + 5} fontSize={14.5} fontWeight={600} fill="#fff" textAnchor="middle" fontFamily="inherit">
          {text}
        </text>
      </g>,
    );
  }

  return (
    <svg viewBox={`0 0 ${VIEW_BOX.width} ${VIEW_BOX.height}`} className="robot-diagram" role="img" aria-label={`Assembly diagram for step ${stepNumber}`} preserveAspectRatio="xMidYMid meet">
      <defs>
        <marker id="arrow-accent" viewBox="0 0 10 10" refX={8.5} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={ACCENT} />
        </marker>
      </defs>

      {!overlayOnly && (
        <g>
          {ghosts.map((inst) => renderInstance(inst, 'ghost', motorTargets))}
          {solids.map((inst) => renderInstance(inst, stateOf(inst.part.id), motorTargets))}
        </g>
      )}

      {activeBoxes}
      {callouts}

      {/* step badge */}
      <g>
        <circle cx={54} cy={54} r={25} fill={INK} />
        <text x={54} y={61} fontSize={21} fontWeight={700} fill="#fff" textAnchor="middle" fontFamily="inherit">
          {stepNumber}
        </text>
        <text x={92} y={60} fontSize={15} fontWeight={600} fill={INK} fontFamily="inherit" letterSpacing={1.5}>
          {`STEP ${stepNumber} OF ${totalSteps}`}
        </text>
      </g>

      {!overlayOnly && (
        <text x={24} y={VIEW_BOX.height - 12} fontSize={11.5} fill="#6f6b62" fontFamily="inherit">
          Schematic illustration — not an engineering drawing. Instructions shown verbatim from upstream data.
        </text>
      )}
    </svg>
  );
}
