import { useState } from 'react'
import { FlaskConical, X } from 'lucide-react'
import { DEMO } from '../lib/demo'

/**
 * Sits under the header whenever the app is running on the demo backend, so nobody
 * mistakes sample data for a real analysis.
 */
export default function DemoBanner() {
  const [dismissed, setDismissed] = useState(false)
  if (!DEMO || dismissed) return null

  return (
    <div className="border-b border-flame-500/20 bg-flame-500/[0.07]">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-2 sm:px-6">
        <FlaskConical className="size-4 shrink-0 text-flame-400" />
        <p className="flex-1 text-xs text-flame-200/90">
          <span className="font-semibold">Demo mode.</span> Sample data — uploads are not analysed.
          {/* The full explanation only earns its space on a wide screen. */}
          <span className="hidden sm:inline">
            {' '}
            Add Supabase credentials to <code className="font-mono">.env</code> to use the real
            pipeline.
          </span>
        </p>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          className="shrink-0 rounded-md p-1 text-flame-300 transition hover:bg-flame-500/15 hover:text-flame-100"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
