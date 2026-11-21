import { useCallback, useEffect, useRef, useState } from 'react';

import type { AssemblyData, AssemblyStep } from '../types';

import { suggestedQuestions } from '../lib/assistant';

import { askAgent, type AgentAction, type AgentTraceEntry, type ChatMessage } from '../lib/agent';

import { NarrationPlayer } from '../lib/narration';

import { VoiceMode, speechRecognitionAvailable, type VoiceState } from '../lib/voiceMode';

import { VoxtralVoice } from '../lib/voxtralVoice';

export interface AssistantPanelProps {
  data: AssemblyData;
  step: AssemblyStep;
  stepIndex: number;
  checklist: Set<string>;
  open: boolean;
  onClose: () => void;
  /** Execute an action the agent requested (highlight / navigate / checklist). */
  onAction?: (action: AgentAction) => void;
  /** When true, opening/using the assistant should pause walkthrough auto-advance. */
  onInteraction?: () => void;
}

/**
 * Context-aware AI assembly assistant drawer. Sits beside the walkthrough
 * illustration without covering it. Supports text input (always available) and
 * optional continuous voice mode (Web Speech API + Voxtral TTS spoken answers).
 */
export function AssistantPanel({ data, step, stepIndex, checklist, open, onClose, onAction, onInteraction }: AssistantPanelProps) {
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trace, setTrace] = useState<AgentTraceEntry[]>([]);
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [liveTranscript, setLiveTranscript] = useState('');
  const [voiceSupported] = useState(speechRecognitionAvailable);
  const [speakAnswers, setSpeakAnswers] = useState(true);
  const [assistantSpeaking, setAssistantSpeaking] = useState(false);
  const [voiceEngine, setVoiceEngine] = useState('');
  const [voxtralAvailable, setVoxtralAvailable] = useState(false);

  const voiceRef = useRef<VoiceMode | VoxtralVoice | null>(null);
  const playerRef = useRef<NarrationPlayer | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stepIdRef = useRef(step.id);
  stepIdRef.current = step.id;

  // Check whether the server has Voxtral Realtime voice configured.
  useEffect(() => {
    void fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((h) => setVoxtralAvailable(Boolean(h?.voice)))
      .catch(() => setVoxtralAvailable(false));
  }, []);

  // Stop voice + speech when the panel closes or the step changes.
  useEffect(() => {
    if (!open) {
      voiceRef.current?.stop();
      voiceRef.current = null;
      playerRef.current?.stop();
      playerRef.current = null;
      setVoiceState('idle');
      setAssistantSpeaking(false);
    }
  }, [open]);

  // Auto-scroll to the latest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history, busy, liveTranscript, trace]);

  const stopSpeaking = useCallback(() => {
    playerRef.current?.stop();
    playerRef.current = null;
    setAssistantSpeaking(false);
    if (voiceRef.current?.isActive) voiceRef.current.resumeAfterSpeaking();
  }, []);

  const speakAnswer = useCallback(
    async (text: string) => {
      if (!speakAnswers || !text) return;
      // Reuse the TTS route: generate audio for the answer, then play it.
      voiceRef.current?.muteWhileSpeaking();
      setAssistantSpeaking(true);
      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        let url: string | undefined;
        if (res.ok) {
          const blob = await res.blob();
          url = URL.createObjectURL(blob);
        }
        const player = new NarrationPlayer(text, url);
        playerRef.current = player;
        player.on('end', () => {
          setAssistantSpeaking(false);
          voiceRef.current?.resumeAfterSpeaking();
        });
        player.on('error', () => {
          setAssistantSpeaking(false);
          voiceRef.current?.resumeAfterSpeaking();
        });
        player.play();
      } catch {
        setAssistantSpeaking(false);
        voiceRef.current?.resumeAfterSpeaking();
      }
    },
    [speakAnswers],
  );

  const send = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || busy) return;
      onInteraction?.();
      setError(null);
      setInput('');
      setLiveTranscript('');
      setTrace([]);
      const newHistory: ChatMessage[] = [...history, { role: 'user', content: q }];
      setHistory(newHistory);
      setBusy(true);
      setVoiceState((s) => (s === 'listening' || s === 'speech' ? 'processing' : s));
      const result = await askAgent(data, step, stepIndex, checklist, history, q);
      setBusy(false);
      if (result.error || !result.answer) {
        setError(result.error ?? 'The assistant could not answer right now. Try again or check the written instructions.');
        setTrace(result.trace ?? []);
        setVoiceState((s) => (voiceRef.current?.isActive ? 'listening' : s));
        return;
      }
      setHistory([...newHistory, { role: 'assistant', content: result.answer }]);
      setTrace(result.trace ?? []);
      setVoiceState((s) => (voiceRef.current?.isActive ? 'responding' : s));
      // Execute any actions the agent requested (highlight / navigate / checklist).
      for (const action of result.actions) {
        onAction?.(action);
      }
      await speakAnswer(result.answer);
      if (voiceRef.current?.isActive) setVoiceState('listening');
    },
    [busy, history, data, step, stepIndex, checklist, onInteraction, onAction, speakAnswer],
  );

  const toggleVoice = useCallback(() => {
    if (voiceRef.current?.isActive) {
      voiceRef.current.stop();
      voiceRef.current = null;
      setVoiceState('idle');
      return;
    }
    onInteraction?.();
    const callbacks = {
      onState: (s: VoiceState) => setVoiceState(s),
      onTranscript: (text: string, isFinal: boolean) => {
        if (!isFinal) setLiveTranscript(text);
      },
      onFinalUtterance: (text: string) => {
        setLiveTranscript('');
        void send(text);
      },
      onError: (msg: string) => setError(msg),
    };
    // Prefer Voxtral Realtime when the server has a key; otherwise browser SpeechRecognition.
    if (voxtralAvailable) {
      // Context bias: robot name + component names improve transcription of technical terms.
      const bias = [data.robot_name, ...data.parts.map((p) => p.name)].filter(Boolean);
      const vv = new VoxtralVoice({ ...callbacks, onEngine: setVoiceEngine });
      voiceRef.current = vv;
      void vv.start(bias, navigator.language?.split('-')[0] || 'en');
    } else if (voiceSupported) {
      setVoiceEngine('Browser speech recognition (Voxtral not configured)');
      const vm = new VoiceMode(callbacks);
      voiceRef.current = vm;
      vm.start();
    } else {
      setError('Voice mode is not available: no Voxtral API key on the server and no browser speech recognition. Use the text input.');
    }
  }, [onInteraction, send, voxtralAvailable, voiceSupported, data]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      voiceRef.current?.stop();
      playerRef.current?.stop();
    };
  }, []);

  const suggestions = suggestedQuestions(step, data);
  const voiceLabel =
    voiceState === 'idle' ? '🎤 Voice'
    : voiceState === 'listening' ? '🎙 Listening…'
    : voiceState === 'speech' ? '🗣 Heard you'
    : voiceState === 'processing' ? '🤖 Thinking…'
    : voiceState === 'responding' ? '💬 Answering…'
    : voiceState === 'speaking' ? '🔊 Speaking…'
    : '⚠ Mic error';

  if (!open) return null;

  return (
    <aside className={`assistant-panel ${open ? 'open' : ''}`} aria-label="Assembly assistant">
      <div className="assistant-header">
        <span className="assistant-title">🤖 Assembly assistant</span>
        <span className="assistant-step">Step {step.number}: {step.title}</span>
        <button type="button" className="btn btn-ghost btn-small" onClick={onClose} aria-label="Close assistant">✕</button>
      </div>

      <div className="assistant-messages" ref={scrollRef}>
        {history.length === 0 && !busy && (
          <div className="assistant-empty">
            <p>Ask anything about this build — e.g. where a part goes, what a step means, or what to do next.</p>
            <div className="assistant-suggestions">
              {suggestions.map((q) => (
                <button key={q} type="button" className="chip chip-suggestion" onClick={() => void send(q)} disabled={busy}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {history.map((m, i) => (
          <div key={i} className={`assistant-msg assistant-msg-${m.role}`}>
            <span className="assistant-msg-role">{m.role === 'user' ? 'You' : 'Assistant'}</span>
            <p>{m.content}</p>
          </div>
        ))}
        {busy && (
          <div className="assistant-msg assistant-msg-assistant">
            <span className="assistant-msg-role">Assistant</span>
            <p className="assistant-thinking"><span className="spinner spinner-small" aria-hidden /> Thinking…</p>
            {trace.map((t, i) => (
              <p key={i} className={`assistant-trace assistant-trace-${t.status}`}>
                {t.status === 'action' ? '⚡' : t.status === 'error' ? '⚠' : '🔍'} {t.label}
              </p>
            ))}
          </div>
        )}
        {!busy && trace.length > 0 && (
          <div className="assistant-trace-summary">
            {trace.map((t, i) => (
              <span key={i} className={`assistant-trace-chip assistant-trace-${t.status}`} title={t.tool}>
                {t.status === 'action' ? '⚡' : t.status === 'error' ? '⚠' : '✓'} {t.label.replace(/…$/, '')}
              </span>
            ))}
          </div>
        )}
        {liveTranscript && <p className="assistant-live-transcript">“{liveTranscript}”</p>}
      </div>

      {error && <p className="assistant-error">{error}</p>}

      <div className="assistant-controls">
        <div className="assistant-input-row">
          <input
            type="text"
            className="assistant-input"
            placeholder="Ask about this step…"
            value={input}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && input.trim()) void send(input);
            }}
          />
          <button type="button" className="btn btn-primary btn-small" disabled={!input.trim() || busy} onClick={() => void send(input)}>
            Send
          </button>
        </div>
        <div className="assistant-toolbar">
          {(voxtralAvailable || voiceSupported) && (
            <button
              type="button"
              className={`btn btn-small ${voiceState !== 'idle' && voiceState !== 'error' ? 'btn-voice-active' : 'btn-secondary'}`}
              onClick={toggleVoice}
              title={voiceState === 'idle' ? 'Start continuous voice mode' : 'Stop voice mode'}
            >
              {voiceLabel}
            </button>
          )}
          {assistantSpeaking && (
            <button type="button" className="btn btn-small btn-secondary" onClick={stopSpeaking}>⏹ Stop voice</button>
          )}
          <label className="assistant-mute">
            <input type="checkbox" checked={speakAnswers} onChange={(e) => setSpeakAnswers(e.target.checked)} />
            Speak answers
          </label>
          <span className="assistant-status">
            {voiceState === 'listening' && <span className="mic-dot" aria-hidden />}
            {voiceState === 'listening' ? 'Listening — just speak' : voiceState === 'idle' ? 'Voice off' : ''}
          </span>
        </div>
        {voiceEngine && <p className="assistant-note">🎙 Engine: {voiceEngine}</p>}
        {!voxtralAvailable && !voiceSupported && <p className="assistant-note">Voice mode unavailable — text input always works.</p>}
        {!voxtralAvailable && voiceSupported && <p className="assistant-note">No MISTRAL_API_KEY on the server — using browser speech recognition fallback. Voxtral Realtime activates automatically when a key is configured.</p>}
      </div>
    </aside>
  );
}
