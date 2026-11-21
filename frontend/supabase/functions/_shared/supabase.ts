import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { HttpError } from './http.ts'

/**
 * Two clients per request:
 *  - `asUser`    respects RLS, used to prove the caller owns the project.
 *  - `asService` bypasses RLS, used for the writes the analyzer performs.
 */
export function clientsFor(req: Request): { asUser: SupabaseClient; asService: SupabaseClient } {
  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const authorization = req.headers.get('Authorization') ?? ''

  if (!authorization) throw new HttpError(401, 'Missing Authorization header')

  return {
    asUser: createClient(url, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    }),
    asService: createClient(url, serviceKey, { auth: { persistSession: false } }),
  }
}

/** Resolve the caller and assert they own `projectId`. */
export async function loadOwnedProject(req: Request, projectId: string) {
  const { asUser, asService } = clientsFor(req)

  const { data: auth, error: authError } = await asUser.auth.getUser()
  if (authError || !auth?.user) throw new HttpError(401, 'Not signed in')

  const { data: project, error } = await asService
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single()

  if (error || !project) throw new HttpError(404, 'Project not found')
  if (project.user_id !== auth.user.id) throw new HttpError(403, 'Not your project')

  return { project, user: auth.user, asService, asUser }
}
