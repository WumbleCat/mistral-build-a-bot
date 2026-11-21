import { useCallback, useRef, useState } from 'react';

/**
 * Tiny WebAudio UI sounds for the hangar theme. Muted by default; the header
 * speaker toggle flips `muted`. Never throws — audio is a nice-to-have.
 */
export function useGameFx() {
  const [muted, setMuted] = useState(true);
  const ctxRef = useRef<AudioContext | null>(null);

  const blip = useCallback((kind: 'step' | 'land' | 'complete' | 'ui') => {
    if (muted) return;
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      if (!ctxRef.current) ctxRef.current = new Ctx();
      const ctx = ctxRef.current;
      if (ctx.state === 'suspended') void ctx.resume();
      const t0 = ctx.currentTime;
      const notes: Record<string, number[]> = {
        step: [660],
        land: [440, 660],
        complete: [523, 659, 784, 1046],
        ui: [880],
      };
      const freqs = notes[kind] ?? notes.ui;
      freqs.forEach((f, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = f;
        const start = t0 + i * 0.07;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.05, start + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.09);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.1);
      });
    } catch {
      /* audio unavailable — ignore */
    }
  }, [muted]);

  const toggleMuted = useCallback(() => setMuted((m) => !m), []);

  return { muted, toggleMuted, blip };
}
