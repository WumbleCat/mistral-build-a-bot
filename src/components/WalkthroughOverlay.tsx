import type { AssemblyData, Part } from '../types';
import type { ImageResult } from '../lib/imageGen';
import type { StepAudioState } from '../hooks/useNarrationEngine';
import { Illustration } from './Illustration';

export interface WalkthroughOverlayProps {
  data: AssemblyData;
  index: number;
  partsById: Map<string, Part>;
  audio: StepAudioState | undefined;
  playing: boolean;
  paused: boolean;
  auto: boolean;
  image?: ImageResult;
  imageLoading?: boolean;
  imageAvailable?: boolean;
  onGenerateImage?: () => void;
  explodedAvailable?: boolean;
  explodedUrl?: string;
  onTogglePlay: () => void;
  onPrev: () => void;
  onNext: () => void;
  onRestart: () => void;
  onToggleAuto: () => void;
  onExit: () => void;
}

export function WalkthroughOverlay(props: WalkthroughOverlayProps) {
  const { data, index } = props;
  const step = data.steps[index];
  if (!step) return null;
  const required = step.component_ids.map((id) => props.partsById.get(id)).filter((p): p is Part => Boolean(p));
  const progress = (index + 1) / data.steps.length;
  const audioTimed = props.audio?.source === 'none';

  return (
    <div className="walkthrough" role="dialog" aria-label="Guided walkthrough">
      <div className="walkthrough-inner">
        <div className="walkthrough-top">
          <span className="walkthrough-tag">🎧 Guided walkthrough</span>
          <span className="walkthrough-progress-text">
            Step {step.number} of {data.steps.length}
          </span>
          <div className="progress-track walkthrough-progress">
            <div className="progress-fill" style={{ width: `${progress * 100}%` }} />
          </div>
          <button type="button" className="btn btn-ghost btn-small" onClick={props.onExit}>
            ✕ Exit walkthrough
          </button>
        </div>

        <div className="walkthrough-stage" key={step.id}>
          <div className="stage-enter">
            <h1 className="stage-title">{step.title}</h1>
            <Illustration
              data={data}
              step={step}
              image={props.image}
              imageLoading={props.imageLoading}
              imageAvailable={props.imageAvailable}
              onGenerateImage={props.onGenerateImage}
              explodedAvailable={props.explodedAvailable}
              explodedUrl={props.explodedUrl}
            />
            <p className="stage-instruction stage-instruction-large">{step.instruction}</p>
            <div className="chip-row">
              {required.map((p) => (
                <span key={p.id} className="chip chip-accent">
                  {p.name}
                  {p.quantity > 1 ? ` ×${p.quantity}` : ''}
                </span>
              ))}
            </div>
            <p className="walkthrough-narration">“{step.narration}”</p>
            {audioTimed && <p className="walkthrough-timed">No audio available for this step — advancing on a timer.</p>}
          </div>
        </div>

        <div className="walkthrough-controls">
          <button type="button" className="btn btn-secondary" onClick={props.onRestart} title="Restart from step 1">
            ⏮ Restart
          </button>
          <button type="button" className="btn btn-secondary" onClick={props.onPrev} disabled={index === 0} title="Previous step">
            ← Prev
          </button>
          <button type="button" className="btn btn-primary btn-play" onClick={props.onTogglePlay}>
            {!props.playing ? '▶ Play' : props.paused ? '▶ Resume' : '⏸ Pause'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={props.onNext} disabled={index === data.steps.length - 1} title="Next step">
            Next →
          </button>
          <label className="auto-advance">
            <input type="checkbox" checked={props.auto} onChange={props.onToggleAuto} />
            Auto-advance after narration
          </label>
          <span className="walkthrough-status">
            {props.playing ? (props.paused ? 'Paused' : 'Playing narration…') : 'Paused — press Play'}
          </span>
        </div>
      </div>
    </div>
  );
}
