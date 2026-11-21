import { fetchWithRetry, HttpError } from './http.ts'

const ENDPOINT = 'https://api.mistral.ai/v1/chat/completions'

export const VISION_MODEL = Deno.env.get('MISTRAL_VISION_MODEL') ?? 'pixtral-large-latest'
export const TEXT_MODEL = Deno.env.get('MISTRAL_TEXT_MODEL') ?? 'mistral-large-latest'

function apiKey(): string {
  const key = Deno.env.get('MISTRAL_API_KEY')
  if (!key) {
    throw new HttpError(
      500,
      'MISTRAL_API_KEY is not set. Run: supabase secrets set MISTRAL_API_KEY=...',
    )
  }
  return key
}

type Content = string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: string }>
type Message = { role: 'system' | 'user' | 'assistant'; content: Content }

async function complete(opts: {
  model: string
  messages: Message[]
  jsonMode?: boolean
  temperature?: number
  maxTokens?: number
}): Promise<string> {
  const res = await fetchWithRetry(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 6000,
      ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  })

  if (!res.ok) throw new HttpError(res.status, `Mistral API error: ${await res.text()}`)

  const payload = await res.json()
  const text = payload?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || !text.trim()) {
    throw new HttpError(502, 'Mistral returned an empty completion')
  }
  return text
}

/** Ask the vision model about an image and parse the JSON it returns. */
export async function visionJson<T>(opts: {
  system: string
  prompt: string
  dataUrl: string
  maxTokens?: number
}): Promise<{ data: T; model: string }> {
  const text = await complete({
    model: VISION_MODEL,
    jsonMode: true,
    maxTokens: opts.maxTokens,
    messages: [
      { role: 'system', content: opts.system },
      {
        role: 'user',
        content: [
          { type: 'text', text: opts.prompt },
          { type: 'image_url', image_url: opts.dataUrl },
        ],
      },
    ],
  })
  return { data: parseJson<T>(text), model: VISION_MODEL }
}

/** Plain text completion, used to turn an assembly step into a video prompt. */
export async function textCompletion(opts: {
  system: string
  prompt: string
  maxTokens?: number
  temperature?: number
}): Promise<string> {
  return (
    await complete({
      model: TEXT_MODEL,
      maxTokens: opts.maxTokens ?? 400,
      temperature: opts.temperature ?? 0.4,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.prompt },
      ],
    })
  ).trim()
}

/** JSON mode is reliable but not guaranteed; strip fences and trailing prose if present. */
export function parseJson<T>(text: string): T {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    return JSON.parse(cleaned) as T
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as T
    }
    throw new HttpError(502, 'Could not parse JSON from the model response')
  }
}
