/**
 * generate-video
 * --------------
 * Input:  { project_id, step_id?, kind: 'step' | 'walkthrough', action?: 'create' | 'poll' }
 *
 * Writes a `videos` row and drives it to ready. Mistral turns the written assembly step into
 * a shot description, which is then sent to the configured video model.
 *
 * VIDEO_PROVIDER=mock (the default) skips the vendor call and stores the shot description only,
 * so the whole product is demoable with just a Mistral key. The UI renders those as storyboards.
 */
import { fetchWithRetry, HttpError, json, preflight } from '../_shared/http.ts'
import { loadOwnedProject } from '../_shared/supabase.ts'
import { textCompletion } from '../_shared/mistral.ts'

const PROVIDER = (Deno.env.get('VIDEO_PROVIDER') ?? 'mock').toLowerCase()

const PROMPT_SYSTEM = `You write shot descriptions for short instructional 3D-animation clips about
assembling hardware and electronics. One paragraph, max 60 words. Describe camera, parts in frame, and the single
motion being demonstrated. Fixed camera on a clean workbench, soft studio light, no people talking,
no text overlays. Output the description only.`

type VideoResult = {
  status: 'queued' | 'generating' | 'ready' | 'failed'
  video_url?: string | null
  thumbnail_url?: string | null
  provider_job_id?: string | null
  error?: string | null
}

/* --------------------------------------------------------------- providers */

async function startReplicate(prompt: string): Promise<VideoResult> {
  const token = Deno.env.get('REPLICATE_API_TOKEN')
  if (!token) throw new HttpError(500, 'REPLICATE_API_TOKEN is not set')
  const model = Deno.env.get('REPLICATE_VIDEO_MODEL') ?? 'wan-video/wan-2.5-t2v-fast'

  const res = await fetchWithRetry(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      // Wait inline for up to 55s; longer jobs fall through to polling.
      Prefer: 'wait=55',
    },
    body: JSON.stringify({ input: { prompt, duration: 5 } }),
  })
  if (!res.ok) throw new HttpError(res.status, `Replicate error: ${await res.text()}`)

  const job = await res.json()
  return normalizeReplicate(job)
}

function normalizeReplicate(job: {
  id?: string
  status?: string
  output?: unknown
  error?: string
}): VideoResult {
  const url = Array.isArray(job.output) ? job.output.at(-1) : job.output
  if (job.status === 'succeeded' && typeof url === 'string') {
    return { status: 'ready', video_url: url, provider_job_id: job.id ?? null }
  }
  if (job.status === 'failed' || job.status === 'canceled') {
    return { status: 'failed', error: job.error ?? 'Video generation failed', provider_job_id: job.id ?? null }
  }
  return { status: 'generating', provider_job_id: job.id ?? null }
}

async function pollReplicate(jobId: string): Promise<VideoResult> {
  const token = Deno.env.get('REPLICATE_API_TOKEN')!
  const res = await fetchWithRetry(`https://api.replicate.com/v1/predictions/${jobId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new HttpError(res.status, `Replicate error: ${await res.text()}`)
  return normalizeReplicate(await res.json())
}

async function startLuma(prompt: string): Promise<VideoResult> {
  const key = Deno.env.get('LUMA_API_KEY')
  if (!key) throw new HttpError(500, 'LUMA_API_KEY is not set')

  const res = await fetchWithRetry('https://api.lumalabs.ai/dream-machine/v1/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, model: 'ray-flash-2', resolution: '720p', duration: '5s' }),
  })
  if (!res.ok) throw new HttpError(res.status, `Luma error: ${await res.text()}`)

  const job = await res.json()
  return { status: 'generating', provider_job_id: job.id ?? null }
}

async function pollLuma(jobId: string): Promise<VideoResult> {
  const key = Deno.env.get('LUMA_API_KEY')!
  const res = await fetchWithRetry(`https://api.lumalabs.ai/dream-machine/v1/generations/${jobId}`, {
    headers: { Authorization: `Bearer ${key}` },
  })
  if (!res.ok) throw new HttpError(res.status, `Luma error: ${await res.text()}`)

  const job = await res.json()
  if (job.state === 'completed' && job.assets?.video) {
    return { status: 'ready', video_url: job.assets.video, thumbnail_url: job.assets.image ?? null }
  }
  if (job.state === 'failed') {
    return { status: 'failed', error: job.failure_reason ?? 'Video generation failed' }
  }
  return { status: 'generating', provider_job_id: jobId }
}

function startVideo(prompt: string): Promise<VideoResult> {
  switch (PROVIDER) {
    case 'replicate':
      return startReplicate(prompt)
    case 'luma':
      return startLuma(prompt)
    default:
      // Storyboard-only mode: the shot description is the deliverable.
      return Promise.resolve({ status: 'ready', video_url: null })
  }
}

function pollVideo(jobId: string): Promise<VideoResult> {
  switch (PROVIDER) {
    case 'replicate':
      return pollReplicate(jobId)
    case 'luma':
      return pollLuma(jobId)
    default:
      return Promise.resolve({ status: 'ready', video_url: null })
  }
}

/* ----------------------------------------------------------------- handler */

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre

  try {
    const body = await req.json().catch(() => ({}))
    const { project_id: projectId, step_id: stepId = null, action = 'create' } = body
    const kind: 'step' | 'walkthrough' = body.kind === 'walkthrough' ? 'walkthrough' : 'step'

    if (!projectId) throw new HttpError(400, 'project_id is required')
    if (kind === 'step' && !stepId) throw new HttpError(400, 'step_id is required for a step clip')

    const { project, asService } = await loadOwnedProject(req, projectId)

    const existingQuery = asService.from('videos').select('*').eq('project_id', projectId)
    const { data: existing } = stepId
      ? await existingQuery.eq('step_id', stepId).maybeSingle()
      : await existingQuery.eq('kind', 'walkthrough').maybeSingle()

    /* ------------------------------------------------------------- polling */
    if (action === 'poll') {
      if (!existing) throw new HttpError(404, 'No video job for that step yet')
      if (existing.status !== 'generating' || !existing.provider_job_id) return json(existing)

      const result = await pollVideo(existing.provider_job_id)
      const { data: updated } = await asService
        .from('videos')
        .update({
          status: result.status,
          video_url: result.video_url ?? existing.video_url,
          thumbnail_url: result.thumbnail_url ?? existing.thumbnail_url,
          error: result.error ?? null,
        })
        .eq('id', existing.id)
        .select('*')
        .single()
      return json(updated)
    }

    /* -------------------------------------------------------- idempotency */
    if (existing && ['generating', 'ready'].includes(existing.status)) return json(existing)

    /* ------------------------------------------------------ build a prompt */
    let prompt: string

    if (kind === 'walkthrough') {
      const { data: steps } = await asService
        .from('assembly_steps')
        .select('step_number, title, instructions')
        .eq('project_id', projectId)
        .order('step_number')

      const outline = (steps ?? [])
        .map((s) => `${s.step_number}. ${s.title}: ${s.instructions}`)
        .join('\n')

      prompt = await textCompletion({
        system: PROMPT_SYSTEM,
        prompt:
          `Write one shot description for a time-lapse build montage of "${project.device_name ?? project.title}" ` +
          `assembling itself from loose parts to finished device, touching each stage in order.\n\n${outline}`,
        maxTokens: 300,
      })
    } else {
      const { data: step } = await asService
        .from('assembly_steps')
        .select('*')
        .eq('id', stepId)
        .single()
      if (!step) throw new HttpError(404, 'Assembly step not found')

      prompt =
        step.video_prompt ||
        (await textCompletion({
          system: PROMPT_SYSTEM,
          prompt:
            `Robot: ${project.device_name ?? project.title}\n` +
            `Step ${step.step_number}: ${step.title}\n` +
            `Instructions: ${step.instructions}\n` +
            `Parts in frame: ${(step.component_names ?? []).join(', ') || 'as described'}`,
        }))
    }

    /* ----------------------------------------------- create / reset the row */
    const baseRow = {
      project_id: projectId,
      step_id: kind === 'step' ? stepId : null,
      kind,
      status: 'generating' as const,
      provider: PROVIDER,
      prompt,
      error: null,
      video_url: null,
      thumbnail_url: null,
    }

    const { data: row, error: upsertError } = existing
      ? await asService.from('videos').update(baseRow).eq('id', existing.id).select('*').single()
      : await asService.from('videos').insert(baseRow).select('*').single()
    if (upsertError) throw new HttpError(500, upsertError.message)

    /* -------------------------------------------------------- call provider */
    try {
      const result = await startVideo(prompt)
      const { data: finished } = await asService
        .from('videos')
        .update({
          status: result.status,
          video_url: result.video_url ?? null,
          thumbnail_url: result.thumbnail_url ?? null,
          provider_job_id: result.provider_job_id ?? null,
          duration_seconds: result.status === 'ready' && result.video_url ? 5 : null,
          error: result.error ?? null,
        })
        .eq('id', row.id)
        .select('*')
        .single()
      return json(finished)
    } catch (providerError) {
      const message = providerError instanceof Error ? providerError.message : 'Provider failed'
      await asService
        .from('videos')
        .update({ status: 'failed', error: message.slice(0, 500) })
        .eq('id', row.id)
      throw providerError
    }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500
    const message = error instanceof Error ? error.message : 'Unexpected error'
    console.error('generate-video failed', message)
    return json({ error: message }, status)
  }
})
