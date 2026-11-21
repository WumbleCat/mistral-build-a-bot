import { Check, LoaderCircle, TriangleAlert } from 'lucide-react'

const STAGES = [
  { key: 'upload', label: 'Photo uploaded' },
  { key: 'vision', label: 'Recognising the device' },
  { key: 'bom', label: 'Building the bill of materials' },
  { key: 'steps', label: 'Writing assembly steps' },
]

/** Derive per-stage state from the project row -- no extra bookkeeping needed. */
function stageStates(project) {
  const hasComponents = (project.components?.length ?? project.component_count ?? 0) > 0
  const hasSteps = (project.assembly_steps?.length ?? 0) > 0

  if (project.status === 'failed') {
    return ['done', hasComponents ? 'done' : 'failed', hasComponents ? 'failed' : 'idle', 'idle']
  }
  if (project.status === 'ready') return ['done', 'done', 'done', 'done']
  if (project.status === 'queued') return ['done', 'active', 'idle', 'idle']

  return [
    'done',
    hasComponents ? 'done' : 'active',
    hasComponents ? (hasSteps ? 'done' : 'active') : 'idle',
    hasSteps ? 'done' : hasComponents ? 'active' : 'idle',
  ]
}

function Dot({ state }) {
  if (state === 'done') {
    return (
      <span className="grid size-6 place-items-center rounded-full bg-mint-400/15 text-mint-400">
        <Check className="size-3.5" strokeWidth={3} />
      </span>
    )
  }
  if (state === 'active') {
    return (
      <span className="grid size-6 place-items-center rounded-full bg-flame-500/15 text-flame-400">
        <LoaderCircle className="size-3.5 animate-spin" strokeWidth={3} />
      </span>
    )
  }
  if (state === 'failed') {
    return (
      <span className="grid size-6 place-items-center rounded-full bg-flame-600/20 text-flame-300">
        <TriangleAlert className="size-3.5" strokeWidth={2.5} />
      </span>
    )
  }
  return <span className="grid size-6 place-items-center rounded-full border border-line" />
}

export default function StatusTimeline({ project }) {
  const states = stageStates(project)

  return (
    <ol className="space-y-3">
      {STAGES.map((stage, i) => (
        <li key={stage.key} className="flex items-center gap-3">
          <Dot state={states[i]} />
          <span
            className={[
              'text-sm',
              states[i] === 'idle' ? 'text-muted' : 'text-strong',
              states[i] === 'active' ? 'font-medium' : '',
            ].join(' ')}
          >
            {stage.label}
          </span>
        </li>
      ))}
    </ol>
  )
}
