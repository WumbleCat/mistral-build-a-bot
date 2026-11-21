/**
 * Client for the team's Parts & Shop API (the `hein-parts` branch).
 *
 * That service knows real stock and real prices from LCSC and Mouser, which is
 * strictly better than the search URLs this app generates on its own. It is
 * optional: with no VITE_PARTS_API_URL set, every call here resolves to null and
 * the UI keeps using the generated links. A hackathon demo should not fall over
 * because a teammate's laptop is off the network.
 *
 * Prices come back as `price_gbp` regardless of the `currency` field, which
 * records what the shop quoted before conversion.
 */

const BASE = import.meta.env.VITE_PARTS_API_URL?.replace(/\/$/, '') ?? ''

export const PARTS_API_CONFIGURED = Boolean(BASE)

/** Fetch with a timeout, because an unreachable laptop should fail fast. */
async function call(path, { timeout = 6000 } = {}) {
  if (!BASE) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(`${BASE}${path}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    // Offline, CORS, timeout, bad JSON: all the same to the caller.
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** True when the service is actually answering. */
export async function partsApiHealthy() {
  const data = await call('/api/health', { timeout: 2500 })
  return Boolean(data?.ok)
}

/**
 * Live offers for a search term, newest prices from both shops interleaved
 * best-price-first. Returns [] when the service is off or has nothing.
 */
export async function liveOffers(query, limit = 4) {
  if (!query) return []
  const data = await call(`/api/search?q=${encodeURIComponent(query)}`)
  if (!data) return []

  const rows = [...(data.lcsc ?? []), ...(data.mouser ?? [])]
    .filter((r) => r?.url)
    .map((r) => ({
      shop: r.shop ?? 'Shop',
      title: r.title ?? '',
      partNumber: r.part_number ?? null,
      priceGbp: typeof r.price_gbp === 'number' ? r.price_gbp : null,
      stock: typeof r.stock === 'number' ? r.stock : null,
      url: r.url,
      verified: Boolean(r.verified),
    }))

  // In stock first, then cheapest. A £0.40 part nobody has is not a better offer.
  rows.sort((a, b) => {
    const aHas = (a.stock ?? 0) > 0
    const bHas = (b.stock ?? 0) > 0
    if (aHas !== bHas) return aHas ? -1 : 1
    return (a.priceGbp ?? Infinity) - (b.priceGbp ?? Infinity)
  })

  return rows.slice(0, limit)
}

/** The USD→GBP rate the service is using, for labelling converted prices. */
export async function partsApiConfig() {
  return call('/api/config', { timeout: 2500 })
}
