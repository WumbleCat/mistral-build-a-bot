/**
 * Server-side API routes for the Assembly Studio, mounted as Vite dev/preview
 * middleware so that secrets (MISTRAL_API_KEY) never reach the browser bundle.
 *
 * Routes:
 *   GET  /api/health          -> which optional integrations are configured
 *   POST /api/tts             -> Mistral Voxtral TTS (POST /v1/audio/speech, voxtral-mini-tts-3-0)
 *   POST /api/image           -> optional Mistral image-generation agent / image model
 *   POST /api/chat            -> context-aware assembly assistant (Mistral chat completions)
 *   POST /api/upstream/bom    -> proxy to the hein-parts FastAPI service (avoids CORS, keeps URL server-side)
 *   GET  /api/upstream/search -> proxy to the same service's live-offer search (shopping list)
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleAgent } from './agent';
import { handleVoice, voiceConfigured, voiceModel } from './voiceWs';
import { handleGenerate } from './generate';

const BASE_URL = (process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1').replace(/\/$/, '');
const TTS_MODEL = 'voxtral-mini-tts-3-0';
// Voxtral TTS requires a voice; default preset, overridable via env.
const TTS_VOICE = process.env.MISTRAL_TTS_VOICE || 'gb_jane_neutral';

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
  const voice = typeof body.voice === 'string' && body.voice.trim() ? body.voice.trim() : TTS_VOICE;
  const cacheKey = createHash('sha256').update(`${TTS_MODEL}|${voice}|${text}`).digest('hex');
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
      body: JSON.stringify({ model: TTS_MODEL, input: text, voice, response_format: 'mp3' }),
    });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      sendJson(res, upstream.status === 401 ? 502 : upstream.status, {
        error: `Mistral TTS request failed (${upstream.status}).`,
        detail: detail.slice(0, 500),
      });
      return;
    }
    // The REST endpoint returns JSON {"audio_data": "<base64 mp3>"}; decode it to raw bytes.
    const raw = Buffer.from(await upstream.arrayBuffer());
    let bytes = raw;
    const contentType = upstream.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(raw.toString('utf8')) as { audio_data?: string };
        if (parsed.audio_data) bytes = Buffer.from(parsed.audio_data, 'base64');
      } catch {
        /* fall through with raw bytes */
      }
    }
    ttsCache.set(cacheKey, { contentType: 'audio/mpeg', bytes });
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'X-Cache': 'miss' });
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

const CHAT_MODEL = process.env.MISTRAL_CHAT_MODEL || 'mistral-medium-latest';

const chatCache = new Map<string, string>();

/** Context-aware assembly assistant: grounded chat over the current workbook state. */
async function handleChat(req: IncomingMessage, res: ServerResponse) {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) {
    sendJson(res, 503, {
      error: 'Assistant unavailable: MISTRAL_API_KEY is not configured on the server.',
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
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m && (m as { role?: string }).role === 'user') as
    | { content?: unknown }
    | undefined;
  const question = typeof lastUser?.content === 'string' ? lastUser.content.trim() : '';
  if (!question) {
    sendJson(res, 400, { error: 'Missing user question.' });
    return;
  }
  const cacheKey = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
  const cached = chatCache.get(cacheKey);
  if (cached) {
    sendJson(res, 200, { answer: cached, model: CHAT_MODEL, cached: true });
    return;
  }
  const systemPrompt = [
    'You are the BuildFromVision assembly assistant — a practical, safety-conscious helper inside an interactive assembly manual.',
    'Ground every answer in the supplied robot data, BOM, current step instructions, tips and conversation history below.',
    'Rules:',
    '- Refer to actual component names and ids from the data when relevant.',
    '- Never invent dimensions, positions, orientations, screw sizes, electrical specifications or mechanical requirements.',
    '- If the supplied information does not establish something, say so clearly ("The instructions do not specify…").',
    '- Distinguish between what the instructions confirm and general suggestions.',
    '- Never claim an assembly is mechanically or electrically safe based on incomplete information.',
    '- Keep answers concise (2-5 sentences), practical and easy to follow.',
    '- The current step and installed components are given in the context; adapt to them.',
  ].join('\n');
  const apiMessages = [{ role: 'system', content: systemPrompt }, ...messages.slice(-12).map((m) => ({
    role: (m as { role?: string }).role === 'assistant' ? 'assistant' : 'user',
    content: String((m as { content?: unknown }).content ?? ''),
  }))];
  try {
    const upstream = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: CHAT_MODEL, messages: apiMessages, temperature: 0.3, max_tokens: 400 }),
    });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      sendJson(res, upstream.status === 401 ? 502 : upstream.status, {
        error: `Assistant request failed (${upstream.status}).`,
        detail: detail.slice(0, 500),
      });
      return;
    }
    const json = (await upstream.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const answer = json.choices?.[0]?.message?.content?.trim() || '';
    if (!answer) {
      sendJson(res, 502, { error: 'The assistant returned an empty answer.' });
      return;
    }
    chatCache.set(cacheKey, answer);
    sendJson(res, 200, { answer, model: CHAT_MODEL });
  } catch (err) {
    sendJson(res, 502, { error: `Could not reach the assistant service: ${(err as Error).message}` });
  }
}

/** Proxy to the hein-parts FastAPI service so the browser never talks to it directly (no CORS, URL stays server-side). */
async function handleUpstreamBom(req: IncomingMessage, res: ServerResponse) {
  const base = (process.env.HEIN_PARTS_URL || 'http://localhost:8000').replace(/\/$/, '');
  let body: Record<string, unknown> = {};
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body.' });
    return;
  }
  const smart = body.smart === true;
  const path = smart ? '/api/match/smart' : '/api/match';
  try {
    const upstream = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ components: body.components ?? [], owned: body.owned ?? [] }),
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      sendJson(res, upstream.status, { error: `Parts service returned ${upstream.status}.`, detail: text.slice(0, 500) });
      return;
    }
    // Pass through the raw JSON so the frontend adapter normalises it.
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(text);
  } catch (err) {
    sendJson(res, 502, {
      error: `Could not reach the parts service at ${base}. Start it with: cd backend && uvicorn main:app --port 8000`,
      detail: (err as Error).message,
    });
  }
}

/** Proxy to the parts service's live-offer search (best effort; the shopping list works without it). */
async function handleUpstreamSearch(req: IncomingMessage, res: ServerResponse) {
  const base = (process.env.HEIN_PARTS_URL || 'http://localhost:8000').replace(/\/$/, '');
  const q = new URL(req.url || '', 'http://localhost').searchParams.get('q')?.trim() ?? '';
  if (!q || q.length > 200) {
    sendJson(res, 400, { error: 'Query "q" is required (max 200 characters).' });
    return;
  }
  try {
    const upstream = await fetch(`${base}/api/search?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(4000) });
    const text = await upstream.text();
    if (!upstream.ok) {
      sendJson(res, upstream.status, { error: `Parts service returned ${upstream.status}.`, detail: text.slice(0, 500) });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(text);
  } catch (err) {
    sendJson(res, 502, { error: `Could not reach the parts service at ${base}.`, detail: (err as Error).message });
  }
}

/** Route handler for /api/* — returns true if the request was handled. */
export async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ...apiConfigured(), chat: Boolean(process.env.MISTRAL_API_KEY), agent: Boolean(process.env.MISTRAL_API_KEY), voice: voiceConfigured(), voiceModel: voiceModel() });
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
  if (pathname === '/api/chat' && req.method === 'POST') {
    await handleChat(req, res);
    return true;
  }
  if (pathname === '/api/agent' && req.method === 'POST') {
    await handleAgent(req, res, readJson, sendJson);
    return true;
  }
  if (pathname === '/api/generate' && req.method === 'POST') {
    await handleGenerate(req, res, readJson, sendJson);
    return true;
  }
  if (pathname.startsWith('/api/voice/')) {
    return await handleVoice(req, res, pathname, readJson, sendJson);
  }
  if (pathname === '/api/upstream/bom' && req.method === 'POST') {
    await handleUpstreamBom(req, res);
    return true;
  }
  if (pathname === '/api/upstream/search' && req.method === 'GET') {
    await handleUpstreamSearch(req, res);
    return true;
  }
  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: `Unknown API route: ${pathname}` });
    return true;
  }
  return false;
}
