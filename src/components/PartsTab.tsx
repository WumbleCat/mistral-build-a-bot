import { ArrowUpRight, CircleCheck, Search, TriangleAlert } from 'lucide-react';
import type { AssemblyData, Part } from '../types';

export interface PartsTabProps {
  data: AssemblyData;
  /** Part ids the user has ticked off (bought or physically located). */
  checklist: Set<string>;
  onToggleChecklist: (partId: string) => void;
}

/** A part the analysis did not see in the photo: the app or the model suggested it. */
const isSuggested = (p: Part) => p.evidence === 'inferred';
const isSeen = (p: Part) => p.evidence === 'visible' || p.visible_in_photo === true;
const notReviewed = (p: Part) => Boolean(p.notes?.includes('[Not reviewed]'));

/** Shop link for a part: the one the pipeline found, else (suggested parts only) a search. */
function buyLink(p: Part): { href: string; label: string; search: boolean } | null {
  const direct = p.product_url || (p.url && p.url !== 'TODO' ? p.url : null);
  if (direct) {
    const search = /[?&](k|q|keywords|searchTerm)=/.test(direct);
    return { href: direct, label: search ? 'Search the shop' : p.shop ? `Buy at ${p.shop}` : 'Open shop page', search };
  }
  if (isSuggested(p)) {
    return { href: `https://www.amazon.com/s?k=${encodeURIComponent(p.name)}`, label: 'Search Amazon', search: true };
  }
  return null;
}

/**
 * The shopping list: what to buy (with a shop link each), then what is already on the
 * robot. Unreviewed and suggested lines are tagged, never hidden.
 */
export function PartsTab({ data, checklist, onToggleChecklist }: PartsTabProps) {
  const hasEvidence = data.parts.some((p) => p.evidence);
  const toBuy = hasEvidence ? data.parts.filter((p) => !isSeen(p)) : data.parts;
  const onRobot = hasEvidence ? data.parts.filter(isSeen) : [];
  const ticked = toBuy.filter((p) => checklist.has(p.id)).length;
  const pending = data.parts.filter(notReviewed).length;
  const priced = toBuy.filter((p) => p.unit_price != null);
  const total = priced.reduce((sum, p) => sum + (p.unit_price ?? 0) * p.quantity, 0);

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 space-y-6">
        <section className="space-y-3" aria-labelledby="parts-buy">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="parts-buy" className="text-lg font-semibold">
              {hasEvidence ? 'To buy' : 'Parts list'}
            </h2>
            <p className="text-xs text-muted">
              {hasEvidence ? 'Not visible in the photo, so suggested for this build' : 'Everything this build uses'}
            </p>
          </div>

          {toBuy.length === 0 && <p className="card p-5 text-sm text-muted">Nothing to buy: every part was seen on the robot.</p>}

          <ul className="space-y-3">
            {toBuy.map((p) => {
              const done = checklist.has(p.id);
              const link = buyLink(p);
              return (
                <li key={p.id} className={`rounded-2xl border p-4 ${done ? 'border-line-soft bg-sunken' : 'border-line bg-surface shadow-sm shadow-black/[0.04]'}`}>
                  <div className="flex flex-wrap items-start gap-4">
                    <label className="grid size-11 shrink-0 cursor-pointer place-items-center">
                      <input
                        type="checkbox"
                        className="size-5 cursor-pointer accent-flame-600"
                        checked={done}
                        onChange={() => onToggleChecklist(p.id)}
                        aria-label={`Got it: ${p.name}`}
                      />
                    </label>
                    <Qty part={p} />
                    <div className="min-w-0 flex-[999_1_15rem] space-y-1.5">
                      <h3 className={`text-base font-semibold ${done ? 'text-muted line-through' : 'text-strong'}`}>{p.name}</h3>
                      <Tags part={p} />
                      {p.notes && <p className="line-clamp-2 text-xs leading-relaxed text-muted">{p.notes.replace('[Not reviewed] ', '')}</p>}
                    </div>
                    <div className="flex flex-[1_1_9rem] flex-col items-stretch gap-2">
                      {p.unit_price != null && (
                        <p className="text-right font-mono text-sm font-semibold text-strong">£{(p.unit_price * p.quantity).toFixed(2)}</p>
                      )}
                      {link ? (
                        <a href={link.href} target="_blank" rel="noreferrer" className="btn-primary min-h-11">
                          {link.search && <Search className="size-4" />}
                          {link.label}
                          {!link.search && <ArrowUpRight className="size-4" />}
                        </a>
                      ) : (
                        <span className="chip justify-center text-muted">No shop link yet</span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        {onRobot.length > 0 && (
          <section className="space-y-3" aria-labelledby="parts-robot">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 id="parts-robot" className="text-lg font-semibold">
                Already on the robot
              </h2>
              <p className="text-xs text-muted">Seen in the photo. Included as they are.</p>
            </div>
            <ul className="card divide-y divide-line-soft overflow-hidden">
              {onRobot.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5">
                  <span className="w-12 shrink-0 font-mono text-sm text-body">{p.quantityUnknown ? '?' : `×${p.quantity}`}</span>
                  <span className="min-w-0 flex-[999_1_12rem] text-sm font-semibold text-strong">{p.name}</span>
                  <Tags part={p} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <aside className="space-y-4 lg:sticky lg:top-24">
        <section className="card space-y-3 p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="label">Ticked off</h2>
            <span className="font-mono text-xs text-body">
              {ticked} of {toBuy.length}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-line-soft">
            <div
              className="h-full rounded-full bg-flame-500 transition-[width] duration-300"
              style={{ width: `${toBuy.length ? (ticked / toBuy.length) * 100 : 0}%` }}
            />
          </div>
          {toBuy.length > 0 && ticked === toBuy.length && (
            <p className="flex items-center gap-1.5 text-xs font-semibold text-mint-400">
              <CircleCheck className="size-3.5" /> Everything is ticked off.
            </p>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-t border-line-soft pt-3 text-sm">
            <dt className="text-muted">Estimated total</dt>
            <dd className="text-right font-mono text-strong">
              {data.bom_total != null ? `£${data.bom_total.toFixed(2)}` : priced.length > 0 ? `£${total.toFixed(2)}` : 'Not priced'}
            </dd>
            {pending > 0 && (
              <>
                <dt className="text-muted">Not reviewed</dt>
                <dd className="text-right font-mono text-strong">
                  {pending} of {data.parts.length}
                </dd>
              </>
            )}
          </dl>
        </section>

        {hasEvidence && (
          <section className="card space-y-3 p-5">
            <h2 className="font-semibold">Before you order</h2>
            <ul className="space-y-2.5 text-sm text-body">
              <li className="flex gap-2.5">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-flame-600" />
                Suggested parts are guesses. Check the real robot first: the part may be hidden under the frame.
              </li>
              <li className="flex gap-2.5">
                <Search className="mt-0.5 size-4 shrink-0 text-flame-600" />
                A search button opens shop results, not one exact product. Match the ratings before you buy.
              </li>
            </ul>
          </section>
        )}
      </aside>
    </div>
  );
}

function Qty({ part }: { part: Part }) {
  return (
    <span className="grid h-11 w-13 shrink-0 place-items-center rounded-xl border border-line bg-sunken font-mono text-[15px] font-medium text-strong">
      {part.quantityUnknown ? '?' : `×${part.quantity}`}
    </span>
  );
}

function Tags({ part }: { part: Part }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {isSuggested(part) && <span className="chip border-flame-500/40 bg-flame-500/10 px-2 py-0.5 text-[11px] font-semibold text-flame-600">Suggested</span>}
      {isSeen(part) && <span className="chip border-mint-400/40 bg-mint-400/10 px-2 py-0.5 text-[11px] font-semibold text-mint-400">Seen in photo</span>}
      {notReviewed(part) ? (
        <span className="chip border-line-strong bg-surface px-2 py-0.5 text-[11px] font-semibold">Not reviewed</span>
      ) : (
        part.review_required && <span className="chip border-line-strong bg-surface px-2 py-0.5 text-[11px] font-semibold">Check this</span>
      )}
      {part.sku && <code className="font-mono text-[11px] text-muted">{part.sku}</code>}
    </span>
  );
}
