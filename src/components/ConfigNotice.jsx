import { TriangleAlert } from 'lucide-react'

/** Shown instead of a broken page when .env has no Supabase credentials. */
export default function ConfigNotice() {
  return (
    <div className="card mx-auto max-w-2xl p-7">
      <div className="flex items-start gap-3">
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-flame-400" />
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Connect Supabase to continue</h2>
            <p className="mt-1 text-sm text-body">
              The frontend runs, but it has no backend to talk to yet.
            </p>
          </div>

          <ol className="space-y-2.5 text-sm text-body">
            <li>
              <span className="label mr-2">1</span>
              Create a project at{' '}
              <a
                className="text-flame-400 underline decoration-flame-400/40 hover:decoration-flame-400"
                href="https://supabase.com/dashboard"
                target="_blank"
                rel="noreferrer"
              >
                supabase.com/dashboard
              </a>
            </li>
            <li>
              <span className="label mr-2">2</span>
              Copy <code className="font-mono text-flame-300">.env.example</code> to{' '}
              <code className="font-mono text-flame-300">.env</code> and fill in the URL and anon key
            </li>
            <li>
              <span className="label mr-2">3</span>
              Run <code className="font-mono text-flame-300">supabase db push</code> to create the
              tables, then restart <code className="font-mono text-flame-300">npm run dev</code>
            </li>
          </ol>

          <p className="text-xs text-muted">
            Full walkthrough in <code className="font-mono">README.md</code>.
          </p>
        </div>
      </div>
    </div>
  )
}
