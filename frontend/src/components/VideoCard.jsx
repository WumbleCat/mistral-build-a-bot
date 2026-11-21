import { useEffect, useRef, useState } from 'react'
import { Film, LoaderCircle, Play, RefreshCw, Sparkles, TriangleAlert } from 'lucide-react'
import { pollVideo, requestVideo } from '../lib/api'

/**
 * One generated clip -- a per-step demo or the full walkthrough.
 *
 * Four states: nothing yet, generating (polled), ready, failed.
 * When VIDEO_PROVIDER=mock the row arrives ready with no URL; we show the shot
 * description that would be sent to the video model rather than faking a player.
 */
export default function VideoCard({ projectId, stepId = null, kind = 'step', video, label, onChange }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const timer = useRef(null)

  const status = video?.status
  const isGenerating = status === 'generating' || status === 'queued'

  // Poll while the provider is working. Realtime also pushes the final row, so this
  // is the fallback for providers that finish without a database write of their own.
  useEffect(() => {
    if (!isGenerating || !video?.provider_job_id) return

    async function tick() {
      try {
        const next = await pollVideo({ projectId, stepId, kind })
        if (next?.status && next.status !== 'generating') onChange?.()
      } catch {
        /* keep polling; a transient failure is not fatal */
      }
    }

    timer.current = setInterval(tick, 5000)
    return () => clearInterval(timer.current)
  }, [isGenerating, video?.provider_job_id, projectId, stepId, kind, onChange])

  async function generate() {
    setBusy(true)
    setError(null)
    try {
      await requestVideo({ projectId, stepId, kind })
      onChange?.()
    } catch (e) {
      setError(e.message ?? 'Could not start the video job')
    } finally {
      setBusy(false)
    }
  }

  /* -------------------------------------------------------- ready, with file */
  if (status === 'ready' && video.video_url) {
    return (
      <div className="overflow-hidden rounded-xl border border-line bg-canvas">
        <video
          src={video.video_url}
          poster={video.thumbnail_url ?? undefined}
          controls
          loop
          playsInline
          className="aspect-video w-full bg-black"
        />
        <div className="flex items-center justify-between gap-3 px-3 py-2">
          <span className="truncate text-[11px] text-muted">{label}</span>
          <button
            type="button"
            onClick={generate}
            disabled={busy}
            className="shrink-0 text-[11px] text-muted transition hover:text-flame-300"
          >
            <RefreshCw className="inline size-3" /> Regenerate
          </button>
        </div>
      </div>
    )
  }

  /* ------------------------------------------- ready, storyboard (mock mode) */
  if (status === 'ready' && !video.video_url) {
    return (
      <div className="rounded-xl border border-line bg-gradient-to-br from-sunken to-surface p-4">
        <div className="mb-2.5 flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-lg bg-flame-500/15 text-flame-400">
            <Film className="size-3.5" />
          </span>
          <span className="label">Storyboard · shot description</span>
        </div>
        <p className="text-sm leading-relaxed text-body">{video.prompt}</p>
        <p className="mt-3 border-t border-line-soft pt-2.5 text-[11px] text-muted">
          Set <code className="font-mono text-flame-300">VIDEO_PROVIDER</code> to a video model and
          this becomes a rendered clip.
        </p>
      </div>
    )
  }

  /* ------------------------------------------------------------- generating */
  if (isGenerating) {
    return (
      <div className="rounded-xl border border-flame-500/30 bg-flame-500/5 p-4">
        <div className="flex items-center gap-2.5 text-sm text-flame-300">
          <LoaderCircle className="size-4 animate-spin" />
          Rendering the clip…
        </div>
        {video.prompt && <p className="mt-2 line-clamp-3 text-xs text-muted">{video.prompt}</p>}
      </div>
    )
  }

  /* ----------------------------------------------------------------- failed */
  if (status === 'failed') {
    return (
      <div className="rounded-xl border border-line bg-surface p-4">
        <div className="flex items-start gap-2.5">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-flame-300" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-strong">Video generation failed</p>
            <p className="mt-0.5 break-words text-xs text-muted">{video.error}</p>
            <button type="button" onClick={generate} disabled={busy} className="btn-ghost mt-3 px-3 py-1.5 text-xs">
              <RefreshCw className="size-3.5" />
              Try again
            </button>
          </div>
        </div>
      </div>
    )
  }

  /* ------------------------------------------------------------ nothing yet */
  return (
    <div className="rounded-xl border border-dashed border-line bg-surface/40 p-4">
      <button type="button" onClick={generate} disabled={busy} className="btn-ghost w-full">
        {busy ? <LoaderCircle className="size-4 animate-spin" /> : kind === 'walkthrough' ? <Play className="size-4" /> : <Sparkles className="size-4" />}
        {busy ? 'Starting…' : kind === 'walkthrough' ? 'Generate full walkthrough' : 'Generate demo clip'}
      </button>
      {error && <p className="mt-2 text-xs text-flame-300">{error}</p>}
    </div>
  )
}
