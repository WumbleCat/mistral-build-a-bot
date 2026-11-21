import { useRef, useState } from 'react';

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
  const fileRef = useRef<HTMLInputElement>(null);
  const jsonFileRef = useRef<HTMLInputElement>(null);

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
    <div className="modal-backdrop" role="dialog" aria-label="Upload robot photo and analysis JSON" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">📷 Robot photo + component analysis</h2>
        <p className="modal-note">
          Upload the original robot photograph and the JSON component-analysis output for that photo.
          Both are sent together to the vision pipeline — the JSON is the structured inventory, the photo is the visual reference.
        </p>

        <div className="photo-inputs">
          <div className="photo-input-col">
            <span className="parts-label">Robot photograph</span>
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
            <button type="button" className="btn btn-secondary btn-small" onClick={() => fileRef.current?.click()}>
              Choose image…
            </button>
            {imageUrl && (
              <div className="photo-preview">
                <img src={imageUrl} alt="Robot photograph preview" />
                <span className="photo-name">{imageName}</span>
              </div>
            )}
            {!imageUrl && <p className="card-note">No image selected.</p>}
          </div>

          <div className="photo-input-col">
            <span className="parts-label">Component-analysis JSON</span>
            <textarea
              className="modal-textarea"
              style={{ minHeight: 120 }}
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
            <button type="button" className="btn btn-secondary btn-small" onClick={() => jsonFileRef.current?.click()}>
              Choose JSON file…
            </button>
          </div>
        </div>

        {errors.length > 0 && (
          <ul className="import-notes">
            {errors.map((e, i) => <li key={i} style={{ color: '#b3261e' }}>✗ {e}</li>)}
          </ul>
        )}
        {warnings.length > 0 && (
          <ul className="import-notes">
            {warnings.map((w, i) => <li key={i}>⚠ {w}</li>)}
          </ul>
        )}

        {components && components.length > 0 && (
          <div className="analysis-preview">
            <span className="parts-label">{components.length} detected component{components.length === 1 ? '' : 's'}</span>
            <ul className="analysis-list">
              {components.map((c, i) => {
                const p = { id: '', name: c.name, quantity: c.quantity === null ? 1 : (c.quantity ?? 1), evidence: c.evidence, source_ids: c.source_ids, review_required: c.review_required, quantityUnknown: c.quantity == null, notes: c.notes } as never;
                return (
                  <li key={i} className={`analysis-row ${c.evidence === 'inferred' ? 'analysis-inferred' : ''} ${c.review_required ? 'analysis-review' : ''}`}>
                    <span className="analysis-name">{c.name}</span>
                    <span className="analysis-meta">
                      {c.category && <span className="chip chip-muted">{c.category}</span>}
                      <span className="chip chip-muted">{c.quantity === null ? 'qty unknown' : `×${c.quantity}`}</span>
                      {c.evidence && <span className={`chip ${c.evidence === 'visible' ? 'chip-muted' : 'chip-accent'}`}>{c.evidence}</span>}
                      {c.review_required && <span className="chip chip-accent">review</span>}
                      {c.source_ids?.length ? <span className="chip chip-muted">src {c.source_ids.join(',')}</span> : null}
                    </span>
                    {c.notes && <span className="analysis-notes">{c.notes}</span>}
                    <span className="analysis-prov">{provenanceLine(p)}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {genError && <p className="modal-error">{genError}</p>}

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <span className="modal-spacer" />
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canGenerate}
            onClick={() => void generate()}
          >
            {generating ? <><span className="spinner spinner-small" aria-hidden /> Generating workbook…</> : '✨ Generate workbook'}
          </button>
        </div>
      </div>
    </div>
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
