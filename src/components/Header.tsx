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

/** Original pixel-cat mascot (not the Mistral logo): rects on a 16x16 grid. */
function PixelCat() {
  const px = (x: number, y: number, w = 1, h = 1, fill = '#FF8205') => (
    <rect key={`${x}-${y}-${fill}`} x={x} y={y} width={w} height={h} fill={fill} />
  );
  return (
    <svg className="mascot" viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden>
      {px(3, 2, 2, 2)} {/* left ear */}
      {px(11, 2, 2, 2)} {/* right ear */}
      {px(3, 4, 10, 8, '#FF8205')} {/* head */}
      {px(2, 5, 1, 5)} {px(13, 5, 1, 5)} {/* side fur */}
      {px(5, 6, 2, 2, '#0E1016')} {/* eyes */}
      {px(9, 6, 2, 2, '#0E1016')}
      {px(7, 9, 2, 1, '#FA500F')} {/* nose/mouth */}
      {px(1, 9, 2, 1, '#FFD800')} {px(13, 9, 2, 1, '#FFD800')} {/* whiskers */}
      {px(5, 12, 6, 3, '#FF8205')} {/* body */}
      {px(6, 15, 1, 1, '#FFD800')} {px(9, 15, 1, 1, '#FFD800')} {/* feet */}
    </svg>
  );
}

export function Header({ robotName, stepNumber, totalSteps, mode, onModeChange, onImportClick, muted, onToggleMuted }: HeaderProps) {
  const progress = totalSteps > 0 ? stepNumber / totalSteps : 0;
  return (
    <header className="app-header">
      <div className="brand">
        <PixelCat />
        <div className="brand-text">
          <span className="brand-name">BuildFromVision</span>
          <span className="brand-sub">Robot Hangar</span>
        </div>
      </div>

      <div className="header-robot">
        <span className="header-robot-label">Robot</span>
        <span className="header-robot-name">{robotName}</span>
      </div>

      <div className="header-progress">
        <div className="header-progress-text">
          <span className="level-tag">LEVEL {stepNumber}/{totalSteps}</span>
          <span style={{ marginLeft: 10 }}>XP {Math.round(progress * 100)}%</span>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${progress * 100}%` }} />
        </div>
      </div>

      <nav className="mode-toggle" aria-label="Viewing mode">
        <button type="button" className={mode === 'workbook' ? 'active' : ''} onClick={() => onModeChange('workbook')}>
          Workbook
        </button>
        <button type="button" className={mode === 'guided' ? 'active' : ''} onClick={() => onModeChange('guided')}>
          Guided
        </button>
      </nav>

      <button type="button" className="btn btn-secondary" onClick={onImportClick} title="Import assembly JSON">
        Import JSON
      </button>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={onToggleMuted}
        title={muted ? 'Unmute UI sounds' : 'Mute UI sounds'}
        aria-pressed={!muted}
      >
        {muted ? 'SND OFF' : 'SND ON'}
      </button>
    </header>
  );
}
