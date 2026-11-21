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
}

export function Sidebar({ data, currentIndex, importNotes, onLoadSample, stepAudio, playingIndex, playingPaused, onToggleStepAudio, narrationStats }: SidebarProps) {
  const currentStep = data.steps[currentIndex];
  const installedSet = new Set(currentStep?.installed_components ?? []);
  const activeSet = new Set(currentStep?.component_ids ?? []);

  return (
    <aside className="sidebar">
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
