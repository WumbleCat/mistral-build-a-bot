import { lazy, Suspense, useMemo, useState } from 'react'
import { Download, ExternalLink, Layers, LayoutGrid, Orbit, Table2 } from 'lucide-react'
import { buildLayout } from '../lib/geometry'
import { money } from '../lib/format'
import { purchaseLinksFor } from '../lib/retailers'
import { bomToCsv, downloadCsv } from '../lib/api'
import BomTable from './BomTable'
import Spinner from './Spinner'
import useMediaQuery from '../hooks/useMediaQuery'

const ExplodedView = lazy(() => import('./ExplodedView'))

/* --------------------------------------------------------------- geometry */

// Percentages of the square stage. The centre disc holds the 3D view; parts ring it,
// and price + retailers sit on an outer ring aligned to the same spoke.
const CENTRE_R = 25
const PART_R = 35
const BUY_R = 47.5

// Neighbouring nodes alternate between two radii. Fifteen boxes on one circle will
// always collide; staggering them doubles the usable arc without a bigger dial.
const STAGGER = 4.5

/** Max nodes before the ring gets too dense to read; the rest fold into the table. */
const MAX_NODES = 20

const CATEGORY_DOT = {
  actuator: 'bg-flame-400',
  wheel: 'bg-flame-300',
  controller: 'bg-sky-ish',
  'motor-driver': 'bg-sky-ish',
  electronics: 'bg-sky-ish',
  sensor: 'bg-mint-400',
  power: 'bg-amber-400',
  chassis: 'bg-ink-300',
  structure: 'bg-ink-300',
  fastener: 'bg-ink-400',
  hardware: 'bg-ink-400',
  bearing: 'bg-ink-400',
  wiring: 'bg-orange-300',
}

const polar = (angle, radius) => ({
  x: 50 + Math.cos(angle) * radius,
  y: 50 + Math.sin(angle) * radius,
})

/* ------------------------------------------------------------------ atlas */

export default function BuildAtlas({ project }) {
  const [selected, setSelected] = useState(null)
  const [explode, setExplode] = useState(0.5)
  const [mode, setMode] = useState('radial')

  // The dial needs real width. Below that the page falls back to viewer + table.
  // This has to be a JS query, not a CSS `hidden`, or both viewers would mount and
  // each would allocate its own WebGL context.
  const wide = useMediaQuery('(min-width: 1024px)')

  const layout = useMemo(() => buildLayout(project), [project])

  // Order the ring by build sequence so the dial reads clockwise in assembly order.
  const nodes = useMemo(() => {
    const stepById = new Map(
      layout.parts.filter((p) => p.isFirstInstance).map((p) => [p.componentId, p.stepNumber]),
    )
    const ordered = [...(project.components ?? [])].sort((a, b) => {
      const sa = stepById.get(a.id) ?? 999
      const sb = stepById.get(b.id) ?? 999
      return sa - sb || a.sort_order - b.sort_order
    })

    const shown = ordered.slice(0, MAX_NODES)
    const total = shown.length

    return shown.map((component, i) => {
      const angle = (i / total) * Math.PI * 2 - Math.PI / 2
      const offset = i % 2 ? STAGGER : 0
      const partR = PART_R + offset
      const buyR = BUY_R + offset
      return {
        component,
        step: stepById.get(component.id) ?? null,
        angle,
        part: polar(angle, partR),
        buy: polar(angle, buyR),
        spokeFrom: polar(angle, CENTRE_R + 1),
        spokeTo: polar(angle, buyR - 2),
      }
    })
  }, [project.components, layout])

  const hidden = (project.components?.length ?? 0) - nodes.length
  const selectedComponent = useMemo(
    () => (project.components ?? []).find((c) => c.id === selected) ?? null,
    [project.components, selected],
  )

  const totals = useMemo(() => {
    const components = project.components ?? []
    const priced = components.filter((c) => c.unit_price_cents != null)
    return {
      cents: priced.reduce((s, c) => s + c.unit_price_cents * c.quantity, 0),
      parts: components.reduce((s, c) => s + c.quantity, 0),
      lines: components.length,
      unpriced: components.length - priced.length,
    }
  }, [project.components])

  return (
    <section className="space-y-5">
      {/* ------------------------------------------------------------ header */}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Parts &amp; build</h2>
          <p className="mt-0.5 text-sm text-ink-400">
            {totals.parts} parts across {totals.lines} line items ·{' '}
            <span className="font-mono text-flame-400">{money(totals.cents, project.currency)}</span>{' '}
            estimated
            {totals.unpriced > 0 && ` · ${totals.unpriced} without an estimate`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex rounded-xl border border-ink-700 p-0.5">
            {[
              { key: 'radial', label: 'Atlas', icon: Orbit },
              { key: 'table', label: 'Table', icon: Table2 },
            ].map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setMode(key)}
                className={[
                  'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition',
                  mode === key ? 'bg-ink-800 text-ink-100' : 'text-ink-400 hover:text-ink-100',
                ].join(' ')}
              >
                <Icon className="size-3.5" />
                {label}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="btn-ghost px-3 py-2 text-xs"
            onClick={() =>
              downloadCsv(
                `${(project.device_name ?? project.title).replace(/\s+/g, '-').toLowerCase()}-bom.csv`,
                bomToCsv(project),
              )
            }
          >
            <Download className="size-3.5" />
            CSV
          </button>
        </div>
      </header>

      {mode === 'table' ? (
        <BomTable project={project} />
      ) : wide ? (
        <>
          {/* -------------------------------------------------------- the dial */}
          <div className="relative mx-auto aspect-square w-full max-w-[min(1000px,86vh)]">
            {/* Rings and spokes */}
            <svg
              viewBox="0 0 100 100"
              className="pointer-events-none absolute inset-0 size-full"
              aria-hidden="true"
            >
              <circle cx="50" cy="50" r={PART_R} fill="none" stroke="currentColor"
                      className="text-ink-700" strokeWidth="0.08" strokeDasharray="0.6 0.9" />
              <circle cx="50" cy="50" r={BUY_R} fill="none" stroke="currentColor"
                      className="text-ink-800" strokeWidth="0.08" strokeDasharray="0.6 0.9" />
              {nodes.map((n) => {
                const active = selected === n.component.id
                return (
                  <line
                    key={n.component.id}
                    x1={n.spokeFrom.x}
                    y1={n.spokeFrom.y}
                    x2={n.spokeTo.x}
                    y2={n.spokeTo.y}
                    stroke={active ? '#f97316' : 'currentColor'}
                    className={active ? '' : 'text-ink-700'}
                    strokeWidth={active ? 0.22 : 0.1}
                    opacity={selected && !active ? 0.25 : 1}
                  />
                )
              })}
            </svg>

            {/* Centre: the device */}
            <div
              className="absolute overflow-hidden rounded-full border border-ink-700 bg-ink-900 shadow-2xl shadow-black/40"
              style={{
                left: `${50 - CENTRE_R}%`,
                top: `${50 - CENTRE_R}%`,
                width: `${CENTRE_R * 2}%`,
                height: `${CENTRE_R * 2}%`,
              }}
            >
              <Suspense
                fallback={
                  <div className="grid size-full place-items-center">
                    <Spinner label="Loading 3D" />
                  </div>
                }
              >
                <ExplodedView
                  project={project}
                  bare
                  showCallouts={false}
                  showControls={false}
                  selected={selected}
                  onSelect={setSelected}
                  explode={explode}
                  onExplodeChange={setExplode}
                />
              </Suspense>
            </div>

            {/* Ring 1: the components */}
            {nodes.map((n) => {
              const active = selected === n.component.id
              return (
                <button
                  key={n.component.id}
                  type="button"
                  onClick={() => setSelected(active ? null : n.component.id)}
                  style={{
                    left: `${n.part.x}%`,
                    top: `${n.part.y}%`,
                    transform: 'translate(-50%, -50%)',
                    opacity: selected && !active ? 0.4 : 1,
                  }}
                  className={[
                    'absolute flex w-[7rem] items-start gap-1 rounded-lg border px-1.5 py-1 text-left text-[9px] leading-snug transition',
                    active
                      ? 'border-flame-500 bg-flame-500/15 text-ink-100'
                      : 'border-ink-700 bg-ink-900/90 text-ink-200 hover:border-ink-500',
                  ].join(' ')}
                  title={n.component.name}
                  data-ring="part"
                >
                  <span
                    className={`mt-1 size-1.5 shrink-0 rounded-full ${CATEGORY_DOT[n.component.category] ?? 'bg-ink-400'}`}
                  />
                  <span className="line-clamp-2 min-w-0 flex-1 font-medium">{n.component.name}</span>
                  {n.component.quantity > 1 && (
                    <span className="shrink-0 font-mono text-[10px] text-ink-400">
                      ×{n.component.quantity}
                    </span>
                  )}
                </button>
              )
            })}

            {/* Ring 2: cost and where to buy */}
            {nodes.map((n) => {
              const active = selected === n.component.id
              const links = purchaseLinksFor(n.component).slice(0, active ? 4 : 2)
              const lineTotal =
                n.component.unit_price_cents != null
                  ? n.component.unit_price_cents * n.component.quantity
                  : null

              return (
                <div
                  key={n.component.id}
                  data-ring="buy"
                  style={{
                    left: `${n.buy.x}%`,
                    top: `${n.buy.y}%`,
                    transform: 'translate(-50%, -50%)',
                    opacity: selected && !active ? 0.3 : 1,
                  }}
                  className={[
                    'absolute flex w-[6.25rem] flex-col gap-0.5 rounded-lg border px-1.5 py-1 transition',
                    active
                      ? 'border-flame-500/60 bg-ink-850 shadow-lg shadow-black/40'
                      : 'border-ink-800 bg-ink-900/70',
                  ].join(' ')}
                >
                  {lineTotal != null ? (
                    <span className="font-mono text-[11px] font-bold text-flame-400">
                      {money(lineTotal, n.component.currency)}
                    </span>
                  ) : (
                    <span className="text-[9px] uppercase tracking-wide text-ink-400">
                      No estimate
                    </span>
                  )}
                  <span className="flex flex-wrap gap-1">
                    {links.map((link) => (
                      <a
                        key={link.retailer + link.url}
                        href={link.url}
                        target="_blank"
                        rel="noreferrer nofollow"
                        title={link.kind === 'product' ? 'Product page' : `Search ${link.label}`}
                        className={[
                          'inline-flex items-center gap-0.5 rounded border px-1 py-px text-[9px] font-medium transition',
                          link.kind === 'product'
                            ? 'border-flame-500/40 bg-flame-500/10 text-flame-300 hover:bg-flame-500/20'
                            : 'border-ink-700 text-ink-400 hover:border-ink-500 hover:text-ink-100',
                        ].join(' ')}
                      >
                        {link.label}
                        <ExternalLink className="size-2" />
                      </a>
                    ))}
                  </span>
                </div>
              )
            })}
          </div>

          {/* Below the dial: explode control + the selected part's detail */}
          <div className="flex flex-wrap items-center gap-4">
            <label className="card flex min-w-[18rem] flex-1 items-center gap-3 p-3.5">
              <Layers className="size-4 shrink-0 text-flame-400" />
              <span className="label shrink-0">Explode</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={explode}
                onChange={(e) => setExplode(Number(e.target.value))}
                className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-ink-700 accent-flame-500"
              />
              <span className="w-9 shrink-0 text-right font-mono text-xs text-ink-400">
                {Math.round(explode * 100)}%
              </span>
            </label>

            {hidden > 0 && (
              <button type="button" className="btn-ghost text-xs" onClick={() => setMode('table')}>
                <LayoutGrid className="size-3.5" />
                {hidden} more {hidden === 1 ? 'part' : 'parts'} in the table
              </button>
            )}
          </div>

          {selectedComponent && (
            <div className="card flex flex-wrap items-start justify-between gap-4 p-4">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-ink-100">{selectedComponent.name}</p>
                {selectedComponent.description && (
                  <p className="mt-1 max-w-2xl text-sm text-ink-300">
                    {selectedComponent.description}
                  </p>
                )}
                <p className="mt-1.5 text-xs text-ink-400">
                  {selectedComponent.category} · ×{selectedComponent.quantity} ·{' '}
                  {money(selectedComponent.unit_price_cents, selectedComponent.currency)} each
                  {selectedComponent.substitutes?.length > 0 &&
                    ` · alt: ${selectedComponent.substitutes.join(', ')}`}
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

        </>
      ) : (
        <div className="space-y-5">
          <Suspense
            fallback={
              <div className="card grid place-items-center py-20">
                <Spinner label="Loading the 3D viewer" />
              </div>
            }
          >
            <ExplodedView
              project={project}
              selected={selected}
              onSelect={setSelected}
              explode={explode}
              onExplodeChange={setExplode}
              heightClass="h-[24rem]"
            />
          </Suspense>
          <BomTable project={project} />
        </div>
      )}
    </section>
  )
}
