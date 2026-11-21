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
        <h2 className="card-title">Parts list</h2>
        <ul className="parts-list">
          {data.parts.map((p) => {
            const state = activeSet.has(p.id) ? 'active' : installedSet.has(p.id) ? 'installed' : 'pending';
            return (
              <li key={p.id} className={`part-row part-${state}`}>
                <span className="part-status" aria-hidden>
                  {state === 'installed' ? '✓' : state === 'active' ? '●' : '○'}
                </span>
                <span className="part-name">{p.name}</span>
                <span className="part-qty">×{p.quantity}</span>
              </li>
            );
          })}
        </ul>
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
