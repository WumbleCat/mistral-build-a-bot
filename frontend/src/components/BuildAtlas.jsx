import { Fragment, lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react'
import { Download, ExternalLink, Layers, Table2, Workflow } from 'lucide-react'
import { buildLayout } from '../lib/geometry'
import { money } from '../lib/format'
import { purchaseLinksFor } from '../lib/retailers'
import { bomToCsv, downloadCsv } from '../lib/api'
import BomTable from './BomTable'
import Spinner from './Spinner'
import useMediaQuery from '../hooks/useMediaQuery'
import LiveOffers from './LiveOffers'

const ExplodedView = lazy(() => import('./ExplodedView'))

const CATEGORY_DOT = {
  actuator: 'bg-flame-500',
  wheel: 'bg-flame-400',
  controller: 'bg-sky-ish',
  'motor-driver': 'bg-sky-ish',
  electronics: 'bg-sky-ish',
  pcb: 'bg-mint-400',
  sensor: 'bg-mint-400',
  display: 'bg-mint-400',
  power: 'bg-amber-500',
  battery: 'bg-amber-500',
  connector: 'bg-amber-600',
  switch: 'bg-line-strong',
  chassis: 'bg-line-strong',
  enclosure: 'bg-line-strong',
  structure: 'bg-line-strong',
}

/* --------------------------------------------------------------- the cards */

function PartCard({ node, side, active, dimmed, onSelect, cardRef }) {
  const left = side === 'left'
  return (
    <button
      ref={cardRef}
      type="button"
      data-ring="part"
      title={node.component.name}
      onClick={() => onSelect(active ? null : node.component.id)}
      className={[
        'group relative flex h-full w-full flex-col justify-center gap-1 rounded-xl border px-3 py-2.5 transition',
        left ? 'items-end text-right' : 'items-start text-left',
        active
          ? 'border-flame-500 bg-flame-500/10 shadow-sm'
          : 'border-line bg-surface hover:border-line-strong hover:shadow-sm',
        dimmed ? 'opacity-40' : '',
      ].join(' ')}
    >
      <span className={`flex items-center gap-1.5 ${left ? 'flex-row-reverse' : ''}`}>
        <span
          className={`size-1.5 shrink-0 rounded-full ${CATEGORY_DOT[node.component.category] ?? 'bg-line-strong'}`}
        />
        {node.step && (
          <span className="font-mono text-[10px] text-muted">
            {String(node.step).padStart(2, '0')}
          </span>
        )}
      </span>

      <span className="line-clamp-2 text-[12px] font-semibold leading-snug text-strong">
        {node.component.name}
      </span>

      <span className="text-[10px] uppercase tracking-wide text-muted">
        {node.component.category}
        {node.component.quantity > 1 && ` · ×${node.component.quantity}`}
      </span>

      {/* A tick pointing in at the device. */}
      <span
        aria-hidden="true"
        className={[
          'absolute top-1/2 h-px w-3 -translate-y-1/2 transition',
          left ? '-right-3' : '-left-3',
          active ? 'bg-flame-500' : 'bg-line',
        ].join(' ')}
      />
    </button>
  )
}

function BuyCard({ node, side, active, dimmed }) {
  const left = side === 'left'
  const links = purchaseLinksFor(node.component).slice(0, 3)
  const lineTotal =
    node.component.unit_price_cents != null
      ? node.component.unit_price_cents * node.component.quantity
      : null

  return (
    <div
      data-ring="buy"
      className={[
        'flex h-full flex-col justify-center gap-1.5 rounded-xl border px-3 py-2.5 transition',
        left ? 'items-end' : 'items-start',
        active ? 'border-flame-500/50 bg-surface shadow-sm' : 'border-line-soft bg-sunken/70',
        dimmed ? 'opacity-40' : '',
      ].join(' ')}
    >
      {lineTotal != null ? (
        <span className="font-mono text-[13px] font-bold text-flame-600">
          {money(lineTotal, node.component.currency)}
        </span>
      ) : (
        <span className="text-[10px] uppercase tracking-wide text-muted">No estimate</span>
      )}

      <span className={`flex flex-wrap gap-1 ${left ? 'justify-end' : ''}`}>
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
                ? 'border-flame-500/40 bg-flame-500/10 text-flame-600 hover:bg-flame-500/20'
                : 'border-line bg-surface text-muted hover:border-line-strong hover:text-strong',
            ].join(' ')}
          >
            {link.label}
            <ExternalLink className="size-2" />
          </a>
        ))}
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ atlas */

export default function BuildAtlas({ project }) {
  const [selected, setSelected] = useState(null)
  const [explode, setExplode] = useState(0.5)
  const [mode, setMode] = useState('atlas')

  // The five-column plate needs real width; below this it becomes viewer + table.
  const wide = useMediaQuery('(min-width: 1180px)')

  const layout = useMemo(() => buildLayout(project), [project])

  /** Components in build order, split down the two sides of the page. */
  const { left, right } = useMemo(() => {
    const stepById = new Map(
      layout.parts.filter((p) => p.isFirstInstance).map((p) => [p.componentId, p.stepNumber]),
    )
    const ordered = [...(project.components ?? [])]
      .sort((a, b) => {
        const sa = stepById.get(a.id) ?? 999
        const sb = stepById.get(b.id) ?? 999
        return sa - sb || a.sort_order - b.sort_order
      })
      .map((component) => ({ component, step: stepById.get(component.id) ?? null }))

    const half = Math.ceil(ordered.length / 2)
    return { left: ordered.slice(0, half), right: ordered.slice(half) }
  }, [project.components, layout])

  const rows = Math.max(left.length, right.length, 1)

  const gridRef = useRef(null)
  const cardRefs = useRef(new Map())
  const lineRefs = useRef(new Map())

  // handleProject runs from the render loop, so it reads the current selection from a
  // ref rather than closing over it -- otherwise every selection would rebuild it.
  const selectedRef = useRef(null)
  selectedRef.current = selected

  /**
   * Draw a leader from each part card to that part in the 3D view.
   *
   * Called straight from the render loop, so it writes SVG attributes rather than
   * going through state -- re-rendering the page every frame is what made an earlier
   * version of this view stutter.
   */
  const handleProject = useCallback(
    (projections) => {
      const grid = gridRef.current
      if (!grid) return
      const box = grid.getBoundingClientRect()
      const seen = new Set()

      for (const { componentId, x, y } of projections) {
        const line = lineRefs.current.get(componentId)
        const card = cardRefs.current.get(componentId)
        if (!line || !card) continue
        seen.add(componentId)

        const c = card.getBoundingClientRect()
        const onLeft = c.left + c.width / 2 < box.left + box.width / 2
        const sx = (onLeft ? c.right : c.left) - box.left
        const sy = c.top + c.height / 2 - box.top
        const ex = x - box.left
        const ey = y - box.top

        // Short horizontal lead-out of the card, then a curve into the part.
        const stub = onLeft ? sx + 12 : sx - 12
        const bend = (ex - stub) * 0.55
        line.setAttribute(
          'd',
          `M ${sx} ${sy} H ${stub} C ${stub + bend} ${sy}, ${ex - bend} ${ey}, ${ex} ${ey}`,
        )

        const active = selectedRef.current === componentId
        const dim = selectedRef.current && !active
        line.style.opacity = dim ? '0.06' : active ? '0.85' : '0.22'
        line.style.stroke = active ? 'var(--color-flame-500)' : 'var(--color-line-strong)'
        line.style.strokeWidth = active ? '1.6' : '1'
      }

      // Anything the camera cannot see right now gets no line.
      for (const [id, line] of lineRefs.current) {
        if (!seen.has(id)) line.style.opacity = '0'
      }
    },
    [],
  )


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

  const viewer = (
    <Suspense
      fallback={
        <div className="grid size-full min-h-[20rem] place-items-center">
          <Spinner label="Loading the 3D view" />
        </div>
      }
    >
      <ExplodedView
        project={project}
        bare={wide}
        showCallouts={false}
        showControls
        selected={selected}
        onSelect={setSelected}
        explode={explode}
        onExplodeChange={setExplode}
        onProject={wide ? handleProject : undefined}
        heightClass="h-[26rem]"
      />
    </Suspense>
  )

  return (
    <section className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Parts &amp; build</h2>
          <p className="mt-0.5 text-sm text-muted">
            {totals.parts} parts across {totals.lines} line items ·{' '}
            <span className="font-mono text-flame-600">{money(totals.cents, project.currency)}</span>{' '}
            estimated
            {totals.unpriced > 0 && ` · ${totals.unpriced} without an estimate`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex rounded-xl border border-line bg-surface p-0.5">
            {[
              { key: 'atlas', label: 'Atlas', icon: Workflow },
              { key: 'table', label: 'Table', icon: Table2 },
            ].map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setMode(key)}
                className={[
                  'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition',
                  mode === key ? 'bg-sunken text-strong' : 'text-muted hover:text-strong',
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
          {/* price · part · DEVICE · part · price */}
          <div
            ref={gridRef}
            className="relative grid items-stretch gap-x-3 gap-y-2.5"
            style={{
              gridTemplateColumns: '0.8fr 1fr minmax(27rem, 1.75fr) 1fr 0.8fr',
              gridTemplateRows: `repeat(${rows}, minmax(4.5rem, auto))`,
            }}
          >
            {left.map((node, i) => {
              const active = selected === node.component.id
              const dimmed = Boolean(selected) && !active
              return (
                <Fragment key={node.component.id}>
                  <div style={{ gridColumn: 1, gridRow: i + 1 }}>
                    <BuyCard node={node} side="left" active={active} dimmed={dimmed} />
                  </div>
                  <div style={{ gridColumn: 2, gridRow: i + 1 }}>
                    <PartCard
                      node={node}
                      side="left"
                      active={active}
                      dimmed={dimmed}
                      onSelect={setSelected}
                      cardRef={(el) => {
                        if (el) cardRefs.current.set(node.component.id, el)
                        else cardRefs.current.delete(node.component.id)
                      }}
                    />
                  </div>
                </Fragment>
              )
            })}

            <div
              style={{ gridColumn: 3, gridRow: `1 / span ${rows}` }}
              className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm"
            >
              <div className="sticky top-24 h-[34rem]">{viewer}</div>
            </div>

            {/* Leaders sit above the cards so they can reach into the 3D view. */}
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 z-10 size-full overflow-visible"
              style={{ gridColumn: '1 / -1', gridRow: `1 / span ${rows}` }}
            >
              {[...left, ...right].map((node) => (
                <path
                  key={node.component.id}
                  data-leader={node.component.id}
                  ref={(el) => {
                    if (el) lineRefs.current.set(node.component.id, el)
                    else lineRefs.current.delete(node.component.id)
                  }}
                  fill="none"
                  style={{ opacity: 0 }}
                />
              ))}
            </svg>

            {right.map((node, i) => {
              const active = selected === node.component.id
              const dimmed = Boolean(selected) && !active
              return (
                <Fragment key={node.component.id}>
                  <div style={{ gridColumn: 4, gridRow: i + 1 }}>
                    <PartCard
                      node={node}
                      side="right"
                      active={active}
                      dimmed={dimmed}
                      onSelect={setSelected}
                      cardRef={(el) => {
                        if (el) cardRefs.current.set(node.component.id, el)
                        else cardRefs.current.delete(node.component.id)
                      }}
                    />
                  </div>
                  <div style={{ gridColumn: 5, gridRow: i + 1 }}>
                    <BuyCard node={node} side="right" active={active} dimmed={dimmed} />
                  </div>
                </Fragment>
              )
            })}
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <label className="card flex min-w-[18rem] flex-1 items-center gap-3 p-3.5">
              <Layers className="size-4 shrink-0 text-flame-500" />
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

            <p className="text-xs text-muted">
              Parts read in build order — down the left, then down the right. Price and suppliers
              sit outside each part.
            </p>
          </div>

          {selectedComponent && (
            <div className="card flex flex-wrap items-start justify-between gap-4 p-4">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-strong">{selectedComponent.name}</p>
                {selectedComponent.description && (
                  <p className="mt-1 max-w-2xl text-sm text-body">{selectedComponent.description}</p>
                )}
                <p className="mt-1.5 text-xs text-muted">
                  {selectedComponent.category} · ×{selectedComponent.quantity} ·{' '}
                  {money(selectedComponent.unit_price_cents, selectedComponent.currency)} each
                  {selectedComponent.substitutes?.length > 0 &&
                    ` · alt: ${selectedComponent.substitutes.join(', ')}`}
                </p>

                {/* Real stock and price, when the Parts API is reachable. */}
                <div className="mt-3 max-w-xl">
                  <LiveOffers component={selectedComponent} />
                </div>
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
          {viewer}
          <BomTable project={project} />
        </div>
      )}
    </section>
  )
}
