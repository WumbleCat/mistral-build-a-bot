import { useEffect, useRef, useState } from 'react';
import { CircleX, FileJson, ImageIcon, LoaderCircle, Sparkles, TriangleAlert, Upload, X } from 'lucide-react';
import { Modal } from './Shell';

import { validateAnalysis, provenanceLine, type ComponentAnalysis } from '../lib/analysisAdapter';

import type { AssemblyData } from '../types';

export interface PhotoAnalysisDialogProps {
  onGenerated: (data: AssemblyData, notes: string[]) => void;
  onClose: () => void;
}

/**
 * Paired-input dialog: upload a robot photograph + its component-analysis JSON
 * (file or paste), preview both, validate, then Generate — the photo and JSON
 * are sent together to the server-side vision pipeline (POST /api/generate).
 */
export function PhotoAnalysisDialog({ onGenerated, onClose }: PhotoAnalysisDialogProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageName, setImageName] = useState('');
  const [jsonText, setJsonText] = useState('');
  const [components, setComponents] = useState<ComponentAnalysis[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [genElapsed, setGenElapsed] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const jsonFileRef = useRef<HTMLInputElement>(null);

  // Honest progress feedback: the whole generation is one blocking vision-model
  // request, so show a live elapsed timer rather than fake stage percentages.
  useEffect(() => {
    if (!generating) {
      setGenElapsed(0);
      return;
    }
    const t0 = Date.now();
    const iv = window.setInterval(() => setGenElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => window.clearInterval(iv);
  }, [generating]);

  const handleImageFile = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      setErrors(['The selected file is not an image.']);
      return;
    }
    // Downscale large photos so the data URL stays reasonable for the API.
    const dataUrl = await readImageAsDataUrl(file, 1280);
    setImageUrl(dataUrl);
    setImageName(file.name);
    setErrors([]);
  };

  const validate = (text: string) => {
    setJsonText(text);
    setGenError(null);
    if (!text.trim()) {
      setComponents(null);
      setErrors([]);
      setWarnings([]);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setComponents(null);
      setErrors([`Malformed JSON: ${(err as Error).message}`]);
      setWarnings([]);
      return;
    }
    const r = validateAnalysis(parsed);
    setComponents(r.components.length > 0 ? r.components : null);
    setErrors(r.errors);
    setWarnings(r.warnings);
  };

  const canGenerate = Boolean(imageUrl) && components !== null && errors.length === 0 && !generating;

  const generate = async () => {
    if (!imageUrl || !components) return;
    setGenerating(true);
    setGenError(null);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageDataUrl: imageUrl, components }),
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
        const msg = json?.error ?? `Generation failed (HTTP ${res.status}).`;
        const det = json?.errors?.length ? ' ' + json.errors.join(' ') : '';
        setGenError(msg + det);
        setGenerating(false);
        return;
      }
      const notes = [
        `Generated with ${json.model ?? 'Mistral vision model'} from photo + ${components.length} analysed components.`,
        ...(json.warnings ?? []),
        ...(json.validationWarnings ?? []),
        ...(json.data.review_flags?.length ? [`${json.data.review_flags.length} component(s) flagged for review (inferred / review_required).`] : []),
      ];
      onGenerated(json.data, notes);
    } catch (err) {
      setGenError(`Could not reach the generation service: ${(err as Error).message}`);
      setGenerating(false);
    }
  };

  return (
    <Modal label="Upload robot photo and analysis JSON" wide onClose={onClose}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Robot photo + component analysis</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Upload the original robot photograph and the JSON component analysis for that photo. Both are sent together
            to the vision pipeline: the JSON is the structured inventory, the photo is the visual reference.
          </p>
        </div>
        <button type="button" className="rounded-lg p-2 text-muted transition hover:bg-sunken hover:text-strong" onClick={onClose} aria-label="Close">
          <X className="size-4" />
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <span className="label">Robot photograph</span>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleImageFile(f);
            }}
          />
          {imageUrl ? (
            <div className="overflow-hidden rounded-2xl border border-line bg-surface">
              <div className="relative bg-canvas">
                <img src={imageUrl} alt="Robot photograph preview" className="max-h-56 w-full object-contain" />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="absolute top-3 right-3 btn-ghost bg-surface/90 px-3 py-1.5 text-xs backdrop-blur"
                >
                  Replace
                </button>
              </div>
              <p className="truncate border-t border-line-soft px-4 py-2 font-mono text-xs text-muted">{imageName}</p>
            </div>
          ) : (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f) void handleImageFile(f);
              }}
              className="rounded-2xl border-2 border-dashed border-line bg-surface/40 px-6 py-8 text-center transition hover:border-line-strong"
            >
              <span className="mx-auto mb-3 grid size-12 place-items-center rounded-2xl border border-line bg-sunken text-flame-400">
                <ImageIcon className="size-6" />
              </span>
              <p className="text-sm font-semibold text-strong">Drop the robot photo here</p>
              <p className="mt-1 text-xs text-muted">JPG, PNG or WebP. A full view works best.</p>
              <button type="button" className="btn-primary mt-4" onClick={() => fileRef.current?.click()}>
                <Upload className="size-4" />
                Choose image
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="label">Component-analysis JSON</span>
          <textarea
            className="input min-h-40 flex-1 resize-y font-mono text-xs"
            placeholder='[{"name": "...", "category": "...", "quantity": 4, "evidence": "visible", "source_ids": ["W001"], ...}]'
            value={jsonText}
            onChange={(e) => validate(e.target.value)}
            spellCheck={false}
          />
          <input
            ref={jsonFileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) validate(await f.text());
            }}
          />
          <button type="button" className="btn-ghost self-start px-3 py-2 text-xs" onClick={() => jsonFileRef.current?.click()}>
            <FileJson className="size-3.5" />
            Choose JSON file…
          </button>
        </div>
      </div>

      {errors.length > 0 && (
        <ul role="alert" className="space-y-1 rounded-xl border border-flame-500/40 bg-flame-500/10 p-3 text-sm text-flame-600">
          {errors.map((e, i) => (
            <li key={i} className="flex gap-2">
              <CircleX className="mt-0.5 size-4 shrink-0" /> {e}
            </li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-line bg-sunken/60 p-3 text-xs text-body">
          {warnings.map((w, i) => (
            <li key={i} className="flex gap-2">
              <TriangleAlert className="mt-px size-3.5 shrink-0 text-flame-400" /> {w}
            </li>
          ))}
        </ul>
      )}

      {components && components.length > 0 && (
        <div className="rounded-2xl border border-line bg-sunken/40 p-3">
          <p className="label mb-2">
            {components.length} detected component{components.length === 1 ? '' : 's'}
          </p>
          <ul className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
            {components.map((c, i) => {
              const p = { id: '', name: c.name, quantity: c.quantity === null ? 1 : (c.quantity ?? 1), evidence: c.evidence, source_ids: c.source_ids, review_required: c.review_required, quantityUnknown: c.quantity == null, notes: c.notes } as never;
              return (
                <li
                  key={i}
                  className={`space-y-1.5 rounded-xl border bg-surface px-3 py-2 text-xs ${
                    c.evidence === 'inferred' ? 'border-l-[3px] border-line border-l-flame-500' : 'border-line'
                  } ${c.review_required ? 'bg-flame-500/5' : ''}`}
                >
                  <p className="text-sm font-semibold text-strong">{c.name}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {c.category && <span className="chip px-2 py-0.5 text-[11px]">{c.category}</span>}
                    <span className="chip px-2 py-0.5 font-mono text-[11px]">{c.quantity === null ? 'qty unknown' : `×${c.quantity}`}</span>
                    {c.evidence && (
                      <span className={`chip px-2 py-0.5 text-[11px] ${c.evidence === 'visible' ? '' : 'border-flame-500/40 bg-flame-500/10 text-flame-600'}`}>
                        {c.evidence}
                      </span>
                    )}
                    {c.review_required && <span className="chip border-flame-500/40 bg-flame-500/10 px-2 py-0.5 text-[11px] text-flame-600">review</span>}
                    {c.source_ids?.length ? <span className="chip px-2 py-0.5 font-mono text-[11px]">src {c.source_ids.join(',')}</span> : null}
                  </div>
                  {c.notes && <p className="text-muted">{c.notes}</p>}
                  <p className="text-[11px] text-line-strong">{provenanceLine(p)}</p>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {genError && (
        <p role="alert" className="rounded-xl border border-flame-500/40 bg-flame-500/10 p-3 text-sm text-flame-600">
          {genError}
        </p>
      )}

      {generating && (
        <p aria-live="polite" className="rounded-xl border border-line bg-sunken/60 p-3 text-xs text-body">
          Analysing the photograph and {components?.length ?? 0} component entries with the Mistral vision
          model — a single request. Elapsed: {genElapsed}s.
        </p>
      )}

      <div className="flex items-center gap-2 border-t border-line-soft pt-4">
        <button type="button" className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <span className="flex-1" />
        <button type="button" className="btn-primary" disabled={!canGenerate} onClick={() => void generate()}>
          {generating ? (
            <>
              <LoaderCircle className="size-4 animate-spin" />
              Generating… {genElapsed}s
            </>
          ) : (
            <>
              <Sparkles className="size-4" />
              Generate workbook
            </>
          )}
        </button>
      </div>
    </Modal>
  );
}

/** Read an image file as a data URL, downscaled to maxWidth (keeps API payload sane). */
function readImageAsDataUrl(file: File, maxWidth: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        resolve(url); // fallback: original object URL won't survive, so read raw
        fileToDataUrl(file).then(resolve, reject);
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      fileToDataUrl(file).then(resolve, reject);
    };
    img.src = url;
  });
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read file.'));
    r.readAsDataURL(file);
  });
}
