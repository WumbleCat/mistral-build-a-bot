/**
 * Voxtral Realtime voice engine (primary). Streams microphone audio to the
 * server-side proxy (/api/voice/*), which forwards it over WebSocket to
 * Mistral's voxtral-mini-transcribe-realtime-3-0 endpoint. Turn detection is
 * done by Voxtral itself (turn.start / turn.end events) — no browser-side VAD.
 *
 * The browser Web Speech API engine (voiceMode.ts) remains as an automatic
 * fallback when Voxtral is unavailable.
 */

import type { VoiceState } from './voiceMode';

export interface VoxtralVoiceCallbacks {
  onState: (s: VoiceState) => void;
  onTranscript: (text: string, isFinal: boolean) => void;
  onFinalUtterance: (text: string) => void;
  onError: (message: string) => void;
  onEngine?: (label: string) => void;
}

const TARGET_SAMPLE_RATE = 24000;
const CHUNK_MS = 100;

export class VoxtralVoice {
  private cb: VoxtralVoiceCallbacks;
  private sessionId: string | null = null;
  private eventSource: EventSource | null = null;
  private mediaStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private active = false;
  private muted = false; // suspended while the assistant speaks
  private turnText = '';
  private turnEndTimer: number | null = null;
  private sendTimer: number | null = null;
  private pcmBuffer: Int16Array[] = [];

  constructor(cb: VoxtralVoiceCallbacks) {
    this.cb = cb;
  }

  get isActive() {
    return this.active;
  }

  async start(contextBias: string[] = [], language = 'en') {
    if (this.active) return;
    this.cb.onEngine?.('Voxtral Realtime (voxtral-mini-transcribe-realtime-3-0)');
    // 1. Start server-side session
    let sessionId: string;
    try {
      const res = await fetch('/api/voice/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context_bias: contextBias, language }),
      });
      const json = (await res.json()) as { sessionId?: string; error?: string };
      if (!res.ok || !json.sessionId) throw new Error(json.error ?? `HTTP ${res.status}`);
      sessionId = json.sessionId;
    } catch (err) {
      this.cb.onError(`Voxtral voice unavailable (${(err as Error).message}). Falling back to browser speech or text input.`);
      this.cb.onState('error');
      return;
    }
    this.sessionId = sessionId;
    this.active = true;

    // 2. Open SSE event stream
    this.eventSource = new EventSource(`/api/voice/events?sessionId=${sessionId}`);
    this.eventSource.onmessage = (ev) => this.handleEvent(ev.data);
    this.eventSource.onerror = () => {
      if (this.active) {
        this.cb.onError('Voice connection lost. Press the mic button to restart voice mode.');
        this.stop();
      }
    };

    // 3. Start microphone capture
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch {
      this.cb.onError('Microphone permission denied. Allow microphone access, or use the text input.');
      this.stop();
      return;
    }
    this.audioCtx = new AudioContext();
    const source = this.audioCtx.createMediaStreamSource(this.mediaStream);
    this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      if (!this.active || this.muted) return;
      const input = e.inputBuffer.getChannelData(0);
      const pcm = resampleToPcm16(input, this.audioCtx!.sampleRate, TARGET_SAMPLE_RATE);
      this.pcmBuffer.push(pcm);
    };
    source.connect(this.processor);
    this.processor.connect(this.audioCtx.destination);

    // 4. Pump audio chunks to the server at ~CHUNK_MS cadence
    this.sendTimer = window.setInterval(() => {
      if (!this.active || this.muted || this.pcmBuffer.length === 0 || !this.sessionId) return;
      const chunks = this.pcmBuffer.splice(0, this.pcmBuffer.length);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const merged = new Int16Array(total);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }
      const b64 = int16ToBase64(merged);
      void fetch('/api/voice/audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: this.sessionId, audio: b64 }),
      }).catch(() => {
        /* transient network errors are non-fatal; the next chunk retries */
      });
    }, CHUNK_MS);

    this.cb.onState('listening');
  }

  private handleEvent(data: string) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    switch (event.type) {
      case 'session.ready':
        this.cb.onState('listening');
        break;
      case 'turn.start':
        this.turnText = '';
        this.cb.onState('speech');
        break;
      case 'transcription.text.delta': {
        const text = String((event as { text?: string }).text ?? '');
        this.turnText += text;
        this.cb.onTranscript(this.turnText, false);
        break;
      }
      case 'turn.end': {
        // Last words may still arrive after turn.end; wait briefly for trailing deltas.
        if (this.turnEndTimer !== null) clearTimeout(this.turnEndTimer);
        this.turnEndTimer = window.setTimeout(() => {
          const text = this.turnText.trim();
          this.turnText = '';
          this.cb.onTranscript('', true);
          if (text) this.cb.onFinalUtterance(text);
          if (this.active && !this.muted) this.cb.onState('listening');
        }, 700);
        break;
      }
      case 'transcription.done':
        break;
      case 'error':
      case 'session.error':
        this.cb.onError(`Voxtral error: ${String((event as { error?: string }).error ?? 'unknown')}`);
        break;
      case 'session.closed':
        break;
    }
  }

  /** Suspend mic capture while the assistant speaks (prevents self-transcription). */
  muteWhileSpeaking() {
    this.muted = true;
  }

  resumeAfterSpeaking() {
    this.muted = false;
    if (this.active) this.cb.onState('listening');
  }

  stop() {
    this.active = false;
    this.muted = false;
    if (this.sendTimer !== null) {
      clearInterval(this.sendTimer);
      this.sendTimer = null;
    }
    if (this.turnEndTimer !== null) {
      clearTimeout(this.turnEndTimer);
      this.turnEndTimer = null;
    }
    try {
      this.processor?.disconnect();
      this.audioCtx?.close();
    } catch {
      /* ignore */
    }
    this.processor = null;
    this.audioCtx = null;
    for (const track of this.mediaStream?.getTracks() ?? []) track.stop();
    this.mediaStream = null;
    this.eventSource?.close();
    this.eventSource = null;
    if (this.sessionId) {
      const id = this.sessionId;
      this.sessionId = null;
      void fetch('/api/voice/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: id }),
      }).catch(() => {});
    }
    this.cb.onState('idle');
  }
}

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

/** Linear-interpolation resample of float32 audio to 16-bit PCM at target rate. */
function resampleToPcm16(input: Float32Array, inputRate: number, targetRate: number): Int16Array {
  const ratio = inputRate / targetRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = input[idx] ?? 0;
    const s1 = input[idx + 1] ?? s0;
    const sample = s0 + (s1 - s0) * frac;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
  }
  return out;
}

function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
