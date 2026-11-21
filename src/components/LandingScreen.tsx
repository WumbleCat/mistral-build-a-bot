import { BookOpen, Boxes, FileJson, Headphones, Link2, ListChecks, ScanSearch } from 'lucide-react';
import type { AssemblyData } from '../types';
import { PhotoBuild } from './PhotoBuild';
import { Footer, TopBar } from './Shell';

export interface LandingScreenProps {
  onLoadSample: () => void;
  onLoadUpstream: () => void;
  onImport: () => void;
  onGenerated: (data: AssemblyData, notes: string[]) => void;
  /** Developer-only UI (samples, JSON import) is shown only with ?dev=1. */
  dev?: boolean;
}

const PIPELINE = [
  { icon: ScanSearch, title: 'Identify', body: 'Vision reads the photo and lists every component it can see.' },
  { icon: Boxes, title: 'Source', body: 'A parts list with UK shop links and prices for each component.' },
  { icon: ListChecks, title: 'Prepare', body: 'Tick off the parts and tools you have before you start.' },
  { icon: Headphones, title: 'Build', body: 'Illustrated steps, read aloud, with an assistant you can talk to.' },
];

/**
 * Entry screen. Main entry point: upload a photo (analysed by the robot_bom
 * pipeline). Also: assembly JSON import, or the bundled samples.
 */
export function LandingScreen({ onLoadSample, onLoadUpstream, onImport, onGenerated, dev }: LandingScreenProps) {
  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar />

      <main className="mx-auto w-full max-w-6xl flex-1 space-y-12 px-4 py-8 sm:px-6 sm:py-12">
        <section className="grid items-center gap-10 lg:grid-cols-[1fr_1.05fr]">
          <div className="space-y-6">
            <span className="chip">
              <span className="size-1.5 rounded-full bg-flame-400" />
              Photo in, narrated build guide out
            </span>

            <h1 className="text-4xl leading-[1.1] font-bold tracking-tight sm:text-5xl">
              Build any robot{' '}
              <span className="bg-gradient-to-r from-flame-400 to-flame-600 bg-clip-text text-transparent">
                from a single photo
              </span>
            </h1>

            <p className="max-w-lg text-[15px] leading-relaxed text-body">
              BuildFromVision turns a photo of a robot into an illustrated, narrated assembly manual. You get a
              parts list with shop links, a checklist to get ready, and an AI assistant you can talk to while you
              build.
            </p>
          </div>

          <div className="card space-y-5 p-5 sm:p-6">
            <div>
              <h2 className="text-base font-semibold">Start a build</h2>
              <p className="mt-0.5 text-xs text-muted">Upload one photo. You get a shopping list and a step-by-step build guide with 3D and exploded views.</p>
            </div>

            <PhotoBuild onGenerated={onGenerated} />

            {dev && (
            <div className="border-t border-line-soft pt-4">
              <p className="label mb-2">Or open existing data</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-ghost px-3 py-2 text-xs" onClick={onLoadSample}>
                  <BookOpen className="size-3.5 text-flame-400" />
                  Sample robot
                </button>
                <button type="button" className="btn-ghost px-3 py-2 text-xs" onClick={onImport}>
                  <FileJson className="size-3.5 text-flame-400" />
                  Import assembly JSON
                </button>
                <button type="button" className="btn-ghost px-3 py-2 text-xs" onClick={onLoadUpstream}>
                  <Link2 className="size-3.5 text-flame-400" />
                  hein-parts output
                </button>
              </div>
            </div>
            )}
          </div>
        </section>

        <section aria-label="How it works">
          <ol className="grid gap-px overflow-hidden rounded-2xl border border-line/70 bg-line/70 sm:grid-cols-2 lg:grid-cols-4">
            {PIPELINE.map(({ icon: Icon, title, body }, i) => (
              <li key={title} className="group relative bg-surface/80 p-5 transition hover:bg-sunken">
                <div className="flex items-center gap-2.5">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-sunken text-flame-400 transition group-hover:border-flame-500/40 group-hover:bg-flame-500/10">
                    <Icon className="size-4" />
                  </span>
                  <span className="font-mono text-[11px] text-line-strong">{String(i + 1).padStart(2, '0')}</span>
                </div>
                <h3 className="mt-3 text-sm font-semibold text-strong">{title}</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted">{body}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <Footer />
    </div>
  );
}
