import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { isSupabaseConfigured, supabase } from '../lib/supabase'
import { DEMO, DEMO_USER } from '../lib/demo'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  // In demo mode you are signed in as a guest from the first paint, so the whole
  // app is reachable with no backend. Sign out still works and lands on /signin.
  const [session, setSession] = useState(DEMO ? { user: DEMO_USER } : null)
  const [loading, setLoading] = useState(DEMO ? false : isSupabaseConfigured)

  useEffect(() => {
    if (DEMO || !supabase) return

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null)
      setLoading(false)
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => setSession(next))
    return () => sub.subscription.unsubscribe()
  }, [])

  const value = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      loading,
      isAnonymous: Boolean(session?.user?.is_anonymous),
      configured: isSupabaseConfigured,
      demo: DEMO,

      /** One-click demo access -- no email needed. */
      async signInAnonymously() {
        if (DEMO) {
          const next = { user: DEMO_USER }
          setSession(next)
          return next
        }
        const { data, error } = await supabase.auth.signInAnonymously()
        if (error) throw error
        return data.session
      },

      async signInWithEmail(email) {
        if (DEMO) {
          setSession({ user: { ...DEMO_USER, email, is_anonymous: false } })
          return
        }
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: window.location.origin },
        })
        if (error) throw error
      },

      /** Attach an email to an anonymous account so the builds survive. */
      async linkEmail(email) {
        if (DEMO) {
          setSession((s) => ({ user: { ...s.user, email, is_anonymous: false } }))
          return
        }
        const { error } = await supabase.auth.updateUser({ email })
        if (error) throw error
      },

      async signOut() {
        if (DEMO) {
          setSession(null)
          return
        }
        await supabase.auth.signOut()
      },
    }),
    [session, loading],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
