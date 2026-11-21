/**
 * analyze-device
 * -------------
 * Input:  { project_id }
 * Effect: reads the uploaded photo from Storage, sends it to Mistral's vision model,
 *         and writes the device identification, bill of materials, purchase links and
 *         assembly steps back into Postgres. The project row carries the progress.
 */
import { encodeBase64 } from 'jsr:@std/encoding@1/base64'
import { corsHeaders, HttpError, json, preflight } from '../_shared/http.ts'
import { loadOwnedProject } from '../_shared/supabase.ts'
import { visionJson } from '../_shared/mistral.ts'

const BUCKET = 'device-images'

const SYSTEM = `You are a hardware engineer who tears down electronics and devices from
photographs and produces buildable bills of materials.

The subject may be anything built from parts: a circuit board, a camera, a keyboard, a power
bank, a drone, a speaker, a robot, an appliance. Work from what the photograph supports.

Rules:
- Identify only what the image actually supports. Say so in "confidence" when the view is partial.
- Prefer real, commonly stocked parts (ESP32-S3, STM32F103, RP2040, 18650 cells, MX-style
  switches, TPS5430, USB-C receptacles, NEMA 17, HC-SR04) over invented part numbers. Give a
  concrete manufacturer part number wherever the image supports one.
- Price in USD at typical single-unit retail from a distributor such as LCSC, DigiKey, Mouser or
  RS. Never invent product URLs: give a "search_query" that would find the part, and only fill
  "links" for parts whose exact product page you are certain of.
- Cover the whole device: enclosure, PCBs, the significant components on them, connectors,
  display, power, actuators, sensors, fasteners and wiring.
- For a part visible only as a module, list the module, not every passive on it. Do not pad the
  list with every resistor and capacitor; name the ones that matter.
- Assembly steps rebuild the device from those parts, in physical order, each naming what it uses.
- Give every component a rough primitive in "geometry" so the build can be drawn as an exploded
  view. Approximate real dimensions in millimetres from the part you named. Do not supply
  "position_mm" unless you are confident where the part sits; layout is derived from the
  assembly order otherwise.
- Reply with JSON only.`

const SCHEMA_HINT = `Return this exact JSON shape:

{
  "device": {
    "name": "string, e.g. '35mm rangefinder camera' or '3-axis desktop SCARA arm'",
    "summary": "2-3 sentences on what it is and what it does",
    "category": "short noun phrase, e.g. camera | keyboard | single-board computer | power bank | drone | speaker | mobile robot | robotic arm | sensor module | other",
    "difficulty": "beginner | intermediate | advanced",
    "est_build_minutes": 480,
    "skills": ["soldering", "3d printing"],
    "tools": ["hex key set", "soldering iron"],
    "confidence": 0.0,
    "visible_features": ["what in the image led to this identification"],
    "assumptions": ["anything inferred rather than seen"]
  },
  "components": [
    {
      "name": "NEMA 17 stepper motor (42x42x40mm)",
      "category": "pcb | controller | electronics | display | sensor | power | battery | connector | switch | actuator | motor-driver | wheel | gripper | enclosure | chassis | structure | optics | fastener | bearing | wiring | hardware | other",
      "description": "why this part is needed and the spec that matters",
      "quantity": 3,
      "unit_price_usd": 12.5,
      "specs": { "torque": "0.4 Nm", "voltage": "12V" },
      "search_query": "NEMA 17 stepper motor 0.4Nm",
      "substitutes": ["NEMA 17 pancake 1.8 deg"],
      "is_optional": false,
      "geometry": {
        "shape": "box | plate | cylinder | tube | sphere",
        "size_mm": { "x": 42, "y": 42, "z": 40 },
        "rotation_deg": { "x": 0, "y": 0, "z": 0 },
        "finish": "metal | steel | pcb | plastic | rubber | acrylic | copper | gold"
      },
      "links": [{ "retailer": "pololu", "retailer_label": "Pololu", "url": "https://..." }]
    }
  ],
  "assembly_steps": [
    {
      "step_number": 1,
      "title": "Build the base frame",
      "instructions": "Specific, imperative, 2-5 sentences. Reference parts by name.",
      "component_names": ["2020 aluminium extrusion 300mm"],
      "tools": ["hex key set"],
      "tips": "optional short tip",
      "warning": "optional safety note, else null",
      "duration_minutes": 30,
      "video_prompt": "One sentence describing the shot a short demo clip of this step should show."
    }
  ]
}

A "cylinder" or "sphere" uses "size_mm": { "d": 25, "h": 46 } (h omitted for a sphere); a
"tube" adds "inner". Everything else uses x/y/z. Device-level: set "assembly_axis" to the
axis the device stacks along, normally "y".

Produce 8-25 components and 6-14 assembly steps.`

type Analysis = {
  device: {
    name?: string
    summary?: string
    category?: string
    difficulty?: string
    est_build_minutes?: number
    assembly_axis?: string
    skills?: string[]
    tools?: string[]
    confidence?: number
    visible_features?: string[]
    assumptions?: string[]
  }
  components?: Array<{
    name?: string
    category?: string
    description?: string
    quantity?: number
    unit_price_usd?: number
    specs?: Record<string, unknown>
    search_query?: string
    substitutes?: string[]
    is_optional?: boolean
    geometry?: Record<string, unknown>
    links?: Array<{ retailer?: string; retailer_label?: string; url?: string; price_usd?: number }>
  }>
  assembly_steps?: Array<{
    step_number?: number
    title?: string
    instructions?: string
    component_names?: string[]
    tools?: string[]
    tips?: string | null
    warning?: string | null
    duration_minutes?: number
    video_prompt?: string
  }>
}

const cents = (usd: unknown): number | null =>
  typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? Math.round(usd * 100) : null

const DIFFICULTIES = new Set(['beginner', 'intermediate', 'advanced'])

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre

  let projectId: string | undefined
  let asService: Awaited<ReturnType<typeof loadOwnedProject>>['asService'] | undefined

  try {
    const body = await req.json().catch(() => ({}))
    projectId = body.project_id
    if (!projectId) throw new HttpError(400, 'project_id is required')

    const owned = await loadOwnedProject(req, projectId)
    const { project } = owned
    asService = owned.asService

    await asService
      .from('projects')
      .update({ status: 'analyzing', error: null })
      .eq('id', projectId)

    // ---------------------------------------------------- image -> data URL
    const { data: blob, error: downloadError } = await asService.storage
      .from(BUCKET)
      .download(project.image_path)
    if (downloadError || !blob) {
      throw new HttpError(404, `Could not read the uploaded image: ${downloadError?.message}`)
    }

    const bytes = new Uint8Array(await blob.arrayBuffer())
    if (bytes.byteLength > 9_000_000) {
      throw new HttpError(413, 'Image is too large for the vision model. Upload one under 9 MB.')
    }
    const mime = blob.type && blob.type !== 'application/json' ? blob.type : 'image/jpeg'
    const dataUrl = `data:${mime};base64,${encodeBase64(bytes)}`

    // ---------------------------------------------------------- vision call
    const promptParts = [
      'Identify the device in this photo, break it down into its parts, and produce a complete build plan for it.',
      project.notes ? `The person adds this context: "${project.notes}".` : null,
      SCHEMA_HINT,
    ].filter(Boolean)

    const { data: analysis, model } = await visionJson<Analysis>({
      system: SYSTEM,
      prompt: promptParts.join('\n\n'),
      dataUrl,
      maxTokens: 8000,
    })

    const device = analysis.device ?? {}
    const rawComponents = (analysis.components ?? []).filter((c) => c?.name)
    const rawSteps = (analysis.assembly_steps ?? []).filter((s) => s?.title && s?.instructions)

    if (!rawComponents.length) {
      throw new HttpError(
        422,
        'No components could be identified. Try a clearer, closer photo of the whole device.',
      )
    }

    // Replace any previous analysis for this project (retry path).
    await asService.from('components').delete().eq('project_id', projectId)
    await asService.from('assembly_steps').delete().eq('project_id', projectId)

    // ------------------------------------------------------ components rows
    const componentRows = rawComponents.map((c, i) => ({
      project_id: projectId,
      name: String(c.name).slice(0, 200),
      category: c.category ? String(c.category).toLowerCase().slice(0, 40) : 'other',
      description: c.description ?? null,
      quantity: Math.max(1, Math.round(Number(c.quantity) || 1)),
      unit_price_cents: cents(c.unit_price_usd),
      currency: 'USD',
      specs: c.specs && typeof c.specs === 'object' ? c.specs : {},
      search_query: c.search_query ?? String(c.name),
      substitutes: Array.isArray(c.substitutes) ? c.substitutes.slice(0, 5).map(String) : [],
      is_optional: Boolean(c.is_optional),
      geometry: c.geometry && typeof c.geometry === 'object' ? c.geometry : null,
      sort_order: i,
    }))

    const { data: inserted, error: componentError } = await asService
      .from('components')
      .insert(componentRows)
      .select('id, sort_order')
    if (componentError) throw new HttpError(500, componentError.message)

    const idBySortOrder = new Map(inserted!.map((r) => [r.sort_order, r.id]))

    // -------------------------------------------------- purchase link rows
    const linkRows = rawComponents.flatMap((c, i) =>
      (c.links ?? [])
        .filter((l) => l?.url && /^https:\/\//.test(l.url))
        .slice(0, 3)
        .map((l) => ({
          component_id: idBySortOrder.get(i)!,
          project_id: projectId!,
          retailer: (l.retailer ?? 'vendor').toLowerCase().slice(0, 40),
          retailer_label: l.retailer_label ?? l.retailer ?? 'Vendor',
          url: l.url!,
          price_cents: cents(l.price_usd),
        })),
    )
    if (linkRows.length) await asService.from('component_links').insert(linkRows)

    // ------------------------------------------------------- assembly steps
    // Sort by whatever order the model gave, then renumber 1..n so the unique
    // (project_id, step_number) constraint can never be violated by a repeat.
    const stepRows = rawSteps
      .map((s, i) => ({ step: s, order: Number(s.step_number) > 0 ? Number(s.step_number) : i + 1 }))
      .sort((a, b) => a.order - b.order)
      .slice(0, 20)
      .map(({ step: s }, i) => ({
        project_id: projectId,
        step_number: i + 1,
        title: String(s.title).slice(0, 200),
        instructions: String(s.instructions),
        component_names: Array.isArray(s.component_names) ? s.component_names.map(String) : [],
        tools: Array.isArray(s.tools) ? s.tools.map(String) : [],
        tips: s.tips || null,
        warning: s.warning || null,
        duration_minutes: Number(s.duration_minutes) > 0 ? Math.round(Number(s.duration_minutes)) : null,
        video_prompt: s.video_prompt ?? null,
      }))

    if (stepRows.length) {
      const { error: stepError } = await asService.from('assembly_steps').insert(stepRows)
      if (stepError) throw new HttpError(500, stepError.message)
    }

    // -------------------------------------------------------- project rollup
    const totalCents = componentRows.reduce(
      (sum, c) => sum + (c.unit_price_cents ?? 0) * c.quantity,
      0,
    )
    const difficulty =
      device.difficulty && DIFFICULTIES.has(String(device.difficulty).toLowerCase())
        ? String(device.difficulty).toLowerCase()
        : null

    const { error: updateError } = await asService
      .from('projects')
      .update({
        status: 'ready',
        device_name: device.name ?? 'Unidentified device',
        device_summary: device.summary ?? null,
        device_category: device.category ?? null,
        difficulty,
        est_build_minutes:
          Number(device.est_build_minutes) > 0 ? Math.round(Number(device.est_build_minutes)) : null,
        assembly_axis: ['x', 'y', 'z'].includes(String(device.assembly_axis))
          ? String(device.assembly_axis)
          : 'y',
        skills: Array.isArray(device.skills) ? device.skills.map(String) : [],
        tools: Array.isArray(device.tools) ? device.tools.map(String) : [],
        total_cost_cents: totalCents || null,
        confidence:
          typeof device.confidence === 'number' ? Math.min(1, Math.max(0, device.confidence)) : null,
        analysis: {
          visible_features: device.visible_features ?? [],
          assumptions: device.assumptions ?? [],
        },
        model,
        error: null,
      })
      .eq('id', projectId)
    if (updateError) throw new HttpError(500, updateError.message)

    return json({
      project_id: projectId,
      status: 'ready',
      components: componentRows.length,
      steps: stepRows.length,
      total_cost_cents: totalCents,
      model,
    })
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500
    const message = error instanceof Error ? error.message : 'Unexpected error'
    console.error('analyze-device failed', message)

    if (projectId && asService) {
      await asService
        .from('projects')
        .update({ status: 'failed', error: message.slice(0, 500) })
        .eq('id', projectId)
    }
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
