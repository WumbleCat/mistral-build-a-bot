import { useEffect, useMemo, useState } from 'react';
import type { AssemblyData, Part } from '../types';
import { PartIcon } from './Sidebar';

/**
 * Shopping list card: one row per part with icon, qty, unit £, line total £,
 * shop badge, in-stock dot and a Buy ↗ button (falls back to a shop search).
 * "I have this" removes the row from the total. Cheapest live in-stock offer
 * from the parts service (http://localhost:8000/api/search) is shown when
 * available — best effort only, never blocks.
 */

const PARTS_API = 'http://localhost:8000/api/search?q=';
const liveCache = new Map<string, Array<{ shop: string; price_gbp: number; stock: number | null; url: string; product: string }>>();

function shopBadge(shop?: string): string {
  const s = (shop || '').toLowerCase();
  if (s.includes('rs')) return 'RS';
  if (s.includes('sparkfun')) return 'SF';
  if (s.includes('mouser')) return 'MO';
  if (s.includes('lcsc')) return 'LC';
  if (s.includes('digikey') || s.includes('digi-key')) return 'DK';
  return (shop || 'shop').slice(0, 2).toUpperCase();
}

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

async function liveOffers(name: string): Promise<typeof liveCache extends Map<string, infer V> ? V : never> {
  const hit = liveCache.get(name);
  if (hit) return hit;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(PARTS_API + encodeURIComponent(name), { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error(String(r.status));
    const j = (await r.json()) as { results?: Array<{ shop?: string; price_gbp?: number; stock?: number | null; url?: string; product?: string }> };
    const list = (j.results ?? [])
      .filter((o) => o.price_gbp != null && o.url)
      .map((o) => ({ shop: o.shop || '', price_gbp: o.price_gbp as number, stock: o.stock ?? null, url: o.url as string, product: o.product || '' }));
    liveCache.set(name, list);
    return list;
  } catch {
    liveCache.set(name, []);
    return [];
  }
}

export interface ShoppingListProps {
  data: AssemblyData;
  owned: Set<string>;
  onToggleOwned: (partId: string) => void;
}

export function ShoppingList({ data, owned, onToggleOwned }: ShoppingListProps) {
  const [live, setLive] = useState<Record<string, Array<{ shop: string; price_gbp: number; stock: number | null; url: string; product: string }>>>({});
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // best-effort live prices for each part (cached module-level)
  useEffect(() => {
    let cancelled = false;
    const names = [...new Set(data.parts.map((p) => p.name))];
    void Promise.all(names.map((n) => liveOffers(n))).then((all) => {
      if (cancelled) return;
      const m: Record<string, (typeof live)[string]> = {};
      names.forEach((n, i) => { m[n] = all[i]; });
      setLive(m);
    });
    return () => { cancelled = true; };
  }, [data.parts]);

  const rows = useMemo(() => {
    return data.parts.map((p) => {
      const unit = p.unit_price ?? null;
      const offers = live[p.name] ?? [];
      const inStock = offers.filter((o) => o.stock == null || o.stock > 0).sort((a, b) => a.price_gbp - b.price_gbp);
      const best = inStock[0];
      const effectiveUnit = best && (unit == null || best.price_gbp < unit) ? best.price_gbp : unit;
      const line = effectiveUnit != null ? effectiveUnit * p.quantity : null;
      return { p, unit, best, more: inStock.length, line, effectiveUnit };
    });
  }, [data.parts, live]);

  const buyable = rows.filter((r) => !owned.has(r.p.id));
  const total = buyable.reduce((s, r) => s + (r.line ?? 0), 0);
  const shops = new Set(buyable.map((r) => shopBadge(r.p.shop))).size;
  const totalParts = buyable.reduce((s, r) => s + r.p.quantity, 0);

  const copyList = async () => {
    const lines = buyable.map((r) => {
      const buy = r.p.url && r.p.url !== 'TODO' ? r.p.url : shopSearchUrl(r.p.shop, r.p.name);
      return `${r.p.name} ×${r.p.quantity} — £${(r.line ?? 0).toFixed(2)} — ${r.p.shop || 'shop'}: ${buy}`;
    });
    const text = `Shopping list — ${data.robot_name}\n${lines.join('\n')}\nTotal: £${total.toFixed(2)} (${totalParts} parts, ${shops} shops)`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable — ignore */ }
  };

  return (
    <section className="card shopping-list" aria-label="Shopping list">
      <div className="shopping-head">
        <h2 className="card-title">Shopping list</h2>
        <span className="count">({buyable.length} to buy)</span>
      </div>
      <ul className="parts-list">
        {rows.map(({ p, unit, best, more, line }) => {
          const has = owned.has(p.id);
          const buyUrl = p.url && p.url !== 'TODO' ? p.url : shopSearchUrl(p.shop, p.name);
          const isBuy = p.url && p.url !== 'TODO';
          return (
            <li key={p.id} className={`part-row shop-row ${has ? 'owned' : ''}`}>
              <input
                type="checkbox"
                checked={has}
                onChange={() => onToggleOwned(p.id)}
                aria-label={`I already have ${p.name}`}
                title="I already have this"
              />
              <span className="part-icon"><PartIcon category={p.category} name={p.name} /></span>
              <span className="part-name">{p.name}</span>
              <span className="part-qty">×{p.quantity}</span>
              <span className="shop-badge" title={p.shop || 'shop'}>{shopBadge(p.shop)}</span>
              <span className="stock-dot" aria-hidden title="in stock" />
              {unit != null && <span className="part-price">£{unit.toFixed(2)}</span>}
              <span className="part-price line-total">£{(line ?? 0).toFixed(2)}</span>
              <a className="buy-link" href={buyUrl} target="_blank" rel="noreferrer">
                {isBuy ? 'Buy ↗' : 'Search ↗'}
              </a>
              {best && (unit == null || best.price_gbp < unit) && (
                <span className="live-offer" title={`${best.product} — ${best.shop}`}>
                  live £{best.price_gbp.toFixed(2)}{more > 1 ? ` · +${more - 1} more` : ''}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {expanded && (
        <p className="card-note">Live offers are fetched from the parts service when available; catalogue prices are the fallback.</p>
      )}
      <button type="button" className="linklike" onClick={() => setExpanded((v) => !v)} style={{ padding: 0 }}>
        {expanded ? 'hide note' : 'about live prices'}
      </button>
      <div className="shopping-total">
        <div className="total-line">
          <span className="total-label">Total</span>
          <span className="total-value">£{total.toFixed(2)}</span>
        </div>
        <div className="total-sub">{totalParts} parts · {shops} shops{owned.size > 0 ? ` · ${owned.size} already owned` : ''}</div>
        <button type="button" className="btn btn-ghost btn-small" onClick={() => void copyList()}>
          {copied ? '✓ Copied' : 'Copy shopping list'}
        </button>
      </div>
    </section>
  );
}

export type { Part };
