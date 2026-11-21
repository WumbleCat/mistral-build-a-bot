import { CatmullRomCurve3, TubeGeometry, Vector3 } from 'three';
import { useMemo } from 'react';
import { RoundedBox, Edges } from '@react-three/drei';
import type { Kind3D } from './layout3d';
import { CHASSIS_SIZE, WHEEL_R, wirePaths3d } from './layout3d';
import type { Part } from '../../types';

/**
 * Real-world materials per part category. Orange #FA500F is used ONLY as the
 * active-part glow (emissive + outline) — never as a body colour.
 */

export const COLORS = {
  flame: '#FA500F',
  amber: '#FFAF00',
  orange: '#FF8205',
  ink: '#0E1016',
  // real-world materials
  tyre: '#17181C',
  tread: '#0B0C0F',
  hub: '#9AA0A6',
  chassisGreen: '#39D353',
  pcbGreen: '#1F6F43',
  arduinoBlue: '#00878F',
  relayBlue: '#1E5BB8',
  servoBlue: '#3E6FB0',
  gold: '#D4AF37',
  batteryBlack: '#1A1B1F',
  leadRed: '#C0392B',
  leadBlack: '#111214',
  breadboardWhite: '#EDEAE3',
  ttMotor: '#C9B458',
  gearbox: '#3A3D42',
  usb: '#B9BEC7',
  wireRed: '#C0392B',
  wireYellow: '#F1C40F',
  wirePurple: '#8E44AD',
  steel: '#8A90A0',
};

/** Detect a colour word from the part's photo-derived text (chassis etc.). */
export function detectPartColor(part: Part): string | null {
  const hay = `${part.name} ${part.description ?? ''} ${part.notes ?? ''}`.toLowerCase();
  const map: Array<[RegExp, string]> = [
    [/green/, '#39D353'],
    [/black/, '#1A1B1F'],
    [/red/, '#C0392B'],
    [/blue/, '#00878F'],
    [/yellow/, '#C9B458'],
    [/white/, '#EDEAE3'],
    [/silver|grey|gray/, '#9AA0A6'],
    [/orange/, '#FF8205'],
  ];
  for (const [re, c] of map) if (re.test(hay)) return c;
  return null;
}

interface MeshProps {
  kind: Kind3D;
  part: Part;
  status: 'active' | 'installed' | 'pending';
}

type MatProps = Record<string, unknown>;

function matProps(status: MeshProps['status'], color: string, extra: MatProps = {}): MatProps {
  if (status === 'active') {
    // real colour + soft orange glow pulse (handled by parent scale/emissive)
    return {
      color,
      roughness: 0.55,
      metalness: 0.15,
      emissive: COLORS.flame,
      emissiveIntensity: 0.45,
      ...extra,
    };
  }
  return { color, roughness: 0.75, metalness: 0.12, ...extra };
}

export function PartMesh({ kind, part, status }: MeshProps) {
  if (status === 'pending') return null; // hidden; slot marker drawn by parent
  const M = (color: string, extra?: MatProps) => <meshStandardMaterial {...matProps(status, color, extra)} />;

  switch (kind) {
    case 'chassis': {
      const c = detectPartColor(part) ?? COLORS.chassisGreen;
      return (
        <group>
          <RoundedBox args={CHASSIS_SIZE} radius={0.05} smoothness={6}>
            {M(c)}
          </RoundedBox>
          {/* mounting holes */}
          {[[-0.86, -0.46], [0.86, -0.46], [-0.86, 0.46], [0.86, 0.46]].map(([x, z]) => (
            <mesh key={`${x}${z}`} position={[x, 0.055, z]}>
              <cylinderGeometry args={[0.035, 0.035, 0.09, 24]} />
              {M('#0B0C0F')}
            </mesh>
          ))}
        </group>
      );
    }
    case 'wheel':
      return (
        <group>
          {/* tyre */}
          <mesh>
            <cylinderGeometry args={[WHEEL_R, WHEEL_R, 0.14, 48]} />
            {M(COLORS.tyre, { roughness: 0.95, metalness: 0 })}
          </mesh>
          {/* tread rings */}
          {[-0.045, 0, 0.045].map((z) => (
            <mesh key={z} position={[0, 0, z]} rotation={[Math.PI / 2, 0, 0]}>
              <torusGeometry args={[WHEEL_R + 0.008, 0.014, 8, 48]} />
              {M(COLORS.tread, { roughness: 1 })}
            </mesh>
          ))}
          {/* hub */}
          <mesh position={[0, 0, 0.02]}>
            <cylinderGeometry args={[0.13, 0.13, 0.16, 48]} />
            {M(COLORS.hub)}
          </mesh>
          <mesh position={[0, 0, 0.085]}>
            <cylinderGeometry args={[0.045, 0.045, 0.02, 24]} />
            {M(COLORS.steel)}
          </mesh>
        </group>
      );
    case 'motor':
      return (
        <group>
          {/* gearbox */}
          <mesh position={[0.09, 0, 0]}>
            <boxGeometry args={[0.16, 0.18, 0.14]} />
            {M(COLORS.gearbox)}
          </mesh>
          {/* motor can (TT yellow) */}
          <mesh position={[-0.08, 0, 0]}>
            <cylinderGeometry args={[0.075, 0.075, 0.26, 48]} />
            {M(COLORS.ttMotor)}
          </mesh>
        </group>
      );
    case 'controller': {
      const blue = /arduino|uno|nano/i.test(`${part.id} ${part.name}`);
      return (
        <group>
          <mesh>
            <boxGeometry args={[0.53, 0.025, 0.35]} />
            {M(blue ? COLORS.arduinoBlue : COLORS.pcbGreen)}
          </mesh>
          {/* header pins: gold */}
          {Array.from({ length: 8 }, (_, i) => (
            <mesh key={`a${i}`} position={[-0.2 + i * 0.057, 0.028, -0.15]}>
              <boxGeometry args={[0.02, 0.035, 0.05]} />
              {M(COLORS.gold, { metalness: 0.8, roughness: 0.3 })}
            </mesh>
          ))}
          {Array.from({ length: 6 }, (_, i) => (
            <mesh key={`b${i}`} position={[-0.15 + i * 0.06, 0.028, 0.15]}>
              <boxGeometry args={[0.02, 0.035, 0.05]} />
              {M(COLORS.gold, { metalness: 0.8, roughness: 0.3 })}
            </mesh>
          ))}
          {/* USB block */}
          <mesh position={[0.24, 0.03, 0.05]}>
            <boxGeometry args={[0.1, 0.05, 0.09]} />
            {M(COLORS.usb, { metalness: 0.6, roughness: 0.4 })}
          </mesh>
        </group>
      );
    }
    case 'driver':
      return (
        <group>
          <mesh>
            <boxGeometry args={[0.3, 0.02, 0.24]} />
            {M(COLORS.pcbGreen)}
          </mesh>
          {/* relay cubes (blue) or heatsink */}
          {/relay/.test(`${part.id} ${part.name}`.toLowerCase()) ? (
            <>
              {[-0.08, 0.07].map((x) => (
                <mesh key={x} position={[x, 0.045, 0]}>
                  <boxGeometry args={[0.06, 0.06, 0.06]} />
                  {M(COLORS.relayBlue)}
                </mesh>
              ))}
            </>
          ) : (
            <mesh position={[-0.06, 0.04, 0]}>
              <boxGeometry args={[0.12, 0.05, 0.16]} />
              {M(COLORS.steel, { metalness: 0.5, roughness: 0.5 })}
            </mesh>
          )}
        </group>
      );
    case 'battery':
      return (
        <group>
          <mesh>
            <boxGeometry args={[0.42, 0.14, 0.26]} />
            {M(COLORS.batteryBlack)}
          </mesh>
          {/* red/black leads */}
          <mesh position={[-0.12, 0.1, 0]}>
            <cylinderGeometry args={[0.012, 0.012, 0.3, 12]} />
            {M(COLORS.leadRed)}
          </mesh>
          <mesh position={[0.12, 0.1, 0]}>
            <cylinderGeometry args={[0.012, 0.012, 0.3, 12]} />
            {M(COLORS.leadBlack)}
          </mesh>
          {/* cells hint */}
          {[-0.12, 0, 0.12].map((x) => (
            <mesh key={x} position={[x, 0.075, 0]}>
              <cylinderGeometry args={[0.045, 0.045, 0.03, 32]} />
              {M(COLORS.steel)}
            </mesh>
          ))}
        </group>
      );
    case 'sensor':
      return (
        <group>
          <mesh>
            <boxGeometry args={[0.32, 0.02, 0.12]} />
            {M(COLORS.pcbGreen)}
          </mesh>
          {[-0.09, 0.09].map((x) => (
            <mesh key={x} position={[x, 0.05, 0]}>
              <cylinderGeometry args={[0.045, 0.045, 0.06, 48]} />
              {M(COLORS.usb, { metalness: 0.7, roughness: 0.3 })}
            </mesh>
          ))}
        </group>
      );
    case 'servo':
      return (
        <group>
          <mesh>
            <boxGeometry args={[0.12, 0.09, 0.22]} />
            {M(COLORS.servoBlue)}
          </mesh>
          <mesh position={[0, 0.06, 0]}>
            <cylinderGeometry args={[0.03, 0.03, 0.03, 24]} />
            {M(COLORS.steel)}
          </mesh>
          <mesh position={[0, 0.075, 0.08]}>
            <boxGeometry args={[0.025, 0.015, 0.16]} />
            {M('#EDEAE3')}
          </mesh>
        </group>
      );
    case 'breadboard':
      return (
        <group>
          <mesh>
            <boxGeometry args={[0.42, 0.025, 0.27]} />
            {M(COLORS.breadboardWhite)}
          </mesh>
          <mesh position={[0, 0.014, -0.1]}>
            <boxGeometry args={[0.36, 0.006, 0.015]} />
            {M(COLORS.leadRed)}
          </mesh>
          <mesh position={[0, 0.014, 0.1]}>
            <boxGeometry args={[0.36, 0.006, 0.015]} />
            {M('#3E6FB0')}
          </mesh>
        </group>
      );
    case 'screw':
      return (
        <mesh>
          <cylinderGeometry args={[0.025, 0.025, 0.06, 24]} />
          {M(COLORS.steel, { metalness: 0.7, roughness: 0.35 })}
        </mesh>
      );
    case 'wire':
      return <WireSet />;
    default:
      return (
        <RoundedBox args={[0.2, 0.12, 0.2]} radius={0.02} smoothness={4}>
          {M(detectPartColor(part) ?? COLORS.gearbox)}
        </RoundedBox>
      );
  }
}

const WIRE_COLORS = [COLORS.wireRed, COLORS.wireYellow, COLORS.wirePurple];

function WireSet() {
  const geoms = useMemo(
    () =>
      wirePaths3d().slice(0, 5).map((pts) => {
        const curve = new CatmullRomCurve3(pts.map((p) => new Vector3(...p)));
        return new TubeGeometry(curve, 24, 0.011, 8, false);
      }),
    [],
  );
  return (
    <group>
      {geoms.map((g, i) => (
        <mesh key={i} geometry={g}>
          <meshStandardMaterial color={WIRE_COLORS[i % WIRE_COLORS.length]} roughness={0.6} metalness={0.05} />
        </mesh>
      ))}
    </group>
  );
}

/** Outline: dark edges normally, flame glow for the active part. */
export function Outline({ active }: { active: boolean }) {
  return (
    <Edges threshold={18} color={active ? COLORS.flame : '#0B0C0F'}>
      <lineBasicMaterial color={active ? COLORS.flame : '#0B0C0F'} transparent opacity={active ? 0.95 : 0.5} />
    </Edges>
  );
}
