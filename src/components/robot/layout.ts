import type { Part } from '../../types';

/**
 * Canonical schematic layout for the robot diagrams. Every stage uses the same
 * coordinates, so the assembly state (ghost / installed / active) is the only
 * thing that changes between steps.
 */

export const VIEW_BOX = { width: 900, height: 600 };

export type PartKind = 'chassis' | 'motor' | 'wheel' | 'controller' | 'battery' | 'wire' | 'screw' | 'generic';

export interface Instance {
  part: Part;
  kind: PartKind;
  index: number;
  x: number;
  y: number;
}

export const CHASSIS_RECT = { x: 250, y: 150, w: 400, h: 300, rx: 16 };
export const CHASSIS_CENTER = { x: 450, y: 300 };

const MOTOR_POS = [
  { x: 320, y: 215 },
  { x: 580, y: 215 },
  { x: 320, y: 385 },
  { x: 580, y: 385 },
];
const WHEEL_POS = [
  { x: 218, y: 215 },
  { x: 682, y: 215 },
  { x: 218, y: 385 },
  { x: 682, y: 385 },
];
const SCREW_POS = [
  { x: 275, y: 175 },
  { x: 625, y: 175 },
  { x: 275, y: 425 },
  { x: 625, y: 425 },
  { x: 450, y: 168 },
  { x: 450, y: 432 },
  { x: 266, y: 300 },
  { x: 634, y: 300 },
];
export const CONTROLLER_POS = { x: 450, y: 252 };
export const BATTERY_POS = { x: 450, y: 372 };

/** Wire paths from the controller to each motor (index matches MOTOR_POS). */
export const WIRE_PATHS = [
  'M 428 294 C 396 262, 352 252, 324 234',
  'M 472 294 C 504 262, 548 252, 576 234',
  'M 428 294 C 392 330, 352 352, 324 366',
  'M 472 294 C 508 330, 548 352, 576 366',
];

const KEYWORDS: Array<[PartKind, RegExp]> = [
  ['chassis', /chassis|frame|base\s*plate|deck/],
  ['motor', /motor|servo|actuator|drive/],
  ['wheel', /wheel|tyre|tire/],
  ['controller', /arduino|controller|board|mcu|esp|raspberry|microcontroller|driver/],
  ['battery', /battery|cell|power\s*pack|lipo/],
  ['wire', /wire|cable|jumper|lead|harness/],
  ['screw', /screw|bolt|nut|fastener|rivet|standoff/],
];

export function classifyPart(part: Part): PartKind {
  const hay = `${part.id} ${part.name}`.toLowerCase();
  for (const [kind, re] of KEYWORDS) if (re.test(hay)) return kind;
  return 'generic';
}

function anchorFor(kind: PartKind, index: number): { x: number; y: number } {
  switch (kind) {
    case 'chassis':
      return CHASSIS_CENTER;
    case 'motor':
      return MOTOR_POS[index % MOTOR_POS.length];
    case 'wheel':
      return WHEEL_POS[index % WHEEL_POS.length];
    case 'screw':
      return SCREW_POS[index % SCREW_POS.length];
    case 'controller':
      return CONTROLLER_POS;
    case 'battery':
      return BATTERY_POS;
    case 'wire':
      return MOTOR_POS[index % MOTOR_POS.length];
    default: {
      const perRow = 5;
      const row = Math.floor(index / perRow);
      const col = index % perRow;
      return { x: 310 + col * 85, y: 522 + row * 56 };
    }
  }
}

/** One diagram instance per unit of the part's quantity. */
export function instancesFor(part: Part): Instance[] {
  const kind = classifyPart(part);
  const count = Math.max(1, Math.min(part.quantity, 24));
  return Array.from({ length: count }, (_, index) => {
    const a = anchorFor(kind, index);
    // Slight offset when more units than anchors, so duplicates stay visible.
    const overflow = index >= 8 && kind !== 'generic' ? (Math.floor(index / 8) * 10) : 0;
    return { part, kind, index, x: a.x + overflow, y: a.y + overflow };
  });
}

export function allInstances(parts: Part[]): Instance[] {
  return parts.flatMap(instancesFor);
}
