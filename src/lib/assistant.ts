import type { AssemblyData, AssemblyStep } from '../types';

/**
 * Client for the context-aware assembly assistant. Builds a grounded context
 * string from the current workbook state and sends the conversation to the
 * server-side /api/chat route (Mistral chat completions, key stays server-side).
 * Session-level only — no persistence beyond the React state that holds history.
 */

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  answer: string;
  error?: string;
}

/** Build the grounding context the assistant sees (sent as a user-role preamble). */
export function buildAssistantContext(data: AssemblyData, step: AssemblyStep, partsById: Map<string, { name: string; quantity: number }>): string {
  const partLine = (id: string) => {
    const p = partsById.get(id);
    return p ? `${p.name} (id: ${id}${p.quantity > 1 ? `, x${p.quantity}` : ''})` : id;
  };
  const bom = data.parts
    .map((p) => {
      const flags = [
        p.evidence ? `evidence:${p.evidence}` : '',
        p.review_required ? 'REVIEW-REQUIRED' : '',
        p.quantityUnknown ? 'qty:unknown' : `qty:${p.quantity}`,
        p.source_ids?.length ? `sources:${p.source_ids.join(',')}` : '',
      ].filter(Boolean).join(', ');
      return `- ${p.name} (id: ${p.id}${flags ? ` — ${flags}` : ''})`;
    })
    .join('\n');
  const rels = data.relationships ?? [];
  const relMap = rels.length
    ? 'CONNECTION MAP:\n' + rels.map((r) => `- ${r.from} --${r.type}--> ${r.to} [${r.status}${r.confidence ? `, confidence:${r.confidence}` : ''}]${r.evidence ? ` (${r.evidence})` : ''}`).join('\n')
    : '';
  const adding = step.component_ids.map(partLine).join(', ') || 'none';
  const installed = step.installed_components.filter((id) => !step.component_ids.includes(id)).map(partLine).join(', ') || 'none yet';
  const tools = step.tools?.length ? step.tools.join(', ') : 'none specified';
  return [
    `ROBOT: ${data.robot_name}${data.description ? ` — ${data.description}` : ''}${data.recipe_id ? ` (recipe: ${data.recipe_id})` : ''}`,
    '',
    'BILL OF MATERIALS:',
    bom,
    '',
    `CURRENT STEP ${step.number} of ${data.steps.length}: "${step.title}"`,
    `Instruction: ${step.instruction}`,
    step.tip ? `Tip: ${step.tip}` : '',
    `Tools for this step: ${tools}`,
    `Components being added in this step: ${adding}`,
    `Already installed before this step: ${installed}`,
    relMap,
    '',
    'All diagrams in this app are schematic/illustrative — not engineering drawings.',
    'Relationships marked "inferred"/"unknown" are NOT confirmed — say so and suggest what to verify.',
  ].filter((l) => l !== '').join('\n');
}

/** Send the conversation (with context preamble) to the server-side assistant. */
export async function askAssistant(
  data: AssemblyData,
  step: AssemblyStep,
  history: ChatMessage[],
  question: string,
): Promise<ChatResult> {
  const context = buildAssistantContext(data, step, new Map(data.parts.map((p) => [p.id, p])));
  const messages: Array<{ role: string; content: string }> = [
    { role: 'user', content: `[Assembly context]\n${context}` },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: question },
  ];
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    });
    const json = (await res.json().catch(() => null)) as { answer?: string; error?: string } | null;
    if (res.ok && json?.answer) return { answer: json.answer };
    return { answer: '', error: json?.error ?? `Assistant request failed (HTTP ${res.status}).` };
  } catch (err) {
    return { answer: '', error: `Assistant unreachable: ${(err as Error).message}` };
  }
}

/** Suggested follow-up questions for the current step. */
export function suggestedQuestions(step: AssemblyStep, data: AssemblyData): string[] {
  const adding = step.component_ids
    .map((id) => data.parts.find((p) => p.id === id)?.name)
    .filter(Boolean);
  const qs = [
    `What do I do in this step (${step.number})?`,
    adding.length > 0 ? `Where does the ${adding[0]} go?` : 'What should I do next?',
    'Have I installed all parts for this step?',
  ];
  if (step.tools?.length) qs.push(`Why do I need the ${step.tools[0]}?`);
  if (step.tip) qs.push('Can you explain the tip again?');
  qs.push('What does this part do?');
  return qs.slice(0, 4);
}
