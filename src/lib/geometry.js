/**
 * Turns a bill of materials into a 3D assembly.
 *
 * The analyzer is asked for a rough primitive per component (shape, size in mm, where it
 * sits, which layer it belongs to). That is a cheap thing for a vision model to produce and
 * a deterministic thing for us to render -- far more reliable than asking for a mesh.
 *
 * Anything the model leaves out is synthesized here from the part's category, so the
 * exploded view always renders even on a partial analysis.
 *
 * Units are millimetres throughout. The viewer divides by SCENE_SCALE at the end.
 */

export const SCENE_SCALE = 10

/** Build steps are grouped into at most this many exploded tiers. */
export const MAX_TIERS = 6

/* ------------------------------------------------------------ part finishes */

export const FINISHES = {
  metal: { color: 0xb8bec8, metalness: 0.92, roughness: 0.28 },
  steel: { color: 0x8d949f, metalness: 0.95, roughness: 0.2 },
  pcb: { color: 0x1f6b4a, metalness: 0.15, roughness: 0.62 },
  plastic: { color: 0x2f3744, metalness: 0.05, roughness: 0.78 },
  rubber: { color: 0x14171d, metalness: 0.0, roughness: 0.95 },
  acrylic: { color: 0x8fa6bd, metalness: 0.1, roughness: 0.25, opacity: 0.55 },
  copper: { color: 0xc07f43, metalness: 0.9, roughness: 0.35 },
  gold: { color: 0xd4a84b, metalness: 0.95, roughness: 0.3 },
  glass: { color: 0x9fc4d8, metalness: 0.2, roughness: 0.08, opacity: 0.45 },
}

/** Which finish a category gets when the model doesn't say. */
const CATEGORY_FINISH = {
  actuator: 'metal',
  wheel: 'rubber',
  controller: 'pcb',
  'motor-driver': 'pcb',
  electronics: 'pcb',
  sensor: 'pcb',
  power: 'plastic',
  chassis: 'acrylic',
  structure: 'metal',
  fastener: 'steel',
  bearing: 'steel',
  hardware: 'steel',
  wiring: 'copper',
  gripper: 'metal',
  kit: 'plastic',
  pcb: 'pcb',
  display: 'glass',
  optics: 'glass',
  battery: 'metal',
  connector: 'gold',
  switch: 'plastic',
  enclosure: 'metal',
}

/** Default primitive per category, in mm. */
const CATEGORY_SHAPE = {
  chassis: { shape: 'plate', size: { x: 150, y: 3, z: 100 } },
  structure: { shape: 'box', size: { x: 200, y: 20, z: 20 } },
  controller: { shape: 'plate', size: { x: 45, y: 2, z: 18 } },
  'motor-driver': { shape: 'plate', size: { x: 28, y: 2, z: 20 } },
  electronics: { shape: 'plate', size: { x: 27, y: 2, z: 27 } },
  sensor: { shape: 'plate', size: { x: 76, y: 2, z: 13 } },
  actuator: { shape: 'cylinder', size: { d: 25, h: 46 }, rotation: { x: 0, y: 0, z: 90 } },
  wheel: { shape: 'cylinder', size: { d: 65, h: 26 }, rotation: { x: 0, y: 0, z: 90 } },
  power: { shape: 'box', size: { x: 78, y: 22, z: 40 } },
  bearing: { shape: 'tube', size: { d: 22, h: 7, inner: 8 } },
  fastener: { shape: 'cylinder', size: { d: 3, h: 12 } },
  wiring: { shape: 'tube', size: { d: 6, h: 60, inner: 4 } },
  gripper: { shape: 'box', size: { x: 60, y: 40, z: 25 } },
  hardware: { shape: 'box', size: { x: 20, y: 14, z: 20 } },
  kit: { shape: 'box', size: { x: 40, y: 20, z: 40 } },
  pcb: { shape: 'plate', size: { x: 60, y: 1.6, z: 40 } },
  display: { shape: 'plate', size: { x: 62, y: 3, z: 42 } },
  optics: { shape: 'cylinder', size: { d: 34, h: 24 } },
  battery: { shape: 'box', size: { x: 60, y: 8, z: 40 } },
  connector: { shape: 'box', size: { x: 9, y: 4, z: 7 } },
  switch: { shape: 'box', size: { x: 14, y: 12, z: 14 } },
  enclosure: { shape: 'box', size: { x: 140, y: 30, z: 90 } },
}

const DEFAULT_SHAPE = { shape: 'box', size: { x: 24, y: 16, z: 24 } }

const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/* --------------------------------------------------------------- normalize */

/** Unrotated bounding size in mm, whatever the shape. */
function localExtent(geometry) {
  const s = geometry.size ?? {}
  switch (geometry.shape) {
    case 'cylinder':
    case 'tube':
      return { x: num(s.d, 20), y: num(s.h, 20), z: num(s.d, 20) }
    case 'sphere':
      return { x: num(s.d, 20), y: num(s.d, 20), z: num(s.d, 20) }
    default:
      return { x: num(s.x, 20), y: num(s.y, 20), z: num(s.z, 20) }
  }
}

const rad = (deg) => (deg * Math.PI) / 180

/**
 * Axis-aligned bounding size in mm, accounting for the part's rotation.
 *
 * This matters: an 18650 cell is a 65mm cylinder, but laid on its side it is 65mm *wide*
 * and 18mm tall. Reading its height as 65mm inflates every tier it sits in and turns the
 * whole exploded view into a tall thin ribbon.
 *
 * Rotation order matches three.js Euler 'XYZ', i.e. M = Rz · Ry · Rx.
 */
export function extentOf(geometry) {
  const e = localExtent(geometry)
  const r = geometry.rotation
  if (!r || (!r.x && !r.y && !r.z)) return e

  const [cx, sx] = [Math.cos(rad(r.x)), Math.sin(rad(r.x))]
  const [cy, sy] = [Math.cos(rad(r.y)), Math.sin(rad(r.y))]
  const [cz, sz] = [Math.cos(rad(r.z)), Math.sin(rad(r.z))]

  // Rows of Rz · Ry · Rx.
  const m = [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ]

  // Half-extent of the rotated box: |M| applied to the half-extents.
  const h = [e.x / 2, e.y / 2, e.z / 2]
  const out = m.map((row) => Math.abs(row[0]) * h[0] + Math.abs(row[1]) * h[1] + Math.abs(row[2]) * h[2])

  return { x: out[0] * 2, y: out[1] * 2, z: out[2] * 2 }
}

function normalizeOne(component) {
  const category = (component.category ?? '').toLowerCase()
  const supplied = component.geometry ?? null
  const base = CATEGORY_SHAPE[category] ?? DEFAULT_SHAPE

  const shape = supplied?.shape ?? base.shape
  const size = supplied?.size_mm ?? supplied?.size ?? base.size
  const rotation = supplied?.rotation_deg ?? supplied?.rotation ?? base.rotation ?? { x: 0, y: 0, z: 0 }
  const finish = supplied?.finish ?? CATEGORY_FINISH[category] ?? 'plastic'

  return {
    shape,
    size,
    rotation: { x: num(rotation.x, 0), y: num(rotation.y, 0), z: num(rotation.z, 0) },
    finish: FINISHES[finish] ? finish : 'plastic',
    position: supplied?.position_mm ?? supplied?.position ?? null,
    layer: num(supplied?.layer, null),
  }
}

/* ------------------------------------------------------------ layer + pose */

/**
 * Explode order follows build order: a part's layer is the first assembly step that
 * mentions it. Parts no step mentions are stacked after the ones that are.
 */
function layersFromSteps(components, steps) {
  const layerByComponentId = new Map()

  for (const step of steps ?? []) {
    for (const name of step.component_names ?? []) {
      const needle = name.toLowerCase().trim()
      for (const c of components) {
        if (layerByComponentId.has(c.id)) continue
        const hay = c.name.toLowerCase()
        if (hay.includes(needle) || needle.includes(hay)) {
          layerByComponentId.set(c.id, step.step_number)
        }
      }
    }
  }
  return layerByComponentId
}

/**
 * Build a renderable layout.
 *
 * Returns one entry per *instance* (a quantity-3 part becomes three instances), each with
 * its assembled position and the direction it travels when the view explodes.
 */
export function buildLayout(project) {
  const components = (project.components ?? []).filter((c) => !c.is_hidden)
  const steps = project.assembly_steps ?? []
  const stepLayers = layersFromSteps(components, steps)

  // Resolve a layer for every component, then compact to 0..n-1.
  const withLayer = components.map((c, i) => {
    const g = normalizeOne(c)
    const layer = g.layer ?? stepLayers.get(c.id) ?? steps.length + i
    return { component: c, geometry: g, layer }
  })

  // Collapse the build sequence into a handful of tiers. One tier per assembly step
  // makes a tall thin stack that reads as a sliver on screen; grouping keeps the build
  // order intact while giving the exploded view a workable aspect ratio.
  const order = [...new Set(withLayer.map((w) => w.layer))].sort((a, b) => a - b)
  const tiers = Math.min(order.length, MAX_TIERS)
  const layerIndex = new Map(
    order.map((l, i) => [l, order.length ? Math.floor((i * tiers) / order.length) : 0]),
  )

  // Lay out each layer as a row, centred, so nothing overlaps when exploded.
  const byLayer = new Map()
  for (const item of withLayer) {
    const idx = layerIndex.get(item.layer)
    if (!byLayer.has(idx)) byLayer.set(idx, [])
    byLayer.get(idx).push(item)
  }

  const parts = []
  let stackY = 0
  const layerGap = 14
  const columnGap = 16
  let tallestLayer = 1

  for (const idx of [...byLayer.keys()].sort((a, b) => a - b)) {
    const items = byLayer.get(idx)

    // One column per component. Quantities fan along Z inside their own column, so a
    // pair of motors reads as a pair rather than widening the row.
    const columns = items.map((item) => ({
      item,
      extent: extentOf(item.geometry),
      count: Math.min(Math.max(item.component.quantity ?? 1, 1), 6),
    }))

    const totalWidth =
      columns.reduce((sum, c) => sum + c.extent.x, 0) + columnGap * Math.max(0, columns.length - 1)
    const layerHeight = Math.max(...columns.map((c) => c.extent.y), 1)
    tallestLayer = Math.max(tallestLayer, layerHeight)

    let cursor = -totalWidth / 2
    for (const { item, extent, count } of columns) {
      for (let n = 0; n < count; n++) {
        const supplied = item.geometry.position
        const position = supplied
          ? { x: num(supplied.x, 0), y: num(supplied.y, stackY), z: num(supplied.z, 0) }
          : {
              x: cursor + extent.x / 2,
              y: stackY + layerHeight / 2,
              z: count > 1 ? (n - (count - 1) / 2) * (extent.z + 8) : 0,
            }

        parts.push({
          key: `${item.component.id}:${n}`,
          componentId: item.component.id,
          name: item.component.name,
          category: item.component.category,
          quantity: item.component.quantity,
          layer: idx,
          stepNumber: stepLayers.get(item.component.id) ?? null,
          geometry: item.geometry,
          extent,
          position,
          isFirstInstance: n === 0,
        })
      }
      cursor += extent.x + columnGap
    }

    stackY += layerHeight + layerGap
  }

  // Recentre on the origin. Without this the stack grows upward from y=0 while the
  // camera targets the origin, which puts the whole assembly off frame.
  const bounds = boundsOf(parts)
  for (const part of parts) {
    part.position.x -= bounds.center.x
    part.position.y -= bounds.center.y
    part.position.z -= bounds.center.z
  }

  // Separation scales with how thick the layers actually are, so a dense build doesn't
  // fly apart and a sparse one doesn't stay clumped. Capped against the footprint so a
  // tall stack of layers doesn't become an unreadable sliver on screen.
  const footprint = Math.max(bounds.size.x, bounds.size.z, 1)
  const spread = Math.max(1, byLayer.size - 1)
  const roomy = (footprint * 2.4 - bounds.size.y) / spread
  const explodeDistance = Math.min(Math.max(28, tallestLayer * 1.15), Math.max(28, roomy))

  return {
    parts,
    layerCount: byLayer.size,
    explodeDistance,
    bounds: boundsOf(parts),
    height: stackY,
    span: { x: bounds.size.x, z: bounds.size.z },
  }
}

/** Axis-aligned bounds of a set of positioned parts, in mm. */
export function boundsOf(parts) {
  if (!parts.length) {
    return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 }, center: { x: 0, y: 0, z: 0 } }
  }

  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }

  for (const p of parts) {
    // Rotation can swap a part's axes, so use its largest dimension as a safe radius.
    const r = Math.max(p.extent.x, p.extent.y, p.extent.z) / 2
    for (const axis of ['x', 'y', 'z']) {
      min[axis] = Math.min(min[axis], p.position[axis] - r)
      max[axis] = Math.max(max[axis], p.position[axis] + r)
    }
  }

  return {
    min,
    max,
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

/**
 * How far a part moves at full explode. Layers fan out along the build axis so the
 * assembly reads bottom-to-top in build order, like a teardown plate.
 */
export function explodeOffset(part, layout) {
  const centred = part.layer - (layout.layerCount - 1) / 2
  return centred * layout.explodeDistance
}

/**
 * Vertical half-height at a given explode amount, used to keep the camera framed.
 * The camera follows the slider so parts stay large when the stack is closed.
 */
export function halfHeightAt(layout, explode = 1) {
  if (!layout.parts.length) return 1
  let half = 0
  for (const part of layout.parts) {
    const reach =
      Math.abs(part.position.y + explodeOffset(part, layout) * explode) + part.extent.y / 2
    half = Math.max(half, reach)
  }
  return half
}

/** Half-height at full explode. */
export function explodedHalfHeight(layout) {
  return halfHeightAt(layout, 1)
}
