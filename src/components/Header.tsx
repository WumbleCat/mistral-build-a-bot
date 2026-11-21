export type ViewMode = 'workbook' | 'guided';

export interface HeaderProps {
  robotName: string;
  stepNumber: number;
  totalSteps: number;
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  onImportClick: () => void;
  muted: boolean;
  onToggleMuted: () => void;
}

/** Small logo mascot (the only place the pixel style survives). */
function PixelCat() {
  const px = (x: number, y: number, w = 1, h = 1, fill = '#FF8205') => (
    <rect key={`${x}-${y}-${fill}`} x={x} y={y} width={w} height={h} fill={fill} />
  );
  return (
    <svg className="mascot" viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden>
      {px(3, 2, 2, 2)} {px(11, 2, 2, 2)}
      {px(3, 4, 10, 8)}
      {px(5, 6, 2, 2, '#0B0D12')} {px(9, 6, 2, 2, '#0B0D12')}
      {px(7, 9, 2, 1, '#FA500F')}
      {px(5, 12, 6, 3)}
    </svg>
  );
}

export function Header({ robotName, stepNumber, totalSteps, mode, onModeChange, onImportClick, muted, onToggleMuted }: HeaderProps) {
  const progress = totalSteps > 0 ? stepNumber / totalSteps : 0;
  return (
    <>
      <header className="app-header">
        <div className="brand">
          <PixelCat />
          <span className="brand-name">BuildFromVision</span>
        </div>

        <div className="header-robot">
          <span className="header-robot-name">{robotName}</span>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onModeChange(mode === 'guided' ? 'workbook' : 'guided')}
          >
            {mode === 'guided' ? 'Exit tour' : 'Guided tour'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onImportClick}>
            Import
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={onToggleMuted}
            title={muted ? 'Unmute sounds' : 'Mute sounds'}
            aria-label={muted ? 'Unmute sounds' : 'Mute sounds'}
            aria-pressed={!muted}
          >
            {muted ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M11 5 6 9H2v6h4l5 4z" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M11 5 6 9H2v6h4l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" />
              </svg>
            )}
          </button>
        </div>
      </header>
      <div className="topbar-strip">
        <div className="topbar-strip-text">Step {stepNumber} of {totalSteps}</div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${progress * 100}%` }} />
        </div>
      </div>
    </>
  );
}
