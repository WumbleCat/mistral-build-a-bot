import type { Part } from '../../types';
import { classifyPart } from '../robot/layout';

/**
 * Deterministic 3D slot layout for the assembly view. Mirrors the 2D anchors in
 * robot/layout.ts (chassis centre, 4 motor corners, 4 wheel positions, top-deck
 * electronics) but in 3D coordinates (y up, chassis plate centred at origin).
 */

export type Kind3D =
  | 'chassis' | 'motor' | 'wheel' | 'controller' | 'driver' | 'battery'
  | 'wire' | 'screw' | 'sensor' | 'servo' | 'breadboard' | 'generic';

export function kind3d(part: Part): Kind3D {
  const c = (part.category || '').toLowerCase();
  const hay = `${part.id} ${part.name}`.toLowerCase();
  if (/chassis|frame|deck|base/.test(c) || /chassis|frame|deck/.test(hay)) return 'chassis';
  if (/wheel|tyre|tire/.test(c + hay)) return 'wheel';
  if (/driver|relay|h-?bridge/.test(c + hay)) return 'driver';
  if (/motor|actuator/.test(c + hay)) return 'motor';
  if (/servo/.test(c + hay)) return 'servo';
  if (/sensor/.test(c + hay)) return 'sensor';
  if (/breadboard|proto/.test(c + hay)) return 'breadboard';
  if (/controller|mcu|arduino|esp|raspberry|board/.test(c + hay)) return 'controller';
  if (/power|battery|cell|lipo/.test(c + hay)) return 'battery';
  if (/wir|jumper|cable|lead|harness/.test(c + hay)) return 'wire';
  if (/fastener|screw|bolt|nut|standoff/.test(c + hay)) return 'screw';
  return classifyPart(part) as Kind3D;
}

export interface Slot3D {
  pos: [number, number, number];
  rot?: [number, number, number];
}

export interface Instance3D {
  part: Part;
  kind: Kind3D;
  index: number;
  slot: Slot3D;
  /** Outward direction used by the explode slider. */
  normal: [number, number, number];
}

export const CHASSIS_SIZE: [number, number, number] = [4.4, 0.12, 3.0];

const MOTOR_POS: Array<[number, number, number]> = [
  [-1.5, 0.2, -0.85], [1.5, 0.2, -0.85], [-1.5, 0.2, 0.85], [1.5, 0.2, 0.85],
];
const WHEEL_POS: Array<[number, number, number]> = [
  [-2.0, 0.34, -0.85], [2.0, 0.34, -0.85], [-2.0, 0.34, 0.85], [2.0, 0.34, 0.85],
];
const WHEEL_ROT: [number, number, number] = [0, 0, Math.PI / 2];
const SCREW_POS: Array<[number, number, number]> = [
  [-1.95, 0.14, -1.25], [1.95, 0.14, -1.25], [-1.95, 0.14, 1.25], [1.95, 0.14, 1.25],
];

function anchorFor(kind: Kind3D, index: number): Slot3D {
  switch (kind) {
    case 'chassis':
      return { pos: [0, 0.07, 0] };
    case 'motor':
      return { pos: MOTOR_POS[index % 4] };
    case 'wheel':
      return { pos: WHEEL_POS[index % 4], rot: WHEEL_ROT };
    case 'screw':
      return { pos: SCREW_POS[index % 4] };
    case 'controller':
      return { pos: [0, 0.17, -0.5] };
    case 'driver':
      return { pos: [1.0, 0.16, -0.1] };
    case 'battery':
      return { pos: [0, 0.2, 0.6] };
    case 'sensor':
      return { pos: [0, 0.2, -1.62] };
    case 'servo':
      return { pos: [-1.0, 0.18, -1.62] };
    case 'breadboard':
      return { pos: [1.0, 0.15, 0.65] };
    case 'wire':
      return { pos: MOTOR_POS[index % 4] };
    default: {
      const perRow = 5;
      const row = Math.floor(index / perRow);
      const col = index % perRow;
      return { pos: [-1.6 + col * 0.8, 0.15, 1.05 + row * 0.32] };
    }
  }
}

function normalFor(pos: [number, number, number]): [number, number, number] {
  const len = Math.hypot(pos[0], pos[2]) || 1;
  return [pos[0] / len, 0.6, pos[2] / len];
}

export function instances3dFor(part: Part): Instance3D[] {
  const kind = kind3d(part);
  const count = Math.max(1, Math.min(part.quantity || 1, 24));
  return Array.from({ length: count }, (_, index) => {
    const slot = anchorFor(kind, index);
    return { part, kind, index, slot, normal: normalFor(slot.pos) };
  });
}

export function allInstances3d(parts: Part[]): Instance3D[] {
  return parts.flatMap(instances3dFor);
}

/** Wire curves: controller board to each motor corner. */
export function wirePaths3d(): Array<[number, number, number][]> {
  const from: [number, number, number] = [0, 0.22, -0.5];
  return MOTOR_POS.map((m) => [
    from,
    [(from[0] + m[0]) / 2, 0.55, (from[2] + m[2]) / 2],
    [m[0], m[1] + 0.1, m[2]],
  ]);
}
