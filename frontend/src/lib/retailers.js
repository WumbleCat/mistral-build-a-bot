/**
 * Purchase links.
 *
 * The analyzer returns a `search_query` per component (plus any exact product URLs it is
 * confident about, stored in `component_links`). Everything else is a deterministic search
 * URL on a distributor that actually stocks that category of part -- no fake product pages.
 *
 * The first five are the project's chosen distributors. Pololu, RobotShop and Adafruit stay on
 * for the robot and mechanical parts (chassis, wheels, grippers, gearmotors) that the
 * component distributors don't carry.
 *
 * `priority` breaks ties when several retailers match a category -- lower wins.
 */
const RETAILERS = {
  lcsc: {
    label: 'LCSC',
    priority: 1,
    build: (q) => `https://www.lcsc.com/search?q=${encodeURIComponent(q)}`,
    categories: [
      'electronics', 'wiring', 'power', 'sensor', 'controller', 'motor-driver',
      'pcb', 'connector', 'switch', 'display', 'battery',
    ],
  },
  digikey: {
    label: 'DigiKey',
    priority: 2,
    build: (q) => `https://www.digikey.co.uk/en/products/result?keywords=${encodeURIComponent(q)}`,
    categories: [
      'electronics', 'wiring', 'power', 'sensor', 'controller', 'actuator', 'motor-driver',
      'pcb', 'connector', 'switch', 'display', 'battery', 'optics',
    ],
  },
  mouser: {
    label: 'Mouser',
    priority: 3,
    build: (q) => `https://www.mouser.co.uk/c/?q=${encodeURIComponent(q)}`,
    categories: [
      'electronics', 'wiring', 'power', 'sensor', 'controller', 'motor-driver',
      'connector', 'switch', 'display', 'battery',
    ],
  },
  rs: {
    label: 'RS',
    priority: 4,
    build: (q) => `https://uk.rs-online.com/web/c/?searchTerm=${encodeURIComponent(q)}`,
    // RS carries mechanical stock too, which is why it covers the structural categories.
    categories: [
      'electronics', 'wiring', 'power', 'actuator', 'sensor',
      'bearing', 'fastener', 'hardware', 'structure', 'tool',
      'enclosure', 'connector', 'switch', 'battery', 'optics',
    ],
  },
  sparkfun: {
    label: 'SparkFun',
    priority: 5,
    build: (q) => `https://www.sparkfun.com/search/results?term=${encodeURIComponent(q)}`,
    categories: ['sensor', 'controller', 'electronics', 'kit', 'power', 'display', 'battery'],
  },

  // Robot-specific mechanical parts the distributors above don't stock.
  pololu: {
    label: 'Pololu',
    priority: 6,
    build: (q) => `https://www.pololu.com/search/compare?q=${encodeURIComponent(q)}`,
    categories: ['actuator', 'motor-driver', 'wheel', 'sensor', 'power'],
  },
  robotshop: {
    label: 'RobotShop',
    priority: 7,
    build: (q) => `https://www.robotshop.com/search?q=${encodeURIComponent(q)}`,
    categories: ['actuator', 'chassis', 'gripper', 'wheel', 'kit', 'structure', 'sensor'],
  },
  adafruit: {
    label: 'Adafruit',
    priority: 8,
    build: (q) => `https://www.adafruit.com/?q=${encodeURIComponent(q)}`,
    categories: ['sensor', 'controller', 'electronics', 'power', 'kit', 'display', 'battery'],
  },
}

/** Retailers that get a link when nothing matches the category. */
const FALLBACK = ['rs', 'digikey', 'lcsc']

/** Up to `limit` retailer search links for a component, best match first. */
export function searchLinksFor(component, limit = 3) {
  const query = component.search_query || component.name
  const category = (component.category || '').toLowerCase()

  const matched = Object.entries(RETAILERS)
    .filter(([, r]) => r.categories.some((c) => category.includes(c)))
    .sort((a, b) => a[1].priority - b[1].priority)

  const chosen = matched.length ? matched : FALLBACK.map((key) => [key, RETAILERS[key]])

  return chosen.slice(0, limit).map(([key, r]) => ({
    retailer: key,
    label: r.label,
    url: r.build(query),
    kind: 'search',
  }))
}

/** Exact links found by the analyzer, followed by search fallbacks, de-duplicated. */
export function purchaseLinksFor(component) {
  const exact = (component.component_links || []).map((l) => ({
    retailer: l.retailer,
    label: l.retailer_label || RETAILERS[l.retailer]?.label || l.retailer,
    url: l.url,
    kind: 'product',
    price_cents: l.price_cents,
  }))
  const seen = new Set(exact.map((l) => l.retailer))
  const fallback = searchLinksFor(component).filter((l) => !seen.has(l.retailer))
  return [...exact, ...fallback].slice(0, 4)
}

/** Retailer names, for the UI to show what it searches across. */
export const RETAILER_LABELS = Object.values(RETAILERS).map((r) => r.label)
