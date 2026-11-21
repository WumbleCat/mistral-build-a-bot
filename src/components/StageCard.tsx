import { lazy, Suspense, useRef, useState } from 'react';
import type { AssemblyData, AssemblyStep, Part } from '../types';
import type { ImageResult } from '../lib/imageGen';
import type { StepAudioState } from '../hooks/useNarrationEngine';
import { Illustration } from './Illustration';
import { PhotoPanel } from './PhotoPanel';

const Robot3DView = lazy(() => import('./three/Robot3DView').then((m) => ({ default: m.Robot3DView })));

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
  onFinish?: () => void;
}

/**
 * Left viewer card: segmented Photo / 3D / Drawing control top-left,
 * icon actions (explode, reset, fullscreen) top-right. Step text and
 * navigation live in StepPanel (right column).
 */
export function StageCard(props: StageCardProps) {
  const { data, step } = props;
  const [view, setView] = useState<'photo' | '3d' | 'drawing'>('3d');
  const [hoverPart, setHoverPart] = useState<string | null>(null);
  const cardRef = useRef<HTMLElement>(null);

  const dispatchKey = (name: string) =>
    window.dispatchEvent(new CustomEvent('bfv:key', { detail: { name } }));

  const illustration = (
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
  );

  return (
    <section className="stage-card" ref={cardRef} aria-label="Robot viewer">
      <div className="stage-enter">
        <div className="viewer-head">
          <div className="mode-toggle stage-view-toggle" role="tablist" aria-label="Stage view">
            {(['photo', '3d', 'drawing'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                className={view === v ? 'active' : ''}
                aria-selected={view === v}
                onClick={() => setView(v)}
              >
                {v === 'photo' ? 'Photo' : v === '3d' ? '3D' : 'Drawing'}
              </button>
            ))}
          </div>
          <div className="viewer-actions">
            <button type="button" className="icon-btn" onClick={() => dispatchKey('explode')} title="Toggle explode" aria-label="Toggle explode">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M12 3v18M3 12h18" /><circle cx="12" cy="12" r="3" />
              </svg>
            </button>
            <button type="button" className="icon-btn" onClick={() => dispatchKey('resetCam')} title="Reset camera view" aria-label="Reset camera view">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" />
              </svg>
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => {
                if (document.fullscreenElement) void document.exitFullscreen();
                else cardRef.current?.requestFullscreen?.();
              }}
              title="Fullscreen"
              aria-label="Toggle fullscreen"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
              </svg>
            </button>
          </div>
        </div>

        {view === 'photo' ? (
          <PhotoPanel
            data={data}
            activeIds={step.component_ids}
            highlightId={hoverPart}
            onHoverPart={setHoverPart}
          />
        ) : view === '3d' ? (
          <Suspense fallback={illustration}>
            <Robot3DView
              parts={data.parts}
              steps={data.steps}
              currentStepIndex={step.number - 1}
              installedIds={step.installed_components}
              activeIds={step.component_ids}
              highlightId={hoverPart}
              onHoverPart={setHoverPart}
              onFallback={() => setView('drawing')}
            />
          </Suspense>
        ) : (
          illustration
        )}
      </div>
    </section>
  );
}
