import { useEffect, useState } from 'react'
import { ExternalLink, LoaderCircle, PackageCheck, PackageX } from 'lucide-react'
import { liveOffers, PARTS_API_CONFIGURED } from '../lib/partsApi'

/**
 * Real stock and prices for one part, from the team's Parts & Shop API.
 *
 * Renders nothing at all when that service is not configured or has no match,
 * so the generated retailer links stay the whole story in that case.
 */
export default function LiveOffers({ component }) {
  const [offers, setOffers] = useState(null)
  const [loading, setLoading] = useState(false)

  const query = component?.search_query || component?.name

  useEffect(() => {
    if (!PARTS_API_CONFIGURED || !query) {
      setOffers(null)
      return
    }

    let active = true
    setLoading(true)
    liveOffers(query).then((rows) => {
      if (!active) return
      setOffers(rows)
      setLoading(false)
    })
    return () => {
      active = false
    }
  }, [query])

  if (!PARTS_API_CONFIGURED) return null

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted">
        <LoaderCircle className="size-3.5 animate-spin text-flame-500" />
        Checking live stock…
      </p>
    )
  }

  if (!offers?.length) return null

  return (
    <div className="space-y-1.5">
      <p className="label">Live stock and price</p>
      <ul className="space-y-1">
        {offers.map((offer) => {
          const inStock = (offer.stock ?? 0) > 0
          return (
            <li key={offer.url}>
              <a
                href={offer.url}
                target="_blank"
                rel="noreferrer nofollow"
                className="flex items-center gap-2.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs transition hover:border-line-strong hover:shadow-sm"
              >
                <span
                  className={`inline-flex items-center gap-1 text-[10px] font-semibold ${
                    inStock ? 'text-mint-400' : 'text-muted'
                  }`}
                  title={inStock ? `${offer.stock} in stock` : 'Out of stock'}
                >
                  {inStock ? <PackageCheck className="size-3" /> : <PackageX className="size-3" />}
                  {inStock ? offer.stock.toLocaleString() : '0'}
                </span>

                <span className="min-w-0 flex-1 truncate text-body" title={offer.title}>
                  {offer.partNumber ? (
                    <span className="font-mono text-[11px] text-strong">{offer.partNumber}</span>
                  ) : (
                    offer.title
                  )}
                  <span className="ml-1.5 text-muted">{offer.shop}</span>
                </span>

                {offer.priceGbp != null && (
                  <span className="shrink-0 font-mono text-[12px] font-bold text-flame-600">
                    £{offer.priceGbp.toFixed(2)}
                  </span>
                )}
                <ExternalLink className="size-3 shrink-0 text-muted" />
              </a>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
