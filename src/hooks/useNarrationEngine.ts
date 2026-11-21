import { useCallback, useRef, useState } from 'react';
import type { AssemblyStep } from '../types';
import { NarrationPlayer, ensureNarration, type NarrationResult, type NarrationSource } from '../lib/narration';

export interface StepAudioState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  source: NarrationSource;
  audioUrl?: string;
  error?: string;
}

const EMPTY: StepAudioState = { status: 'idle', source: 'browser' };

/**
 * Central narration engine: one player, per-step generation state, session
 * caching handled inside lib/narration. Used by both workbook mode and the
 * guided walkthrough.
 */
export function useNarrationEngine(prefix: string) {
  const [states, setStates] = useState<Record<string, StepAudioState>>({});
  const playerRef = useRef<NarrationPlayer | null>(null);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  const keyFor = useCallback((step: AssemblyStep) => `${prefix}:${step.id}`, [prefix]);

  const setState = useCallback((key: string, patch: Partial<StepAudioState>) => {
    setStates((s) => ({ ...s, [key]: { ...EMPTY, ...s[key], ...patch } }));
  }, []);

  const ensure = useCallback(
    async (step: AssemblyStep, force = false): Promise<NarrationResult> => {
      const key = keyFor(step);
      setState(key, { status: 'loading' });
      const r = await ensureNarration(key, step.narration, force);
      setState(key, {
        status: r.source === 'none' ? 'error' : 'ready',
        source: r.source,
        audioUrl: r.audioUrl,
        error: r.error,
      });
      return r;
    },
    [keyFor, setState],
  );

  /** Generate narration for every step (sequentially). Never plays audio. */
  const ensureAll = useCallback(
    async (steps: AssemblyStep[], isCancelled?: () => boolean): Promise<void> => {
      for (const s of steps) {
        if (isCancelled?.()) return;
        await ensure(s);
      }
    },
    [ensure],
  );

  const stop = useCallback(() => {
    playerRef.current?.stop();
    playerRef.current = null;
    setPlayingKey(null);
    setIsPlaying(false);
    setIsPaused(false);
  }, []);

  /** Generate (if needed) and play the narration for a step. */
  const play = useCallback(
    async (step: AssemblyStep, onEnd?: () => void): Promise<NarrationResult> => {
      stop();
      const r = await ensure(step);
      if (!step.narration.trim() || (r.source !== 'tts' && !('speechSynthesis' in window))) {
        setState(keyFor(step), { status: 'error', error: r.source === 'tts' ? undefined : r.error ?? 'No audio available for this step.' });
        onEnd?.();
        return { ...r, source: 'none' };
      }
      const key = keyFor(step);
      const player = new NarrationPlayer(step.narration, r.audioUrl);
      playerRef.current = player;
      setPlayingKey(key);
      setIsPlaying(true);
      setIsPaused(false);
      player.on('end', () => {
        setIsPlaying(false);
        setPlayingKey(null);
        onEnd?.();
      });
      player.on('error', () => {
        setIsPlaying(false);
        setPlayingKey(null);
        onEnd?.();
      });
      player.on('play', () => {
        setIsPlaying(true);
        setIsPaused(false);
      });
      player.on('pause', () => setIsPaused(true));
      player.play();
      return r;
    },
    [ensure, stop, keyFor, setState],
  );

  const pause = useCallback(() => playerRef.current?.pause(), []);
  const resume = useCallback(() => playerRef.current?.resume(), []);

  return { states, keyFor, ensure, ensureAll, play, pause, resume, stop, playingKey, isPlaying, isPaused };
}
