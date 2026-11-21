import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, ImageIcon, Upload, X } from 'lucide-react'
import { prepareImage } from '../lib/image'
import CameraCapture from './CameraCapture'

export default function ImageDropzone({ onPick, disabled }) {
  const [dragging, setDragging] = useState(false)
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState(null)
  const [shooting, setShooting] = useState(false)
  const inputRef = useRef(null)

  useEffect(
    () => () => {
      if (preview?.previewUrl) URL.revokeObjectURL(preview.previewUrl)
    },
    [preview],
  )

  const handleFile = useCallback(
    async (file) => {
      if (!file) return
      setError(null)
      try {
        const prepared = await prepareImage(file)
        setPreview(prepared)
        onPick(prepared.file)
      } catch (e) {
        setError(e.message)
        onPick(null)
      }
    },
    [onPick],
  )

  function clear() {
    if (preview?.previewUrl) URL.revokeObjectURL(preview.previewUrl)
    setPreview(null)
    setError(null)
    onPick(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  if (shooting && !preview) {
    return (
      <CameraCapture
        onClose={() => setShooting(false)}
        onCapture={(file) => {
          setShooting(false)
          handleFile(file)
        }}
      />
    )
  }

  if (preview) {
    return (
      <div className="relative overflow-hidden rounded-2xl border border-ink-700 bg-ink-900">
        <img
          src={preview.previewUrl}
          alt="The device you uploaded"
          className="max-h-[22rem] w-full object-contain"
        />
        <button
          type="button"
          onClick={clear}
          disabled={disabled}
          className="absolute right-3 top-3 grid size-9 place-items-center rounded-xl bg-ink-950/80 text-ink-100 backdrop-blur transition hover:bg-ink-950 disabled:opacity-40"
          aria-label="Remove image"
        >
          <X className="size-4" />
        </button>
        <div className="flex items-center justify-between gap-3 border-t border-ink-800 px-4 py-2.5 text-xs text-ink-400">
          <span className="truncate font-mono">{preview.file.name}</span>
          <span className="shrink-0">
            {preview.width ? `${preview.width}×${preview.height} · ` : ''}
            {(preview.file.size / 1024).toFixed(0)} KB
          </span>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          handleFile(e.dataTransfer.files?.[0])
        }}
        className={[
          'rounded-2xl border-2 border-dashed px-6 py-12 text-center transition',
          dragging
            ? 'border-flame-500 bg-flame-500/5'
            : 'border-ink-700 bg-ink-900/40 hover:border-ink-600',
        ].join(' ')}
      >
        <span className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl border border-ink-700 bg-ink-850 text-flame-400">
          <ImageIcon className="size-7" />
        </span>
        <p className="text-sm font-semibold text-ink-100">
          Drop a photo of the electronics to take apart
        </p>
        <p className="mx-auto mt-1.5 max-w-sm text-xs text-ink-400">
          A camera, a board, a keyboard, a drone, a robot. A full view works best. JPG, PNG or WebP,
          upload.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
          <button
            type="button"
            className="btn-primary"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="size-4" />
            Choose file
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={disabled}
            onClick={() => setShooting(true)}
          >
            <Camera className="size-4" />
            Take a photo
          </button>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />

      </div>

      {error && <p className="mt-2.5 text-sm text-flame-300">{error}</p>}
    </div>
  )
}
