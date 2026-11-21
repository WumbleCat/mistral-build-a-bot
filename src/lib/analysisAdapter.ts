import type { Part } from '../types';

/**
 * Adapter for the image-analysis / component-detection JSON schema — a
 * DIFFERENT schema from the hein-parts BOM output. It converts the detected
 * component array into the internal BuildFromVision model without discarding
 * provenance (source_ids, evidence, review flags, null quantities).
 *
 * Input entry shape (array of these, or {"components": [...]}):
 *   { name, category, quantity (number|null), evidence ("visible"|"inferred"|...),
 *     source_ids: string[], sku, product_url, review_required, notes, ...extra }
 */

export interface ComponentAnalysis {
  name: string;
  category?: string;
  /** number, or null = unknown (NOT zero, NOT one) */
  quantity?: number | null;
  evidence?: string;
  source_ids?: string[];
  sku?: string | null;
  product_url?: string | null;
  review_required?: boolean;
  notes?: string;
  [key: string]: unknown; // preserve tolerance for extra fields
}

export interface AnalysisValidation {
  components: ComponentAnalysis[];
  errors: string[];
  warnings: string[];
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function slugify(text: string, fallback: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || fallback;
}

/** Parse + validate the raw analysis JSON (bare array or {components:[...]}). */
export function validateAnalysis(raw: unknown): AnalysisValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  let arr: unknown = raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    arr = (raw as Record<string, unknown>).components ?? (raw as Record<string, unknown>).detections;
    if (!Array.isArray(arr)) {
      errors.push('Expected a JSON array of components, or an object with a "components" array.');
      return { components: [], errors, warnings };
    }
  }
  if (!Array.isArray(arr)) {
    errors.push('Input is not a JSON array of detected components.');
    return { components: [], errors, warnings };
  }
  if (arr.length === 0) errors.push('The component array is empty.');
  const components: ComponentAnalysis[] = [];
  const usedIds = new Set<string>();
  arr.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      warnings.push(`Entry #${i + 1} is not an object and was skipped.`);
      return;
    }
    const rec = entry as Record<string, unknown>;
    const name = asString(rec.name) ?? asString(rec.label) ?? asString(rec.description);
    if (!name) {
      warnings.push(`Entry #${i + 1} has no "name" and was skipped.`);
      return;
    }
    let qty: number | null | undefined = undefined;
    if (rec.quantity === null) qty = null; // unknown — preserved as null
    else if (typeof rec.quantity === 'number' && Number.isFinite(rec.quantity)) qty = Math.max(0, Math.floor(rec.quantity));
    else if (typeof rec.quantity === 'string' && rec.quantity.trim() !== '') {
      const n = Number(rec.quantity);
      qty = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
    }
    if (rec.quantity !== null && qty === undefined) warnings.push(`Component "${name}": quantity is not a number — treated as unknown (null).`);
    const rawIds = Array.isArray(rec.source_ids) ? rec.source_ids : Array.isArray(rec.sources) ? rec.sources : [];
    const sourceIds: string[] = (rawIds as unknown[])
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s) => s.trim());
    const idFromSource = sourceIds[0] ? slugify(sourceIds[0], '') : '';
    let id = asString(rec.id) ?? (idFromSource || slugify(name, `part-${i + 1}`));
    if (usedIds.has(id)) id = `${id}-${i + 1}`;
    usedIds.add(id);
    const c: ComponentAnalysis = {
      ...rec,
      name,
      category: asString(rec.category),
      quantity: qty,
      evidence: asString(rec.evidence),
      source_ids: sourceIds,
      sku: rec.sku == null ? null : asString(rec.sku) ?? String(rec.sku),
      product_url: asString(rec.product_url) ?? asString(rec.url) ?? null,
      review_required: rec.review_required === true,
      notes: asString(rec.notes) ?? asString(rec.note),
    };
    if (c.evidence && !['visible', 'inferred'].includes(c.evidence)) warnings.push(`Component "${name}": evidence "${c.evidence}" is not "visible"/"inferred" — preserved as-is.`);
    components.push(c);
  });
  return { components, errors, warnings };
}

/**
 * Map a validated component to an internal Part, preserving provenance.
 * quantity null -> quantityUnknown: true (display quantity falls back to 1 but
 * is always flagged as unknown downstream).
 */
export function analysisToPart(c: ComponentAnalysis, index: number): Part {
  const quantityUnknown = c.quantity === null || c.quantity === undefined;
  return {
    id: slugify(c.name, `part-${index + 1}`),
    name: c.name,
    quantity: quantityUnknown ? 1 : Math.max(1, c.quantity as number),
    category: c.category,
    description: c.notes,
    evidence: c.evidence,
    source_ids: c.source_ids,
    sku: c.sku ?? null,
    product_url: c.product_url ?? null,
    review_required: c.review_required === true,
    notes: c.notes,
    quantityUnknown,
    visible_in_photo: c.evidence === 'visible',
  };
}

export function analysisToParts(components: ComponentAnalysis[]): Part[] {
  const used = new Set<string>();
  return components.map((c, i) => {
    const p = analysisToPart(c, i);
    if (used.has(p.id)) p.id = `${p.id}-${i + 1}`;
    used.add(p.id);
    return p;
  });
}

/** One-line provenance summary used in agent/assistant context and UI. */
export function provenanceLine(p: Part): string {
  const bits: string[] = [];
  if (p.evidence) bits.push(`evidence: ${p.evidence}`);
  if (p.review_required) bits.push('REVIEW REQUIRED');
  if (p.quantityUnknown) bits.push('quantity unknown');
  else bits.push(`qty ${p.quantity}`);
  if (p.source_ids?.length) bits.push(`sources: ${p.source_ids.join(',')}`);
  return bits.join(' · ');
}
