/**
 * Client for the robot_bom Python pipeline (src/robot_bom/api.py).
 *
 * The pipeline owns the photo -> bill of materials logic. This module only calls
 * it (through the Vite proxy at /bom, see vite.config.ts) and reshapes its
 * output into the component-analysis format that /api/generate takes.
 */

import type { ComponentAnalysis } from './analysisAdapter';

const BASE = '/bom';

// ---- the parts of the pipeline's JSON this app reads (see robot_bom/models.py) ----

export type EvidenceType = 'observed' | 'inferred' | 'unknown';

export interface BomEvidence {
  image_id: string;
  description: string;
}

export interface BomComponent {
  id: string;
  category: string;
  name: string;
  evidence_type: EvidenceType;
  evidence: BomEvidence[];
  visible_quantity: number | null;
  required_quantity: number | null;
  purchase_quantity: number | null;
  confidence: number | null;
  manufacturer: string | null;
  model: string | null;
  sku: string | null;
  specs: Record<string, string>;
  status: 'needs_review' | 'confirmed' | 'rejected';
  notes: string[];
  assumed_fields?: string[];
}

export interface BomIssue {
  severity: 'critical' | 'warning' | 'info';
  component_ids: string[];
  message: string;
  resolved?: boolean;
}

export interface BomCatalogCandidate {
  component_id: string;
  vendor: string;
  title: string;
  sku: string | null;
  price: number | null;
  currency: string | null;
  product_url: string;
  match_score: number | null;
}

export interface RobotBom {
  project_name: string;
  components: BomComponent[];
  issues: BomIssue[];
  catalog_candidates: BomCatalogCandidate[];
  metadata: Record<string, string>;
}

/** review.json: the BOM plus bookkeeping the pipeline needs back unchanged. */
export interface ReviewDocument {
  bom: RobotBom;
  [key: string]: unknown;
}

export interface AnalyzeResult {
  job_id: string;
  bom: RobotBom;
  review: ReviewDocument;
}

export interface InferResult {
  review: ReviewDocument;
  order_links?: { components?: Array<{ name: string; products?: Array<{ url: string }>; links?: Record<string, string> }> };
  [key: string]: unknown;
}

export interface PipelineHealth {
  status: string;
  api_key_configured: boolean;
  vision_model: string;
  mock_default: boolean;
}

// ---- calls ----

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, init);
  } catch {
    throw new Error(PIPELINE_DOWN);
  }
  const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
  if (!res.ok) {
    // The Vite proxy answers 502/504 with no JSON when the Python server is not running.
    if (!body && (res.status === 502 || res.status === 503 || res.status === 504)) throw new Error(PIPELINE_DOWN);
    const detail = body?.detail;
    const text = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : `HTTP ${res.status}`;
    throw new Error(text);
  }
  return body as T;
}

export const PIPELINE_DOWN =
  'The photo analysis service is not running. Start it with `npm run dev` (starts both servers) or `npm run bom-api`.';

/** null when the Python server is not reachable. */
export async function pipelineHealth(): Promise<PipelineHealth | null> {
  try {
    return await call<PipelineHealth>('/health');
  } catch {
    return null;
  }
}

/** POST /analyze — the same request the pipeline's own web page sends. */
export function analyzePhotos(files: File[], opts: { projectName?: string; mock?: boolean } = {}): Promise<AnalyzeResult> {
  const data = new FormData();
  for (const f of files) data.append('images', f);
  data.append('project_name', opts.projectName?.trim() || 'robot');
  data.append('mock', opts.mock ? 'true' : 'false');
  return call<AnalyzeResult>('/analyze', { method: 'POST', body: data });
}

/** POST /infer — the "AI best guess" step the pipeline's web page runs right after /analyze. */
export function inferBestGuess(analysis: AnalyzeResult, opts: { mock?: boolean } = {}): Promise<InferResult> {
  return call<InferResult>('/infer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: analysis.job_id, review: analysis.review, model: null, mock: Boolean(opts.mock) }),
  });
}

// ---- reshaping for /api/generate ----

function quantityOf(c: BomComponent): number | null {
  return c.purchase_quantity ?? c.required_quantity ?? c.visible_quantity ?? null;
}

/**
 * Turn the pipeline's BOM into the component-analysis list /api/generate takes.
 * Nothing is upgraded: only "observed" parts become "visible"; rejected parts are dropped.
 */
export function bomToComponents(bom: RobotBom): ComponentAnalysis[] {
  const openIssues = new Set(
    bom.issues.filter((i) => !i.resolved && i.severity !== 'info').flatMap((i) => i.component_ids),
  );
  const bestLink = new Map<string, BomCatalogCandidate>();
  for (const cand of bom.catalog_candidates) {
    const prev = bestLink.get(cand.component_id);
    if (!prev || (cand.match_score ?? 0) > (prev.match_score ?? 0)) bestLink.set(cand.component_id, cand);
  }

  return bom.components
    .filter((c) => c.status !== 'rejected')
    .map((c) => {
      const link = bestLink.get(c.id);
      const specs = Object.entries(c.specs ?? {}).map(([k, v]) => `${k}: ${v}`);
      const made = [c.manufacturer, c.model].filter(Boolean).join(' ');
      const notes = [
        made && `Identified as ${made}.`,
        ...c.notes,
        specs.length ? `Specs: ${specs.join(', ')}.` : '',
        c.assumed_fields?.length ? `Assumed, not seen: ${c.assumed_fields.join(', ')}.` : '',
        ...c.evidence.map((e) => `Seen in ${e.image_id}: ${e.description}`),
      ].filter(Boolean);
      return {
        name: c.name,
        category: c.category,
        quantity: quantityOf(c),
        evidence: c.evidence_type === 'observed' ? 'visible' : 'inferred',
        source_ids: [c.id],
        sku: c.sku ?? link?.sku ?? null,
        product_url: link?.product_url ?? null,
        review_required:
          c.status !== 'confirmed' && (c.evidence_type !== 'observed' || Boolean(c.assumed_fields?.length) || openIssues.has(c.id)),
        notes: notes.join(' '),
        confidence: c.confidence,
      };
    });
}
