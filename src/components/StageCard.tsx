import type { AssemblyData, AssemblyStep, Part } from '../types';
import type { ImageResult } from '../lib/imageGen';
import type { StepAudioState } from '../hooks/useNarrationEngine';
import { Illustration } from './Illustration';
import { AudioControls } from './AudioControls';

export interface StageCardProps {
  data: AssemblyData;
  step: AssemblyStep;
  partsById: Map<string, Part>;
  isFirst: boolean;
  isLast: boolean;
  audio: StepAudioState | undefined;
  isCurrentAudio: boolean;
  audioPlaying: boolean;
  audioPaused: boolean;
  image?: ImageResult;
  imageLoading?: boolean;
  imageAvailable?: boolean;
  onGenerateImage?: () => void;
  explodedAvailable?: boolean;
  explodedUrl?: string;
  explodedOn?: boolean;
  onToggleExploded?: () => void;
  onRegenerateAudio: () => void;
  onPlayAudio: () => void;
  onPauseAudio: () => void;
  onResumeAudio: () => void;
  onPrev: () => void;
  onNext: () => void;
}

export function StageCard(props: StageCardProps) {
  const { data, step, partsById } = props;
  const required = step.component_ids.map((id) => partsById.get(id)).filter((p): p is Part => Boolean(p));
  const installedBefore = step.installed_components.filter((id) => !step.component_ids.includes(id));

  return (
    <section className="stage-card" key={step.id}>
      <div className="stage-enter" key={step.id}>
        <div className="stage-heading">
          <span className="step-chip">
            Step {step.number} / {data.steps.length}
          </span>
          <h1 className="stage-title">{step.title}</h1>
        </div>

        <Illustration
          data={data}
          step={step}
          image={props.image}
          imageLoading={props.imageLoading}
          imageAvailable={props.imageAvailable}
          onGenerateImage={props.onGenerateImage}
          explodedAvailable={props.explodedAvailable}
          explodedUrl={props.explodedUrl}
          explodedOn={props.explodedOn}
          onToggleExploded={props.onToggleExploded}
        />

        <p className="stage-instruction">{step.instruction}</p>

        {step.tip && (
          <div className="stage-tip">
            <span className="stage-tip-icon" aria-hidden>💡</span>
            <span>{step.tip}</span>
          </div>
        )}
        {step.tools && step.tools.length > 0 && (
          <div className="stage-tools">
            <span className="stage-tools-label">Tools</span>
            {step.tools.map((t) => (
              <span key={t} className="chip chip-muted">🔧 {t}</span>
            ))}
          </div>
        )}

        <div className="stage-parts">
          <div className="parts-group">
            <span className="parts-label">Add in this step</span>
            <div className="chip-row">
              {required.length === 0 && <span className="chip chip-muted">No new parts</span>}
              {required.map((p) => (
                <span key={p.id} className="chip chip-accent">
                  {p.name}
                  {p.quantity > 1 ? ` ×${p.quantity}` : ''}
                </span>
              ))}
            </div>
          </div>
          {installedBefore.length > 0 && (
            <div className="parts-group">
              <span className="parts-label">Already installed</span>
              <div className="chip-row">
                {installedBefore.map((id) => (
                  <span key={id} className="chip chip-muted">
                    {partsById.get(id)?.name ?? id}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <AudioControls
          step={step}
          audio={props.audio}
          isCurrent={props.isCurrentAudio}
          playing={props.audioPlaying}
          paused={props.audioPaused}
          onPlay={props.onPlayAudio}
          onPause={props.onPauseAudio}
          onResume={props.onResumeAudio}
          onRegenerate={props.onRegenerateAudio}
        />

        <div className="stage-nav">
          <button type="button" className="btn btn-secondary btn-nav" onClick={props.onPrev} disabled={props.isFirst}>
            ← Previous
          </button>
          <button type="button" className="btn btn-primary btn-nav" onClick={props.onNext} disabled={props.isLast}>
            Next →
          </button>
        </div>
      </div>
    </section>
  );
}
