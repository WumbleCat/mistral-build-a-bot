import { useMemo, useState } from 'react'
import { Download, ExternalLink, ShoppingCart } from 'lucide-react'
import { money } from '../lib/format'
import { purchaseLinksFor } from '../lib/retailers'
import { bomToCsv, downloadCsv } from '../lib/api'

const CATEGORY_TINT = {
  actuator: 'text-flame-300 border-flame-500/30 bg-flame-500/10',
  electronics: 'text-sky-ish border-sky-ish/30 bg-sky-ish/10',
  controller: 'text-sky-ish border-sky-ish/30 bg-sky-ish/10',
  sensor: 'text-mint-400 border-mint-400/30 bg-mint-400/10',
  power: 'text-flame-300 border-flame-500/30 bg-flame-500/10',
}

function CategoryChip({ category }) {
  const tint = CATEGORY_TINT[category] ?? 'text-ink-300 border-ink-700 bg-ink-850'
  return (
    <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tint}`}>
      {category || 'part'}
    </span>
  )
}

function LinkRow({ component }) {
  const links = purchaseLinksFor(component)
  return (
    <div className="flex flex-wrap gap-1.5">
      {links.map((link) => (
        <a
          key={link.retailer + link.url}
          href={link.url}
          target="_blank"
          rel="noreferrer nofollow"
          title={link.kind === 'product' ? 'Product page' : `Search ${link.label}`}
          className={[
            'inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition',
            link.kind === 'product'
              ? 'border-flame-500/40 bg-flame-500/10 text-flame-300 hover:bg-flame-500/20'
              : 'border-ink-700 bg-ink-850 text-ink-300 hover:border-ink-600 hover:text-ink-100',
          ].join(' ')}
        >
          {link.label}
          <ExternalLink className="size-3" />
        </a>
      ))}
    </div>
  )
}

export default function BomTable({ project }) {
  const [showOptional, setShowOptional] = useState(true)
  const components = useMemo(() => project.components ?? [], [project.components])

  const visible = useMemo(
    () => (showOptional ? components : components.filter((c) => !c.is_optional)),
    [components, showOptional],
  )

  const totals = useMemo(() => {
    const priced = visible.filter((c) => c.unit_price_cents != null)
    return {
      cents: priced.reduce((s, c) => s + c.unit_price_cents * c.quantity, 0),
      parts: visible.reduce((s, c) => s + c.quantity, 0),
      unpriced: visible.length - priced.length,
    }
  }, [visible])

  const hasOptional = components.some((c) => c.is_optional)

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Bill of materials</h2>
          <p className="mt-0.5 text-sm text-ink-400">
            {totals.parts} parts across {visible.length} line items
            {totals.unpriced > 0 && ` · ${totals.unpriced} without an estimate`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {hasOptional && (
            <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-400">
              <input
                type="checkbox"
                checked={showOptional}
                onChange={(e) => setShowOptional(e.target.checked)}
                className="size-3.5 accent-flame-500"
              />
              Include optional
            </label>
          )}
          <button
            type="button"
            className="btn-ghost px-3 py-2 text-xs"
            onClick={() =>
              downloadCsv(
                `${(project.device_name ?? project.title).replace(/\s+/g, '-').toLowerCase()}-bom.csv`,
                bomToCsv({ ...project, components: visible }),
              )
            }
          >
            <Download className="size-3.5" />
            CSV
          </button>
        </div>
      </header>

      <div className="card overflow-hidden">
        {/* Desktop: table. Mobile: stacked cards. */}
        <table className="hidden w-full text-left text-sm md:table">
          <thead>
            <tr className="border-b border-ink-800 text-[11px] uppercase tracking-wider text-ink-400">
              <th className="px-4 py-3 font-semibold">Part</th>
              <th className="px-3 py-3 text-center font-semibold">Qty</th>
              <th className="px-3 py-3 text-right font-semibold">Unit</th>
              <th className="px-3 py-3 text-right font-semibold">Total</th>
              <th className="px-4 py-3 font-semibold">Buy</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((c) => (
              <tr key={c.id} className="border-b border-ink-800/60 last:border-0 align-top">
                <td className="px-4 py-3.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink-100">{c.name}</span>
                    <CategoryChip category={c.category} />
                    {c.is_optional && <span className="text-[10px] uppercase text-ink-400">optional</span>}
                  </div>
                  {c.description && <p className="mt-1 max-w-xl text-xs text-ink-400">{c.description}</p>}
                  {c.specs && Object.keys(c.specs).length > 0 && (
                    <p className="mt-1 font-mono text-[11px] text-ink-400">
                      {Object.entries(c.specs)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(' · ')}
                    </p>
                  )}
                  {c.substitutes?.length > 0 && (
                    <p className="mt-1 text-[11px] text-ink-400">
                      Alt: {c.substitutes.join(', ')}
                    </p>
                  )}
                </td>
                <td className="px-3 py-3.5 text-center font-mono text-ink-300">×{c.quantity}</td>
                <td className="px-3 py-3.5 text-right font-mono text-ink-300">
                  {money(c.unit_price_cents, c.currency)}
                </td>
                <td className="px-3 py-3.5 text-right font-mono font-semibold text-ink-100">
                  {c.unit_price_cents != null
                    ? money(c.unit_price_cents * c.quantity, c.currency)
                    : '—'}
                </td>
                <td className="px-4 py-3.5">
                  <LinkRow component={c} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-ink-700 bg-ink-850/60">
              <td className="px-4 py-3 text-xs uppercase tracking-wider text-ink-400" colSpan={3}>
                Estimated parts cost
              </td>
              <td className="px-3 py-3 text-right font-mono text-base font-bold text-flame-400">
                {money(totals.cents, project.currency)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>

        <ul className="divide-y divide-ink-800/60 md:hidden">
          {visible.map((c) => (
            <li key={c.id} className="space-y-2.5 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-ink-100">{c.name}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <CategoryChip category={c.category} />
                    <span className="font-mono text-xs text-ink-400">×{c.quantity}</span>
                  </div>
                </div>
                <span className="shrink-0 font-mono text-sm font-semibold text-ink-100">
                  {c.unit_price_cents != null
                    ? money(c.unit_price_cents * c.quantity, c.currency)
                    : '—'}
                </span>
              </div>
              {c.description && <p className="text-xs text-ink-400">{c.description}</p>}
              <LinkRow component={c} />
            </li>
          ))}
          <li className="flex items-center justify-between bg-ink-850/60 px-4 py-3">
            <span className="text-xs uppercase tracking-wider text-ink-400">Estimated total</span>
            <span className="font-mono text-base font-bold text-flame-400">
              {money(totals.cents, project.currency)}
            </span>
          </li>
        </ul>
      </div>

      <p className="flex items-start gap-2 text-xs text-ink-400">
        <ShoppingCart className="mt-0.5 size-3.5 shrink-0" />
        Prices are the model's estimate of single-unit hobbyist retail. Links open a search on a
        retailer that stocks the category, so you can compare before ordering.
      </p>
    </section>
  )
}
