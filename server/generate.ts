/**
 * POST /api/generate — turns a robot photograph + component-analysis JSON into
 * a BuildFromVision workbook using a vision-capable Mistral model.
 *
 * The photo and the JSON travel together as one input package. The model sees
 * the image (image_url content part) and the full component inventory, and must
 * return strict JSON matching the internal workbook schema, which is then
 * validated/normalised through the SAME adapter the rest of the app uses
 * (src/lib/adapter.ts), so the output drops straight into the existing
 * workbook / walkthrough / agent. Analysis provenance (evidence, source_ids,
 * review flags, null quantities) is merged back so nothing is lost.
 */

import { createHash } from 'node:crypto';

import type { IncomingMessage, ServerResponse } from 'node:http';

import { normalizeAssembly } from '../src/lib/adapter';
import { validateAnalysis, type ComponentAnalysis } from '../src/lib/analysisAdapter';
import type { AssemblyData } from '../src/types';

const VISION_MODEL = process.env.MISTRAL_VISION_MODEL || 'mistral-large-latest';

const SYSTEM_PROMPT = `You are the BuildFromVision assembly-generation model. You receive (1) a photograph of a robot and (2) a JSON array of components detected/inferred by an image-analysis model. Produce a BuildFromVision workbook as STRICT JSON only (no markdown fences, no commentary).

HARD ACCURACY RULES:
- A single photo of an assembled robot does NOT reveal the original construction order, hidden parts, or exact wiring. Treat the proposed assembly sequence as a PROPOSAL, not a verified manufacturer instruction.
- Distinguish visually confirmed facts (evidence "visible") from inferences (evidence "inferred"). NEVER upgrade an inferred component to confirmed.
- NEVER invent wiring connections, pin assignments, voltage ratings, motor specs, dimensions, SKUs or product URLs. If unknown, omit or set null.
- quantity null in the input means UNKNOWN — keep it null in your output parts, never 0 or 1.
- Preserve every input component: keep its name, category, evidence, source_ids, sku, product_url, review_required, notes. Add a stable "id" (slug of the name). Do not drop components and do not double-count duplicates.
- Where the photo and the JSON disagree, or evidence is insufficient, add an entry to top-level "warnings" and set "review_required": true on the affected part and "uncertain": true on affected steps.
- Include battery/electrical safety notes as step "safety" fields where relevant.
- Steps must reference part ids from the parts array via "component_ids", and "installed_components" must be cumulative.
- Suggested top-level "tools" array lists tools/materials needed.
- Also produce a "relationships" array: the component relationship & connection map.
  Each entry: { "from": partId, "to": partId, "type": one of "mounted-on"|"attached-to"|"above"|"beneath"|"mechanically-connected"|"adjacent"|"wired-to",
  "evidence": what in the photo/JSON supports it, "confidence": "high"|"medium"|"low",
  "status": "visually-confirmed"|"inferred"|"unknown", "source_ids"?: [...] }.
  Physical relationships (mounted on, above/beneath, adjacent, mechanically connected) come from the photograph's layout.
  "wired-to" ONLY when a wire is visibly running between two components — never assume crossing wires connect; never invent pin assignments, polarity or voltage. If a connection cannot be established from the photo, set status "unknown" and say what needs checking.

OUTPUT SCHEMA (strict JSON):
{
  "robot_name": string,
  "description": string,
  "parts": [{ "id", "name", "quantity" (number|null), "category"?, "evidence"?, "source_ids"?, "sku"?, "product_url"?, "review_required"?, "notes"? }],
  "steps": [{ "number", "title", "instruction", "narration"?, "component_ids": [ids], "installed_components": [ids], "tip"?, "tools"?, "uncertain"?, "safety"? }],
  "relationships": [{ "from", "to", "type", "evidence"?, "confidence"?, "status", "source_ids"? }],
  "tools": [strings],
  "warnings": [strings]
}`;

const genCache = new Map<string, unknown>();

function sendToLog(msg: string) {
  console.log(`[generate] ${msg}`);
}

export async function handleGenerate(
  req: IncomingMessage,
  res: ServerResponse,
  readJson: (r: IncomingMessage) => Promise<Record<string, unknown>>,
  sendJson: (r: ServerResponse, s: number, b: unknown) => void,
): Promise<void> {
  const key = process.env.MISTRAL_API_KEY;
  const baseUrl = (process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1').replace(/\/$/, '');
  if (!key) {
    sendJson(res, 503, { error: 'Generation unavailable: MISTRAL_API_KEY is not configured on the server.', code: 'NO_API_KEY' });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body.' });
    return;
  }
  const imageDataUrl = typeof body.imageDataUrl === 'string' ? body.imageDataUrl : '';
  if (!imageDataUrl.startsWith('data:image/')) {
    sendJson(res, 400, { error: 'Missing or invalid "imageDataUrl" (expected a data:image/... URL).' });
    return;
  }
  const validation = validateAnalysis(body.components);
  if (validation.errors.length > 0 || validation.components.length === 0) {
    sendJson(res, 400, { error: 'Component analysis JSON is invalid.', errors: validation.errors, warnings: validation.warnings });
    return;
  }
  const components = validation.components;

  const cacheKey = createHash('sha256').update(imageDataUrl.slice(0, 200000) + JSON.stringify(components)).digest('hex');
  const cached = genCache.get(cacheKey);
  if (cached) {
    sendJson(res, 200, { ...(cached as object), cached: true });
    return;
  }

  const userText = [
    'Here is the component-analysis JSON (detected/inferred components from an image-analysis model). Use it as the structured component inventory.',
    'Cross-check it against the photograph: note agreements, discrepancies, and anything visible in the photo but missing from the JSON.',
    JSON.stringify(components, null, 1),
    '',
    'Now return the BuildFromVision workbook JSON per the schema. Strict JSON only.',
  ].join('\n');

  try {
    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 16384,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: [
            { type: 'text', text: userText },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ] },
        ],
      }),
    });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      sendJson(res, upstream.status === 401 ? 502 : upstream.status, { error: `Vision model request failed (${upstream.status}).`, detail: detail.slice(0, 400) });
      return;
    }
    const json = (await upstream.json()) as { choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }> };
    const rawContent = json.choices?.[0]?.message?.content ?? '';
    // Vision/thinking models may return an array of content parts — flatten text parts.
    let text = typeof rawContent === 'string'
      ? rawContent
      : rawContent.map((p) => p.text ?? '').join('\n');
    // Strip markdown fences if present and extract the JSON object.
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) text = fence[1];
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) {
      sendJson(res, 502, { error: 'The model did not return JSON.', raw: text.slice(0, 400) });
      return;
    }
    let parsed: unknown;
    const slice = text.slice(start, end + 1);
    try {
      parsed = JSON.parse(slice);
    } catch (err) {
      // Tolerant repair: the model may be truncated by the token cap mid-element.
      // Cut at the last comma before the error position, then close open brackets.
      const msg = (err as Error).message;
      const posMatch = msg.match(/position (\d+)/);
      const errPos = posMatch ? Number(posMatch[1]) : slice.length;
      const cut = slice.lastIndexOf(',', Math.min(errPos, slice.length - 1));
      if (cut > 0) {
        let candidate = slice.slice(0, cut);
        const stack: string[] = [];
        let inStr = false;
        for (const ch of candidate) {
          if (ch === '"' && !inStr) inStr = true;
          else if (ch === '"' && inStr) inStr = false;
          else if (!inStr && (ch === '{' || ch === '[')) stack.push(ch === '{' ? '}' : ']');
          else if (!inStr && (ch === '}' || ch === ']')) stack.pop();
        }
        candidate += stack.reverse().join('');
        try {
          parsed = JSON.parse(candidate);
          sendToLog(`generate: repaired truncated model JSON (cut at ${cut})`);
        } catch {
          sendJson(res, 502, { error: `Model JSON did not parse: ${msg}`, raw: slice.slice(0, 400) });
          return;
        }
      } else {
        sendJson(res, 502, { error: `Model JSON did not parse: ${msg}`, raw: slice.slice(0, 400) });
        return;
      }
    }

    // Validate/normalise through the shared adapter so the output is guaranteed
    // to fit the existing workbook/walkthrough/agent contracts.
    const result = normalizeAssembly(parsed);
    if (!result.data) {
      sendJson(res, 422, { error: 'Model output failed validation.', errors: result.errors, warnings: result.warnings });
      return;
    }
    const data = result.data as AssemblyData;

    // Merge analysis provenance back into parts (by id match, then by name) so
    // evidence/source_ids/review flags/null quantities are never lost.
    const byId = new Map<string, ComponentAnalysis>();
    const byName = new Map<string, ComponentAnalysis>();
    for (const c of components) {
      const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      byName.set(c.name.toLowerCase(), c);
      if (slug) byId.set(slug, c);
    }
    for (const p of data.parts) {
      const c = byId.get(p.id) ?? byName.get(p.name.toLowerCase());
      if (c) {
        p.evidence = c.evidence ?? p.evidence;
        p.source_ids = c.source_ids ?? p.source_ids;
        p.sku = c.sku ?? p.sku ?? null;
        p.product_url = c.product_url ?? p.product_url ?? null;
        p.review_required = c.review_required === true || p.review_required;
        p.notes = c.notes ?? p.notes;
        if (c.quantity === null || c.quantity === undefined) p.quantityUnknown = true;
        if (c.evidence === 'visible') p.visible_in_photo = true;
      }
    }
    data.photo = imageDataUrl; // session-only, for display + provenance
    data.review_flags = data.parts.filter((p) => p.review_required || p.evidence === 'inferred').map((p) => p.id);
    if (Array.isArray((parsed as Record<string, unknown>).warnings)) data.warnings = (parsed as Record<string, unknown>).warnings as string[];
    if (Array.isArray((parsed as Record<string, unknown>).tools)) data.tools = (parsed as Record<string, unknown>).tools as string[];

    const payload = { data, warnings: result.warnings, validationWarnings: validation.warnings, model: VISION_MODEL };
    genCache.set(cacheKey, payload);
    sendJson(res, 200, payload);
  } catch (err) {
    // Node's fetch reports network errors and timeouts as "fetch failed"; the real reason is in `cause`.
    const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
    const why = cause ? ` (${[cause.code, cause.message].filter(Boolean).join(': ')})` : '';
    sendToLog(`generation failed: ${(err as Error).message}${why}`);
    sendJson(res, 502, { error: `Generation failed: ${(err as Error).message}${why}` });
  }
}
