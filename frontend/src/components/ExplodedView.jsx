import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { Box, Download, Layers, Maximize2, Moon, Sun } from 'lucide-react'
import { buildLayout, explodeOffset, FINISHES, halfHeightAt, SCENE_SCALE } from '../lib/geometry'
import { money } from '../lib/format'

/* ------------------------------------------------------------ mesh factory */

function makeGeometry(spec) {
  const s = spec.size ?? {}
  switch (spec.shape) {
    case 'cylinder': {
      const r = (s.d ?? 20) / 2
      return new THREE.CylinderGeometry(r, r, s.h ?? 20, 48)
    }
    case 'tube': {
      const outer = (s.d ?? 20) / 2
      const inner = Math.min((s.inner ?? outer * 0.6) / 2, outer * 0.95)
      const shape = new THREE.Shape()
      shape.absarc(0, 0, outer, 0, Math.PI * 2, false)
      const hole = new THREE.Path()
      hole.absarc(0, 0, inner, 0, Math.PI * 2, true)
      shape.holes.push(hole)
      const depth = s.h ?? 10
      const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 32 })
      geo.translate(0, 0, -depth / 2)
      geo.rotateX(Math.PI / 2)
      return geo
    }
    case 'sphere':
      return new THREE.SphereGeometry((s.d ?? 20) / 2, 32, 24)
    case 'plate':
    case 'box':
    default:
      return new THREE.BoxGeometry(s.x ?? 20, s.y ?? 20, s.z ?? 20)
  }
}

const THEMES = {
  light: {
    background: 0xf1efea,
    edge: 0x2b2f36,
    ground: 0xd8d2c6,
    hemiSky: 0xffffff,
    hemiIntensity: 0.9,
    shadowOpacity: 0.16,
    leader: '#2b2f36',
  },
  dark: {
    background: 0x0d0f14,
    edge: 0xc8d0dd,
    ground: 0x12151c,
    hemiSky: 0x5b6b86,
    hemiIntensity: 0.6,
    shadowOpacity: 0.38,
    leader: '#7c8697',
  },
}

const VIEW_DIR = new THREE.Vector3(0.58, 0.44, 0.69).normalize()
const FOV = 36
const LABEL_SPACING = 25
const LABEL_MARGIN = 10

/**
 * Lets a parent drive a value while keeping the component usable on its own.
 * Passing `value` makes it controlled; leaving it undefined keeps internal state.
 */
function useControlled(value, onChange, initial) {
  const [internal, setInternal] = useState(initial)
  const isControlled = value !== undefined
  const current = isControlled ? value : internal

  const set = useCallback(
    (next) => {
      const resolved = typeof next === 'function' ? next(current) : next
      if (!isControlled) setInternal(resolved)
      onChange?.(resolved)
    },
    [current, isControlled, onChange],
  )

  return [current, set]
}

/* ------------------------------------------------------------------ viewer */

export default function ExplodedView({
  project,
  /** Strip the frame, controls and footnote -- for embedding inside another layout. */
  bare = false,
  showCallouts = true,
  showControls = true,
  heightClass = 'h-[32rem] sm:h-[38rem]',
  selected: selectedProp,
  onSelect,
  explode: explodeProp,
  onExplodeChange,
  theme: themeProp,
  /** Called with [{componentId, x, y}] in client coords whenever the view redraws. */
  onProject,
}) {
  const mountRef = useRef(null)
  const sceneRef = useRef(null)
  const labelRefs = useRef(new Map())
  const lineRefs = useRef(new Map())
  const dotRefs = useRef(new Map())

  const [explode, setExplode] = useControlled(explodeProp, onExplodeChange, 0.5)
  const [selected, setSelected] = useControlled(selectedProp, onSelect, null)
  const [theme, setTheme] = useState(themeProp ?? 'light')
  const [stepFilter, setStepFilter] = useState(null)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    if (themeProp) setTheme(themeProp)
  }, [themeProp])

  // Read inside the render loop without re-creating it.
  const filterRef = useRef(null)
  const selectedRef = useRef(null)
  const calloutsRef = useRef(true)
  const projectRef = useRef(null)
  filterRef.current = stepFilter
  selectedRef.current = selected
  calloutsRef.current = showCallouts
  projectRef.current = onProject

  const layout = useMemo(() => buildLayout(project), [project])

  const componentsById = useMemo(
    () => new Map((project.components ?? []).map((c) => [c.id, c])),
    [project.components],
  )
  const labelParts = useMemo(() => layout.parts.filter((p) => p.isFirstInstance), [layout])
  const stepNumbers = useMemo(
    () => [...new Set(layout.parts.map((p) => p.stepNumber).filter(Boolean))].sort((a, b) => a - b),
    [layout],
  )

  /* ------------------------------------------------------------ scene init */
  useEffect(() => {
    const mount = mountRef.current
    if (!mount || !layout.parts.length) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(THEMES.light.background)

    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 20000)
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    mount.appendChild(renderer.domElement)

    // A room environment gives the metal parts something to reflect. Without it
    // everything reads as flat plastic.
    const pmrem = new THREE.PMREMGenerator(renderer)
    const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environment = envMap

    const hemi = new THREE.HemisphereLight(0xffffff, THEMES.light.ground, 0.9)
    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.bias = -0.0008
    const fill = new THREE.DirectionalLight(0xffffff, 0.4)
    scene.add(hemi, key, fill)

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(20000, 20000),
      new THREE.ShadowMaterial({ opacity: THEMES.light.shadowOpacity }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    scene.add(ground)

    const assembly = new THREE.Group()
    assembly.scale.setScalar(1 / SCENE_SCALE)
    scene.add(assembly)

    const meshes = []
    for (const part of layout.parts) {
      const finish = FINISHES[part.geometry.finish] ?? FINISHES.plastic
      const geometry = makeGeometry(part.geometry)

      const material = new THREE.MeshStandardMaterial({
        color: finish.color,
        metalness: finish.metalness,
        roughness: finish.roughness,
        transparent: finish.opacity != null,
        opacity: finish.opacity ?? 1,
        envMapIntensity: 0.85,
      })

      const mesh = new THREE.Mesh(geometry, material)
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.rotation.set(
        THREE.MathUtils.degToRad(part.geometry.rotation.x),
        THREE.MathUtils.degToRad(part.geometry.rotation.y),
        THREE.MathUtils.degToRad(part.geometry.rotation.z),
      )
      mesh.userData.part = part

      // Edge overlay is what makes it read as a technical drawing rather than a render.
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry, 30),
        new THREE.LineBasicMaterial({ color: THEMES.light.edge, transparent: true, opacity: 0.5 }),
      )
      mesh.add(edges)

      assembly.add(mesh)
      meshes.push({ mesh, part, material, edges, baseOpacity: finish.opacity ?? 1 })
    }

    /* --- framing ---
     * Distance is derived from how tall the stack actually is right now, so the parts
     * stay large when it is closed and everything still fits when it is wide open.
     */
    const halfWidth = Math.max(layout.bounds.size.x, layout.bounds.size.z) / 2 / SCENE_SCALE
    const sinHalfFov = Math.sin(THREE.MathUtils.degToRad(FOV / 2))

    /**
     * Bounding radius at a given explode amount, in scene units.
     *
     * Using the diagonal would frame a sphere around the model and leave a third of the
     * viewport empty for anything taller than it is wide. The larger half-extent plus a
     * small margin fills the frame; the user can still orbit and zoom out.
     */
    function radiusFor(amount) {
      const halfHeight = halfHeightAt(layout, amount) / SCENE_SCALE
      return Math.max(Math.max(halfWidth, halfHeight) * 1.06, 1)
    }

    function distanceFor(amount) {
      return (radiusFor(amount) / sinHalfFov) * 1.08
    }

    // Shadow frustum and zoom limits are sized for the widest case: fully exploded.
    const radius = radiusFor(1)
    const distance = distanceFor(1)

    key.position.copy(new THREE.Vector3(0.6, 1.1, 0.5).multiplyScalar(distance))
    key.shadow.camera.near = distance * 0.05
    key.shadow.camera.far = distance * 4
    const shadowExtent = radius * 1.6
    Object.assign(key.shadow.camera, {
      left: -shadowExtent,
      right: shadowExtent,
      top: shadowExtent,
      bottom: -shadowExtent,
    })
    key.shadow.camera.updateProjectionMatrix()
    fill.position.copy(new THREE.Vector3(-0.7, 0.4, -0.6).multiplyScalar(distance))

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.minDistance = radius * 0.5
    controls.maxDistance = distance * 3
    controls.maxPolarAngle = Math.PI * 0.49
    controls.target.set(0, 0, 0)

    function frame(amount = 1) {
      camera.position.copy(VIEW_DIR).multiplyScalar(distanceFor(amount))
      controls.target.set(0, 0, 0)
      controls.update()
    }

    /** Dolly to suit the current explode without disturbing the user's orbit angle. */
    function refit(amount) {
      const direction = camera.position.clone().sub(controls.target)
      if (direction.lengthSq() < 1e-6) return
      camera.position.copy(controls.target).add(direction.setLength(distanceFor(amount)))
      controls.update()
    }

    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    let dirty = true
    const markDirty = () => {
      dirty = true
    }
    controls.addEventListener('change', markDirty)

    function resize() {
      const w = mount.clientWidth
      const h = mount.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      markDirty()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(mount)
    resize()

    // A drag should orbit, not select; only treat it as a click if the pointer barely moved.
    let downAt = null
    function onPointerDown(e) {
      downAt = { x: e.clientX, y: e.clientY }
    }
    function onPointerUp(e) {
      if (!downAt) return
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y)
      downAt = null
      if (moved > 4) return

      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      const hit = raycaster.intersectObjects(assembly.children, false)[0]
      setSelected((current) => {
        const next = hit ? hit.object.userData.part.componentId : null
        return next === current ? null : next
      })
    }
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointerup', onPointerUp)

    /* --------------------------------------------------- callout placement --
     * Labels are positioned straight on the DOM nodes. Doing this through React
     * state would re-render the whole tab on every animation frame.
     */
    const projected = new THREE.Vector3()

    function placeLabels() {
      const w = mount.clientWidth
      const h = mount.clientHeight
      if (!w || !h) return

      const rect = renderer.domElement.getBoundingClientRect()
      const projections = []
      const visible = []

      for (const { mesh, part } of meshes) {
        if (!part.isFirstInstance) continue

        const hidden = filterRef.current && part.stepNumber !== filterRef.current

        // Where this part lands on screen, for whoever is drawing leader lines.
        mesh.getWorldPosition(projected)
        projected.project(camera)
        if (!hidden && projected.z <= 1) {
          projections.push({
            componentId: part.componentId,
            x: rect.left + ((projected.x + 1) / 2) * w,
            y: rect.top + ((-projected.y + 1) / 2) * h,
          })
        }

        if (!calloutsRef.current) continue

        if (hidden) {
          const el = labelRefs.current.get(part.key)
          if (el) el.style.opacity = '0'
          const line = lineRefs.current.get(part.key)
          if (line) line.style.opacity = '0'
          const dot = dotRefs.current.get(part.key)
          if (dot) dot.style.opacity = '0'
          continue
        }

        visible.push({
          part,
          sx: ((projected.x + 1) / 2) * w,
          sy: ((-projected.y + 1) / 2) * h,
          behind: projected.z > 1,
        })
      }

      projectRef.current?.(projections)
      if (!calloutsRef.current) return

      // Two gutters. Each is sorted by the part's own height on screen, then pushed
      // apart just enough that no two labels overlap.
      for (const side of ['left', 'right']) {
        const column = visible
          .filter((v) => (side === 'left' ? v.sx < w / 2 : v.sx >= w / 2))
          .sort((a, b) => a.sy - b.sy)

        let y = LABEL_MARGIN
        for (const entry of column) {
          entry.ly = Math.max(y, entry.sy - 9)
          y = entry.ly + LABEL_SPACING
        }

        const overflow = y - LABEL_SPACING + 22 - (h - LABEL_MARGIN)
        if (overflow > 0) for (const entry of column) entry.ly -= overflow

        for (const entry of column) {
          entry.ly = Math.min(Math.max(entry.ly, LABEL_MARGIN), h - 24)
          entry.side = side
        }
      }

      const active = selectedRef.current
      for (const entry of visible) {
        const { part, sx, sy, ly, side, behind } = entry
        const el = labelRefs.current.get(part.key)
        const line = lineRefs.current.get(part.key)
        const dot = dotRefs.current.get(part.key)
        if (!el || !line || !dot) continue

        const dim = active && active !== part.componentId
        const opacity = behind ? '0.25' : dim ? '0.3' : '1'

        el.style.transform = `translateY(${ly}px)`
        el.style.opacity = opacity

        const width = el.offsetWidth || 120
        const innerEdge = side === 'left' ? LABEL_MARGIN + width : w - LABEL_MARGIN - width
        const elbow = side === 'left' ? innerEdge + 14 : innerEdge - 14
        const anchorY = ly + 9

        line.setAttribute('points', `${innerEdge},${anchorY} ${elbow},${anchorY} ${sx},${sy}`)
        line.style.opacity = behind ? '0.1' : dim ? '0.12' : '0.45'

        dot.setAttribute('cx', sx)
        dot.setAttribute('cy', sy)
        dot.style.opacity = behind ? '0' : dim ? '0.2' : '0.8'
      }
    }

    let frameId
    function tick() {
      frameId = requestAnimationFrame(tick)
      const moving = controls.update()
      if (!dirty && !moving) return
      dirty = false
      renderer.render(scene, camera)
      placeLabels()
    }

    sceneRef.current = {
      scene, camera, renderer, controls, assembly, meshes, ground, hemi,
      markDirty, frame, refit, distance,
    }
    frame(0.5)
    tick()

    return () => {
      cancelAnimationFrame(frameId)
      observer.disconnect()
      controls.removeEventListener('change', markDirty)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      controls.dispose()
      for (const { mesh, edges } of meshes) {
        mesh.geometry.dispose()
        mesh.material.dispose()
        edges.geometry.dispose()
        edges.material.dispose()
      }
      ground.geometry.dispose()
      ground.material.dispose()
      envMap.dispose()
      pmrem.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement)
      sceneRef.current = null
    }
  }, [layout])

  /* ------------------------------------------- explode / selection / dimming */
  useEffect(() => {
    const state = sceneRef.current
    if (!state) return

    let lowest = Infinity
    for (const { mesh, part, material, edges, baseOpacity } of state.meshes) {
      const offset = explodeOffset(part, layout) * explode
      mesh.position.set(part.position.x, part.position.y + offset, part.position.z)
      lowest = Math.min(lowest, part.position.y + offset - part.extent.y / 2)

      const dimmed =
        (selected && part.componentId !== selected) ||
        (stepFilter && part.stepNumber !== stepFilter)
      const highlighted = selected && part.componentId === selected

      material.transparent = dimmed || baseOpacity < 1
      material.opacity = dimmed ? 0.12 : baseOpacity
      material.emissive.setHex(highlighted ? 0xf97316 : 0x000000)
      material.emissiveIntensity = highlighted ? 0.3 : 0
      edges.material.opacity = dimmed ? 0.06 : 0.5
      mesh.castShadow = !dimmed
    }

    // Keep the contact shadow just under the lowest part as the stack opens up.
    state.ground.position.y = lowest / SCENE_SCALE - 1.5
    state.refit(explode)
    state.markDirty()
  }, [explode, selected, stepFilter, layout])

  /* --------------------------------------------------------------- theming */
  useEffect(() => {
    const state = sceneRef.current
    if (!state) return
    const palette = THEMES[theme]

    state.scene.background = new THREE.Color(palette.background)
    state.ground.material.opacity = palette.shadowOpacity
    state.hemi.color.setHex(palette.hemiSky)
    state.hemi.groundColor.setHex(palette.ground)
    state.hemi.intensity = palette.hemiIntensity
    for (const { edges } of state.meshes) edges.material.color.setHex(palette.edge)
    state.markDirty()
  }, [theme])

  /* --------------------------------------------------------------- actions */
  const resetView = useCallback(() => {
    sceneRef.current?.frame(explode)
    sceneRef.current?.markDirty()
  }, [explode])

  const downloadGlb = useCallback(() => {
    const state = sceneRef.current
    if (!state) return
    setExporting(true)
    new GLTFExporter().parse(
      state.assembly,
      (result) => {
        const blob = new Blob([result], { type: 'model/gltf-binary' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${(project.device_name ?? project.title).replace(/\s+/g, '-').toLowerCase()}.glb`
        a.click()
        URL.revokeObjectURL(url)
        setExporting(false)
      },
      () => setExporting(false),
      { binary: true },
    )
  }, [project.device_name, project.title])

  const selectedComponent = selected ? componentsById.get(selected) : null
  const palette = THEMES[theme]

  if (!layout.parts.length) {
    return (
      <div className="card grid place-items-center py-16 text-center">
        <Box className="mb-3 size-6 text-line-strong" />
        <p className="text-sm text-muted">No parts to lay out yet.</p>
      </div>
    )
  }

  const stage = (
    <>
      <div
        ref={mountRef}
        className={`w-full cursor-grab touch-none active:cursor-grabbing ${bare ? 'h-full' : heightClass}`}
      />

      {/* Leader lines and anchor dots, positioned imperatively each frame. */}
      {showCallouts && (
        <svg className="pointer-events-none absolute inset-0 size-full overflow-visible">
          {labelParts.map((part) => (
            <g key={part.key}>
              <polyline
                ref={(el) => {
                  if (el) lineRefs.current.set(part.key, el)
                  else lineRefs.current.delete(part.key)
                }}
                points=""
                fill="none"
                stroke={palette.leader}
                strokeWidth="1"
                style={{ opacity: 0 }}
              />
              <circle
                ref={(el) => {
                  if (el) dotRefs.current.set(part.key, el)
                  else dotRefs.current.delete(part.key)
                }}
                r="2.5"
                fill={palette.leader}
                style={{ opacity: 0 }}
              />
            </g>
          ))}
        </svg>
      )}

      {showCallouts &&
        labelParts.map((part) => {
          const onLeft = part.position.x < 0
          return (
            <button
              key={part.key}
              ref={(el) => {
                if (el) labelRefs.current.set(part.key, el)
                else labelRefs.current.delete(part.key)
              }}
              type="button"
              onClick={() => setSelected((c) => (c === part.componentId ? null : part.componentId))}
              style={{ top: 0, [onLeft ? 'left' : 'right']: LABEL_MARGIN, opacity: 0 }}
              className={[
                'absolute max-w-[15rem] truncate rounded-md border px-1.5 py-0.5 text-[11px] font-medium transition-colors',
                theme === 'light'
                  ? 'border-[#2b2f36]/15 bg-white/90 text-[#2b2f36] hover:border-[#2b2f36]/50'
                  : 'border-line-strong bg-surface/90 text-strong hover:border-flame-500',
                selected === part.componentId ? 'ring-1 ring-flame-500' : '',
              ].join(' ')}
            >
              {part.stepNumber ? (
                <span className="mr-1 font-mono text-flame-500">{part.stepNumber}</span>
              ) : null}
              {part.name}
              {part.quantity > 1 ? ` ×${part.quantity}` : ''}
            </button>
          )
        })}

      {showControls && (
        <div className="absolute right-3 top-3 flex gap-1.5">
          <button
            type="button"
            onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
            title="Toggle background"
            className="grid size-8 place-items-center rounded-lg border border-line bg-surface/85 text-strong backdrop-blur transition hover:bg-surface"
          >
            {theme === 'light' ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={resetView}
            title="Reset view"
            className="grid size-8 place-items-center rounded-lg border border-line bg-surface/85 text-strong backdrop-blur transition hover:bg-surface"
          >
            <Maximize2 className="size-3.5" />
          </button>
        </div>
      )}

      {/* A circular embed clips a wide caption, and the dial's own labels explain it. */}
      {!bare && (
        <p className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 text-[10px] uppercase tracking-wider text-muted">
          Drag to orbit · scroll to zoom · click a part
        </p>
      )}
    </>
  )

  // Embedded: just the canvas, the parent supplies the frame and the controls.
  if (bare) return <div className="relative size-full overflow-hidden">{stage}</div>

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-2xl border border-line">{stage}</div>

      <div className="card flex flex-wrap items-center gap-4 p-3.5">
        <label className="flex min-w-[15rem] flex-1 items-center gap-3">
          <Layers className="size-4 shrink-0 text-flame-400" />
          <span className="label shrink-0">Explode</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={explode}
            onChange={(e) => setExplode(Number(e.target.value))}
            className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-line accent-flame-500"
          />
          <span className="w-9 shrink-0 text-right font-mono text-xs text-muted">
            {Math.round(explode * 100)}%
          </span>
        </label>

        {stepNumbers.length > 0 && (
          <select
            value={stepFilter ?? ''}
            onChange={(e) => setStepFilter(e.target.value ? Number(e.target.value) : null)}
            className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-strong"
          >
            <option value="">All steps</option>
            {stepNumbers.map((n) => (
              <option key={n} value={n}>
                Step {n}
              </option>
            ))}
          </select>
        )}

        <button
          type="button"
          className="btn-ghost px-3 py-2 text-xs"
          onClick={downloadGlb}
          disabled={exporting}
        >
          <Download className="size-3.5" />
          {exporting ? 'Exporting…' : '.glb'}
        </button>
      </div>

      {selectedComponent && (
        <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="font-semibold text-strong">{selectedComponent.name}</p>
            <p className="mt-0.5 text-xs text-muted">
              {selectedComponent.category} · ×{selectedComponent.quantity} ·{' '}
              {money(selectedComponent.unit_price_cents, selectedComponent.currency)} each
            </p>
          </div>
          <button
            type="button"
            className="btn-ghost px-3 py-1.5 text-xs"
            onClick={() => setSelected(null)}
          >
            Clear
          </button>
        </div>
      )}

      <p className="text-xs text-muted">
        The layout is built from the bill of materials: each part becomes a primitive sized from its
        specs, and layers are ordered by the assembly step that installs them. It is a schematic of
        how the device goes together, not a dimensioned CAD model.
      </p>
    </div>
  )
}
