export interface LandingScreenProps {
  onLoadSample: () => void;
  onLoadUpstream: () => void;
  onImport: () => void;
  onPhotoAnalysis: () => void;
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

/** Clean product hero: one title, one subtitle, two actions, three feature cards. */
export function LandingScreen({ onLoadSample, onImport, onPhotoAnalysis }: LandingScreenProps) {
  return (
    <div className="landing">
      <div className="landing-card">
        <Logo />
        <h1 className="landing-title">From a photo to a working robot.</h1>
        <p className="landing-sub">
          Snap your robot, get a real parts list with UK prices, and build it step by step
          in 3D with a voice coach.
        </p>
        <div className="landing-actions">
          <button type="button" className="btn btn-primary landing-btn" onClick={onLoadSample}>
            Try the demo robot
          </button>
          <button type="button" className="btn btn-secondary landing-btn" onClick={onPhotoAnalysis}>
            Upload a photo
          </button>
          <button type="button" className="btn btn-ghost landing-btn" onClick={onImport} style={{ minHeight: 48 }}>
            Import JSON
          </button>
        </div>
        <div className="landing-note">
          <div className="feature-card">
            <h3>Identify parts</h3>
            <p>Vision AI reads the photo and names every visible component.</p>
          </div>
          <div className="feature-card">
            <h3>Live UK prices</h3>
            <p>A buyable BOM with real shop links and a total in £.</p>
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
