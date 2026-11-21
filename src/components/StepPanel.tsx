import type { AssemblyData, AssemblyStep, Part } from '../types';
import type { StepAudioState } from '../hooks/useNarrationEngine';
import { PartIcon } from './Sidebar';

export interface StepPanelProps {
  data: AssemblyData;
  step: AssemblyStep;
  partsById: Map<string, Part>;
  isFirst: boolean;
  isLast: boolean;
  audio: StepAudioState | undefined;
  isCurrentAudio: boolean;
  audioPlaying: boolean;
  audioPaused: boolean;
  onPlayAudio: () => void;
  onPauseAudio: () => void;
  onResumeAudio: () => void;
  onRegenerateAudio: () => void;
  onPrev: () => void;
  onNext: () => void;
  onFinish?: () => void;
  /** Guided-tour controls shown inside this panel while the tour is active. */
  guided?: {
    playing: boolean;
    paused: boolean;
    auto: boolean;
    onTogglePlay: () => void;
    onRestart: () => void;
    onToggleAuto: () => void;
  };
}

/** Right-hand step panel: kicker, title, instruction, parts for this step, actions. */
export function StepPanel(props: StepPanelProps) {
  const { data, step, partsById, isFirst, isLast, audio, isCurrentAudio, audioPlaying, audioPaused } = props;
  const stepParts = step.component_ids.map((id) => partsById.get(id)).filter((p): p is Part => Boolean(p));

  return (
    <section className="step-panel" aria-label={`Step ${step.number}`}>
      {props.guided && (
        <div className="guided-controls">
          <button type="button" className="btn btn-ghost btn-small" onClick={props.guided.onTogglePlay}>
            {props.guided.playing ? (props.guided.paused ? '▶ Resume' : '⏸ Pause') : '▶ Play'}
          </button>
          <button type="button" className="btn btn-ghost btn-small" onClick={props.onPrev}>← Back</button>
          <button type="button" className="btn btn-ghost btn-small" onClick={props.onNext}>Next →</button>
          <button type="button" className="btn btn-ghost btn-small" onClick={props.guided.onRestart}>↺ Restart</button>
          <label className="auto-toggle">
            <input type="checkbox" checked={props.guided.auto} onChange={props.guided.onToggleAuto} />
            Auto-advance
          </label>
        </div>
      )}
      <span className="step-kicker">STEP {step.number} OF {data.steps.length}</span>
      <h1 className="step-title">{step.title}</h1>
      <p className="step-instruction">{step.instruction}</p>

      {step.tip && (
        <div className="stage-tip" style={{ display: 'flex' }}>
          <span aria-hidden>Tip</span>
          <span>{step.tip}</span>
        </div>
      )}
      {step.tools && step.tools.length > 0 && (
        <div className="stage-tools" style={{ display: 'flex' }}>
          <span className="stage-tools-label">Tools</span>
          {step.tools.map((t) => (
            <span key={t} className="chip">{t}</span>
          ))}
        </div>
      )}

      <div>
        <span className="parts-label">Parts for this step</span>
        <div className="step-parts" style={{ marginTop: 8 }}>
          {stepParts.length === 0 && <span className="chip">No new parts</span>}
          {stepParts.map((p) => (
            <div key={p.id} className="step-part-row">
              <PartIcon category={p.category} name={p.name} />
              <span className="step-part-name">{p.name}</span>
              <span className="step-part-qty">×{p.quantity}</span>
              {p.unit_price != null && <span className="step-part-price">£{p.unit_price.toFixed(2)}</span>}
              {p.url && p.url !== 'TODO' && (
                <a className="chip-buy" href={p.url} target="_blank" rel="noreferrer">Buy ↗</a>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="step-actions">
        <button
          type="button"
          className="btn-play"
          onClick={() => (isCurrentAudio ? (audioPaused ? props.onResumeAudio() : props.onPauseAudio()) : props.onPlayAudio())}
          disabled={!audio && !isCurrentAudio}
          title="Play narration for this step"
        >
          <span aria-hidden>{isCurrentAudio && audioPlaying ? '⏸' : '▶'}</span>
          <span className="waveform" aria-hidden>
            {[6, 10, 14, 8, 12, 5, 9].map((h, i) => <i key={i} style={{ height: h }} />)}
          </span>
          <span>{isCurrentAudio ? (audioPaused ? 'Resume narration' : 'Pause narration') : 'Play narration'}</span>
        </button>
        <div className="step-nav" style={{ display: 'flex' }}>
          <button type="button" className="btn btn-secondary btn-nav" onClick={props.onPrev} disabled={isFirst}>
            ← Back
          </button>
          {isLast && props.onFinish ? (
            <button type="button" className="btn btn-primary btn-nav" onClick={props.onFinish}>
              Finish build →
            </button>
          ) : (
            <button type="button" className="btn btn-primary btn-nav" onClick={props.onNext} disabled={isLast}>
              Next step →
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
