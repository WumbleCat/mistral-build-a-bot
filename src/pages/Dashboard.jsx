import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Boxes, ChevronRight, LoaderCircle, Sparkles, Trash2, TriangleAlert } from 'lucide-react'
import { deleteProject, listProjects } from '../lib/api'
import { describeError } from '../lib/errors'
import { money, relativeTime } from '../lib/format'
import DeviceImage from '../components/DeviceImage'
import Spinner from '../components/Spinner'
import Empty from '../components/Empty'

const STATUS_STYLE = {
  queued: 'border-ink-700 bg-ink-850 text-ink-300',
  analyzing: 'border-flame-500/30 bg-flame-500/10 text-flame-300',
  ready: 'border-mint-400/30 bg-mint-400/10 text-mint-400',
  failed: 'border-flame-600/40 bg-flame-600/15 text-flame-200',
}

function StatusBadge({ status }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[status] ?? STATUS_STYLE.queued}`}
    >
      {(status === 'analyzing' || status === 'queued') && (
        <LoaderCircle className="size-3 animate-spin" />
      )}
      {status === 'failed' && <TriangleAlert className="size-3" />}
      {status === 'analyzing' ? 'analysing' : status}
    </span>
  )
}

export default function Dashboard() {
  const [projects, setProjects] = useState(null)
  const [error, setError] = useState(null)
  const [removing, setRemoving] = useState(null)

  const load = useCallback(async () => {
    try {
      setProjects(await listProjects())
    } catch (e) {
      setError(describeError(e))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Keep the list fresh while anything is still being analysed.
  useEffect(() => {
    const pending = projects?.some((p) => p.status === 'queued' || p.status === 'analyzing')
    if (!pending) return
    const id = setInterval(load, 4000)
    return () => clearInterval(id)
  }, [projects, load])

  async function handleDelete(event, id) {
    event.preventDefault()
    event.stopPropagation()
    setRemoving(id)
    try {
      await deleteProject(id)
      setProjects((list) => list.filter((p) => p.id !== id))
    } catch (e) {
      setError(e.message)
    } finally {
      setRemoving(null)
    }
  }

  if (error) {
    return (
      <Empty
        icon={TriangleAlert}
        title="Could not load your builds"
        body={error}
        action={
          <button type="button" className="btn-ghost" onClick={load}>
            Try again
          </button>
        }
      />
    )
  }

  if (!projects) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner label="Loading your builds" />
      </div>
    )
  }

  if (!projects.length) {
    return (
      <Empty
        icon={Boxes}
        title="No builds yet"
        body="Upload a photo of any device and BuildFromVision will work out what it is made of."
        action={
          <Link to="/" className="btn-primary">
            <Sparkles className="size-4" />
            Start a build
          </Link>
        }
      />
    )
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">My builds</h1>
          <p className="mt-0.5 text-sm text-ink-400">
            {projects.length} {projects.length === 1 ? 'device' : 'devices'} analysed
          </p>
        </div>
        <Link to="/" className="btn-primary">
          <Sparkles className="size-4" />
          New build
        </Link>
      </header>

      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {projects.map((project) => (
          <li key={project.id}>
            <Link
              to={`/builds/${project.id}`}
              className="card card-interactive group flex h-full flex-col overflow-hidden"
            >
              <DeviceImage
                path={project.image_path}
                alt={project.device_name ?? project.title}
                className="aspect-[16/10] w-full bg-ink-950 object-cover transition duration-300 group-hover:scale-[1.03]"
              />

              <div className="flex flex-1 flex-col gap-2.5 p-4">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="min-w-0 flex-1 truncate font-semibold text-ink-100">
                    {project.device_name ?? project.title}
                  </h2>
                  <StatusBadge status={project.status} />
                </div>

                <dl className="mt-auto flex items-center gap-4 text-xs text-ink-400">
                  <div>
                    <dt className="label">Parts</dt>
                    <dd className="mt-0.5 font-mono text-sm text-ink-100">
                      {project.component_count || '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="label">Est. cost</dt>
                    <dd className="mt-0.5 font-mono text-sm text-flame-400">
                      {money(project.total_cost_cents, project.currency)}
                    </dd>
                  </div>
                </dl>

                <div className="flex items-center justify-between border-t border-ink-800 pt-2.5 text-xs text-ink-400">
                  <span>{relativeTime(project.created_at)}</span>
                  <span className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={(e) => handleDelete(e, project.id)}
                      disabled={removing === project.id}
                      aria-label="Delete build"
                      className="rounded-md p-1 transition hover:bg-ink-800 hover:text-flame-300"
                    >
                      {removing === project.id ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )}
                    </button>
                    <ChevronRight className="size-4 transition group-hover:translate-x-0.5 group-hover:text-flame-400" />
                  </span>
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
