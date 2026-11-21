import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Check, Copy, ShoppingCart } from 'lucide-react';
import type { AssemblyData, Part } from '../types';

/**
 * Shopping list (from the hein branch, on this app's design): one row per part with
 * quantity, unit price, line total, shop and a Buy link that falls back to a shop search.
 * Ticking "I have this" takes the row out of the total; it is the same set as the
 * pre-assembly checklist. Live in-stock offers from the parts service are shown when it
 * is running (best effort, proxied through /api/upstream/search) and never block the list.
 */

interface Offer {
  shop: string;
  price_gbp: number;
  stock: number | null;
  url: string;
  product: string;
}

const offerCache = new Map<string, Offer[]>();
/** Set once the parts service turned out to be unreachable, so it is not asked again per part. */
let serviceDown = false;

function shopSearchUrl(shop: string | undefined, name: string): string {
  const q = encodeURIComponent(name);
  const s = (shop || '').toLowerCase();
  if (s.includes('rs')) return `https://uk.rs-online.com/web/c/?searchTerm=${q}`;
  if (s.includes('sparkfun')) return `https://www.sparkfun.com/search/results?term=${q}`;
  if (s.includes('mouser')) return `https://www.mouser.co.uk/Search/Refine?Keywords=${q}`;
  if (s.includes('lcsc')) return `https://www.lcsc.com/search?q=${q}`;
  if (s.includes('digikey') || s.includes('digi-key')) return `https://www.digikey.co.uk/en/products/result?keywords=${q}`;
  return `https://www.google.com/search?q=${q}+buy`;
}

/** A real product page when the data has one; otherwise a search on the part's shop. */
function buyLink(p: Part): { url: string; direct: boolean } {
  const direct = p.product_url || (p.url && p.url !== 'TODO' ? p.url : null);
  return direct ? { url: direct, direct: true } : { url: shopSearchUrl(p.shop, p.name), direct: false };
}

async function liveOffers(name: string): Promise<Offer[]> {
  const hit = offerCache.get(name);
  if (hit) return hit;
  if (serviceDown) return [];
  try {
    const r = await fetch('/api/upstream/search?q=' + encodeURIComponent(name), { signal: AbortSignal.timeout(5000) });
    if (!r.ok) {
      if (r.status === 502) serviceDown = true;
      return [];
    }
    const j = (await r.json()) as { results?: Array<Partial<Offer>> };
    const list = (j.results ?? [])
      .filter((o) => typeof o.price_gbp === 'number' && typeof o.url === 'string' && /^https?:\/\//.test(o.url))
      .map((o) => ({ shop: o.shop || '', price_gbp: o.price_gbp as number, stock: o.stock ?? null, url: o.url as string, product: o.product || '' }));
    offerCache.set(name, list);
    return list;
  } catch {
    return [];
  }
}

const gbp = (n: number) => `£${n.toFixed(2)}`;

export interface ShoppingListProps {
  data: AssemblyData;
  owned: Set<string>;
  onToggleOwned: (partId: string) => void;
}

export function ShoppingList({ data, owned, onToggleOwned }: ShoppingListProps) {
  const [live, setLive] = useState<Record<string, Offer[]>>({});
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLive({});
    void (async () => {
      const names = [...new Set(data.parts.map((p) => p.name))];
      if (names.length === 0) return;
      // Ask for one part first: if the service is not running, the rest are skipped.
      const first = await liveOffers(names[0]);
      const rest = await Promise.all(names.slice(1).map((n) => liveOffers(n)));
      if (cancelled) return;
      const found: Record<string, Offer[]> = {};
      [first, ...rest].forEach((offers, i) => {
        if (offers.length > 0) found[names[i]] = offers;
      });
      setLive(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [data.parts]);

  const rows = useMemo(
    () =>
      data.parts.map((p) => {
        const inStock = (live[p.name] ?? []).filter((o) => o.stock == null || o.stock > 0).sort((a, b) => a.price_gbp - b.price_gbp);
        const best = inStock[0];
        const cheaper = best && (p.unit_price == null || best.price_gbp < p.unit_price) ? best : undefined;
        const unit = cheaper ? cheaper.price_gbp : (p.unit_price ?? null);
        return { p, unit, line: unit != null ? unit * p.quantity : null, cheaper, link: buyLink(p) };
      }),
    [data.parts, live],
  );

  const toBuy = rows.filter((r) => !owned.has(r.p.id));
  const total = toBuy.reduce((sum, r) => sum + (r.line ?? 0), 0);
  const unpriced = toBuy.filter((r) => r.line == null).length;
  const pieces = toBuy.reduce((sum, r) => sum + r.p.quantity, 0);
  const shops = new Set(toBuy.map((r) => r.p.shop).filter(Boolean)).size;

  const copyList = async () => {
    const lines = toBuy.map((r) => `${r.p.name} ×${r.p.quantity} | ${r.line != null ? gbp(r.line) : 'no price'} | ${r.p.shop || 'shop'}: ${(r.cheaper ?? r.link).url}`);
    const text = `Shopping list: ${data.robot_name}\n${lines.join('\n')}\nTotal: ${gbp(total)} (${pieces} pieces${unpriced ? `, ${unpriced} without a price` : ''})`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <section className="card p-5 sm:p-6" aria-label="Shopping list">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <ShoppingCart className="size-4 text-flame-500" />
            Shopping list
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {toBuy.length} of {rows.length} lines to buy. Tick the parts you already have to take them out of the total.
          </p>
        </div>
        <button type="button" className="btn-ghost px-3 py-2 text-xs" onClick={() => void copyList()} disabled={toBuy.length === 0}>
          {copied ? <Check className="size-3.5 text-mint-400" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy shopping list'}
        </button>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-line-soft text-[11px] tracking-wider text-muted uppercase">
              <th className="py-2.5 pr-3 font-semibold">Have</th>
              <th className="px-3 py-2.5 font-semibold">Part</th>
              <th className="px-3 py-2.5 text-center font-semibold">Qty</th>
              <th className="px-3 py-2.5 font-semibold">Shop</th>
              <th className="px-3 py-2.5 text-right font-semibold">Unit</th>
              <th className="px-3 py-2.5 text-right font-semibold">Total</th>
              <th className="py-2.5 pl-3 font-semibold">Buy</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ p, unit, line, cheaper, link }) => {
              const has = owned.has(p.id);
              return (
                <tr key={p.id} className={`border-b border-line-soft/60 align-top last:border-0 ${has ? 'opacity-50' : ''}`}>
                  <td className="py-3 pr-3">
                    <input
                      type="checkbox"
                      className="size-4 accent-flame-500"
                      checked={has}
                      onChange={() => onToggleOwned(p.id)}
                      aria-label={`I already have ${p.name}`}
                      title="I already have this"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <span className={`font-medium text-strong ${has ? 'line-through' : ''}`}>{p.name}</span>
                    {cheaper && (
                      <a href={cheaper.url} target="_blank" rel="noreferrer" className="mt-0.5 block text-[11px] text-mint-400 underline underline-offset-2" title={cheaper.product}>
                        Live offer {gbp(cheaper.price_gbp)}
                        {cheaper.shop ? ` at ${cheaper.shop}` : ''}
                      </a>
                    )}
                  </td>
                  <td className="px-3 py-3 text-center font-mono text-body">×{p.quantity}</td>
                  <td className="px-3 py-3 text-xs text-body">{p.shop || <span className="text-muted">not set</span>}</td>
                  <td className="px-3 py-3 text-right font-mono text-body">{unit != null ? gbp(unit) : <span className="text-muted">?</span>}</td>
                  <td className="px-3 py-3 text-right font-mono font-semibold text-strong">{line != null ? gbp(line) : <span className="font-normal text-muted">?</span>}</td>
                  <td className="py-3 pl-3">
                    <a href={link.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-xs font-semibold text-flame-600 underline underline-offset-2 hover:text-flame-500">
                      {link.direct ? 'Buy' : 'Search'}
                      <ArrowUpRight className="size-3" />
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2 border-t border-line-soft pt-4">
        <p className="text-xs text-muted">
          {pieces} pieces{shops > 0 ? ` from ${shops} shop${shops === 1 ? '' : 's'}` : ''}
          {owned.size > 0 ? `, ${rows.length - toBuy.length} already owned` : ''}
          {unpriced > 0 ? `. ${unpriced} line${unpriced === 1 ? ' has' : 's have'} no price and ${unpriced === 1 ? 'is' : 'are'} not in the total` : ''}.
        </p>
        <p className="flex items-baseline gap-2">
          <span className="label">Total</span>
          <span className="font-mono text-xl font-bold text-flame-500">{toBuy.length > 0 && unpriced === toBuy.length ? "—" : gbp(total)}</span>
        </p>
      </div>
    </section>
  );
}
