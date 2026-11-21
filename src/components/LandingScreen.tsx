export interface LandingScreenProps {
  onLoadSample: () => void;
  onLoadUpstream: () => void;
  onImport: () => void;
  onPhotoAnalysis: () => void;
}

/**
 * Simple entry screen so the demo starts with a clear product story instead of
 * dropping straight into sample data. Entry points: paired photo+JSON analysis,
 * raw JSON import, or the bundled samples.
 */
export function LandingScreen({ onLoadSample, onLoadUpstream, onImport, onPhotoAnalysis }: LandingScreenProps) {
  return (
    <div className="landing">
      <div className="landing-card">
        <svg className="landing-logo" viewBox="0 0 40 40" aria-hidden>
          <rect x="2" y="2" width="36" height="36" rx="9" fill="#17181a" />
          <rect x="11" y="15" width="18" height="13" rx="3" fill="none" stroke="#fff" strokeWidth="2.4" />
          <circle cx="16.5" cy="21.5" r="1.8" fill="#ff5a1f" />
          <circle cx="23.5" cy="21.5" r="1.8" fill="#ff5a1f" />
          <line x1="20" y1="15" x2="20" y2="9" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="20" cy="8" r="2.4" fill="#ff5a1f" />
        </svg>
        <h1 className="landing-title">BuildFromVision</h1>
        <p className="landing-sub">
          Turn a photo of a robot into an illustrated, narrated assembly manual —
          with an AI assistant you can talk to while you build.
        </p>
        <div className="landing-actions">
          <button type="button" className="btn btn-primary landing-btn" onClick={onPhotoAnalysis}>
            📷 Upload robot photo + analysis JSON
          </button>
          <button type="button" className="btn btn-secondary landing-btn" onClick={onImport}>
            ⇪ Import assembly JSON only
          </button>
          <button type="button" className="btn btn-secondary landing-btn" onClick={onLoadSample}>
            📖 Try the sample robot (Four-Wheel Robot Car)
          </button>
          <button type="button" className="btn btn-secondary landing-btn" onClick={onLoadUpstream}>
            🔗 Load hein-parts team output (Obstacle-avoiding car)
          </button>
        </div>
        <p className="landing-note">
          Upload → Identify → BOM → Prepare → Illustrate → Build with voice guidance → Complete
        </p>
      </div>
    </div>
  );
}
