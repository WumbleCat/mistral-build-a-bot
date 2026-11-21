/**
 * Deterministic schematic exploded-view SVG for a generated workbook.
 *
 * The teardown skill produces hand-crafted exploded views offline for the
 * sample robot. For an uploaded robot photo + component JSON there is no
 * pre-baked asset, so we build a schematic exploded column directly from the
 * generated workbook data (parts + relationship map). This costs milliseconds
 * (no extra AI calls) and every part group carries data-item="<part id>" so
 * the existing step highlighting (bfv-active / bfv-installed / bfv-pending)
 * works unchanged in the workbook and guided walkthrough.
 *
 * ACCURACY: vertical order follows first appearance in the assembly steps;
 * horizontal position is schematic only. Nothing here is a verified dimension
 * or engineering position — the SVG says so explicitly.
 */

import type { AssemblyData, Part, Relationship } from '../src/types';

const W = 680;
const HEADER_H = 96;
const NODE_W = 460;
const NODE_H = 58;
const GAP = 34;
const TOP = HEADER_H + 20;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Rounded-rect path (used so .bfv-active path stroke rules apply). */
function rectPath(cx: number, cy: number, w: number, h: number, r: number): string {
  return `M ${cx - w / 2 + r} ${cy - h / 2} h ${w - 2 * r} a ${r} ${r} 0 0 1 ${r} ${r} v ${h - 2 * r} a ${r} ${r} 0 0 1 -${r} ${r} h -${w - 2 * r} a ${r} ${r} 0 0 1 -${r} -${r} v -${h - 2 * r} a ${r} ${r} 0 0 1 ${r} -${r} z`;
}

function partOrder(data: AssemblyData): Part[] {
  const seen = new Set<string>();
  const ordered: Part[] = [];
  const byId = new Map(data.parts.map((p) => [p.id, p]));
  const push = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const p = byId.get(id);
    if (p) ordered.push(p);
  };
  for (const s of data.steps) {
    for (const id of s.component_ids ?? []) push(id);
    for (const id of s.installed_components ?? []) push(id);
  }
  for (const p of data.parts) push(p.id); // unreferenced parts last
  return ordered;
}

function relStyle(rel: Relationship): { stroke: string; dash: string; label: string } {
  switch (rel.status) {
    case 'visually-confirmed':
      return { stroke: '#5b6470', dash: '6 4', label: rel.type };
    case 'inferred':
      return { stroke: '#9aa3ad', dash: '3 4', label: `${rel.type} (inferred)` };
    default:
      return { stroke: '#c3c9cf', dash: '1.5 4', label: `${rel.type} (unknown)` };
  }
}

export function buildExplodedSvg(data: AssemblyData): string {
  const parts = partOrder(data);
  const pos = new Map<string, { x: number; y: number }>();
  const cx = W / 2;
  parts.forEach((p, i) => {
    pos.set(p.id, { x: cx, y: TOP + NODE_H / 2 + i * (NODE_H + GAP) });
  });
  const height = TOP + parts.length * (NODE_H + GAP) + 64;

  const rels = (data.relationships ?? []).filter((r) => pos.has(r.from) && pos.has(r.to));

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" font-family="Segoe UI, Arial, sans-serif">`);
  out.push(`<rect x="0" y="0" width="${W}" height="${height}" fill="#ffffff"/>`);
  out.push(`<text x="${cx}" y="30" text-anchor="middle" font-size="17" font-weight="600" fill="#1c2126">${esc(truncate(data.robot_name, 60))} — exploded view</text>`);
  out.push(`<text x="${cx}" y="52" text-anchor="middle" font-size="11.5" fill="#8a6d3b">Schematic layout from generated assembly data — illustrative only, positions not verified, not to scale, not engineering data</text>`);
  out.push(`<text x="${cx}" y="70" text-anchor="middle" font-size="11" fill="#6b7280">Solid-dash = visually confirmed · short-dash = inferred · dotted = unknown</text>`);

  // Relationship edges (drawn first, under the nodes), offset to the right side.
  rels.forEach((rel, i) => {
    const a = pos.get(rel.from)!;
    const b = pos.get(rel.to)!;
    const style = relStyle(rel);
    const off = 18 + (i % 5) * 14;
    const x1 = a.x + NODE_W / 2;
    const x2 = b.x + NODE_W / 2 + off;
    const y1 = a.y;
    const y2 = b.y;
    out.push(`<path d="M ${x1} ${y1} C ${x1 + 60 + off} ${y1}, ${x2 + 60} ${y2}, ${x2} ${y2}" fill="none" stroke="${style.stroke}" stroke-width="1.4" stroke-dasharray="${style.dash}"/>`);
    out.push(`<text x="${(x1 + x2) / 2 + 34}" y="${(y1 + y2) / 2 - 4}" text-anchor="middle" font-size="9.5" fill="${style.stroke}">${esc(style.label)}</text>`);
  });

  // Part nodes.
  for (const p of parts) {
    const { x, y } = pos.get(p.id)!;
    const inferred = p.evidence === 'inferred';
    const review = p.review_required === true;
    const fill = inferred ? '#f6f7f8' : '#eef1f3';
    const stroke = review ? '#ff5a1f' : '#9aa3ad';
    const dash = inferred ? '5 3' : 'none';
    const qty = p.quantityUnknown ? 'qty ?' : `×${p.quantity}`;
    const meta = [qty, p.evidence ?? '', review ? 'review' : '', p.category ?? ''].filter(Boolean).join(' · ');
    out.push(`<g data-item="${esc(p.id)}">`);
    out.push(`<path d="${rectPath(x, y, NODE_W, NODE_H, 10)}" fill="${fill}" stroke="${stroke}" stroke-width="${review ? 2 : 1.3}" stroke-dasharray="${dash}"/>`);
    out.push(`<text x="${x - NODE_W / 2 + 14}" y="${y - 4}" font-size="13" font-weight="600" fill="#1c2126">${esc(truncate(p.name, 52))}</text>`);
    out.push(`<text x="${x - NODE_W / 2 + 14}" y="${y + 15}" font-size="10.5" fill="#6b7280">${esc(truncate(meta, 70))}</text>`);
    out.push(`</g>`);
  }

  out.push(`<text x="${cx}" y="${height - 18}" text-anchor="middle" font-size="10" fill="#9aa3ad">Generated by BuildFromVision from the uploaded photo + component analysis · ${parts.length} components · ${rels.length} relationships</text>`);
  out.push(`</svg>`);
  return out.join('\n');
}
