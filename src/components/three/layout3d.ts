import type { Part } from '../../types';
import { classifyPart } from '../robot/layout';

/**
 * 3D slot layout with REAL 4-wheel rover proportions (1 unit = 10 cm):
 * chassis 20 x 12 cm, 4 big wheels at the corners at the same height,
 * motors next to each wheel, electronics on the top deck, battery at the back.
 */

export type Kind3D =
  | 'chassis' | 'motor' | 'wheel' | 'controller' | 'driver' | 'battery'
  | 'wire' | 'screw' | 'sensor' | 'servo' | 'breadboard' | 'generic';

export function kind3d(part: Part): Kind3D {
  const c = (part.category || '').toLowerCase();
  const hay = `${part.id} ${part.name}`.toLowerCase();
  if (/chassis|frame|deck|base/.test(c + hay)) return 'chassis';
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
  normal: [number, number, number];
}

/** chassis plate: 20 x 0.8 x 12 cm */
export const CHASSIS_SIZE: [number, number, number] = [2.0, 0.08, 1.2];
export const WHEEL_R = 0.33; // 6.6 cm diameter wheels

const MOTOR_POS: Array<[number, number, number]> = [
  [-0.68, 0.22, -0.5], [0.68, 0.22, -0.5], [-0.68, 0.22, 0.5], [0.68, 0.22, 0.5],
];
const WHEEL_POS: Array<[number, number, number]> = [
  [-0.9, WHEEL_R, -0.52], [0.9, WHEEL_R, -0.52], [-0.9, WHEEL_R, 0.52], [0.9, WHEEL_R, 0.52],
];
const WHEEL_ROT: [number, number, number] = [0, 0, Math.PI / 2];
const SCREW_POS: Array<[number, number, number]> = [
  [-0.86, 0.1, -0.46], [0.86, 0.1, -0.46], [-0.86, 0.1, 0.46], [0.86, 0.1, 0.46],
];

function anchorFor(kind: Kind3D, index: number): Slot3D {
  switch (kind) {
    case 'chassis':
      return { pos: [0, 0.05, 0] };
    case 'motor':
      return { pos: MOTOR_POS[index % 4], rot: [0, Math.PI / 2, 0] };
    case 'wheel':
      return { pos: WHEEL_POS[index % 4], rot: WHEEL_ROT };
    case 'screw':
      return { pos: SCREW_POS[index % 4] };
    case 'controller':
      return { pos: [0, 0.14, -0.3] };
    case 'driver':
      return { pos: [0.45, 0.13, -0.05] };
    case 'battery':
      return { pos: [0, 0.17, 0.42] };
    case 'sensor':
      return { pos: [0, 0.15, -0.62] };
    case 'servo':
      return { pos: [-0.48, 0.13, -0.55] };
    case 'breadboard':
      return { pos: [0.48, 0.12, 0.32] };
    case 'wire':
      return { pos: MOTOR_POS[index % 4] };
    default: {
      const perRow = 4;
      const row = Math.floor(index / perRow);
      const col = index % perRow;
      return { pos: [-0.6 + col * 0.4, 0.12, 0.68 + row * 0.16] };
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

/** Wire curves: controller board to each motor, hugging the chassis deck. */
export function wirePaths3d(): Array<[number, number, number][]> {
  const from: [number, number, number] = [0, 0.16, -0.28];
  return MOTOR_POS.map((m) => [
    from,
    [(from[0] + m[0]) / 2, 0.22, (from[2] + m[2]) / 2],
    [m[0], m[1] + 0.06, m[2]],
  ]);
}
