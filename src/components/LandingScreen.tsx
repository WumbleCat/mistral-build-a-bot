import { ArrowRight, BookOpen, Boxes, Camera, FileJson, Headphones, Link2, ListChecks, ScanSearch } from 'lucide-react';
import { Footer, TopBar } from './Shell';

export interface LandingScreenProps {
  onLoadSample: () => void;
  onLoadUpstream: () => void;
  onImport: () => void;
  onPhotoAnalysis: () => void;
}

const PIPELINE = [
  { icon: ScanSearch, title: 'Identify', body: 'Vision reads the photo and lists every component it can see.' },
  { icon: Boxes, title: 'Source', body: 'A parts list with UK shop links and prices for each component.' },
  { icon: ListChecks, title: 'Prepare', body: 'Tick off the parts and tools you have before you start.' },
  { icon: Headphones, title: 'Build', body: 'Illustrated steps, read aloud, with an assistant you can talk to.' },
];

/**
 * Entry screen. Entry points: paired photo + JSON analysis, raw JSON import,
 * or the bundled samples.
 */
export function LandingScreen({ onLoadSample, onLoadUpstream, onImport, onPhotoAnalysis }: LandingScreenProps) {
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
              <p className="mt-0.5 text-xs text-muted">Upload a photo with its analysis, or open one of the samples.</p>
            </div>

            <button type="button" className="btn-primary w-full py-3" onClick={onPhotoAnalysis}>
              <Camera className="size-4" />
              Upload robot photo + analysis JSON
              <ArrowRight className="size-4" />
            </button>

            <div className="grid gap-2.5 sm:grid-cols-2">
              <button type="button" className="btn-ghost justify-start" onClick={onImport}>
                <FileJson className="size-4 text-flame-400" />
                Import assembly JSON
              </button>
              <button type="button" className="btn-ghost justify-start" onClick={onLoadSample}>
                <BookOpen className="size-4 text-flame-400" />
                Try the sample robot
              </button>
              <button type="button" className="btn-ghost justify-start sm:col-span-2" onClick={onLoadUpstream}>
                <Link2 className="size-4 text-flame-400" />
                Load hein-parts team output (obstacle-avoiding car)
              </button>
            </div>

            <p className="text-center text-[11px] text-muted">
              The sample is a four-wheel robot car with narration and an exploded view.
            </p>
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
