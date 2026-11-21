import { useEffect, useMemo, useRef, useState } from 'react';
import type { AssemblyData, AssemblyStep } from './types';
import { mockRobot } from './data/mockRobot';
import { datasetKey, normalizeAssembly } from './lib/adapter';
import { clearNarrationCaches } from './lib/narration';
import { buildStepPrompt, clearImageCache, generateStepImage, imageGenerationAvailable, type ImageResult } from './lib/imageGen';
import { useNarrationEngine } from './hooks/useNarrationEngine';
import { useGameFx } from './hooks/useGameFx';
import { Header, type ViewMode } from './components/Header';
import { StageCard } from './components/StageCard';
import { StepPanel } from './components/StepPanel';
import { Sidebar } from './components/Sidebar';
import { ImportDialog } from './components/ImportDialog';
import { AssistantPanel } from './components/AssistantPanel';

import { LandingScreen } from './components/LandingScreen';

import { PhotoAnalysisDialog } from './components/PhotoAnalysisDialog';

function initialStep(): number {
  const s = new URLSearchParams(window.location.search).get('step');
  const n = s ? Number.parseInt(s, 10) : Number.NaN;
  return Number.isFinite(n) ? Math.max(0, n - 1) : 0;
}

export default function App() {
  // Developer-only UI (Import JSON, Data panel, sample loaders) unless ?dev=1.
  const dev = new URLSearchParams(window.location.search).has('dev');
  // Deep links (?mode=guided, ?step=N, ?view=exploded) skip the landing screen.
  const [screen, setScreen] = useState<'landing' | 'studio'>(() =>
    new URLSearchParams(window.location.search).has('mode') || new URLSearchParams(window.location.search).has('step') ? 'studio' : 'landing',
  );
  const [data, setData] = useState<AssemblyData>(mockRobot);
  const [index, setIndex] = useState(initialStep);
  const [mode, setMode] = useState<ViewMode>(() =>
    new URLSearchParams(window.location.search).get('mode') === 'guided' ? 'guided' : 'workbook',
  );
  const [guided, setGuided] = useState({ playing: false, auto: true });
  const [tick, setTick] = useState(0); // bump to force replay (restart)
  const [importOpen, setImportOpen] = useState(false);
  const [photoDialogOpen, setPhotoDialogOpen] = useState(false);
  const [importNotes, setImportNotes] = useState<string[]>([]);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [checklist, setChecklist] = useState<Set<string>>(new Set());
  const [images, setImages] = useState<Record<string, ImageResult>>({});
  const [imageLoading, setImageLoading] = useState(false);
  const [imageAvailable, setImageAvailable] = useState(false);
  // hangar game-feel state
  const fx = useGameFx();
  const [toast, setToast] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [hintOpen, setHintOpen] = useState(false);
  const prevIndexRef = useRef(index);
  const toastTimer = useRef<number | null>(null);
  // Exploded-view asset produced by the teardown skill (public/illustrations/manifest.json).
  const [exploded, setExploded] = useState<{ available: boolean; url?: string }>({ available: false });
  // Exploded view is the DEFAULT when available; the toggle is a persistent on/off (not per-step).
  const [explodedOn, setExplodedOn] = useState(
    () => new URLSearchParams(window.location.search).get('view') !== 'step',
  );

  useEffect(() => {
    let cancelled = false;
    fetch('/illustrations/manifest.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        if (cancelled || !m) return;
        setExploded(m.robot_name === data.robot_name ? { available: true, url: m.exploded } : { available: false });
      })
      .catch(() => !cancelled && setExploded({ available: false }));
    return () => {
      cancelled = true;
    };
  }, [data.robot_name]);

  const prefix = useMemo(() => datasetKey(data), [data]);
  const engine = useNarrationEngine(prefix);
  const { play, stop, ensure, ensureAll, pause, resume, states, playingKey, isPaused } = engine;
  const partsById = useMemo(() => new Map(data.parts.map((p) => [p.id, p])), [data]);

  // Per-step narration states (aligned with data.steps) for the sidebar players.
  const stepAudio = useMemo(() => data.steps.map((s) => states[`${prefix}:${s.id}`]), [data.steps, states, prefix]);
  const playingIndex = useMemo(
    () => data.steps.findIndex((s) => playingKey === `${prefix}:${s.id}`),
    [data.steps, playingKey, prefix],
  );
  const narrationStats = useMemo(() => {
    let ready = 0;
    let loading = 0;
    let error = 0;
    for (const st of stepAudio) {
      if (!st) continue;
      if (st.status === 'ready') ready++;
      else if (st.status === 'loading') loading++;
      else if (st.status === 'error') error++;
    }
    return { ready, loading, error, total: data.steps.length };
  }, [stepAudio, data.steps.length]);

  useEffect(() => {
    void imageGenerationAvailable().then(setImageAvailable);
  }, []);

  const step: AssemblyStep | undefined = data.steps[index];
  const audioKey = step ? `${prefix}:${step.id}` : '';
  const audio = audioKey ? states[audioKey] : undefined;
  const isCurrentAudio = Boolean(audioKey) && playingKey === audioKey;

  // ---- refs so the walkthrough effect always sees fresh values ----
  const guidedRef = useRef(guided);
  guidedRef.current = guided;
  const indexRef = useRef(index);
  indexRef.current = index;
  const dataRef = useRef(data);
  dataRef.current = data;
  const dwellRef = useRef<number | null>(null);
  const clearDwell = () => {
    if (dwellRef.current !== null) {
      clearTimeout(dwellRef.current);
      dwellRef.current = null;
    }
  };

  // ---- guided walkthrough: play narration, advance only when it ends ----
  // Paused while the assistant panel is open so Q&A never triggers a step change.
  useEffect(() => {
    if (mode !== 'guided' || !guided.playing || !data.steps[index] || assistantOpen) return;
    const s = data.steps[index];
    let cancelled = false;
    void play(s, (source) => {
      if (cancelled) return;
      const advance = () => {
        if (!guidedRef.current.auto) {
          setGuided((g) => ({ ...g, playing: false }));
          return;
        }
        if (indexRef.current < dataRef.current.steps.length - 1) setIndex((i) => i + 1);
        else setGuided((g) => ({ ...g, playing: false }));
      };
      // Only use a timed fallback when there is NO real audio; with genuine
      // narration the 'end' event already fired, so advance immediately.
      clearDwell();
      if (source === 'none') dwellRef.current = window.setTimeout(advance, 5000);
      else advance();
    });
    return () => {
      cancelled = true;
      clearDwell();
      stop();
    };
  }, [mode, guided.playing, index, tick, data, play, stop, assistantOpen]);

  // Auto-generate narration for every step whenever a workbook is (re)loaded.
  // Generation only — audio is never played automatically in workbook mode.
  useEffect(() => {
    let cancelled = false;
    void ensureAll(data.steps, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [data, ensureAll]);

  // ---- mode switching ----
  const handleModeChange = (m: ViewMode) => {
    if (m === 'guided') {
      setIndex(0);
      setTick((t) => t + 1);
      setGuided({ playing: true, auto: true });
      setMode('guided');
    } else {
      setMode('workbook');
      setGuided((g) => ({ ...g, playing: false }));
      clearDwell();
      stop();
    }
  };

  // ---- guided controls ----
  const guidedTogglePlay = () => {
    if (!guided.playing) {
      setGuided((g) => ({ ...g, playing: true }));
      return;
    }
    if (isPaused) resume();
    else pause();
  };
  const guidedPrev = () => {
    stop();
    clearDwell();
    setIndex((i) => Math.max(0, i - 1));
  };
  const guidedNext = () => {
    stop();
    clearDwell();
    setIndex((i) => Math.min(data.steps.length - 1, i + 1));
  };
  const guidedRestart = () => {
    stop();
    clearDwell();
    setIndex(0);
    setTick((t) => t + 1);
    setGuided((g) => ({ ...g, playing: true }));
  };
  // ---- keyboard-hint popover: close on outside click / Esc ----
  useEffect(() => {
    if (!hintOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest('.hint-fab') && !t?.closest('.hint-tip')) setHintOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setHintOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [hintOpen]);

  // ---- workbook controls ----
  const workbookPrev = () => {
    stop();
    setIndex((i) => Math.max(0, i - 1));
  };
  const workbookNext = () => {
    stop();
    setIndex((i) => Math.min(data.steps.length - 1, i + 1));
  };

  // ---- hangar game feel: toast + sounds + keyboard ----
  useEffect(() => {
    if (index > prevIndexRef.current && data.steps[index]) {
      const title = data.steps[index].title.toUpperCase();
      setToast(`✔ ${title} INSTALLED`);
      fx.blip('step');
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
      toastTimer.current = window.setTimeout(() => setToast(null), 1500);
    }
    prevIndexRef.current = index;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  useEffect(() => {
    const onLand = () => fx.blip('land');
    window.addEventListener('bfv:land', onLand);
    return () => window.removeEventListener('bfv:land', onLand);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finishBuild = () => {
    setComplete(true);
    fx.blip('complete');
  };
  const replayBuild = () => {
    setComplete(false);
    setIndex(0);
    setTick((t) => t + 1);
  };

  useEffect(() => {
    if (screen !== 'studio') return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (complete) return;
      switch (e.key) {
        case 'ArrowRight':
        case ' ':
          e.preventDefault();
          if (mode === 'workbook') workbookNext();
          else guidedNext();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (mode === 'workbook') workbookPrev();
          else guidedPrev();
          break;
        case 'r':
        case 'R':
          window.dispatchEvent(new CustomEvent('bfv:key', { detail: { name: 'resetCam' } }));
          break;
        case 'e':
        case 'E':
          window.dispatchEvent(new CustomEvent('bfv:key', { detail: { name: 'explode' } }));
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, mode, complete, data.steps.length]);

  // ---- audio handlers (workbook) ----
  const playAudio = () => {
    if (step) void play(step);
  };
  const regenerateAudio = () => {
    stop();
    if (step) void ensure(step, true);
  };
  /** Sidebar mini-player: play/pause the narration of a step (and show that step). */
  const toggleStepAudio = (i: number) => {
    const s = data.steps[i];
    if (!s) return;
    if (playingKey === `${prefix}:${s.id}`) {
      if (isPaused) resume();
      else pause();
      return;
    }
    setIndex(i);
    void play(s);
  };

  // ---- AI illustration ----
  const generateImageFor = async (s: AssemblyStep) => {
    setImageLoading(true);
    const prompt = buildStepPrompt(data, s, partsById);
    const r = await generateStepImage(`${prefix}:${s.id}`, prompt);
    setImages((m) => ({ ...m, [s.id]: r }));
    setImageLoading(false);
  };

  // ---- data import ----
  const applyData = (next: AssemblyData, notes: string[]) => {
    stop();
    clearDwell();
    setData(next);
    setIndex(0);
    setMode('workbook');
    setGuided({ playing: false, auto: true });
    setImages({});
    setImportNotes(notes);
    setChecklist(new Set());
    setAssistantOpen(false);
    clearNarrationCaches();
    clearImageCache();
  };
  const handleImport = (result: ReturnType<typeof normalizeAssembly>) => {
    if (result.data) {
      applyData(result.data, result.warnings.length > 0 ? result.warnings : ['JSON imported successfully.']);
      setImportOpen(false);
      setScreen('studio');
    }
  };
  const loadSample = () => {
    applyData(mockRobot, ['Sample four-wheel robot car loaded.']);
    setScreen('studio');
  };
  const loadUpstreamSample = async () => {
    try {
      const r = await fetch('/upstream-sample.json');
      const json = await r.json();
      const result = normalizeAssembly(json);
      if (result.data) {
        applyData(result.data, result.warnings.length > 0 ? result.warnings : ['Loaded real hein-parts upstream output (Obstacle-avoiding car).']);
        setScreen('studio');
      }
    } catch (err) {
      setImportNotes([`Could not load upstream sample: ${(err as Error).message}`]);
    }
  };
  const openImport = () => {
    setScreen('studio');
    setImportOpen(true);
  };
  const toggleChecklist = (partId: string) => {
    setChecklist((prev) => {
      const next = new Set(prev);
      if (next.has(partId)) next.delete(partId);
      else next.add(partId);
      return next;
    });
  };
  const allTools = useMemo(() => {
    const set = new Set<string>();
    for (const s of data.steps) for (const t of s.tools ?? []) set.add(t);
    return [...set];
  }, [data]);

  if (screen === 'landing') {
    return (
      <>
        <LandingScreen
          onLoadSample={loadSample}
          onLoadUpstream={() => void loadUpstreamSample()}
          onImport={openImport}
          onPhotoAnalysis={() => setPhotoDialogOpen(true)}
          dev={dev}
        />
        {photoDialogOpen && (
          <PhotoAnalysisDialog
            onGenerated={(d, notes) => {
              applyData(d, notes);
              setPhotoDialogOpen(false);
              setScreen('studio');
            }}
            onClose={() => setPhotoDialogOpen(false)}
          />
        )}
        {importOpen && <ImportDialog onLoad={handleImport} onClose={() => setImportOpen(false)} />}
      </>
    );
  }

  if (!step) return null;

  return (
    <div className="app">
      <Header
        robotName={data.robot_name}
        stepNumber={step.number}
        totalSteps={data.steps.length}
        mode={mode}
        onModeChange={handleModeChange}
        onImportClick={() => setImportOpen(true)}
        muted={fx.muted}
        onToggleMuted={fx.toggleMuted}
        dev={dev}
      />
      <main className="app-main">
        <StageCard
          data={data}
          step={step}
          partsById={partsById}
          isFirst={index === 0}
          isLast={index === data.steps.length - 1}
          audio={audio}
          isCurrentAudio={isCurrentAudio}
          audioPlaying={isCurrentAudio && !isPaused && playingKey !== null}
          audioPaused={isCurrentAudio && isPaused}
          image={images[step.id]}
          imageLoading={imageLoading}
          imageAvailable={imageAvailable}
          onGenerateImage={() => void generateImageFor(step)}
          explodedAvailable={exploded.available}
          explodedUrl={exploded.url}
          explodedOn={explodedOn && exploded.available}
          onToggleExploded={() => setExplodedOn((v) => !v)}
          onRegenerateAudio={regenerateAudio}
          onPlayAudio={playAudio}
          onPauseAudio={pause}
          onResumeAudio={resume}
          onPrev={workbookPrev}
          onNext={workbookNext}
          onFinish={finishBuild}
        />
        <div className="right-col">
        <StepPanel
          data={data}
          step={step}
          partsById={partsById}
          isFirst={index === 0}
          isLast={index === data.steps.length - 1}
          audio={audio}
          isCurrentAudio={isCurrentAudio}
          audioPlaying={isCurrentAudio && !isPaused && playingKey !== null}
          audioPaused={isCurrentAudio && isPaused}
          onPlayAudio={playAudio}
          onPauseAudio={pause}
          onResumeAudio={resume}
          onRegenerateAudio={regenerateAudio}
          onPrev={mode === 'guided' ? guidedPrev : workbookPrev}
          onNext={mode === 'guided' ? guidedNext : workbookNext}
          onFinish={finishBuild}
          guided={mode === 'guided' ? {
            playing: guided.playing,
            paused: isCurrentAudio && isPaused,
            auto: guided.auto,
            onTogglePlay: guidedTogglePlay,
            onRestart: guidedRestart,
            onToggleAuto: () => setGuided((g) => ({ ...g, auto: !g.auto })),
          } : undefined}
        />
        <Sidebar
          data={data}
          currentIndex={index}
          importNotes={importNotes}
          onLoadSample={loadSample}
          stepAudio={stepAudio}
          playingIndex={playingIndex}
          playingPaused={playingIndex === index && isPaused}
          onToggleStepAudio={toggleStepAudio}
          narrationStats={narrationStats}
          checklist={checklist}
          onToggleChecklist={toggleChecklist}
          allTools={allTools}
          onLoadUpstream={() => void loadUpstreamSample()}
          dev={dev}
        />
        </div>
      </main>

      {mode === 'guided' && step && (
        <AssistantPanel
          data={data}
          step={step}
          stepIndex={index}
          checklist={checklist}
          open={assistantOpen}
          onClose={() => setAssistantOpen(false)}
          onAction={(action) => {
            if (action.type === 'highlight_component' && action.partId) {
              window.dispatchEvent(new CustomEvent('bfv:highlight', { detail: { partId: action.partId } }));
            } else if (action.type === 'navigate_to_step' && Number.isFinite(action.stepNumber)) {
              const target = Math.max(0, Math.min(data.steps.length - 1, (action.stepNumber ?? 1) - 1));
              stop();
              setIndex(target);
            } else if (action.type === 'mark_part_available' && action.part_id) {
              setChecklist((prev) => (prev.has(action.part_id as string) ? prev : new Set(prev).add(action.part_id as string)));
            }
          }}
          onInteraction={() => {
            // Opening/using the assistant pauses auto-progression (handled by effect dep).
            if (guided.auto) setGuided((g) => ({ ...g, auto: false }));
          }}
        />
      )}

      {importOpen && <ImportDialog onLoad={handleImport} onClose={() => setImportOpen(false)} />}

      {toast && (
        <div className="toast" role="status">
          <span className="toast-title">{toast}</span>
          <span className="toast-sub">+100 XP</span>
        </div>
      )}

      <button
        type="button"
        className="hint-fab"
        onClick={() => setHintOpen((v) => !v)}
        aria-label="Keyboard shortcuts"
        aria-expanded={hintOpen}
        title="Keyboard shortcuts"
      >
        ?
      </button>
      {hintOpen && (
        <div className="hint-tip" role="tooltip">
          <div><b>SPACE / →</b> next step</div>
          <div><b>←</b> previous step</div>
          <div><b>R</b> reset 3D camera</div>
          <div><b>E</b> toggle explode</div>
          <div>sound toggle in the top bar</div>
        </div>
      )}

      {complete && (
        <div className="complete-overlay" role="dialog" aria-label="Build complete">
          <div className="confetti" aria-hidden>
            {Array.from({ length: 48 }, (_, i) => (
              <i
                key={i}
                style={{
                  left: `${(i * 97) % 100}%`,
                  background: ['#FFD800', '#FFAF00', '#FF8205', '#FA500F', '#E10500'][i % 5],
                  animationDuration: `${1.6 + (i % 7) * 0.25}s`,
                  animationDelay: `${(i % 11) * 0.08}s`,
                }}
              />
            ))}
          </div>
          <div className="card complete-card">
            <h2 className="complete-title">BUILD COMPLETE</h2>
            <p className="complete-stats">
              <span className="num">{data.parts.length}</span> parts installed ·{' '}
              <span className="num">{data.steps.length}</span> steps ·{' '}
              {data.bom_total != null && (
                <>total <span className="num">£{data.bom_total.toFixed(2)}</span></>
              )}
              <br />
              +{data.steps.length * 100} XP earned
            </p>
            <div className="card-actions" style={{ justifyContent: 'center', marginTop: 16 }}>
              <button type="button" className="btn btn-primary" onClick={replayBuild}>
                Replay build
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setComplete(false)}>
                Keep exploring
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
