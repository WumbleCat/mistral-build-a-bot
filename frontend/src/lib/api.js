/**
 * Data access.
 *
 * Every function here has two paths: the real Supabase call, and a demo shim
 * (see `demo.js`) used when no backend is connected. The components never know
 * which one they got, so the UI can be built and styled before the backend exists.
 */
import { IMAGE_BUCKET, requireSupabase } from './supabase'
import { DEMO, demoApi } from './demo'
import { describeError } from './errors'
import { titleFromFilename } from './format'

const PROJECT_SELECT = '*'
const FULL_SELECT = `
  *,
  components:components(*, component_links:component_links(*)),
  assembly_steps:assembly_steps(*),
  videos:videos(*)
`

/* ------------------------------------------------------------------ uploads */

/** Upload the source photo to Storage and return its object path. */
export async function uploadDeviceImage(file, userId) {
  const sb = requireSupabase()
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
  const path = `${userId}/${crypto.randomUUID()}.${ext}`

  const { error } = await sb.storage.from(IMAGE_BUCKET).upload(path, file, {
    cacheControl: '3600',
    contentType: file.type || 'image/jpeg',
    upsert: false,
  })
  if (error) throw error
  return path
}

/** Signed URL for a private storage object (1 hour). */
export async function signedImageUrl(path, expiresIn = 3600) {
  if (!path) return null
  if (DEMO) return demoApi.signedImageUrl(path)

  const sb = requireSupabase()
  const { data, error } = await sb.storage.from(IMAGE_BUCKET).createSignedUrl(path, expiresIn)
  if (error) return null
  return data.signedUrl
}

/* ----------------------------------------------------------------- projects */

/**
 * Create the project row, then kick off the vision analysis edge function.
 * The function returns immediately; progress is tracked on the project row.
 */
export async function createProject({ file, userId, title, notes }) {
  if (DEMO) return demoApi.createProject({ file, title, notes })

  const sb = requireSupabase()
  const imagePath = await uploadDeviceImage(file, userId)

  const { data: project, error } = await sb
    .from('projects')
    .insert({
      user_id: userId,
      title: title?.trim() || titleFromFilename(file.name),
      notes: notes?.trim() || null,
      image_path: imagePath,
      status: 'queued',
    })
    .select(PROJECT_SELECT)
    .single()
  if (error) throw error

  // Fire-and-forget so the caller can navigate straight to the project page.
  // The function writes its own failures to the row; a failure to *reach* it never
  // gets that chance, so record that here or the project sits at 'queued' forever.
  sb.functions
    .invoke('analyze-device', { body: { project_id: project.id } })
    .then(({ error }) => {
      if (error) throw error
    })
    .catch(async (e) => {
      console.error('analyze-device invoke failed', e)
      await sb
        .from('projects')
        .update({ status: 'failed', error: describeError(e).slice(0, 500) })
        .eq('id', project.id)
    })

  return project
}

export async function listProjects() {
  if (DEMO) return demoApi.listProjects()

  const sb = requireSupabase()
  const { data, error } = await sb
    .from('projects')
    .select(
      'id, title, status, device_name, image_path, total_cost_cents, currency, component_count, created_at',
    )
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function getProject(id) {
  if (DEMO) return demoApi.getProject(id)

  const sb = requireSupabase()
  const { data, error } = await sb.from('projects').select(FULL_SELECT).eq('id', id).single()
  if (error) throw error

  data.components = (data.components ?? []).sort((a, b) => a.sort_order - b.sort_order)
  data.assembly_steps = (data.assembly_steps ?? []).sort((a, b) => a.step_number - b.step_number)
  return data
}

export async function deleteProject(id) {
  if (DEMO) return demoApi.deleteProject(id)

  const sb = requireSupabase()
  const { error } = await sb.from('projects').delete().eq('id', id)
  if (error) throw error
}

export async function retryAnalysis(projectId) {
  if (DEMO) return demoApi.retryAnalysis(projectId)

  const sb = requireSupabase()
  const { error } = await sb
    .from('projects')
    .update({ status: 'queued', error: null })
    .eq('id', projectId)
  if (error) throw error
  await sb.functions.invoke('analyze-device', { body: { project_id: projectId } })
}

/** Live updates for one project (row changes + child-table inserts). */
export function subscribeToProject(projectId, onChange) {
  if (DEMO) return demoApi.subscribeToProject(projectId, onChange)

  const sb = requireSupabase()
  const channel = sb.channel(`project:${projectId}`)

  const tables = ['projects', 'components', 'assembly_steps', 'videos']
  for (const table of tables) {
    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table,
        filter: table === 'projects' ? `id=eq.${projectId}` : `project_id=eq.${projectId}`,
      },
      onChange,
    )
  }

  channel.subscribe()
  return () => sb.removeChannel(channel)
}

/* ------------------------------------------------------------------- videos */

/** Request a clip for one assembly step, or the full walkthrough when stepId is null. */
export async function requestVideo({ projectId, stepId = null, kind = 'step' }) {
  if (DEMO) return demoApi.requestVideo({ projectId, stepId, kind })

  const sb = requireSupabase()
  const { data, error } = await sb.functions.invoke('generate-video', {
    body: { project_id: projectId, step_id: stepId, kind },
  })
  if (error) throw error
  return data
}

/** Check on an in-flight provider job. */
export async function pollVideo({ projectId, stepId = null, kind = 'step' }) {
  if (DEMO) return demoApi.pollVideo({ projectId, stepId, kind })

  const sb = requireSupabase()
  const { data, error } = await sb.functions.invoke('generate-video', {
    body: { project_id: projectId, step_id: stepId, kind, action: 'poll' },
  })
  if (error) throw error
  return data
}

/* ------------------------------------------------------------------ exports */

export function bomToCsv(project) {
  const rows = [
    ['Part', 'Category', 'Qty', 'Unit price', 'Line total', 'Specs', 'Search query'],
    ...project.components.map((c) => [
      c.name,
      c.category ?? '',
      c.quantity,
      c.unit_price_cents != null ? (c.unit_price_cents / 100).toFixed(2) : '',
      c.unit_price_cents != null ? ((c.unit_price_cents * c.quantity) / 100).toFixed(2) : '',
      c.description ?? '',
      c.search_query ?? '',
    ]),
  ]
  return rows
    .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n')
}

export function downloadCsv(filename, csv) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
