import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, ImageIcon, LoaderCircle, TriangleAlert, Upload, X } from 'lucide-react';
import type { AssemblyData } from '../types';
import { readImageAsDataUrl } from '../lib/image';
import { analyzePhotos, bomToComponents, inferBestGuess, pipelineHealth, type PipelineHealth } from '../lib/robotBom';

export interface PhotoBuildProps {
  onGenerated: (data: AssemblyData, notes: string[]) => void;
}

type Stage = 'idle' | 'analyze' | 'infer' | 'generate';

const STAGES: Array<{ key: Exclude<Stage, 'idle'>; label: string; hint: string }> = [
  { key: 'analyze', label: 'Identifying components', hint: 'The vision model lists every part it can see.' },
  { key: 'infer', label: 'Best guess and shop lookup', hint: 'Settles open questions and finds where to buy parts.' },
  { key: 'generate', label: 'Writing the build guide', hint: 'Orders the parts into illustrated, narrated steps.' },
];

/**
 * Photo in, workbook out. Follows the robot_bom pipeline's own flow:
 * /analyze -> /infer (best effort, like the pipeline's web page) -> /api/generate.
 */
export function PhotoBuild({ onGenerated }: PhotoBuildProps) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<PipelineHealth | null | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void pipelineHealth().then(setHealth);
  }, []);

  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const busy = stage !== 'idle';

  // Honest progress feedback: each stage is one blocking request, so show a live
  // elapsed timer for the running stage rather than fake percentages.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    if (stage === 'idle') return;
    const t0 = Date.now();
    const iv = window.setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => window.clearInterval(iv);
  }, [stage]);
  const mock = health ? !health.api_key_configured || health.mock_default : false;

  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) {
      setError('That file is not an image. Use a JPG, PNG or WebP photo.');
      return;
    }
    setError(null);
    setFile(f);
  };

  const run = async () => {
    if (!file || busy) return;
    setError(null);
    const notes: string[] = [];
    try {
      setStage('analyze');
      const analysis = await analyzePhotos([file], { projectName: file.name.replace(/\.[^.]+$/, ''), mock });
      let bom = analysis.bom;
      notes.push(
        `Analysed with ${bom.metadata.vision_model ?? 'the vision model'}${mock ? ' (mock mode: canned analysis, no API key on the pipeline)' : ''}.`,
      );

      setStage('infer');
      try {
        const inferred = await inferBestGuess(analysis, { mock });
        bom = inferred.review.bom;
        notes.push('Best guess applied to the critical parts (assumptions, not confirmed).');
      } catch (e) {
        // The pipeline's own page treats this step as optional too: the parts list stands without it.
        notes.push(`Best guess skipped: ${(e as Error).message}`);
      }

      const components = bomToComponents(bom);
      if (components.length === 0) throw new Error('The analysis found no components in this photo. Try a clearer, full view of the robot.');

      setStage('generate');
      const imageDataUrl = await readImageAsDataUrl(file, 1280);
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageDataUrl, components }),
      });
      const json = (await res.json().catch(() => null)) as {
        data?: AssemblyData;
        error?: string;
        errors?: string[];
        warnings?: string[];
        validationWarnings?: string[];
        model?: string;
      } | null;
      if (!res.ok || !json?.data) {
        throw new Error((json?.error ?? `Generation failed (HTTP ${res.status}).`) + (json?.errors?.length ? ' ' + json.errors.join(' ') : ''));
      }
      onGenerated(json.data, [
        ...notes,
        `Build guide written by ${json.model ?? 'the Mistral vision model'} from the photo and ${components.length} components.`,
        ...(json.warnings ?? []),
        ...(json.validationWarnings ?? []),
        ...(json.data.review_flags?.length ? [`${json.data.review_flags.length} component(s) flagged for review.`] : []),
      ]);
    } catch (e) {
      setError((e as Error).message);
      setStage('idle');
    }
  };

  const stageIndex = STAGES.findIndex((s) => s.key === stage);

  return (
    <div className="space-y-4">
      {preview ? (
        <div className="relative overflow-hidden rounded-2xl border border-line bg-surface">
          <div className="bg-canvas">
            <img src={preview} alt="The robot you uploaded" className="max-h-72 w-full object-contain" />
          </div>
          {!busy && (
            <button
              type="button"
              onClick={() => setFile(null)}
              className="absolute top-3 right-3 grid size-9 place-items-center rounded-xl bg-scrim/80 text-white backdrop-blur transition hover:bg-scrim"
              aria-label="Remove photo"
            >
              <X className="size-4" />
            </button>
          )}
          <div className="flex items-center justify-between gap-3 border-t border-line-soft px-4 py-2.5 text-xs text-muted">
            <span className="truncate font-mono">{file?.name}</span>
            <span className="shrink-0">{file ? `${(file.size / 1024).toFixed(0)} KB` : ''}</span>
          </div>
        </div>
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            pick(e.dataTransfer.files?.[0]);
          }}
          className={`rounded-2xl border-2 border-dashed px-6 py-10 text-center transition ${
            dragging ? 'border-flame-500 bg-flame-500/5' : 'border-line bg-surface/40 hover:border-line-strong'
          }`}
        >
          <span className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl border border-line bg-sunken text-flame-400">
            <ImageIcon className="size-7" />
          </span>
          <p className="text-sm font-semibold text-strong">Drop a photo of the robot</p>
          <p className="mx-auto mt-1.5 max-w-sm text-xs text-muted">A full view works best. JPG, PNG or WebP.</p>
          <button type="button" className="btn-primary mt-5" onClick={() => inputRef.current?.click()}>
            <Upload className="size-4" />
            Choose photo
          </button>
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          pick(e.target.files?.[0]);
          e.target.value = '';
        }}
      />

      {busy ? (
        <ol className="space-y-2.5 rounded-2xl border border-line bg-sunken/40 p-4">
          {STAGES.map((s, i) => {
            const done = i < stageIndex;
            const active = i === stageIndex;
            return (
              <li key={s.key} className="flex items-start gap-3">
                <span
                  className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg ${
                    done ? 'bg-mint-400/10 text-mint-400' : active ? 'bg-flame-500/10 text-flame-500' : 'bg-line-soft text-muted'
                  }`}
                >
                  {done ? <Check className="size-3.5" /> : active ? <LoaderCircle className="size-3.5 animate-spin" /> : <span className="font-mono text-[11px]">{i + 1}</span>}
                </span>
                <div>
                  <p className={`text-sm ${active ? 'font-semibold text-strong' : done ? 'text-body' : 'text-muted'}`}>{s.label}</p>
                  {active && (
                    <p className="text-xs text-muted" aria-live="polite">
                      {s.hint} <span className="font-mono">{elapsed}s</span>
                    </p>
                  )}
                </div>
              </li>
            );
          })}
          <p className="pt-1 text-[11px] text-muted">This can take a few minutes. Keep this tab open.</p>
        </ol>
      ) : (
        <button type="button" className="btn-primary w-full py-3" disabled={!file || health === null} onClick={() => void run()}>
          Build it from this photo
          <ArrowRight className="size-4" />
        </button>
      )}

      {health === null && (
        <p className="flex gap-2 rounded-xl border border-flame-500/40 bg-flame-500/10 p-3 text-sm text-flame-600">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            The photo analysis service is not running. Start everything with <code className="font-mono text-xs">npm run dev</code>, then reload.
          </span>
        </p>
      )}
      {health && mock && (
        <p className="text-xs text-muted">
          No Mistral API key on the analysis service, so it returns a canned mock analysis. Add <code className="font-mono">MISTRAL_API_KEY</code> to{' '}
          <code className="font-mono">.env</code> for real results.
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-xl border border-flame-500/40 bg-flame-500/10 p-3 text-sm text-flame-600">
          {error}
        </p>
      )}
    </div>
  );
}
