import { Pause, Play, RefreshCw, RotateCcw, Volume2 } from 'lucide-react';
import type { AssemblyStep } from '../types';
import { Spinner } from './Shell';
import type { StepAudioState } from '../hooks/useNarrationEngine';

export interface AudioControlsProps {
  step: AssemblyStep;
  audio: StepAudioState | undefined;
  isCurrent: boolean; // this step is the one currently loaded in the player
  playing: boolean;
  paused: boolean;
  onPlay: () => void;
  onPause: () => void;
  onResume: () => void;
  onRegenerate: () => void;
}

function sourceLabel(audio: StepAudioState | undefined): string {
  if (!audio) return 'Preparing narration…';
  if (audio.status === 'loading') return 'Generating narration…';
  if (audio.source === 'tts') return 'Mistral Voxtral TTS audio ready';
  if (audio.source === 'browser') return 'Browser speech synthesis (TTS API unavailable)';
  return 'No audio available';
}

/**
 * Per-step narration player. Narration is generated automatically when the
 * workbook loads, so the player is available without any extra click; audio is
 * never auto-played. The written instruction stays visible in the stage card
 * regardless of the audio state.
 */
export function AudioControls({ step, audio, isCurrent, playing, paused, onPlay, onPause, onResume, onRegenerate }: AudioControlsProps) {
  const status = audio?.status ?? 'idle';
  const loading = status === 'loading';
  const ready = status === 'ready';
  const ended = isCurrent && !playing && !paused && ready;

  return (
    <div className="space-y-3 rounded-xl border border-line bg-sunken/50 p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-surface text-flame-400">
          <Volume2 className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="label">Narration</p>
          <blockquote className="mt-1 text-sm text-body italic">“{step.narration}”</blockquote>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {loading && <Spinner label="Generating narration…" />}
        {!loading && ready && !isCurrent && (
          <button type="button" className="btn-primary" onClick={onPlay}>
            <Play className="size-4" /> Play
          </button>
        )}
        {!loading && isCurrent && playing && !paused && (
          <button type="button" className="btn-primary" onClick={onPause}>
            <Pause className="size-4" /> Pause
          </button>
        )}
        {!loading && isCurrent && paused && (
          <button type="button" className="btn-primary" onClick={onResume}>
            <Play className="size-4" /> Resume
          </button>
        )}
        {!loading && ended && (
          <button type="button" className="btn-primary" onClick={onPlay}>
            <RotateCcw className="size-4" /> Replay
          </button>
        )}
        {!loading && (ready || status === 'error') && (
          <button type="button" className="btn-ghost px-3 py-2 text-xs" onClick={onRegenerate} title="Regenerate the narration audio for this step">
            <RefreshCw className="size-3.5" /> Regenerate
          </button>
        )}
        {!loading && (
          <span className={`ml-auto text-xs ${status === 'error' ? 'text-flame-600' : 'text-muted'}`}>
            {status === 'error'
              ? `${audio?.error ?? 'Narration could not be generated.'} The written instructions above still apply.`
              : sourceLabel(audio)}
          </span>
        )}
      </div>
    </div>
  );
}
