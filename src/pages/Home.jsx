import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, Boxes, Film, ListOrdered, LoaderCircle, ScanSearch } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { createProject } from '../lib/api'
import { describeError } from '../lib/errors'
import ImageDropzone from '../components/ImageDropzone'
import ConfigNotice from '../components/ConfigNotice'

const PIPELINE = [
  { icon: ScanSearch, title: 'Dismantle', body: 'Vision identifies the device and every component it can see.' },
  { icon: Boxes, title: 'Source', body: 'A costed bill of materials, with a link to a distributor for every part.' },
  { icon: ListOrdered, title: 'Assemble', body: 'Ordered steps naming the parts and tools each one needs.' },
  { icon: Film, title: 'Watch', body: 'A short clip per step, plus a full build walkthrough.' },
]

export default function Home() {
  const navigate = useNavigate()
  const { user, signInAnonymously, configured, demo } = useAuth()

  const [file, setFile] = useState(null)
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  async function handleSubmit(event) {
    event.preventDefault()
    if (!file || submitting) return

    setSubmitting(true)
    setError(null)
    try {
      // Let people try it without an account; the session is upgradeable later.
      const session = user ? { user } : await signInAnonymously()
      const project = await createProject({
        file,
        userId: session.user.id,
        title,
        notes,
      })
      navigate(`/builds/${project.id}`)
    } catch (e) {
      setError(describeError(e))
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-12">
      <section className="grid items-center gap-10 lg:grid-cols-[1fr_1.05fr]">
        <div className="space-y-6">
          <span className="chip">
            <span className="size-1.5 rounded-full bg-flame-400" />
            Photo in, buildable parts list out
          </span>

          <h1 className="text-4xl font-bold leading-[1.1] tracking-tight sm:text-5xl">
            Take apart any electronics{' '}
            <span className="bg-gradient-to-r from-flame-400 to-flame-600 bg-clip-text text-transparent">
              from a single photo
            </span>
          </h1>

          <p className="max-w-lg text-[15px] leading-relaxed text-ink-300">
            A camera, a circuit board, a keyboard, a drone, a robot. BuildFromVision recognises the
            device, dismantles it into components you can actually order, prices the whole build
            with a link to a distributor for each part, writes the assembly steps, and generates a
            video of the build.
          </p>

        </div>

        {configured || demo ? (
          <form onSubmit={handleSubmit} className="card space-y-5 p-5 sm:p-6">
            <div>
              <h2 className="text-base font-semibold">Start a build</h2>
              <p className="mt-0.5 text-xs text-ink-400">
                No account needed — you can attach an email afterwards to keep your builds.
              </p>
            </div>

            <ImageDropzone onPick={setFile} disabled={submitting} />

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5">
                <span className="label">Name this build (optional)</span>
                <input
                  className="input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Rangefinder camera"
                  disabled={submitting}
                  maxLength={80}
                />
              </label>
              <label className="space-y-1.5">
                <span className="label">Anything we should know?</span>
                <input
                  className="input"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Budget under $200, no soldering"
                  disabled={submitting}
                  maxLength={200}
                />
              </label>
            </div>

            <button type="submit" className="btn-primary w-full" disabled={!file || submitting}>
              {submitting ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  Uploading…
                </>
              ) : (
                <>
                  Dismantle it
                  <ArrowRight className="size-4" />
                </>
              )}
            </button>

            {error && (
              <p
                role="alert"
                className="rounded-xl border border-flame-500/40 bg-flame-500/10 p-3 text-sm text-flame-200"
              >
                {error}
              </p>
            )}

            <p className="text-center text-[11px] text-ink-400">
              Analysis takes 20–60 seconds. You can watch it work.
            </p>
          </form>
        ) : (
          <ConfigNotice />
        )}
      </section>

      {/* The four stages, as a strip. In the hero column they were cramped into
          two tight rows and left a dead band across the bottom of the page. */}
      <section aria-label="How it works">
        <ol className="grid gap-px overflow-hidden rounded-2xl border border-ink-700/70 bg-ink-700/70 sm:grid-cols-2 lg:grid-cols-4">
          {PIPELINE.map(({ icon: Icon, title: t, body }, i) => (
            <li key={t} className="group relative bg-ink-900/80 p-5 transition hover:bg-ink-850">
              <div className="flex items-center gap-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-ink-700 bg-ink-850 text-flame-400 transition group-hover:border-flame-500/40 group-hover:bg-flame-500/10">
                  <Icon className="size-4" />
                </span>
                <span className="font-mono text-[11px] text-ink-600">
                  {String(i + 1).padStart(2, '0')}
                </span>
              </div>
              <h3 className="mt-3 text-sm font-semibold text-ink-100">{t}</h3>
              <p className="mt-1 text-xs leading-relaxed text-ink-400">{body}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
