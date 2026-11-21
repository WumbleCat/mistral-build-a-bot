import type { AssemblyData, AssemblyStep } from '../types';

/**
 * Optional AI illustration client. Calls the server-side /api/image route
 * (Mistral image-generation agent when MISTRAL_IMAGE_AGENT_ID is configured,
 * or a direct image model). Results are cached per step for the session.
 * When unavailable the UI simply uses the SVG diagrams.
 */

export interface ImageResult {
  url?: string;
  dataUrl?: string;
  error?: string;
}

const cache = new Map<string, ImageResult>();
let checked = false;
let available = false;

export async function imageGenerationAvailable(): Promise<boolean> {
  if (checked) return available;
  try {
    const res = await fetch('/api/health');
    if (res.ok) {
      const h = (await res.json()) as { image?: boolean };
      available = Boolean(h.image);
    }
  } catch {
    available = false;
  }
  checked = true;
  return available;
}

export function clearImageCache() {
  cache.clear();
  checked = false;
}

/** Consistent illustration style across all stages (per project brief). */
export function buildStepPrompt(data: AssemblyData, step: AssemblyStep, partsById: Map<string, { name: string; quantity: number }>): string {
  const adding = step.component_ids
    .map((id) => partsById.get(id))
    .filter((p): p is { name: string; quantity: number } => Boolean(p))
    .map((p) => `${p.name}${p.quantity > 1 ? ` (x${p.quantity})` : ''}`)
    .join(', ');
  const installed = step.installed_components
    .filter((id) => !step.component_ids.includes(id))
    .map((id) => partsById.get(id)?.name)
    .filter((n): n is string => Boolean(n))
    .join(', ');
  return [
    'Clean technical product illustration of a small robot assembly stage.',
    `Robot: ${data.robot_name}${data.description ? ` — ${data.description}` : ''}.`,
    `Already assembled (shown in neutral grey): ${installed || 'nothing yet'}.`,
    `Being added in this step (highlighted in a single accent colour, clearly separated): ${adding || 'none'}.`,
    step.visual_prompt ? `Stage: ${step.visual_prompt}` : '',
    'Style: minimalist isometric or slightly elevated view, white or very light background, realistic but simplified mechanical components, soft shadows.',
    'No text, no numbers, no labels, no watermark embedded in the image — all annotations are rendered by the app.',
  ]
    .filter(Boolean)
    .join(' ');
}

export async function generateStepImage(cacheKey: string, prompt: string): Promise<ImageResult> {
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  try {
    const res = await fetch('/api/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    if (res.ok) {
      const json = (await res.json()) as ImageResult;
      const result: ImageResult = json.url || json.dataUrl ? json : { error: 'Empty image response.' };
      cache.set(cacheKey, result);
      return result;
    }
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    const result: ImageResult = { error: detail?.error ?? `Image request failed (HTTP ${res.status}).` };
    cache.set(cacheKey, result);
    return result;
  } catch (err) {
    const result: ImageResult = { error: `Image service unreachable: ${(err as Error).message}` };
    cache.set(cacheKey, result);
    return result;
  }
}
