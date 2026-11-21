import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, CameraOff, LoaderCircle, RefreshCw, SwitchCamera, X } from 'lucide-react'

/**
 * Live camera capture.
 *
 * Shoots straight into the same pipeline as a dropped file: the frame is drawn to a
 * canvas, encoded as JPEG and handed back as a File, so `prepareImage` resizes it and
 * the upload path is identical.
 *
 * getUserMedia needs a secure context. localhost counts, so dev works; anything served
 * over plain http on a LAN address will not, and we say so rather than failing silently.
 */

const FRIENDLY_ERRORS = {
  NotAllowedError:
    'Camera access was blocked. Allow it for this site in your browser’s address bar, then try again.',
  NotFoundError: 'No camera was found on this device. Choose a file instead.',
  NotReadableError: 'The camera is already in use by another app. Close that and try again.',
  OverconstrainedError: 'That camera could not provide a usable video size.',
  SecurityError: 'The camera needs a secure connection (https, or localhost).',
}

export default function CameraCapture({ onCapture, onClose }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)

  const [facing, setFacing] = useState('environment')
  const [hasMultiple, setHasMultiple] = useState(false)
  const [status, setStatus] = useState('starting')
  const [error, setError] = useState(null)

  const stop = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop()
    streamRef.current = null
  }, [])

  // (Re)open the stream whenever the chosen camera changes.
  useEffect(() => {
    let cancelled = false

    async function start() {
      setStatus('starting')
      setError(null)
      stop()

      if (!navigator.mediaDevices?.getUserMedia) {
        setError(
          window.isSecureContext
            ? 'This browser has no camera API. Choose a file instead.'
            : FRIENDLY_ERRORS.SecurityError,
        )
        setStatus('failed')
        return
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        })
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop()
          return
        }

        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play().catch(() => {})
        }
        setStatus('live')

        // Only offer the flip control when there is somewhere to flip to.
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
        if (!cancelled) {
          setHasMultiple(devices.filter((d) => d.kind === 'videoinput').length > 1)
        }
      } catch (e) {
        if (cancelled) return
        setError(FRIENDLY_ERRORS[e.name] ?? e.message ?? 'The camera could not be started.')
        setStatus('failed')
      }
    }

    start()
    return () => {
      cancelled = true
      stop()
    }
  }, [facing, stop])

  // Belt and braces: never leave the camera light on.
  useEffect(() => stop, [stop])

  function shoot() {
    const video = videoRef.current
    if (!video || !video.videoWidth) return

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight

    const ctx = canvas.getContext('2d')
    // A front camera is previewed mirrored; un-mirror it so the capture matches reality.
    if (facing === 'user') {
      ctx.translate(canvas.width, 0)
      ctx.scale(-1, 1)
    }
    ctx.drawImage(video, 0, 0)

    canvas.toBlob(
      (blob) => {
        if (!blob) return
        const file = new File([blob], `capture-${Date.now()}.jpg`, {
          type: 'image/jpeg',
          lastModified: Date.now(),
        })
        stop()
        onCapture(file)
      },
      'image/jpeg',
      0.92,
    )
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-ink-700 bg-ink-950">
      <div className="relative aspect-[4/3] w-full bg-black">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className={`size-full object-cover ${facing === 'user' ? '-scale-x-100' : ''}`}
        />

        {status === 'starting' && (
          <div className="absolute inset-0 grid place-items-center bg-ink-950/80">
            <div className="flex items-center gap-2.5 text-sm text-ink-300">
              <LoaderCircle className="size-4 animate-spin text-flame-400" />
              Starting the camera…
            </div>
          </div>
        )}

        {status === 'failed' && (
          <div className="absolute inset-0 grid place-items-center bg-ink-950/90 p-6">
            <div className="max-w-sm text-center">
              <CameraOff className="mx-auto mb-3 size-6 text-flame-400" />
              <p className="text-sm text-ink-200">{error}</p>
              <button
                type="button"
                onClick={() => setFacing((f) => f)}
                className="btn-ghost mt-4 px-3 py-1.5 text-xs"
              >
                <RefreshCw className="size-3.5" />
                Try again
              </button>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => {
            stop()
            onClose()
          }}
          aria-label="Close camera"
          className="absolute right-3 top-3 grid size-9 place-items-center rounded-xl bg-ink-950/75 text-ink-100 backdrop-blur transition hover:bg-ink-950"
        >
          <X className="size-4" />
        </button>

        {hasMultiple && status === 'live' && (
          <button
            type="button"
            onClick={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))}
            aria-label="Switch camera"
            className="absolute left-3 top-3 grid size-9 place-items-center rounded-xl bg-ink-950/75 text-ink-100 backdrop-blur transition hover:bg-ink-950"
          >
            <SwitchCamera className="size-4" />
          </button>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-ink-800 px-4 py-3">
        <p className="text-xs text-ink-400">
          Fill the frame with the device. Good light, plain background.
        </p>
        <button
          type="button"
          onClick={shoot}
          disabled={status !== 'live'}
          className="btn-primary px-4 py-2 text-sm"
        >
          <Camera className="size-4" />
          Capture
        </button>
      </div>
    </div>
  )
}
