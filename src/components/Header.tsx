export type ViewMode = 'workbook' | 'guided';

export interface HeaderProps {
  robotName: string;
  stepNumber: number;
  totalSteps: number;
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  onImportClick: () => void;
}

export function Header({ robotName, stepNumber, totalSteps, mode, onModeChange, onImportClick }: HeaderProps) {
  const progress = totalSteps > 0 ? stepNumber / totalSteps : 0;
  return (
    <header className="app-header">
      <div className="brand">
        <svg className="brand-mark" viewBox="0 0 40 40" aria-hidden>
          <rect x="2" y="2" width="36" height="36" rx="9" fill="#17181a" />
          <rect x="11" y="15" width="18" height="13" rx="3" fill="none" stroke="#fff" strokeWidth="2.4" />
          <circle cx="16.5" cy="21.5" r="1.8" fill="#ff5a1f" />
          <circle cx="23.5" cy="21.5" r="1.8" fill="#ff5a1f" />
          <line x1="20" y1="15" x2="20" y2="9" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="20" cy="8" r="2.4" fill="#ff5a1f" />
        </svg>
        <div className="brand-text">
          <span className="brand-name">BuildFromVision</span>
          <span className="brand-sub">Assembly Studio</span>
        </div>
      </div>

      <div className="header-robot">
        <span className="header-robot-label">Robot</span>
        <span className="header-robot-name">{robotName}</span>
      </div>

      <div className="header-progress">
        <div className="header-progress-text">
          Step {stepNumber} of {totalSteps} · {Math.round(progress * 100)}%
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${progress * 100}%` }} />
        </div>
      </div>

      <nav className="mode-toggle" aria-label="Viewing mode">
        <button type="button" className={mode === 'workbook' ? 'active' : ''} onClick={() => onModeChange('workbook')}>
          📖 Workbook
        </button>
        <button type="button" className={mode === 'guided' ? 'active' : ''} onClick={() => onModeChange('guided')}>
          🎧 Guided walkthrough
        </button>
      </nav>

      <button type="button" className="btn btn-secondary" onClick={onImportClick}>
        ⇪ Import JSON
      </button>
    </header>
  );
}
