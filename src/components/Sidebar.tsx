import type { ReactNode } from 'react';
import { Check, CircleCheck, Download, LoaderCircle, Pause, Play, Wrench } from 'lucide-react';
import type { AssemblyData } from '../types';
import type { StepAudioState } from '../hooks/useNarrationEngine';

export interface NarrationStats {
  ready: number;
  loading: number;
  error: number;
  total: number;
}

export interface SidebarProps {
  data: AssemblyData;
  currentIndex: number;
  importNotes: string[];
  onLoadSample: () => void;
  /** Per-step narration state, aligned with data.steps. */
  stepAudio: Array<StepAudioState | undefined>;
  /** Index of the step currently loaded in the player, if any. */
  playingIndex: number | null;
  playingPaused: boolean;
  onToggleStepAudio: (index: number) => void;
  narrationStats: NarrationStats;
  onLoadUpstream?: () => void;
  /** Pre-assembly checklist: part ids the user has physically confirmed. */
  checklist?: Set<string>;
  onToggleChecklist?: (partId: string) => void;
  /** Tools needed across all steps (for the checklist card). */
  allTools?: string[];
  /** Developer-only UI (the Data card and sample loaders) is shown only with ?dev=1. */
  dev?: boolean;
}

type PartState = 'active' | 'installed' | 'pending';

export function Sidebar({ data, currentIndex, importNotes, onLoadSample, onLoadUpstream, stepAudio, playingIndex, playingPaused, onToggleStepAudio, narrationStats, checklist, onToggleChecklist, allTools, dev }: SidebarProps) {
  const currentStep = data.steps[currentIndex];
  const installedSet = new Set(currentStep?.installed_components ?? []);
  const activeSet = new Set(currentStep?.component_ids ?? []);
  const checkedCount = checklist ? data.parts.filter((p) => checklist.has(p.id)).length : 0;
  const allChecked = checkedCount === data.parts.length;

  const partState = (id: string): PartState => (activeSet.has(id) ? 'active' : installedSet.has(id) ? 'installed' : 'pending');
  const name = (id: string) => data.parts.find((p) => p.id === id)?.name ?? id;
  const touches = (r: { from: string; to: string }) =>
    activeSet.has(r.from) || activeSet.has(r.to) || installedSet.has(r.from) || installedSet.has(r.to);

  return (
    <aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-24">
      {checklist && onToggleChecklist && (
        <Card title="Pre-assembly checklist" aside={`${checkedCount}/${data.parts.length}`}>
          <p className="mb-2 text-xs text-muted">Tick off parts you have physically located.</p>
          <div className="mb-2 h-1 overflow-hidden rounded-full bg-line-soft">
            <div
              className="h-full rounded-full bg-mint-400 transition-[width] duration-300"
              style={{ width: `${data.parts.length ? (checkedCount / data.parts.length) * 100 : 0}%` }}
            />
          </div>
          <ul className="divide-y divide-line-soft">
            {data.parts.map((p) => {
              const checked = checklist.has(p.id);
              return (
                <li key={p.id}>
                  <label className="flex cursor-pointer items-center gap-2.5 py-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 shrink-0 accent-flame-500"
                      checked={checked}
                      onChange={() => onToggleChecklist(p.id)}
                      aria-label={`Mark ${p.name} as located`}
                    />
                    <PartDot state={partState(p.id)} />
                    <span className={`min-w-0 flex-1 truncate ${checked ? 'text-muted line-through' : 'text-strong'}`}>{p.name}</span>
                    <Qty n={p.quantity} />
                  </label>
                </li>
              );
            })}
          </ul>
          {allChecked && (
            <p className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-mint-400">
              <CircleCheck className="size-3.5" /> All parts located — ready to build!
            </p>
          )}
          {allTools && allTools.length > 0 && (
            <div className="mt-3 border-t border-line-soft pt-3">
              <p className="label mb-1.5">Tools needed</p>
              <div className="flex flex-wrap gap-1.5">
                {allTools.map((t) => (
                  <span key={t} className="chip">
                    <Wrench className="size-3" />
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      <Card title="Parts list" aside={String(data.parts.length)}>
        <ul className="divide-y divide-line-soft">
          {data.parts.map((p) => {
            const state = partState(p.id);
            return (
              <li key={p.id} className="flex items-center gap-2.5 py-2 text-sm">
                <PartDot state={state} />
                <span className={`min-w-0 flex-1 truncate ${state === 'active' ? 'font-semibold text-flame-600' : 'text-strong'}`}>{p.name}</span>
                <Qty n={p.quantity} />
              </li>
            );
          })}
        </ul>
      </Card>

      {data.relationships && data.relationships.length > 0 && (
        <Card title="Connections">
          <ul className="space-y-1.5">
            {data.relationships
              .filter(touches)
              .concat(data.relationships.filter((r) => !touches(r)))
              .slice(0, 12)
              .map((r) => {
                const involvesCurrent = activeSet.has(r.from) || activeSet.has(r.to);
                return (
                  <li
                    key={r.id}
                    className={`space-y-1.5 rounded-xl border px-3 py-2 text-xs ${
                      involvesCurrent ? 'border-flame-500/40 bg-flame-500/5' : 'border-line-soft bg-surface'
                    }`}
                  >
                    <p className="flex flex-wrap items-center gap-1.5 text-body">
                      <strong className="text-strong">{name(r.from)}</strong>
                      <span className="font-mono text-[10.5px] text-flame-500">→ {r.type} →</span>
                      <strong className="text-strong">{name(r.to)}</strong>
                    </p>
                    <span
                      className={`chip px-2 py-0.5 text-[10.5px] ${
                        r.status === 'visually-confirmed' ? '' : 'border-flame-500/40 bg-flame-500/10 text-flame-600'
                      }`}
                    >
                      {r.status}
                      {r.confidence ? ` · ${r.confidence}` : ''}
                    </span>
                  </li>
                );
              })}
          </ul>
        </Card>
      )}

      <Card title="Assembly steps" aside={String(data.steps.length)}>
        <ol className="space-y-0.5">
          {data.steps.map((s, i) => {
            const state = i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'upcoming';
            const audio = stepAudio[i];
            const isPlayingThis = playingIndex === i;
            const loading = audio?.status === 'loading';
            return (
              <li key={s.id} className={`flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-sm ${state === 'current' ? 'bg-flame-500/10' : ''}`}>
                <span
                  className={`grid size-6 shrink-0 place-items-center rounded-lg font-mono text-[11px] font-bold ${
                    state === 'done' ? 'bg-mint-400/10 text-mint-400' : state === 'current' ? 'bg-flame-500 text-on-accent' : 'bg-sunken text-muted'
                  }`}
                >
                  {state === 'done' ? <Check className="size-3.5" /> : s.number}
                </span>
                <span
                  className={`min-w-0 flex-1 truncate ${
                    state === 'done' ? 'text-muted line-through decoration-line' : state === 'current' ? 'font-semibold text-strong' : 'text-body'
                  }`}
                >
                  {s.title}
                </span>
                <button
                  type="button"
                  className={`grid size-7 shrink-0 place-items-center rounded-full border bg-surface transition disabled:cursor-default disabled:opacity-50 ${
                    state === 'current' ? 'border-flame-500/50 text-flame-500' : 'border-line text-strong hover:border-line-strong'
                  }`}
                  disabled={loading}
                  title={loading ? 'Generating narration…' : isPlayingThis ? (playingPaused ? 'Resume narration' : 'Pause narration') : 'Play narration'}
                  onClick={() => onToggleStepAudio(i)}
                >
                  {loading ? (
                    <LoaderCircle className="size-3.5 animate-spin text-flame-400" />
                  ) : isPlayingThis && !playingPaused ? (
                    <Pause className="size-3.5" />
                  ) : (
                    <Play className="size-3.5" />
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      </Card>

      {!dev && importNotes.length > 0 && (
        <Card title="Notes">
          <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted">
            {importNotes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </Card>
      )}

      {dev && (
      <Card title="Data">
        <p className="text-sm text-body">
          Loaded: <strong className="text-strong">{data.robot_name}</strong> — {data.parts.length} parts, {data.steps.length} steps.
        </p>
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
          Narration audio: {narrationStats.ready}/{narrationStats.total} generated
          {narrationStats.loading > 0 && (
            <>
              <LoaderCircle className="size-3 animate-spin text-flame-400" /> {narrationStats.loading} in progress
            </>
          )}
          {narrationStats.error > 0 && <span className="text-flame-600"> · {narrationStats.error} failed</span>}
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={onLoadSample}>
            Load sample robot
          </button>
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={onLoadUpstream}>
            Load hein-parts output
          </button>
          <a className="btn-ghost px-3 py-1.5 text-xs" href="/sample-robot.json" download>
            <Download className="size-3.5" />
            Sample JSON
          </a>
        </div>
        {importNotes.length > 0 && (
          <ul className="mt-3 list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted">
            {importNotes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </Card>
      )}
    </aside>
  );
}

function Card({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  return (
    <section className="card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="label">{title}</h2>
        {aside && <span className="font-mono text-[11px] text-muted">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function PartDot({ state }: { state: PartState }) {
  if (state === 'installed') return <Check className="size-3.5 shrink-0 text-mint-400" aria-hidden />;
  return (
    <span
      className={`mx-[3px] size-2 shrink-0 rounded-full ${state === 'active' ? 'bg-flame-500 ring-4 ring-flame-500/15' : 'border border-line-strong'}`}
      aria-hidden
    />
  );
}

function Qty({ n }: { n: number }) {
  return <span className="shrink-0 rounded-md bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-muted">×{n}</span>;
}
