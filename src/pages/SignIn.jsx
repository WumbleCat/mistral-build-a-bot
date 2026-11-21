import { useState } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'
import { ArrowRight, LoaderCircle, Mail, Sparkles } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import ConfigNotice from '../components/ConfigNotice'
import { describeError } from '../lib/errors'

export default function SignIn() {
  const { user, signInWithEmail, signInAnonymously, configured, demo } = useAuth()
  const { state } = useLocation()

  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  if (!configured && !demo) return <ConfigNotice />
  if (user) return <Navigate to={state?.from ?? '/builds'} replace />

  async function handleEmail(event) {
    event.preventDefault()
    setBusy('email')
    setError(null)
    try {
      await signInWithEmail(email.trim())
      setSent(true)
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(null)
    }
  }

  async function handleGuest() {
    setBusy('guest')
    setError(null)
    try {
      await signInAnonymously()
    } catch (e) {
      setError(describeError(e))
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold tracking-tight">Sign in</h1>
        <p className="mt-1.5 text-sm text-ink-400">
          Your builds, bills of materials and generated videos stay on your account.
        </p>
      </div>

      <div className="card space-y-5 p-6">
        {sent ? (
          <div className="space-y-3 text-center">
            <span className="mx-auto grid size-11 place-items-center rounded-2xl bg-mint-400/15 text-mint-400">
              <Mail className="size-5" />
            </span>
            <h2 className="font-semibold">Check your inbox</h2>
            <p className="text-sm text-ink-400">
              We sent a sign-in link to <span className="text-ink-100">{email}</span>. Open it on this
              device.
            </p>
            <button type="button" className="btn-ghost w-full" onClick={() => setSent(false)}>
              Use a different email
            </button>
          </div>
        ) : (
          <>
            <form onSubmit={handleEmail} className="space-y-3">
              <label className="space-y-1.5">
                <span className="label">Email</span>
                <input
                  type="email"
                  required
                  className="input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                />
              </label>
              <button type="submit" className="btn-primary w-full" disabled={busy === 'email'}>
                {busy === 'email' ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Mail className="size-4" />
                )}
                Send a magic link
              </button>
            </form>

            <div className="flex items-center gap-3 text-[11px] uppercase tracking-wider text-ink-400">
              <span className="h-px flex-1 bg-ink-800" />
              or
              <span className="h-px flex-1 bg-ink-800" />
            </div>

            <button
              type="button"
              className="btn-ghost w-full"
              onClick={handleGuest}
              disabled={busy === 'guest'}
            >
              {busy === 'guest' ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              Continue as a guest
            </button>

            {error && <p className="text-sm text-flame-300">{error}</p>}
          </>
        )}
      </div>

      <p className="text-center text-sm text-ink-400">
        <Link to="/" className="inline-flex items-center gap-1 text-flame-400 hover:text-flame-300">
          Skip and upload a photo
          <ArrowRight className="size-3.5" />
        </Link>
      </p>
    </div>
  )
}
