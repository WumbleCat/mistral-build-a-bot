import { CatmullRomCurve3, TubeGeometry, Vector3 } from 'three';
import { useMemo } from 'react';
import { RoundedBox, Edges } from '@react-three/drei';
import type { Kind3D } from './layout3d';
import { CHASSIS_SIZE, wirePaths3d } from './layout3d';

/**
 * One small primitive-built component per part category. No external models.
 * Everything is matte; outlines come from drei <Edges> in the parent group.
 */

export const COLORS = {
  flame: '#FA500F',
  graphite: '#3A3D42',
  ink: '#17181a',
  ttMotor: '#C9B458',
  boardGreen: '#33523F',
  relayBlue: '#3E5C76',
  breadboard: '#F2EFE9',
  tyre: '#26272B',
  hub: '#8A8D93',
  wireA: '#B3543F',
  wireB: '#5C6E91',
  wireC: '#A98F3F',
};

interface MeshProps {
  kind: Kind3D;
  /** 'active' = flame orange, 'installed' = graphite, 'pending' = faint ghost */
  status: 'active' | 'installed' | 'pending';
}

type MatProps = Record<string, unknown>;

function matProps(status: MeshProps['status'], color: string, extra: MatProps = {}): MatProps {
  const ghost = status === 'pending';
  return {
    color,
    roughness: 0.8,
    metalness: 0.1,
    transparent: ghost,
    opacity: ghost ? 0.12 : 1,
    emissive: status === 'active' ? COLORS.flame : '#000000',
    emissiveIntensity: status === 'active' ? 0.35 : 0,
    ...extra,
  };
}

export function PartMesh({ kind, status }: MeshProps) {
  const body = status === 'active' ? COLORS.flame : status === 'installed' ? COLORS.graphite : COLORS.ink;
  const M = (color: string, extra?: MatProps) => <meshStandardMaterial {...matProps(status, color, extra)} />;

  switch (kind) {
    case 'chassis':
      return (
        <group>
          <RoundedBox args={CHASSIS_SIZE} radius={0.06} smoothness={4}>
            {M(body)}
          </RoundedBox>
          {[[-1.95, -1.25], [1.95, -1.25], [-1.95, 1.25], [1.95, 1.25]].map(([x, z]) => (
            <mesh key={`${x}${z}`} position={[x, 0.075, z]}>
              <cylinderGeometry args={[0.07, 0.07, 0.14, 16]} />
              {M(COLORS.ink)}
            </mesh>
          ))}
        </group>
      );
    case 'wheel':
      return (
        <group>
          <mesh>{<cylinderGeometry args={[0.34, 0.34, 0.18, 24]} />}{M(status === 'pending' ? COLORS.ink : COLORS.tyre)}</mesh>
          <mesh position={[0, 0, 0.02]}>{<cylinderGeometry args={[0.12, 0.12, 0.2, 16]} />}{M(status === 'pending' ? COLORS.ink : COLORS.hub)}</mesh>
        </group>
      );
    case 'motor':
      return (
        <group>
          <mesh position={[0, 0.02, 0.12]}>{<boxGeometry args={[0.34, 0.24, 0.3]} />}{M(status === 'pending' ? COLORS.ink : COLORS.graphite)}</mesh>
          <mesh position={[0, 0.02, -0.18]}>{<cylinderGeometry args={[0.11, 0.11, 0.36, 16]} />}{M(status === 'pending' ? COLORS.ink : COLORS.ttMotor)}</mesh>
        </group>
      );
    case 'controller':
      return (
        <group>
          <mesh>{<boxGeometry args={[1.1, 0.05, 0.72]} />}{M(status === 'pending' ? COLORS.ink : COLORS.boardGreen)}</mesh>
          {Array.from({ length: 8 }, (_, i) => (
            <mesh key={i} position={[-0.42 + i * 0.12, 0.055, -0.3]}>
              <boxGeometry args={[0.05, 0.05, 0.12]} />
              {M(COLORS.ink)}
            </mesh>
          ))}
          <mesh position={[0.48, 0.05, 0.1]}>{<boxGeometry args={[0.22, 0.08, 0.16]} />}{M(COLORS.hub)}</mesh>
        </group>
      );
    case 'driver':
      return (
        <group>
          <mesh>{<boxGeometry args={[0.62, 0.045, 0.5]} />}{M(status === 'pending' ? COLORS.ink : COLORS.relayBlue)}</mesh>
          <mesh position={[-0.15, 0.06, 0]}>{<boxGeometry args={[0.2, 0.08, 0.3]} />}{M(COLORS.hub)}</mesh>
          <mesh position={[0.18, 0.05, 0]}>{<boxGeometry args={[0.14, 0.07, 0.14]} />}{M(COLORS.relayBlue)}</mesh>
        </group>
      );
    case 'battery':
      return (
        <group>
          <mesh>{<boxGeometry args={[0.9, 0.22, 0.5]} />}{M(status === 'pending' ? COLORS.ink : COLORS.graphite)}</mesh>
          {[-0.3, -0.1, 0.1, 0.3].map((x) => (
            <mesh key={x} position={[x, 0.13, 0]}>
              <cylinderGeometry args={[0.075, 0.075, 0.05, 12]} />
              {M(status === 'pending' ? COLORS.ink : COLORS.hub)}
            </mesh>
          ))}
        </group>
      );
    case 'sensor':
      return (
        <group>
          <mesh>{<boxGeometry args={[0.7, 0.04, 0.24]} />}{M(status === 'pending' ? COLORS.ink : COLORS.boardGreen)}</mesh>
          {[-0.2, 0.2].map((x) => (
            <mesh key={x} position={[x, 0.08, 0]}>
              <cylinderGeometry args={[0.09, 0.09, 0.1, 14]} />
              {M(COLORS.hub)}
            </mesh>
          ))}
        </group>
      );
    case 'servo':
      return (
        <group>
          <mesh>{<boxGeometry args={[0.24, 0.16, 0.4]} />}{M(status === 'pending' ? COLORS.ink : '#4A6FA5')}</mesh>
          <mesh position={[0, 0.1, 0]}>{<cylinderGeometry args={[0.06, 0.06, 0.05, 12]} />}{M(COLORS.hub)}</mesh>
          <mesh position={[0, 0.12, 0.14]}>{<boxGeometry args={[0.05, 0.03, 0.3]} />}{M(COLORS.hub)}</mesh>
        </group>
      );
    case 'breadboard':
      return (
        <mesh>{<boxGeometry args={[0.85, 0.05, 0.55]} />}{M(status === 'pending' ? COLORS.ink : COLORS.breadboard)}</mesh>
      );
    case 'screw':
      return (
        <mesh>{<cylinderGeometry args={[0.05, 0.05, 0.12, 10]} />}{M(COLORS.hub)}</mesh>
      );
    case 'wire':
      return <WireSet ghost={status === 'pending'} />;
    default:
      return (
        <mesh>{<boxGeometry args={[0.4, 0.24, 0.4]} />}{M(body)}</mesh>
      );
  }
}

const WIRE_COLORS = [COLORS.wireA, COLORS.wireB, COLORS.wireC];

function WireSet({ ghost }: { ghost: boolean }) {
  const geoms = useMemo(
    () =>
      wirePaths3d().slice(0, 5).map((pts) => {
        const curve = new CatmullRomCurve3(pts.map((p) => new Vector3(...p)));
        return new TubeGeometry(curve, 20, 0.018, 6, false);
      }),
    [],
  );
  return (
    <group>
      {geoms.map((g, i) => (
        <mesh key={i} geometry={g}>
          <meshStandardMaterial
            color={WIRE_COLORS[i % WIRE_COLORS.length]}
            roughness={0.8}
            metalness={0.1}
            transparent={ghost}
            opacity={ghost ? 0.12 : 0.9}
          />
        </mesh>
      ))}
    </group>
  );
}

/** Outline wrapper: crisp dark edges, shown strongly for active/hovered parts. */
export function Outline({ strong }: { strong: boolean }) {
  return (
    <Edges threshold={15} color={COLORS.ink}>
      <lineBasicMaterial color={COLORS.ink} transparent opacity={strong ? 1 : 0.55} />
    </Edges>
  );
}
