import type { AssemblyStep } from '../types';
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
    <div className="audio-controls">
      <div className="audio-text">
        <span className="audio-label">Narration</span>
        <blockquote>“{step.narration}”</blockquote>
      </div>
      <div className="audio-buttons">
        {loading && (
          <span className="audio-loading">
            <span className="spinner" aria-hidden /> Generating narration…
          </span>
        )}
        {!loading && ready && !isCurrent && (
          <button type="button" className="btn btn-primary" onClick={onPlay}>
            ▶ Play
          </button>
        )}
        {!loading && isCurrent && playing && !paused && (
          <button type="button" className="btn btn-primary" onClick={onPause}>
            ⏸ Pause
          </button>
        )}
        {!loading && isCurrent && paused && (
          <button type="button" className="btn btn-primary" onClick={onResume}>
            ▶ Resume
          </button>
        )}
        {!loading && ended && (
          <button type="button" className="btn btn-primary" onClick={onPlay}>
            ↻ Replay
          </button>
        )}
        {!loading && (ready || status === 'error') && (
          <button type="button" className="btn btn-ghost btn-small" onClick={onRegenerate} title="Regenerate the narration audio for this step">
            ↻ Regenerate
          </button>
        )}
      </div>
      <div className={`audio-status ${status === 'error' ? 'audio-status-error' : ''}`}>
        {status === 'error'
          ? `${audio?.error ?? 'Narration could not be generated.'} The written instructions above still apply.`
          : sourceLabel(audio)}
      </div>
    </div>
  );
}
