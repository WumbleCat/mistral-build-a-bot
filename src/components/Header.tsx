import { BookOpen, FileUp, Headphones } from 'lucide-react';
import { TopBar } from './Shell';

export type ViewMode = 'workbook' | 'guided';

export interface HeaderProps {
  robotName: string;
  stepNumber: number;
  totalSteps: number;
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  onImportClick: () => void;
  onHome?: () => void;
  /** Developer-only UI (Import JSON) is shown only with ?dev=1. */
  dev?: boolean;
}

const tab = (active: boolean) =>
  [
    'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition',
    active ? 'bg-line-soft text-strong' : 'text-muted hover:bg-sunken hover:text-strong',
  ].join(' ');

export function Header({ robotName, stepNumber, totalSteps, mode, onModeChange, onImportClick, onHome, dev }: HeaderProps) {
  const progress = totalSteps > 0 ? stepNumber / totalSteps : 0;
  return (
    <TopBar onLogoClick={onHome} progress={progress}>
      <div className="mr-2 hidden min-w-0 flex-col items-end leading-tight md:flex">
        <span className="max-w-[22ch] truncate text-sm font-semibold text-strong">{robotName}</span>
        <span className="font-mono text-[11px] text-muted tabular-nums">
          Step {stepNumber}/{totalSteps} · {Math.round(progress * 100)}%
        </span>
      </div>

      <nav className="flex items-center gap-1" aria-label="Viewing mode">
        <button type="button" className={tab(mode === 'workbook')} onClick={() => onModeChange('workbook')} aria-pressed={mode === 'workbook'}>
          <BookOpen className="size-4" />
          <span className="hidden sm:inline">Workbook</span>
        </button>
        <button type="button" className={tab(mode === 'guided')} onClick={() => onModeChange('guided')} aria-pressed={mode === 'guided'}>
          <Headphones className="size-4" />
          <span className="hidden sm:inline">Guided tour</span>
        </button>
      </nav>

      {dev && (
        <div className="ml-1 border-l border-line-soft pl-3">
          <button type="button" className="btn-ghost px-3 py-2" onClick={onImportClick}>
            <FileUp className="size-4" />
            <span className="hidden sm:inline">Import JSON</span>
          </button>
        </div>
      )}
    </TopBar>
  );
}
