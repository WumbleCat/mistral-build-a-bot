import { Boxes, ListOrdered, Wrench } from 'lucide-react';
import type { AssemblyData } from '../types';

export interface OverviewTabProps {
  data: AssemblyData;
  tools: string[];
  notes: string[];
  onOpenParts: () => void;
  onStartAssembly: () => void;
}

/** First tab of a build: what was seen, what was guessed, what you need, and where to go next. */
export function OverviewTab({ data, tools, notes, onOpenParts, onStartAssembly }: OverviewTabProps) {
  const seen = data.parts.filter((p) => p.evidence === 'visible' || p.visible_in_photo === true);
  const inferred = data.parts.filter((p) => p.evidence === 'inferred');
  const hasEvidence = seen.length > 0 || inferred.length > 0;
  const remarks = [...notes, ...(data.warnings ?? [])];

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="card p-5">
        <h2 className="font-semibold">{hasEvidence ? 'What the photo shows' : 'What is in this build'}</h2>
        <ul className="mt-3 space-y-2">
          {(hasEvidence ? seen : data.parts).map((p) => (
            <li key={p.id} className="flex gap-2.5 text-sm text-body">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-flame-400" />
              {p.name}
              {!p.quantityUnknown && p.quantity > 1 ? ` ×${p.quantity}` : ''}
            </li>
          ))}
          {hasEvidence && seen.length === 0 && <li className="text-sm text-muted">Nothing was confirmed in the photo.</li>}
        </ul>
      </section>

      {inferred.length > 0 && (
        <section className="card p-5">
          <h2 className="font-semibold">Inferred, not seen</h2>
          <p className="mt-0.5 text-xs text-muted">Worth checking before you order these parts.</p>
          <ul className="mt-3 space-y-2">
            {inferred.map((p) => (
              <li key={p.id} className="flex gap-2.5 text-sm text-body">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-line-strong" />
                {p.name}
                {!p.quantityUnknown && p.quantity > 1 ? ` ×${p.quantity}` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}

      {tools.length > 0 && (
        <section className="card p-5">
          <h2 className="font-semibold">Tools you will need</h2>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {tools.map((tool) => (
              <span key={tool} className="chip">
                <Wrench className="size-3" />
                {tool}
              </span>
            ))}
          </div>
        </section>
      )}

      {remarks.length > 0 && (
        <section className="card p-5">
          <h2 className="font-semibold">Notes on this build</h2>
          <ul className="mt-3 space-y-2">
            {remarks.map((note, i) => (
              <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-body">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-line-strong" />
                {note}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card p-5 lg:col-span-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Ready to build?</h2>
            <p className="mt-0.5 text-sm text-muted">Order the parts, then follow the steps with narration for each one.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-ghost" onClick={onOpenParts}>
              <Boxes className="size-4" />
              Parts list
            </button>
            <button type="button" className="btn-primary" onClick={onStartAssembly}>
              <ListOrdered className="size-4" />
              Start assembly
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
