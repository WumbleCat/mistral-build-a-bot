/**
 * Server-side API routes for the Assembly Studio, mounted as Vite dev/preview
 * middleware so that secrets (MISTRAL_API_KEY) never reach the browser bundle.
 *
 * Routes:
 *   GET  /api/health   -> which optional integrations are configured
 *   POST /api/tts      -> Mistral Voxtral TTS (POST /v1/audio/speech, voxtral-mini-tts-3-0)
 *   POST /api/image    -> optional Mistral image-generation agent / image model
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const BASE_URL = (process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1').replace(/\/$/, '');
const TTS_MODEL = 'voxtral-mini-tts-3-0';

// In-memory caches for the lifetime of the dev server (avoid repeat API calls).
const ttsCache = new Map<string, { contentType: string; bytes: Buffer }>();
const imageCache = new Map<string, unknown>();

export function apiConfigured() {
  return {
    tts: Boolean(process.env.MISTRAL_API_KEY),
    image: Boolean(process.env.MISTRAL_IMAGE_AGENT_ID || process.env.MISTRAL_IMAGE_MODEL),
    ttsModel: TTS_MODEL,
  };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readBody(req)).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

async function handleTts(req: IncomingMessage, res: ServerResponse) {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) {
    sendJson(res, 503, {
      error: 'TTS unavailable: MISTRAL_API_KEY is not configured on the server. The app will fall back to browser speech synthesis.',
      code: 'NO_API_KEY',
    });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body.' });
    return;
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    sendJson(res, 400, { error: 'Missing "text" field.' });
    return;
  }
  const voice = typeof body.voice === 'string' && body.voice ? body.voice : undefined;
  const cacheKey = createHash('sha256').update(`${TTS_MODEL}|${voice ?? ''}|${text}`).digest('hex');
  const cached = ttsCache.get(cacheKey);
  if (cached) {
    res.writeHead(200, { 'Content-Type': cached.contentType, 'X-Cache': 'hit' });
    res.end(cached.bytes);
    return;
  }
  try {
    const upstream = await fetch(`${BASE_URL}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(voice ? { model: TTS_MODEL, input: text, voice } : { model: TTS_MODEL, input: text }),
    });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      sendJson(res, upstream.status === 401 ? 502 : upstream.status, {
        error: `Mistral TTS request failed (${upstream.status}).`,
        detail: detail.slice(0, 500),
      });
      return;
    }
    const contentType = upstream.headers.get('content-type') || 'audio/mpeg';
    const bytes = Buffer.from(await upstream.arrayBuffer());
    ttsCache.set(cacheKey, { contentType, bytes });
    res.writeHead(200, { 'Content-Type': contentType, 'X-Cache': 'miss' });
    res.end(bytes);
  } catch (err) {
    sendJson(res, 502, { error: `Could not reach Mistral TTS: ${(err as Error).message}` });
  }
}

function extractImageFromAgentContent(content: unknown): { url?: string; dataUrl?: string } | null {
  // Agent responses may embed images as markdown, raw URLs, or structured blocks.
  const urls: string[] = [];
  const collect = (value: unknown): { dataUrl: string } | null => {
    if (typeof value === 'string') {
      const found = value.match(/https?:\/\/[^\s)"']+\.(?:png|jpe?g|webp|gif)(\?[^\s)"']*)?/gi);
      if (found) urls.push(...found);
      const data = value.match(/data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=\s]+/);
      if (data) return { dataUrl: data[0] };
    } else if (Array.isArray(value)) {
      for (const v of value) {
        const r: { dataUrl: string } | null = collect(v);
        if (r) return r;
      }
    } else if (value && typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) {
        const r: { dataUrl: string } | null = collect(v);
        if (r) return r;
      }
    }
    return null;
  };
  const dataHit = collect(content);
  if (dataHit) return dataHit;
  if (urls.length > 0) return { url: urls[0] };
  return null;
}

async function handleImage(req: IncomingMessage, res: ServerResponse) {
  const key = process.env.MISTRAL_API_KEY;
  const agentId = process.env.MISTRAL_IMAGE_AGENT_ID;
  const imageModel = process.env.MISTRAL_IMAGE_MODEL;
  if (!key || (!agentId && !imageModel)) {
    sendJson(res, 503, {
      error: 'Image generation unavailable: set MISTRAL_API_KEY plus MISTRAL_IMAGE_AGENT_ID or MISTRAL_IMAGE_MODEL on the server. The app will use SVG diagrams.',
      code: 'NO_IMAGE_CONFIG',
    });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body.' });
    return;
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    sendJson(res, 400, { error: 'Missing "prompt" field.' });
    return;
  }
  const cacheKey = createHash('sha256').update(prompt).digest('hex');
  const cached = imageCache.get(cacheKey);
  if (cached) {
    sendJson(res, 200, cached);
    return;
  }
  try {
    let result: { url?: string; dataUrl?: string } | null = null;
    if (agentId) {
      const upstream = await fetch(`${BASE_URL}/agents/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, inputs: prompt }),
      });
      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => '');
        sendJson(res, 502, { error: `Mistral agent request failed (${upstream.status}).`, detail: detail.slice(0, 500) });
        return;
      }
      const json = (await upstream.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
      result = extractImageFromAgentContent(json.choices?.[0]?.message?.content);
    } else if (imageModel) {
      const upstream = await fetch(`${BASE_URL}/images/generations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: imageModel, prompt }),
      });
      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => '');
        sendJson(res, 502, { error: `Mistral image request failed (${upstream.status}).`, detail: detail.slice(0, 500) });
        return;
      }
      const json = (await upstream.json()) as { data?: Array<{ url?: string; b64_json?: string }> };
      const first = json.data?.[0];
      result = first?.url ? { url: first.url } : first?.b64_json ? { dataUrl: `data:image/png;base64,${first.b64_json}` } : null;
    }
    if (!result) {
      sendJson(res, 502, { error: 'The image service returned no image. Falling back to SVG diagrams is recommended.' });
      return;
    }
    imageCache.set(cacheKey, result);
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 502, { error: `Could not reach Mistral image service: ${(err as Error).message}` });
  }
}

/** Route handler for /api/* — returns true if the request was handled. */
export async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, apiConfigured());
    return true;
  }
  if (pathname === '/api/tts' && req.method === 'POST') {
    await handleTts(req, res);
    return true;
  }
  if (pathname === '/api/image' && req.method === 'POST') {
    await handleImage(req, res);
    return true;
  }
  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: `Unknown API route: ${pathname}` });
    return true;
  }
  return false;
}
