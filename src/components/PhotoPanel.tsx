import { useMemo, useState } from 'react';
import type { AssemblyData } from '../types';
// demo robot photo (Person 2 analysis target) — bundled by vite
import robotPhoto from '../../test-data/robot.png';

export interface PhotoPanelProps {
  data: AssemblyData;
  activeIds: string[];
  highlightId?: string | null;
  onHoverPart?: (partId: string | null) => void;
}

/** Normalised (0..1) box per category on the demo photo, per copy index. */
const BOXES: Record<string, Array<[number, number, number, number]>> = {
  wheel: [[0.05, 0.52, 0.22, 0.38], [0.73, 0.52, 0.22, 0.38], [0.07, 0.08, 0.2, 0.34], [0.73, 0.06, 0.22, 0.36]],
  chassis: [[0.24, 0.26, 0.52, 0.42]],
  motor: [[0.3, 0.5, 0.12, 0.16], [0.58, 0.5, 0.12, 0.16], [0.3, 0.2, 0.12, 0.16], [0.58, 0.2, 0.12, 0.16]],
  controller: [[0.4, 0.42, 0.2, 0.22]],
  driver: [[0.28, 0.3, 0.1, 0.12], [0.62, 0.3, 0.1, 0.12]],
  battery: [[0.3, 0.04, 0.4, 0.2]],
  sensor: [[0.44, 0.6, 0.14, 0.12]],
  servo: [[0.3, 0.62, 0.1, 0.12]],
  breadboard: [[0.42, 0.4, 0.18, 0.22]],
  wire: [[0.2, 0.45, 0.6, 0.1]],
  screw: [[0.24, 0.24, 0.06, 0.08], [0.7, 0.24, 0.06, 0.08], [0.24, 0.64, 0.06, 0.08], [0.7, 0.64, 0.06, 0.08]],
  tape: [[0.84, 0.3, 0.1, 0.4]],
  generic: [[0.4, 0.3, 0.2, 0.3]],
};

function boxFor(part: { id: string; name: string; category?: string }, index: number): [number, number, number, number] {
  const hay = `${part.category ?? ''} ${part.id} ${part.name}`.toLowerCase();
  let key = 'generic';
  for (const k of Object.keys(BOXES)) {
    if (k === 'generic') continue;
    if (hay.includes(k) || (k === 'chassis' && /frame|deck|base/.test(hay))) { key = k; break; }
  }
  if (/wheel|tyre|tire/.test(hay)) key = 'wheel';
  if (/battery|power/.test(hay)) key = 'battery';
  if (/relay|driver/.test(hay)) key = 'driver';
  if (/tape/.test(hay)) key = 'tape';
  if (/wire|jumper|harness/.test(hay)) key = 'wire';
  if (/breadboard/.test(hay)) key = 'breadboard';
  const list = BOXES[key] ?? BOXES.generic;
  return list[index % list.length];
}

/**
 * The uploaded robot photo with thin orange detection boxes for the parts in the
 * current step (same labels as the 3D view). Hover syncs with the 3D model.
 */
export function PhotoPanel({ data, activeIds, highlightId, onHoverPart }: PhotoPanelProps) {
  const [imgSrc, setImgSrc] = useState<string>(data.photo || robotPhoto);
  const active = useMemo(() => new Set(activeIds), [activeIds]);

  // The box positions are hand-placed for the bundled demo photo; on an uploaded photo they
  // would point at the wrong things, so that photo is shown without boxes.
  const isDemoPhoto = imgSrc === robotPhoto;
  const boxes = useMemo(() => {
    if (!isDemoPhoto) return [];
    const perType = new Map<string, number>();
    return data.parts
      .filter((p) => active.has(p.id) || highlightId === p.id)
      .map((p) => {
        const i = perType.get(p.id) ?? 0;
        perType.set(p.id, i + 1);
        return { part: p, box: boxFor(p, i) };
      });
  }, [data.parts, active, highlightId, isDemoPhoto]);

  return (
    <div className="photo-panel">
      <div className="photo-frame">
        <img
          src={imgSrc}
          alt={`Robot photo — ${data.robot_name}`}
          draggable={false}
          onError={() => setImgSrc(robotPhoto)}
        />
        {boxes.map(({ part, box }) => {
          const [x, y, w, h] = box;
          const hot = highlightId === part.id || active.has(part.id);
          return (
            <div
              key={part.id}
              className={`photo-box ${hot ? 'hot' : ''}`}
              style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }}
              onMouseEnter={() => onHoverPart?.(part.id)}
              onMouseLeave={() => onHoverPart?.(null)}
              title={`${part.name}${part.quantity > 1 ? ` ×${part.quantity}` : ''}`}
            >
              <span className="photo-box-label">
                {part.name.toUpperCase()}{part.quantity > 1 ? ` ×${part.quantity}` : ''}
              </span>
            </div>
          );
        })}
      </div>
      <span className="robot3d-note">{isDemoPhoto ? 'Demo photo, approximate boxes for the parts in this step' : 'Your photo'}</span>
    </div>
  );
}
