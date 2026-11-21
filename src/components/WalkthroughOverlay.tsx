import type { AssemblyData, Part } from '../types';
import type { ImageResult } from '../lib/imageGen';
import type { StepAudioState } from '../hooks/useNarrationEngine';
import { ArrowLeft, ArrowRight, Bot, Headphones, Pause, Play, SkipBack, X } from 'lucide-react';
import { Illustration } from './Illustration';
import { TopBar } from './Shell';

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
  explodedOn?: boolean;
  onToggleExploded?: () => void;
  assistantOpen?: boolean;
  onToggleAssistant?: () => void;
  assistantMention?: string | null;
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
    <div className="stage-enter fixed inset-0 z-50 overflow-y-auto bg-canvas" role="dialog" aria-label="Guided walkthrough">
      <TopBar onLogoClick={props.onExit} progress={progress}>
        <span className="chip hidden sm:inline-flex">
          <Headphones className="size-3.5 text-flame-400" />
          Guided walkthrough
        </span>
        <span className="font-mono text-xs text-muted tabular-nums">
          Step {step.number}/{data.steps.length}
        </span>
        <button
          type="button"
          className={`${props.assistantOpen ? 'btn-primary' : 'btn-ghost'} px-3 py-2`}
          onClick={props.onToggleAssistant}
          title="Ask the AI assembly assistant"
          aria-pressed={props.assistantOpen}
        >
          <Bot className="size-4" />
          <span className="hidden sm:inline">Assistant</span>
        </button>
        <button type="button" className="rounded-lg p-2 text-muted transition hover:bg-sunken hover:text-strong" onClick={props.onExit} title="Exit walkthrough" aria-label="Exit walkthrough">
          <X className="size-4" />
        </button>
      </TopBar>

      <div className="mx-auto w-full max-w-5xl px-4 pt-6 pb-36 sm:px-6">
        <section className="card p-5 sm:p-6" key={step.id}>
          <div className="stage-enter space-y-5">
            <div>
              <p className="label">
                Step {step.number} of {data.steps.length}
              </p>
              <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">{step.title}</h1>
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
              extraHighlight={props.assistantMention ?? null}
            />
            <p className="max-w-[70ch] text-lg leading-relaxed text-body sm:text-xl">{step.instruction}</p>
            {required.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {required.map((p) => (
                  <span key={p.id} className="chip border-flame-500/40 bg-flame-500/10 text-flame-600">
                    {p.name}
                    {p.quantity > 1 ? ` ×${p.quantity}` : ''}
                  </span>
                ))}
              </div>
            )}
            <blockquote className="border-l-2 border-flame-500/50 pl-3 text-sm text-muted italic">“{step.narration}”</blockquote>
            {audioTimed && <p className="text-xs text-flame-600">No audio available for this step — advancing on a timer.</p>}
          </div>
        </section>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-[60] border-t border-line-soft/80 bg-canvas/90 backdrop-blur-lg">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-center gap-2 px-4 py-3 sm:px-6">
          <button type="button" className="btn-ghost" onClick={props.onRestart} title="Restart from step 1">
            <SkipBack className="size-4" />
            <span className="hidden sm:inline">Restart</span>
          </button>
          <button type="button" className="btn-ghost" onClick={props.onPrev} disabled={index === 0} title="Previous step">
            <ArrowLeft className="size-4" />
            <span className="hidden sm:inline">Prev</span>
          </button>
          <button type="button" className="btn-primary min-w-32" onClick={props.onTogglePlay}>
            {!props.playing || props.paused ? <Play className="size-4" /> : <Pause className="size-4" />}
            {!props.playing ? 'Play' : props.paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className="btn-ghost" onClick={props.onNext} disabled={index === data.steps.length - 1} title="Next step">
            <span className="hidden sm:inline">Next</span>
            <ArrowRight className="size-4" />
          </button>
          <label className="ml-2 inline-flex cursor-pointer items-center gap-2 text-xs text-muted select-none">
            <input type="checkbox" className="size-4 accent-flame-500" checked={props.auto} onChange={props.onToggleAuto} />
            Auto-advance after narration
          </label>
          <span className="min-w-36 text-xs text-muted">
            {props.playing ? (props.paused ? 'Paused' : 'Playing narration…') : 'Paused — press Play'}
          </span>
        </div>
      </div>
    </div>
  );
}
