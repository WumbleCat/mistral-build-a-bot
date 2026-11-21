import type { AssemblyData, AssemblyStep, NormalizeResult, Part, Relationship } from '../types';

/**
 * Input adapter: normalises JSON coming from the other BuildFromVision modules
 * (BOM generation, assembly-step generation) into the canonical AssemblyData
 * shape the frontend components consume. It is intentionally tolerant: missing
 * fields get sensible defaults and upstream text is never rewritten.
 */

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
}

function slugify(text: string, fallback: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

export function normalizeAssembly(raw: unknown): NormalizeResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { data: null, warnings, errors: ['Input is not a JSON object.'] };
  }
  const input = raw as Record<string, unknown>;

  const robotName = asString(input.robot_name) ?? asString(input.robotName) ?? asString(input.name) ?? 'Untitled robot';
  if (robotName === 'Untitled robot') warnings.push('Missing robot name — defaulted to "Untitled robot".');
  const description = asString(input.description) ?? '';

  // ---- parts ----
  const rawParts = Array.isArray(input.parts) ? input.parts : Array.isArray(input.components) ? input.components : Array.isArray(input.bom) ? input.bom : [];
  if (!Array.isArray(input.parts) && rawParts.length > 0) warnings.push('Parts found under a non-standard key — normalised.');

  // Upstream (hein-parts) keeps shop/price data in a separate "bom" array keyed by part_id.
  // Index it so we can enrich the parts list without losing anything.
  const bomIndex = new Map<string, Record<string, unknown>>();
  if (Array.isArray(input.bom)) {
    for (const row of input.bom) {
      if (row && typeof row === 'object') {
        const rid = asString((row as Record<string, unknown>).part_id) ?? asString((row as Record<string, unknown>).id);
        if (rid) bomIndex.set(rid, row as Record<string, unknown>);
      }
    }
  }

  const parts: Part[] = [];
  const usedIds = new Set<string>();
  rawParts.forEach((p, i) => {
    if (!p || typeof p !== 'object') {
      warnings.push(`Part #${i + 1} is not an object and was skipped.`);
      return;
    }
    const rec = p as Record<string, unknown>;
    const name = asString(rec.name) ?? asString(rec.label) ?? `Part ${i + 1}`;
    let id = asString(rec.id) ?? asString(rec.part_id) ?? slugify(name, `part-${i + 1}`);
    if (usedIds.has(id)) {
      id = `${id}-${i + 1}`;
      warnings.push(`Duplicate part id "${id}" — made unique.`);
    }
    usedIds.add(id);
    const quantity = Math.max(1, Math.floor(asNumber(rec.quantity) ?? asNumber(rec.qty) ?? 1));
    // quantity === null in the source means UNKNOWN (not zero/one) — flag it, per the
    // image-analysis provenance convention (display falls back to 1, never 0).
    const quantityUnknown = rec.quantity === null || (rec.quantity === undefined && rec.qty === null);
    // Enrich with shop/price data from the upstream bom array when available.
    const bomRow = bomIndex.get(id);
    parts.push({
      id,
      name,
      quantity,
      quantityUnknown: quantityUnknown || undefined,
      description: asString(rec.description),
      category: asString(rec.category),
      shop: asString(rec.shop) ?? asString(bomRow?.shop),
      url: asString(rec.url) ?? asString(bomRow?.url),
      unit_price: asNumber(rec.unit_price_gbp) ?? asNumber(rec.unit_price) ?? asNumber(bomRow?.unit_price_gbp),
      visible_in_photo: typeof rec.visible_in_photo === 'boolean' ? rec.visible_in_photo : rec.evidence === 'visible' ? true : undefined,
      // Image-analysis provenance — preserved, never dropped or upgraded.
      evidence: asString(rec.evidence),
      source_ids: asStringArray(rec.source_ids ?? rec.sources).length > 0 ? asStringArray(rec.source_ids ?? rec.sources) : undefined,
      sku: rec.sku === null ? null : asString(rec.sku),
      product_url: rec.product_url === null ? null : asString(rec.product_url),
      review_required: typeof rec.review_required === 'boolean' ? rec.review_required : undefined,
      notes: asString(rec.notes),
    });
  });
  if (parts.length === 0) errors.push('No parts list found (expected "parts", "components" or "bom").');

  const partIds = new Set(parts.map((p) => p.id));

  // ---- steps ----
  const rawSteps = Array.isArray(input.steps) ? input.steps : Array.isArray(input.assembly_steps) ? input.assembly_steps : [];
  if (rawSteps.length === 0) errors.push('No assembly steps found (expected "steps").');
  const steps: AssemblyStep[] = [];
  const usedStepIds = new Set<string>();
  const cumulative = new Set<string>();
  rawSteps.forEach((s, i) => {
    if (!s || typeof s !== 'object') {
      warnings.push(`Step #${i + 1} is not an object and was skipped.`);
      return;
    }
    const rec = s as Record<string, unknown>;
    const title = asString(rec.title) ?? asString(rec.name) ?? `Step ${i + 1}`;
    const instruction = asString(rec.instruction) ?? asString(rec.description) ?? asString(rec.action) ?? '';
    if (!instruction) warnings.push(`Step "${title}" has no instruction text.`);
    const narration = asString(rec.narration) ?? asString(rec.voiceover) ?? instruction ?? title;
    if (!asString(rec.narration) && instruction) warnings.push(`Step "${title}" has no narration — using the written instruction as fallback.`);
    // Upstream (hein-parts) uses "n" for the step number and has no explicit id.
    const number = asNumber(rec.number) ?? asNumber(rec.step) ?? asNumber(rec.n) ?? i + 1;
    let id = asString(rec.id) ?? `step-${number}`;
    if (usedStepIds.has(id)) id = `${id}-${i + 1}`;
    usedStepIds.add(id);
    // Upstream uses "parts_used"; classic schema uses "component_ids".
    const componentIds = asStringArray(rec.component_ids ?? rec.components ?? rec.parts ?? rec.parts_used);
    for (const cid of componentIds) {
      if (!partIds.has(cid)) warnings.push(`Step "${title}" references unknown part id "${cid}".`);
    }
    // Preserve upstream tip / tools / anim metadata.
    const tip = asString(rec.tip) ?? asString(rec.warning);
    const tools = asStringArray(rec.tools);
    const animRaw = Array.isArray(rec.anim) ? rec.anim : undefined;
    const anim = animRaw
      ?.filter((a): a is { part_id: string; slot: string } =>
        Boolean(a && typeof a === 'object' && asString((a as Record<string, unknown>).part_id) && asString((a as Record<string, unknown>).slot)),
      )
      .map((a) => ({ part_id: asString((a as Record<string, unknown>).part_id) as string, slot: asString((a as Record<string, unknown>).slot) as string }));
    let installed = asStringArray(rec.installed_components ?? rec.installed);
    if (installed.length === 0) {
      // Fallback: cumulatively install every component mentioned so far.
      for (const cid of componentIds) cumulative.add(cid);
      installed = [...cumulative];
      if (componentIds.length > 0) warnings.push(`Step "${title}" had no installed_components — derived cumulatively.`);
    } else {
      for (const cid of installed) cumulative.add(cid);
    }
    steps.push({
      id,
      number,
      title,
      instruction,
      narration,
      component_ids: componentIds,
      installed_components: installed,
      visual_prompt: asString(rec.visual_prompt) ?? asString(rec.visualPrompt),
      tip,
      tools: tools.length > 0 ? tools : undefined,
      anim: anim && anim.length > 0 ? anim : undefined,
    });
  });

  steps.sort((a, b) => a.number - b.number);
  steps.forEach((s, i) => {
    if (s.number !== i + 1) warnings.push(`Step numbers were not sequential — renumbered "${s.title}" to ${i + 1}.`);
    s.number = i + 1;
  });

  // ---- relationships (component connection map) — optional, validated against part ids ----
  const rawRels = Array.isArray(input.relationships) ? input.relationships : Array.isArray(input.connections) ? input.connections : [];
  const relationships: Relationship[] = [];
  rawRels.forEach((r, i) => {
    if (!r || typeof r !== 'object') {
      warnings.push(`Relationship #${i + 1} is not an object and was skipped.`);
      return;
    }
    const rec = r as Record<string, unknown>;
    const from = asString(rec.from) ?? asString(rec.source) ?? asString(rec.source_id) ?? asString(rec.source_part_id);
    const to = asString(rec.to) ?? asString(rec.target) ?? asString(rec.target_id) ?? asString(rec.target_part_id) ?? asString(rec.destination);
    if (!from || !to) {
      warnings.push(`Relationship #${i + 1} has no from/to and was skipped.`);
      return;
    }
    if (!partIds.has(from)) warnings.push(`Relationship #${i + 1} references unknown part "${from}" — kept but flagged.`);
    if (!partIds.has(to)) warnings.push(`Relationship #${i + 1} references unknown part "${to}" — kept but flagged.`);
    relationships.push({
      id: asString(rec.id) ?? `rel-${i + 1}`,
      from,
      to,
      type: asString(rec.type) ?? asString(rec.relationship) ?? 'related',
      evidence: asString(rec.evidence),
      confidence: (['high', 'medium', 'low'].includes(String(rec.confidence)) ? String(rec.confidence) : undefined) as Relationship['confidence'],
      status: (['visually-confirmed', 'inferred', 'unknown'].includes(String(rec.status)) ? String(rec.status) : 'unknown') as Relationship['status'],
      source_ids: asStringArray(rec.source_ids ?? rec.sources),
    });
  });

  // ---- ensure every part is referenced by at least one assembly step ----
  // Model output occasionally omits inferred parts from every step's component_ids.
  // Associate such parts with the most relevant step (via relationships, else the final
  // step). This only adds a reference: instructions are untouched and the part keeps its
  // own evidence / quantityUnknown / review_required flags.
  const firstStepOfPart = new Map<string, number>();
  steps.forEach((s) => {
    for (const cid of s.component_ids) if (!firstStepOfPart.has(cid)) firstStepOfPart.set(cid, s.number);
  });
  for (const part of parts) {
    if (firstStepOfPart.has(part.id)) continue;
    const linkedStepNumbers = relationships
      .filter((r) => r.from === part.id || r.to === part.id)
      .map((r) => firstStepOfPart.get(r.from === part.id ? r.to : r.from))
      .filter((n): n is number => typeof n === 'number')
      .sort((a, b) => a - b);
    const targetNumber = linkedStepNumbers[0] ?? steps[steps.length - 1]?.number;
    const target = steps.find((s) => s.number === targetNumber);
    if (!target) {
      warnings.push(`Part "${part.id}" is not referenced by any assembly step and no step exists to attach it to.`);
      continue;
    }
    target.component_ids.push(part.id);
    steps.forEach((s) => {
      if (s.number >= target.number && !s.installed_components.includes(part.id)) s.installed_components.push(part.id);
    });
    if (part.evidence === 'inferred' || part.review_required || part.quantityUnknown) target.uncertain = true;
    warnings.push(
      `Part "${part.id}" was not referenced by any step — associated with step ${target.number} ("${target.title}") via ${linkedStepNumbers.length > 0 ? 'a relationship to an installed part' : 'final-step fallback'}.`,
    );
  }

  if (errors.length > 0) return { data: null, warnings, errors };
  return {
    data: {
      robot_name: robotName,
      description,
      parts,
      steps,
      relationships: relationships.length > 0 ? relationships : undefined,
      illustrative: true,
      recipe_id: asString(input.recipe_id),
      confidence: asNumber(input.confidence),
      bom_total: asNumber(input.bom_total_gbp) ?? asNumber(input.bom_total),
      unmatched: Array.isArray(input.unmatched)
        ? input.unmatched.filter((u): u is Record<string, unknown> => Boolean(u && typeof u === 'object')).map((u) => ({
            name: asString(u.name),
            category: asString(u.category),
            qty: asNumber(u.qty),
          }))
        : undefined,
      warnings: asStringArray(input.warnings),
    },
    warnings,
    errors,
  };
}

/** Stable key prefix for per-session caches, so imported datasets never collide. */
export function datasetKey(data: AssemblyData): string {
  const basis = `${data.robot_name}|${data.parts.map((p) => p.id + 'x' + p.quantity).join(',')}|${data.steps.map((s) => s.id).join(',')}`;
  let hash = 0;
  for (let i = 0; i < basis.length; i++) hash = (hash * 31 + basis.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}
