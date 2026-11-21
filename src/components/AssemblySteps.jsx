import { useState } from 'react'
import { ChevronDown, Clock, Lightbulb, TriangleAlert, Wrench } from 'lucide-react'
import { duration } from '../lib/format'
import VideoCard from './VideoCard'

function StepCard({ project, step, video, defaultOpen, onChange }) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <li className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-4 px-4 py-4 text-left transition hover:bg-ink-850/50"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-flame-500/30 bg-flame-500/10 font-mono text-sm font-bold text-flame-400">
          {step.step_number}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-ink-100">{step.title}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-400">
            {step.duration_minutes && (
              <span className="inline-flex items-center gap-1">
                <Clock className="size-3" />
                {duration(step.duration_minutes)}
              </span>
            )}
            {step.component_names?.length > 0 && (
              <span className="truncate">{step.component_names.length} parts</span>
            )}
            {step.warning && <span className="text-flame-300">safety note</span>}
          </span>
        </span>
        <ChevronDown
          className={`size-4 shrink-0 text-ink-400 transition ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="grid gap-5 border-t border-ink-800 px-4 py-4 lg:grid-cols-[1.4fr_1fr]">
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-ink-300">{step.instructions}</p>

            {step.component_names?.length > 0 && (
              <div>
                <p className="label mb-1.5">Parts for this step</p>
                <div className="flex flex-wrap gap-1.5">
                  {step.component_names.map((name) => (
                    <span key={name} className="chip">
                      {name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {step.tools?.length > 0 && (
              <div>
                <p className="label mb-1.5">Tools</p>
                <div className="flex flex-wrap gap-1.5">
                  {step.tools.map((tool) => (
                    <span key={tool} className="chip">
                      <Wrench className="size-3" />
                      {tool}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {step.tips && (
              <p className="flex gap-2 rounded-xl border border-ink-700 bg-ink-850/60 p-3 text-xs text-ink-300">
                <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-flame-400" />
                {step.tips}
              </p>
            )}

            {step.warning && (
              <p className="flex gap-2 rounded-xl border border-flame-500/30 bg-flame-500/10 p-3 text-xs text-flame-200">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                {step.warning}
              </p>
            )}
          </div>

          <div>
            <p className="label mb-1.5">Demo clip</p>
            <VideoCard
              projectId={project.id}
              stepId={step.id}
              kind="step"
              video={video}
              label={`Step ${step.step_number} · ${step.title}`}
              onChange={onChange}
            />
          </div>
        </div>
      )}
    </li>
  )
}

export default function AssemblySteps({ project, onChange }) {
  const steps = project.assembly_steps ?? []
  const videosByStep = new Map((project.videos ?? []).filter((v) => v.step_id).map((v) => [v.step_id, v]))

  const totalMinutes = steps.reduce((s, step) => s + (step.duration_minutes ?? 0), 0)

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Assembly instructions</h2>
          <p className="mt-0.5 text-sm text-ink-400">
            {steps.length} steps
            {totalMinutes > 0 && ` · about ${duration(totalMinutes)} of work`}
          </p>
        </div>
      </header>

      <ol className="space-y-2.5">
        {steps.map((step, i) => (
          <StepCard
            key={step.id}
            project={project}
            step={step}
            video={videosByStep.get(step.id)}
            defaultOpen={i === 0}
            onChange={onChange}
          />
        ))}
      </ol>
    </section>
  )
}
