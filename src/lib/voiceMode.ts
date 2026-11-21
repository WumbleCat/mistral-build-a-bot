/**
 * Continuous hands-free voice mode for the assembly assistant.
 *
 * Uses the browser-native Web Speech API (SpeechRecognition) for continuous
 * listening — no API key, no streaming infrastructure, works in Chrome/Edge.
 * Spoken answers reuse the existing Voxtral TTS / speechSynthesis path.
 *
 * State machine:
 *   idle → listening → speech → processing → responding → speaking → listening …
 *
 * The microphone is paused while the assistant speaks so it never transcribes
 * its own voice. Voice mode is only ever started by an explicit user action.
 */

export type VoiceState = 'idle' | 'listening' | 'speech' | 'processing' | 'responding' | 'speaking' | 'error';

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: unknown) => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onstart: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export function speechRecognitionAvailable(): boolean {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

export interface VoiceCallbacks {
  onState: (s: VoiceState) => void;
  onTranscript: (text: string, isFinal: boolean) => void;
  onFinalUtterance: (text: string) => void;
  onError: (message: string) => void;
}

export class VoiceMode {
  private recognition: SpeechRecognitionLike | null = null;
  private cb: VoiceCallbacks;
  private active = false;
  private mutedWhileSpeaking = false;
  private lastUtterance = '';
  private lastUtteranceAt = 0;
  private restartTimer: number | null = null;

  constructor(cb: VoiceCallbacks) {
    this.cb = cb;
  }

  get isActive() {
    return this.active;
  }

  /** Start continuous listening. Requests mic permission implicitly via the browser. */
  start() {
    if (this.active) return;
    const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) {
      this.cb.onError('Speech recognition is not supported in this browser. Use the text input instead.');
      this.cb.onState('error');
      return;
    }
    this.active = true;
    this.recognition = new Ctor();
    const rec = this.recognition;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    rec.onstart = () => {
      if (this.active) this.cb.onState(this.mutedWhileSpeaking ? 'idle' : 'listening');
    };
    rec.onresult = (ev: unknown) => {
      if (!this.active || this.mutedWhileSpeaking) return;
      const results = (ev as { results: ArrayLike<ArrayLike<{ transcript: string }>> }).results;
      let interim = '';
      let finalText = '';
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const transcript = result[0]?.transcript ?? '';
        const isFinal = Boolean((result as unknown as { isFinal: boolean }).isFinal);
        if (isFinal) finalText += transcript;
        else interim += transcript;
      }
      if (interim) this.cb.onTranscript(interim, false);
      if (finalText) {
        this.cb.onTranscript(finalText, true);
        this.cb.onState('speech');
        this.handleUtterance(finalText.trim());
      }
    };
    rec.onerror = (ev: unknown) => {
      const err = (ev as { error?: string }).error ?? 'unknown';
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        this.cb.onError('Microphone permission denied. Allow microphone access in the browser and try again, or use text input.');
        this.stop();
        this.cb.onState('error');
        return;
      }
      if (err === 'no-speech' || err === 'aborted') return; // normal between utterances
      if (err === 'network') {
        this.cb.onError('Speech recognition network error. Check your connection or use text input.');
        return;
      }
      // 'audio-capture' etc.
      this.cb.onError(`Microphone error: ${err}. You can still use the text input.`);
    };
    rec.onend = () => {
      // Continuous recognition stops after silence; restart automatically while active.
      if (this.active && !this.mutedWhileSpeaking) {
        this.cb.onState('listening');
        this.restartTimer = window.setTimeout(() => {
          try {
            rec.start();
          } catch {
            /* already started */
          }
        }, 250);
      }
    };
    try {
      rec.start();
      this.cb.onState('listening');
    } catch (err) {
      this.cb.onError(`Could not start voice mode: ${(err as Error).message}`);
      this.cb.onState('error');
    }
  }

  private handleUtterance(text: string) {
    if (!text) return;
    // Avoid duplicate submissions of the same utterance within 1.5s.
    const now = Date.now();
    if (text === this.lastUtterance && now - this.lastUtteranceAt < 1500) return;
    this.lastUtterance = text;
    this.lastUtteranceAt = now;
    this.cb.onFinalUtterance(text);
  }

  /** Pause capture while the assistant is speaking (prevents self-transcription). */
  muteWhileSpeaking() {
    this.mutedWhileSpeaking = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    try {
      this.recognition?.stop();
    } catch {
      /* ignore */
    }
  }

  /** Resume capture after the assistant finished speaking. */
  resumeAfterSpeaking() {
    this.mutedWhileSpeaking = false;
    if (!this.active) return;
    this.cb.onState('listening');
    this.restartTimer = window.setTimeout(() => {
      try {
        this.recognition?.start();
      } catch {
        /* already started */
      }
    }, 300);
  }

  stop() {
    this.active = false;
    this.mutedWhileSpeaking = false;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    try {
      this.recognition?.abort();
    } catch {
      /* ignore */
    }
    this.recognition = null;
    this.cb.onState('idle');
  }
}
