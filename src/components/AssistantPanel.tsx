import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioLines, Bot, Check, LoaderCircle, Mic, MicOff, Search, SendHorizontal, Square, TriangleAlert, X, Zap } from 'lucide-react';

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
    voiceState === 'idle' ? 'Voice'
    : voiceState === 'listening' ? 'Listening…'
    : voiceState === 'speech' ? 'Heard you'
    : voiceState === 'processing' ? 'Thinking…'
    : voiceState === 'responding' ? 'Answering…'
    : voiceState === 'speaking' ? 'Speaking…'
    : 'Mic error';

  if (!open) return null;

  return (
    <aside
      className="drawer-enter fixed inset-y-0 right-0 z-[70] flex w-full flex-col border-l border-line bg-surface shadow-2xl shadow-black/10 sm:w-[min(400px,92vw)]"
      aria-label="Assembly assistant"
    >
      <div className="flex items-center gap-3 border-b border-line-soft px-4 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-flame-500 text-on-accent">
          <Bot className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-strong">Assembly assistant</p>
          <p className="truncate text-xs text-muted">
            Step {step.number}: {step.title}
          </p>
        </div>
        <button type="button" className="rounded-lg p-2 text-muted transition hover:bg-sunken hover:text-strong" onClick={onClose} aria-label="Close assistant">
          <X className="size-4" />
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4" ref={scrollRef}>
        {history.length === 0 && !busy && (
          <div className="space-y-3">
            <p className="text-sm text-muted">Ask anything about this build — e.g. where a part goes, what a step means, or what to do next.</p>
            <div className="flex flex-col items-start gap-2">
              {suggestions.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="chip cursor-pointer text-left transition hover:border-flame-500/50 hover:bg-flame-500/10 hover:text-flame-600"
                  onClick={() => void send(q)}
                  disabled={busy}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {history.map((m, i) => (
          <div
            key={i}
            className={`max-w-[92%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
              m.role === 'user'
                ? 'self-end rounded-br-md bg-strong text-canvas'
                : 'self-start rounded-bl-md border border-line bg-sunken/60 text-body'
            }`}
          >
            <span className={`text-[10px] font-semibold tracking-[0.14em] uppercase ${m.role === 'user' ? 'text-canvas/60' : 'text-muted'}`}>
              {m.role === 'user' ? 'You' : 'Assistant'}
            </span>
            <p className="mt-1 whitespace-pre-wrap">{m.content}</p>
          </div>
        ))}
        {busy && (
          <div className="max-w-[92%] self-start rounded-2xl rounded-bl-md border border-line bg-sunken/60 px-3.5 py-2.5 text-sm">
            <span className="text-[10px] font-semibold tracking-[0.14em] text-muted uppercase">Assistant</span>
            <p className="mt-1 flex items-center gap-2 text-muted italic">
              <LoaderCircle className="size-3.5 animate-spin text-flame-400" /> Thinking…
            </p>
            {trace.map((t, i) => (
              <p
                key={i}
                className={`mt-1.5 flex items-center gap-1.5 text-xs ${t.status === 'action' ? 'font-semibold text-flame-600' : t.status === 'error' ? 'text-flame-600' : 'text-muted'}`}
              >
                <TraceIcon status={t.status} running /> {t.label}
              </p>
            ))}
          </div>
        )}
        {!busy && trace.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {trace.map((t, i) => (
              <span
                key={i}
                title={t.tool}
                className={`chip px-2 py-0.5 text-[11px] ${t.status === 'action' || t.status === 'error' ? 'border-flame-500/40 bg-flame-500/10 text-flame-600' : ''}`}
              >
                <TraceIcon status={t.status} /> {t.label.replace(/…$/, '')}
              </span>
            ))}
          </div>
        )}
        {liveTranscript && <p className="px-1 text-xs text-flame-500 italic">“{liveTranscript}”</p>}
      </div>

      {error && <p className="border-t border-flame-500/30 bg-flame-500/10 px-4 py-2 text-xs text-flame-600">{error}</p>}

      <div className="space-y-2.5 border-t border-line-soft bg-sunken/40 px-4 py-3">
        <div className="flex gap-2">
          <input
            type="text"
            className="input py-2"
            placeholder="Ask about this step…"
            value={input}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && input.trim()) void send(input);
            }}
          />
          <button type="button" className="btn-primary px-3 py-2" disabled={!input.trim() || busy} onClick={() => void send(input)} aria-label="Send">
            <SendHorizontal className="size-4" />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(voxtralAvailable || voiceSupported) && (
            <button
              type="button"
              className={`${voiceState !== 'idle' && voiceState !== 'error' ? 'btn-primary voice-pulse' : 'btn-ghost'} px-3 py-1.5 text-xs`}
              onClick={toggleVoice}
              title={voiceState === 'idle' ? 'Start continuous voice mode' : 'Stop voice mode'}
            >
              {voiceState === 'idle' ? <Mic className="size-3.5" /> : voiceState === 'error' ? <MicOff className="size-3.5" /> : <AudioLines className="size-3.5" />}
              {voiceLabel}
            </button>
          )}
          {assistantSpeaking && (
            <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={stopSpeaking}>
              <Square className="size-3" /> Stop voice
            </button>
          )}
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            {voiceState === 'listening' && <span className="size-2 animate-pulse rounded-full bg-red-500" aria-hidden />}
            {voiceState === 'listening' ? 'Listening — just speak' : voiceState === 'idle' ? 'Voice off' : ''}
          </span>
          <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" className="accent-flame-500" checked={speakAnswers} onChange={(e) => setSpeakAnswers(e.target.checked)} />
            Speak answers
          </label>
        </div>
        {voiceEngine && <p className="text-[11px] text-muted">Engine: {voiceEngine}</p>}
        {!voxtralAvailable && !voiceSupported && <p className="text-[11px] text-muted">Voice mode unavailable — text input always works.</p>}
        {!voxtralAvailable && voiceSupported && (
          <p className="text-[11px] text-muted">
            No MISTRAL_API_KEY on the server — using browser speech recognition fallback. Voxtral Realtime activates automatically when a key is configured.
          </p>
        )}
      </div>
    </aside>
  );
}

function TraceIcon({ status, running }: { status: AgentTraceEntry['status']; running?: boolean }) {
  if (status === 'action') return <Zap className="size-3 shrink-0" />;
  if (status === 'error') return <TriangleAlert className="size-3 shrink-0" />;
  return running ? <Search className="size-3 shrink-0" /> : <Check className="size-3 shrink-0" />;
}
