import { useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';
import { normalizeAssembly } from '../lib/adapter';
import { Modal } from './Shell';

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
    <Modal label="Import assembly JSON" onClose={onClose}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Import assembly JSON</h2>
          <p className="mt-1 text-sm text-muted">
            Paste the JSON produced by the vision / BOM / step-generation modules, or pick a{' '}
            <code className="font-mono text-xs">.json</code> file. Fields are normalised automatically; your original
            instruction text is never modified.
          </p>
        </div>
        <button type="button" className="rounded-lg p-2 text-muted transition hover:bg-sunken hover:text-strong" onClick={onClose} aria-label="Close">
          <X className="size-4" />
        </button>
      </div>
      <textarea
        className="input min-h-56 resize-y font-mono text-xs"
        placeholder='{"robot_name": "…", "parts": […], "steps": […]}'
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        spellCheck={false}
      />
      {error && (
        <p role="alert" className="rounded-xl border border-flame-500/40 bg-flame-500/10 p-3 text-sm text-flame-600">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
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
        <button type="button" className="btn-ghost" onClick={() => fileRef.current?.click()}>
          <Upload className="size-4" />
          Choose file…
        </button>
        <span className="flex-1" />
        <button type="button" className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn-primary" onClick={handleLoad}>
          Load
        </button>
      </div>
    </Modal>
  );
}
