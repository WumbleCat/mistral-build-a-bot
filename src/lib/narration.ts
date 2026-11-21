/**
 * Narration client: generates per-step audio through the server-side
 * /api/tts route (Mistral Voxtral TTS, voxtral-mini-tts-3-0) and falls back to
 * browser speech synthesis when the API is unavailable. Generated audio is
 * cached for the session so steps are never regenerated needlessly.
 */

export type NarrationSource = 'tts' | 'browser' | 'none';

export interface NarrationResult {
  key: string;
  source: NarrationSource;
  /** Object URL for generated audio (source === 'tts'). */
  audioUrl?: string;
  error?: string;
}

interface HealthInfo {
  tts: boolean;
  image: boolean;
  ttsModel: string;
}

let healthPromise: Promise<HealthInfo | null> | null = null;
let health: HealthInfo | null = null;

const audioCache = new Map<string, string>(); // cacheKey -> object URL
const resultCache = new Map<string, NarrationResult>();
let ttsBroken = false; // sticky flag: stop calling the API after a hard failure

export async function getHealth(): Promise<HealthInfo | null> {
  if (health) return health;
  if (!healthPromise) {
    healthPromise = fetch('/api/health')
      .then((r) => (r.ok ? (r.json() as Promise<HealthInfo>) : null))
      .then((h) => {
        health = h;
        return h;
      })
      .catch(() => {
        health = null;
        return null;
      });
  }
  return healthPromise;
}

export function clearNarrationCaches() {
  for (const url of audioCache.values()) URL.revokeObjectURL(url);
  audioCache.clear();
  resultCache.clear();
  ttsBroken = false;
}

/** Fetch (or reuse) the narration audio for a step. Never throws. `force` regenerates even if cached. */
export async function ensureNarration(cacheKey: string, text: string, force = false): Promise<NarrationResult> {
  if (force) {
    const prev = resultCache.get(cacheKey);
    if (prev?.audioUrl) {
      URL.revokeObjectURL(prev.audioUrl);
      audioCache.delete(cacheKey);
    }
    resultCache.delete(cacheKey);
  }
  const cached = resultCache.get(cacheKey);
  if (cached) return cached;

  const fallback: NarrationResult = { key: cacheKey, source: 'browser' };
  if (!text.trim()) {
    const none: NarrationResult = { key: cacheKey, source: 'none', error: 'No narration text for this step.' };
    resultCache.set(cacheKey, none);
    return none;
  }

  if (!ttsBroken) {
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        const blob = await res.blob();
        const existing = audioCache.get(cacheKey);
        const url = existing ?? URL.createObjectURL(blob);
        if (!existing) audioCache.set(cacheKey, url);
        const result: NarrationResult = { key: cacheKey, source: 'tts', audioUrl: url };
        resultCache.set(cacheKey, result);
        return result;
      }
      if (res.status === 503) {
        // Expected when no API key is configured — permanent for this session.
        ttsBroken = true;
      } else {
        const detail = await res.json().catch(() => null);
        const result: NarrationResult = {
          key: cacheKey,
          source: 'browser',
          error: detail?.error ?? `TTS request failed (HTTP ${res.status}). Using browser voice.`,
        };
        resultCache.set(cacheKey, result);
        return result;
      }
    } catch (err) {
      const result: NarrationResult = {
        key: cacheKey,
        source: 'browser',
        error: `TTS unreachable (${(err as Error).message}). Using browser voice.`,
      };
      resultCache.set(cacheKey, result);
      return result;
    }
  }
  resultCache.set(cacheKey, fallback);
  return fallback;
}

type PlayerEvent = 'play' | 'pause' | 'end' | 'error';

/**
 * Unified playback for generated audio (HTMLAudioElement) and browser speech
 * synthesis. Callbacks let the walkthrough react to narration ending.
 */
export class NarrationPlayer {
  private audio: HTMLAudioElement | null = null;
  private listeners: Record<PlayerEvent, Array<() => void>> = { play: [], pause: [], end: [], error: [] };
  private usingSpeech = false;
  private text: string;
  private audioUrl?: string;
  playing = false;

  constructor(text: string, audioUrl?: string) {
    this.text = text;
    this.audioUrl = audioUrl;
  }

  on(event: PlayerEvent, cb: () => void) {
    this.listeners[event].push(cb);
  }

  private emit(event: PlayerEvent) {
    for (const cb of this.listeners[event]) cb();
  }

  /** Start playback from the beginning (replay). */
  play() {
    this.stopInternal();
    if (this.audioUrl) {
      this.usingSpeech = false;
      const audio = new Audio(this.audioUrl);
      audio.onplay = () => {
        this.playing = true;
        this.emit('play');
      };
      audio.onpause = () => {
        this.playing = false;
        this.emit('pause');
      };
      audio.onended = () => {
        this.playing = false;
        this.emit('end');
      };
      audio.onerror = () => {
        this.playing = false;
        this.emit('error');
      };
      this.audio = audio;
      void audio.play().catch(() => this.emit('error'));
    } else if ('speechSynthesis' in window) {
      this.usingSpeech = true;
      const utterance = new SpeechSynthesisUtterance(this.text);
      utterance.onstart = () => {
        this.playing = true;
        this.emit('play');
      };
      utterance.onend = () => {
        this.playing = false;
        this.emit('end');
      };
      utterance.onerror = () => {
        this.playing = false;
        this.emit('error');
      };
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    } else {
      this.emit('error');
    }
  }

  pause() {
    if (this.audio && !this.audio.paused) {
      this.audio.pause();
    } else if (this.usingSpeech && 'speechSynthesis' in window) {
      window.speechSynthesis.pause();
      this.playing = false;
      this.emit('pause');
    }
  }

  resume() {
    if (this.audio && this.audio.paused) {
      void this.audio.play().catch(() => this.emit('error'));
    } else if (this.usingSpeech && 'speechSynthesis' in window) {
      window.speechSynthesis.resume();
      this.playing = true;
      this.emit('play');
    }
  }

  private stopInternal() {
    if (this.audio) {
      this.audio.onplay = this.audio.onpause = this.audio.onended = this.audio.onerror = null;
      this.audio.pause();
      this.audio = null;
    }
    if (this.usingSpeech && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    this.usingSpeech = false;
    this.playing = false;
  }

  stop() {
    this.stopInternal();
    this.emit('pause');
  }
}
