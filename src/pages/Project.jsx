import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowRight,
  FlaskConical,
  Boxes,
  CircleDollarSign,
  Clock,
  Cpu,
  Film,
  ListOrdered,
  RefreshCw,
  TriangleAlert,
  Wrench,
} from 'lucide-react'
import { getProject, retryAnalysis, subscribeToProject } from '../lib/api'
import { describeError } from '../lib/errors'
import { duration, money, relativeTime } from '../lib/format'
import DeviceImage from '../components/DeviceImage'
import StatusTimeline from '../components/StatusTimeline'
import AssemblySteps from '../components/AssemblySteps'
import VideoCard from '../components/VideoCard'
import Spinner from '../components/Spinner'

// Pulls in Three.js (~600 KB); keep it out of the initial bundle.
const BuildAtlas = lazy(() => import('../components/BuildAtlas'))
import Empty from '../components/Empty'

const TABS = [
  { key: 'overview', label: 'Overview', icon: Cpu },
  { key: 'build', label: 'Parts & build', icon: Boxes },
  { key: 'assembly', label: 'Assembly', icon: ListOrdered },
  { key: 'video', label: 'Walkthrough', icon: Film },
]

function Stat({ icon: Icon, label, value, accent }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 text-ink-400">
        <Icon className="size-3.5" />
        <span className="label">{label}</span>
      </div>
      <p className={`mt-1.5 font-mono text-xl font-bold ${accent ?? 'text-ink-100'}`}>{value}</p>
    </div>
  )
}

export default function Project() {
  const { id } = useParams()
  const [project, setProject] = useState(null)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('overview')
  const [retrying, setRetrying] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setProject(await getProject(id))
      setError(null)
    } catch (e) {
      setError(describeError(e))
    }
  }, [id])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Live updates while the analysis runs, with a poll as a safety net.
  const isWorking = project?.status === 'queued' || project?.status === 'analyzing'

  useEffect(() => {
    if (!id) return
    return subscribeToProject(id, refresh)
  }, [id, refresh])

  useEffect(() => {
    if (!isWorking) return
    const timer = setInterval(refresh, 3000)
    return () => clearInterval(timer)
  }, [isWorking, refresh])

  async function handleRetry() {
    setRetrying(true)
    try {
      await retryAnalysis(id)
      await refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setRetrying(false)
    }
  }

  if (error && !project) {
    return (
      <Empty
        icon={TriangleAlert}
        title="Build not found"
        body={error}
        action={
          <Link to="/builds" className="btn-ghost">
            Back to my builds
          </Link>
        }
      />
    )
  }

  if (!project) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner label="Loading this build" />
      </div>
    )
  }

  const walkthrough = (project.videos ?? []).find((v) => v.kind === 'walkthrough')
  const ready = project.status === 'ready'

  return (
    <div className="space-y-7">
      {/* ------------------------------------------------------------ header */}
      <header className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <DeviceImage
          path={project.image_path}
          alt={project.device_name ?? project.title}
          className="aspect-[4/3] w-full rounded-2xl border border-ink-700 bg-ink-950 object-cover"
        />

        <div className="space-y-4">
          <div>
            <p className="label">{project.device_category ?? 'Device'}</p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
              {project.device_name ?? project.title}
            </h1>
            {project.device_summary && (
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-300">
                {project.device_summary}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {project.difficulty && <span className="chip capitalize">{project.difficulty}</span>}
            {project.confidence != null && (
              <span className="chip">{Math.round(project.confidence * 100)}% confidence</span>
            )}
            {project.model && <span className="chip font-mono">{project.model}</span>}
            <span className="chip">{relativeTime(project.created_at)}</span>
          </div>

          {ready && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat icon={Boxes} label="Parts" value={project.component_count || '—'} />
              <Stat
                icon={CircleDollarSign}
                label="Est. cost"
                value={money(project.total_cost_cents, project.currency)}
                accent="text-flame-400"
              />
              <Stat icon={ListOrdered} label="Steps" value={project.assembly_steps?.length ?? 0} />
              <Stat icon={Clock} label="Build time" value={duration(project.est_build_minutes)} />
            </div>
          )}
        </div>
      </header>

      {/* The analysis is canned in demo mode; say so where the result is read. */}
      {project.is_demo_sample && (
        <section className="flex items-start gap-3 rounded-2xl border border-flame-500/25 bg-flame-500/10 p-4">
          <FlaskConical className="mt-0.5 size-4 shrink-0 text-flame-400" />
          <p className="text-sm text-flame-100">
            <span className="font-semibold">This is sample data, not your photo.</span> Demo mode has
            no vision model, so it replays one of two prepared teardowns. Connect Supabase and deploy
            the <code className="font-mono text-xs">analyze-device</code> function to analyse what you
            actually uploaded.
          </p>
        </section>
      )}

      {/* ----------------------------------------------------- in progress */}
      {isWorking && (
        <section className="card space-y-4 p-6">
          <div>
            <h2 className="font-semibold">Working on it</h2>
            <p className="mt-0.5 text-sm text-ink-400">
              Mistral is reading the photo and producing the build plan. This usually takes 20–60
              seconds.
            </p>
          </div>
          <StatusTimeline project={project} />
        </section>
      )}

      {/* ---------------------------------------------------------- failed */}
      {project.status === 'failed' && (
        <section className="card border-flame-600/40 p-6">
          <div className="flex items-start gap-3">
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-flame-300" />
            <div className="space-y-3">
              <div>
                <h2 className="font-semibold">Analysis failed</h2>
                <p className="mt-1 text-sm text-ink-300">{project.error}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-primary" onClick={handleRetry} disabled={retrying}>
                  <RefreshCw className={`size-4 ${retrying ? 'animate-spin' : ''}`} />
                  Run it again
                </button>
                <Link to="/" className="btn-ghost">
                  Upload a different photo
                  <ArrowRight className="size-4" />
                </Link>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ------------------------------------------------------------- tabs */}
      {ready && (
        <>
          <nav className="flex gap-1 overflow-x-auto border-b border-ink-800 pb-px">
            {TABS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={[
                  '-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3.5 py-2.5 text-sm font-medium transition',
                  tab === key
                    ? 'border-flame-500 text-ink-100'
                    : 'border-transparent text-ink-400 hover:text-ink-100',
                ].join(' ')}
              >
                <Icon className="size-4" />
                {label}
              </button>
            ))}
          </nav>

          {tab === 'overview' && (
            <div className="grid gap-6 lg:grid-cols-2">
              {project.analysis?.visible_features?.length > 0 && (
                <section className="card p-5">
                  <h2 className="font-semibold">What the photo shows</h2>
                  <ul className="mt-3 space-y-2">
                    {project.analysis.visible_features.map((feature) => (
                      <li key={feature} className="flex gap-2.5 text-sm text-ink-300">
                        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-flame-400" />
                        {feature}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {project.analysis?.assumptions?.length > 0 && (
                <section className="card p-5">
                  <h2 className="font-semibold">Inferred, not seen</h2>
                  <p className="mt-0.5 text-xs text-ink-400">
                    Worth checking before you order these parts.
                  </p>
                  <ul className="mt-3 space-y-2">
                    {project.analysis.assumptions.map((item) => (
                      <li key={item} className="flex gap-2.5 text-sm text-ink-300">
                        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-ink-600" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {project.tools?.length > 0 && (
                <section className="card p-5">
                  <h2 className="font-semibold">Tools you will need</h2>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {project.tools.map((tool) => (
                      <span key={tool} className="chip">
                        <Wrench className="size-3" />
                        {tool}
                      </span>
                    ))}
                  </div>
                </section>
              )}

              {project.skills?.length > 0 && (
                <section className="card p-5">
                  <h2 className="font-semibold">Skills involved</h2>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {project.skills.map((skill) => (
                      <span key={skill} className="chip">
                        {skill}
                      </span>
                    ))}
                  </div>
                </section>
              )}

              <section className="card p-5 lg:col-span-2">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold">Ready to build?</h2>
                    <p className="mt-0.5 text-sm text-ink-400">
                      Order the parts, then follow the steps with a clip for each one.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" className="btn-ghost" onClick={() => setTab('build')}>
                      <Boxes className="size-4" />
                      Parts list
                    </button>
                    <button type="button" className="btn-primary" onClick={() => setTab('assembly')}>
                      <ListOrdered className="size-4" />
                      Start assembly
                    </button>
                  </div>
                </div>
              </section>
            </div>
          )}

          {tab === 'build' && (
            <Suspense
              fallback={
                <div className="card grid place-items-center py-24">
                  <Spinner label="Loading the build atlas" />
                </div>
              }
            >
              <BuildAtlas project={project} />
            </Suspense>
          )}

          {tab === 'assembly' && <AssemblySteps project={project} onChange={refresh} />}

          {tab === 'video' && (
            <section className="space-y-4">
              <header>
                <h2 className="text-lg font-semibold">Full build walkthrough</h2>
                <p className="mt-0.5 text-sm text-ink-400">
                  One continuous clip taking the device from loose parts to finished build.
                </p>
              </header>

              <div className="mx-auto max-w-3xl">
                <VideoCard
                  projectId={project.id}
                  kind="walkthrough"
                  video={walkthrough}
                  label={`${project.device_name ?? project.title} · full build`}
                  onChange={refresh}
                />
              </div>

              <div className="card p-5">
                <h3 className="font-semibold">Per-step clips</h3>
                <p className="mt-0.5 text-sm text-ink-400">
                  {(project.videos ?? []).filter((v) => v.step_id && v.status === 'ready').length} of{' '}
                  {project.assembly_steps?.length ?? 0} steps have a clip. Generate them from the
                  assembly tab.
                </p>
                <button type="button" className="btn-ghost mt-4" onClick={() => setTab('assembly')}>
                  <ListOrdered className="size-4" />
                  Go to assembly steps
                </button>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
