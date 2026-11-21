import { lazy, Suspense, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Lightbulb, TriangleAlert, Wrench } from 'lucide-react';
import type { AssemblyData, AssemblyStep, Part } from '../types';
import type { ImageResult } from '../lib/imageGen';
import type { StepAudioState } from '../hooks/useNarrationEngine';
import { Illustration } from './Illustration';
import { AudioControls } from './AudioControls';
import { PhotoPanel } from './PhotoPanel';

// three.js is large: load it only when the 3D view is shown.
const Robot3DView = lazy(() => import('./three/Robot3DView').then((m) => ({ default: m.Robot3DView })));

type StageView = '3d' | 'drawing' | 'photo';
const VIEWS: Array<{ key: StageView; label: string }> = [
  { key: '3d', label: '3D' },
  { key: 'drawing', label: 'Drawing' },
  { key: 'photo', label: 'Photo' },
];

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
  const [view, setView] = useState<StageView>('3d');
  const [hoverPart, setHoverPart] = useState<string | null>(null);

  return (
    <section className="card min-w-0 p-5 sm:p-6" key={step.id}>
      <div className="stage-enter space-y-5" key={step.id}>
        <div className="flex flex-wrap items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-flame-500/30 bg-flame-500/10 font-mono text-sm font-bold text-flame-500">
            {step.number}
          </span>
          <div className="min-w-0">
            <p className="label">
              Step {step.number} of {data.steps.length}
            </p>
            <h2 className="text-xl font-bold tracking-tight sm:text-2xl">{step.title}</h2>
          </div>
          {step.uncertain && <span className="chip ml-auto">Not verified</span>}
        </div>

        <div className="space-y-3">
          <div role="group" aria-label="Stage view" className="inline-flex rounded-xl border border-line bg-sunken/60 p-1">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                type="button"
                aria-pressed={view === v.key}
                onClick={() => setView(v.key)}
                className={`rounded-lg px-3.5 py-1.5 text-sm font-semibold transition ${
                  view === v.key ? 'bg-surface text-strong shadow-sm' : 'text-muted hover:text-strong'
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>

          {view === '3d' && (
            <Suspense fallback={<div className="skeleton h-[460px] rounded-2xl" />}>
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
          )}
          {view === 'photo' && (
            <PhotoPanel data={data} activeIds={step.component_ids} highlightId={hoverPart} onHoverPart={setHoverPart} />
          )}
          {view === 'drawing' && (
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
          )}
        </div>

        <p className="max-w-[70ch] text-[16px] leading-relaxed text-body">{step.instruction}</p>

        {step.tip && (
          <p className="flex gap-2 rounded-xl border border-line bg-sunken/60 p-3 text-sm text-body">
            <Lightbulb className="mt-0.5 size-4 shrink-0 text-flame-400" />
            {step.tip}
          </p>
        )}

        {step.safety && (
          <p className="flex gap-2 rounded-xl border border-flame-500/30 bg-flame-500/10 p-3 text-sm text-flame-600">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            {step.safety}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="label mb-1.5">Add in this step</p>
            <div className="flex flex-wrap gap-1.5">
              {required.length === 0 && <span className="chip text-muted">No new parts</span>}
              {required.map((p) => (
                <span
                  key={p.id}
                  className="chip border-flame-500/40 bg-flame-500/10 text-flame-600"
                  onMouseEnter={() => setHoverPart(p.id)}
                  onMouseLeave={() => setHoverPart(null)}
                >
                  {p.name}
                  {p.quantity > 1 ? ` ×${p.quantity}` : ''}
                  {(p.product_url || (p.url && p.url !== 'TODO')) && (
                    <a
                      href={p.product_url || p.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-0.5 font-semibold underline underline-offset-2"
                    >
                      Buy
                      <ArrowUpRight className="size-3" />
                    </a>
                  )}
                </span>
              ))}
            </div>
          </div>

          {step.tools && step.tools.length > 0 && (
            <div>
              <p className="label mb-1.5">Tools</p>
              <div className="flex flex-wrap gap-1.5">
                {step.tools.map((t) => (
                  <span key={t} className="chip">
                    <Wrench className="size-3" />
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          {installedBefore.length > 0 && (
            <div className="sm:col-span-2">
              <p className="label mb-1.5">Already installed</p>
              <div className="flex flex-wrap gap-1.5">
                {installedBefore.map((id) => (
                  <span key={id} className="chip text-muted">
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

        <div className="flex justify-between gap-3 border-t border-line-soft pt-5">
          <button type="button" className="btn-ghost min-w-32" onClick={props.onPrev} disabled={props.isFirst}>
            <ArrowLeft className="size-4" />
            Previous
          </button>
          <button type="button" className="btn-primary min-w-32" onClick={props.onNext} disabled={props.isLast}>
            Next
            <ArrowRight className="size-4" />
          </button>
        </div>
      </div>
    </section>
  );
}
