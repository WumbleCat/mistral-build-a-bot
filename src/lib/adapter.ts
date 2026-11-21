import type { AssemblyData, AssemblyStep, NormalizeResult, Part } from '../types';

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
    parts.push({ id, name, quantity, description: asString(rec.description) });
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
    let id = asString(rec.id) ?? `${slugify(title, `step-${i + 1}`)}`;
    if (usedStepIds.has(id)) id = `${id}-${i + 1}`;
    usedStepIds.add(id);
    const number = asNumber(rec.number) ?? asNumber(rec.step) ?? i + 1;
    const componentIds = asStringArray(rec.component_ids ?? rec.components ?? rec.parts);
    for (const cid of componentIds) {
      if (!partIds.has(cid)) warnings.push(`Step "${title}" references unknown part id "${cid}".`);
    }
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
    });
  });

  steps.sort((a, b) => a.number - b.number);
  steps.forEach((s, i) => {
    if (s.number !== i + 1) warnings.push(`Step numbers were not sequential — renumbered "${s.title}" to ${i + 1}.`);
    s.number = i + 1;
  });

  if (errors.length > 0) return { data: null, warnings, errors };
  return {
    data: {
      robot_name: robotName,
      description,
      parts,
      steps,
      illustrative: true,
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
