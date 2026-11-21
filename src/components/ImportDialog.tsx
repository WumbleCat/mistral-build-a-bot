import { useRef, useState } from 'react';
import { normalizeAssembly } from '../lib/adapter';

export interface ImportDialogProps {
  onLoad: (result: ReturnType<typeof normalizeAssembly>) => void;
  onClose: () => void;
}

export function ImportDialog({ onLoad, onClose }: ImportDialogProps) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleLoad = () => {
    if (!text.trim()) {
      setError('Paste JSON or choose a file first.');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setError(`Malformed JSON: ${(err as Error).message}`);
      return;
    }
    const result = normalizeAssembly(parsed);
    if (result.errors.length > 0) {
      setError(result.errors.join(' '));
      return;
    }
    onLoad(result);
  };

  const handleFile = async (file: File) => {
    const content = await file.text();
    setText(content);
    setError(null);
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-label="Import assembly JSON" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Import assembly JSON</h2>
        <p className="modal-note">
          Paste the JSON produced by the vision / BOM / step-generation modules, or pick a <code>.json</code> file. Fields are normalised automatically;
          your original instruction text is never modified.
        </p>
        <textarea
          className="modal-textarea"
          placeholder='{"robot_name": "…", "parts": […], "steps": […]}'
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          spellCheck={false}
        />
        <div className="modal-actions">
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
            }}
          />
          <button type="button" className="btn btn-secondary" onClick={() => fileRef.current?.click()}>
            Choose file…
          </button>
          <span className="modal-spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={handleLoad}>
            Load
          </button>
        </div>
        {error && <p className="modal-error">{error}</p>}
      </div>
    </div>
  );
}
