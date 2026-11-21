import type { AssemblyData } from '../types';
import type { StepAudioState } from '../hooks/useNarrationEngine';

/** Tiny pixel-style category icon (original, crisp rects). */
function PartIcon({ category, name }: { category?: string; name: string }) {
  const c = (category || '').toLowerCase();
  const hay = `${c} ${name}`.toLowerCase();
  const P = '#FF8205';
  const D = '#262C38';
  const rects = (list: Array<[number, number, number, number, string]>) =>
    list.map(([x, y, w, h, f], i) => <rect key={i} x={x} y={y} width={w} height={h} fill={f} />);
  let body;
  if (/wheel|tyre|tire/.test(hay)) {
    body = rects([[2, 4, 12, 8, P], [5, 6, 6, 4, D], [6, 7, 4, 2, P]]);
  } else if (/motor|servo|actuator/.test(hay)) {
    body = rects([[3, 6, 6, 5, P], [9, 7, 5, 3, '#FFD800']]);
  } else if (/driver|relay|h-?bridge/.test(hay)) {
    body = rects([[3, 4, 10, 8, P], [5, 6, 3, 3, D], [9, 6, 2, 4, '#FFAF00']]);
  } else if (/controller|mcu|arduino|esp|raspberry|board/.test(hay)) {
    body = rects([[2, 5, 12, 7, '#2A2F3A'], [4, 7, 8, 1, P], [4, 9, 8, 1, P], [12, 6, 2, 3, '#8A90A0']]);
  } else if (/battery|power|cell|lipo/.test(hay)) {
    body = rects([[3, 5, 10, 7, P], [11, 7, 2, 3, '#E8E6E1'], [5, 7, 2, 3, D], [8, 7, 2, 3, D]]);
  } else if (/sensor/.test(hay)) {
    body = rects([[3, 6, 10, 5, P], [5, 4, 2, 3, '#8A90A0'], [9, 4, 2, 3, '#8A90A0']]);
  } else if (/chassis|frame|deck|base/.test(hay)) {
    body = rects([[2, 6, 12, 5, P], [4, 4, 2, 2, D], [10, 4, 2, 2, D]]);
  } else if (/wire|cable|jumper|lead|harness/.test(hay)) {
    body = rects([[2, 8, 4, 2, P], [6, 6, 4, 2, '#FFAF00'], [10, 8, 4, 2, '#FFD800']]);
  } else if (/screw|bolt|nut|fastener|standoff/.test(hay)) {
    body = rects([[6, 3, 4, 10, '#8A90A0'], [4, 3, 8, 3, P]]);
  } else if (/breadboard/.test(hay)) {
    body = rects([[2, 5, 12, 7, '#E8E6E1'], [4, 7, 2, 1, D], [7, 7, 2, 1, D], [10, 7, 2, 1, D], [4, 9, 2, 1, P], [7, 9, 2, 1, P]]);
  } else {
    body = rects([[4, 4, 8, 8, P], [6, 6, 4, 4, D]]);
  }
  return (
    <svg viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden>
      {body}
    </svg>
  );
}

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
}

export function Sidebar({ data, currentIndex, importNotes, onLoadSample, onLoadUpstream, stepAudio, playingIndex, playingPaused, onToggleStepAudio, narrationStats, checklist, onToggleChecklist, allTools }: SidebarProps) {
  const currentStep = data.steps[currentIndex];
  const installedSet = new Set(currentStep?.installed_components ?? []);
  const activeSet = new Set(currentStep?.component_ids ?? []);
  const checkedCount = checklist ? data.parts.filter((p) => checklist.has(p.id)).length : 0;
  const allChecked = checkedCount === data.parts.length;

  return (
    <aside className="sidebar">
      {checklist && onToggleChecklist && (
        <section className="card">
          <h2 className="card-title">Pre-assembly checklist</h2>
          <p className="checklist-progress">Tick off parts you have physically located: {checkedCount}/{data.parts.length}</p>
          <ul className="parts-list">
            {data.parts.map((p) => {
              const checked = checklist.has(p.id);
              const state = activeSet.has(p.id) ? 'active' : installedSet.has(p.id) ? 'installed' : 'pending';
              return (
                <li key={p.id} className={`part-row part-${state} checklist-row ${checked ? 'checked' : ''}`} onClick={() => onToggleChecklist(p.id)}>
                  <input type="checkbox" checked={checked} onChange={() => onToggleChecklist(p.id)} onClick={(e) => e.stopPropagation()} aria-label={`Mark ${p.name} as located`} />
                  <span className="part-status" aria-hidden>
                    {state === 'installed' ? '✓' : state === 'active' ? '●' : '○'}
                  </span>
                  <span className="part-name">{p.name}</span>
                  <span className="part-qty">×{p.quantity}</span>
                </li>
              );
            })}
          </ul>
          {allChecked && <p className="checklist-ready">✓ All parts located — ready to build!</p>}
          {allTools && allTools.length > 0 && (
            <div className="checklist-tools">
              <span className="parts-label">Tools needed</span>
              <div className="chip-row" style={{ marginTop: 6 }}>
                {allTools.map((t) => (
                  <span key={t} className="chip chip-muted">🔧 {t}</span>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
      <section className="card">
        <h2 className="card-title">Inventory</h2>
        <ul className="inv-grid">
          {data.parts.map((p) => {
            const state = activeSet.has(p.id) ? 'active' : installedSet.has(p.id) ? 'installed' : 'pending';
            return (
              <li key={p.id} className={`inv-slot state-${state}`} title={`${p.name} ×${p.quantity}${p.unit_price != null ? ` · £${p.unit_price.toFixed(2)}` : ''}`}>
                <PartIcon category={p.category} name={p.name} />
                <span className="inv-qty">×{p.quantity}</span>
                {p.unit_price != null && <span className="inv-price">£{p.unit_price.toFixed(2)}</span>}
              </li>
            );
          })}
        </ul>
        <p className="inv-legend">slot border: amber = installed · flame = in current step · dim = pending</p>
      </section>

      {data.relationships && data.relationships.length > 0 && (
        <section className="card">
          <h2 className="card-title">Connections</h2>
          <ul className="rel-list">
            {data.relationships
              .filter((r) => activeSet.has(r.from) || activeSet.has(r.to) || installedSet.has(r.from) || installedSet.has(r.to))
              .concat(data.relationships.filter((r) => !(activeSet.has(r.from) || activeSet.has(r.to) || installedSet.has(r.from) || installedSet.has(r.to))))
              .slice(0, 12)
              .map((r) => {
                const name = (id: string) => data.parts.find((p) => p.id === id)?.name ?? id;
                const involvesCurrent = activeSet.has(r.from) || activeSet.has(r.to);
                return (
                  <li key={r.id} className={`rel-row ${involvesCurrent ? 'rel-current' : ''}`}>
                    <span className="rel-line">
                      <strong>{name(r.from)}</strong>
                      <span className="rel-arrow">→ {r.type} →</span>
                      <strong>{name(r.to)}</strong>
                    </span>
                    <span className={`chip ${r.status === 'visually-confirmed' ? 'chip-muted' : 'chip-accent'}`}>
                      {r.status}{r.confidence ? ` · ${r.confidence}` : ''}
                    </span>
                  </li>
                );
              })}
          </ul>
        </section>
      )}

      <section className="card">
        <h2 className="card-title">Assembly steps</h2>
        <ol className="steps-list">
          {data.steps.map((s, i) => {
            const state = i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'upcoming';
            const audio = stepAudio[i];
            const isPlayingThis = playingIndex === i;
            const loading = audio?.status === 'loading';
            return (
              <li key={s.id} className={`step-row step-${state}`}>
                <span className="step-num">{state === 'done' ? '✓' : s.number}</span>
                <span className="step-title">{s.title}</span>
                <button
                  type="button"
                  className="step-play"
                  disabled={loading}
                  title={loading ? 'Generating narration…' : isPlayingThis ? (playingPaused ? 'Resume narration' : 'Pause narration') : 'Play narration'}
                  onClick={() => onToggleStepAudio(i)}
                >
                  {loading ? <span className="spinner spinner-small" aria-hidden /> : isPlayingThis ? (playingPaused ? '▶' : '⏸') : '▶'}
                </button>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="card">
        <h2 className="card-title">Data</h2>
        <p className="card-note">
          Loaded: <strong>{data.robot_name}</strong> — {data.parts.length} parts, {data.steps.length} steps.
        </p>
        <p className="card-note narration-stats">
          Narration audio: {narrationStats.ready}/{narrationStats.total} generated
          {narrationStats.loading > 0 && (
            <>
              {' '}
              <span className="spinner spinner-small" aria-hidden /> {narrationStats.loading} in progress
            </>
          )}
          {narrationStats.error > 0 && <span className="narration-stats-error"> · {narrationStats.error} failed</span>}
        </p>
        <div className="card-actions">
          <button type="button" className="btn btn-ghost btn-small" onClick={onLoadSample}>
            Load sample robot
          </button>
          <button type="button" className="btn btn-ghost btn-small" onClick={onLoadUpstream}>
            Load hein-parts output
          </button>
          <a className="btn btn-ghost btn-small" href="/sample-robot.json" download>
            Download sample JSON
          </a>
        </div>
        {importNotes.length > 0 && (
          <ul className="import-notes">
            {importNotes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
