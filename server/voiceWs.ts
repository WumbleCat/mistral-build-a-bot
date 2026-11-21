/**
 * Server-side Voxtral Realtime transcription proxy.
 *
 * Browser cannot hold the Mistral API key, so the browser streams mic audio
 * to our server over HTTP POST, and this module holds one WebSocket per voice
 * session to Mistral's realtime transcription endpoint:
 *
 *   wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=voxtral-mini-transcribe-realtime-3-0
 *
 * Uses Node 22+ global WebSocket (no extra dependency). Events are relayed to
 * the browser over SSE (GET /api/voice/events), audio goes upstream via
 * POST /api/voice/audio. Sessions are cleaned up on stop or disconnect.
 */

import { randomUUID } from 'node:crypto';

import type { IncomingMessage, ServerResponse } from 'node:http';

const VOXTRAL_RT_MODEL = 'voxtral-mini-transcribe-realtime-3-0';
const SAMPLE_RATE = 24000;

interface VoiceSession {
  id: string;
  ws: WebSocket | null;
  listeners: Set<ServerResponse>;
  createdAt: number;
  closed: boolean;
}

const sessions = new Map<string, VoiceSession>();

function sendToListeners(session: VoiceSession, event: Record<string, unknown>) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of session.listeners) {
    try {
      res.write(payload);
    } catch {
      session.listeners.delete(res);
    }
  }
}

function closeSession(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  s.closed = true;
  try {
    s.ws?.close();
  } catch {
    /* ignore */
  }
  s.ws = null;
  for (const res of s.listeners) {
    try {
      res.write(`data: ${JSON.stringify({ type: 'session.closed' })}\n\n`);
      res.end();
    } catch {
      /* ignore */
    }
  }
  s.listeners.clear();
  sessions.delete(id);
}

/** Open a Voxtral realtime session and wire event relay to SSE listeners. */
function startSession(contextBias: string[], language: string): string {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error('NO_API_KEY');
  const base = (process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai').replace(/\/$/, '').replace(/\/v1$/, '');
  const url = `${base.replace(/^http/, 'ws')}/v1/audio/transcriptions/realtime?model=${VOXTRAL_RT_MODEL}`;
  const id = randomUUID();
  const session: VoiceSession = { id, ws: null, listeners: new Set(), createdAt: Date.now(), closed: false };
  sessions.set(id, session);

  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });
  session.ws = ws;

  ws.onmessage = (ev: MessageEvent) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    // Relay everything the model sends; the client interprets turn/transcription events.
    sendToListeners(session, event);
    if (event.type === 'error') {
      sendToListeners(session, { type: 'session.error', error: (event as { error?: { message?: string } }).error?.message ?? 'unknown' });
    }
  };
  ws.onerror = () => {
    sendToListeners(session, { type: 'session.error', error: 'WebSocket to Voxtral failed. Check MISTRAL_API_KEY and network.' });
  };
  ws.onclose = () => {
    if (!session.closed) closeSession(id);
  };

  // Configure the session before any audio: format, turn detection, context bias, language.
  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        audio_format: { encoding: 'pcm_s16le', sample_rate: SAMPLE_RATE },
        turn_detection: {},
        language: language || 'en',
        ...(contextBias.length > 0 ? { context_bias: contextBias.slice(0, 100) } : {}),
      },
    }));
    sendToListeners(session, { type: 'session.ready', sessionId: id, model: VOXTRAL_RT_MODEL, sampleRate: SAMPLE_RATE });
  };

  return id;
}

export function voiceConfigured(): boolean {
  return Boolean(process.env.MISTRAL_API_KEY);
}

export function voiceModel(): string {
  return VOXTRAL_RT_MODEL;
}

export async function handleVoice(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  readJson: (r: IncomingMessage) => Promise<Record<string, unknown>>,
  sendJson: (r: ServerResponse, s: number, b: unknown) => void,
): Promise<boolean> {
  if (pathname === '/api/voice/start' && req.method === 'POST') {
    if (!voiceConfigured()) {
      sendJson(res, 503, { error: 'Voice (Voxtral Realtime) unavailable: MISTRAL_API_KEY is not configured on the server.', code: 'NO_API_KEY' });
      return true;
    }
    let body: Record<string, unknown> = {};
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body.' });
      return true;
    }
    const bias = Array.isArray(body.context_bias)
      ? body.context_bias.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean)
      : [];
    const language = typeof body.language === 'string' ? body.language : 'en';
    try {
      const sessionId = startSession(bias, language);
      sendJson(res, 200, { sessionId, model: VOXTRAL_RT_MODEL, sampleRate: SAMPLE_RATE });
    } catch (err) {
      sendJson(res, 502, { error: `Could not start voice session: ${(err as Error).message}` });
    }
    return true;
  }

  if (pathname === '/api/voice/audio' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body.' });
      return true;
    }
    const session = sessions.get(String(body.sessionId ?? ''));
    const audio = typeof body.audio === 'string' ? body.audio : '';
    if (!session || !session.ws || session.closed) {
      sendJson(res, 404, { error: 'Unknown or closed voice session.' });
      return true;
    }
    if (audio && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: 'input_audio.append', audio }));
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/api/voice/stop' && req.method === 'POST') {
    let body: Record<string, unknown> = {};
    try {
      body = await readJson(req);
    } catch {
      /* ignore */
    }
    closeSession(String(body.sessionId ?? ''));
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/api/voice/events' && req.method === 'GET') {
    const sessionId = new URL(req.url ?? '', 'http://localhost').searchParams.get('sessionId') ?? '';
    const session = sessions.get(sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'Unknown voice session.' });
      return true;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ type: 'session.attached', sessionId })}\n\n`);
    session.listeners.add(res);
    req.on('close', () => {
      session.listeners.delete(res);
    });
    return true;
  }

  return false;
}
