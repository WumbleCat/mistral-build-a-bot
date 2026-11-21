import { useRef, useState } from 'react';

export interface LandingScreenProps {
  onLoadSample: () => void;
  onLoadUpstream: () => void;
  onImport: () => void;
  onPhotoAnalysis: (file?: File) => void;
  /** Developer-only UI (Import JSON) unless ?dev=1. */
  dev?: boolean;
}

function Logo() {
  const px = (x: number, y: number, w = 1, h = 1, fill = '#FF8205') => (
    <rect key={`${x}-${y}-${fill}`} x={x} y={y} width={w} height={h} fill={fill} />
  );
  return (
    <svg className="landing-logo" viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden>
      {px(3, 2, 2, 2)} {px(11, 2, 2, 2)}
      {px(3, 4, 10, 8)}
      {px(5, 6, 2, 2, '#0B0D12')} {px(9, 6, 2, 2, '#0B0D12')}
      {px(7, 9, 2, 1, '#FA500F')}
      {px(5, 12, 6, 3)}
    </svg>
  );
}

/**
 * Photo-first landing: big drop zone as the main action, demo robot as the
 * secondary action. No JSON anywhere unless ?dev=1.
 */
export function LandingScreen({ onLoadSample, onImport, onPhotoAnalysis, dev }: LandingScreenProps) {
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const pickFile = (f?: File | null) => {
    if (f) onPhotoAnalysis(f);
    else onPhotoAnalysis();
  };

  return (
    <div className="landing">
      <div className="landing-card">
        <Logo />
        <h1 className="landing-title">From a photo to a working robot.</h1>
        <p className="landing-sub">
          Drop a photo of a robot — get a real parts list with UK prices, then build it
          step by step in 3D with a voice coach.
        </p>

        <div
          className={`dropzone ${dragOver ? 'drag' : ''}`}
          role="button"
          tabIndex={0}
          aria-label="Drop a photo of a robot or choose a photo"
          onClick={() => fileRef.current?.click()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); pickFile(e.dataTransfer.files?.[0]); }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <circle cx="9" cy="9" r="2" />
            <path d="m21 15-4.5-4.5L6 21" />
          </svg>
          <span className="dropzone-title">Drop a photo of a robot or its parts</span>
          <span className="dropzone-sub">
            <span className="btn btn-primary btn-small">Choose photo</span>
            <span className="dropzone-hint">or use the camera on mobile</span>
          </span>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => pickFile(e.target.files?.[0])}
        />

        <div className="landing-actions">
          <button type="button" className="btn btn-secondary landing-btn" onClick={onLoadSample}>
            Try the demo robot instead
          </button>
          {dev && (
            <button type="button" className="btn btn-ghost landing-btn" onClick={onImport} style={{ minHeight: 48 }}>
              Import JSON
            </button>
          )}
        </div>
        <div className="landing-note">
          <div className="feature-card">
            <h3>Identify parts</h3>
            <p>Vision AI reads the photo and names every visible component.</p>
          </div>
          <div className="feature-card">
            <h3>Live UK prices</h3>
            <p>A buyable parts list with real shop links and a total in £.</p>
          </div>
          <div className="feature-card">
            <h3>Build in 3D</h3>
            <p>Animated steps plus a hands-free voice coach while you build.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
