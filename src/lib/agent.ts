import type { AssemblyData, AssemblyStep } from '../types';

/**
 * Client for the Assembly Orchestrator Agent (/api/agent). Sends the question,
 * conversation history and a state snapshot; receives the agent's answer, the
 * list of actions to perform in the app, and a tool-activity trace for display.
 */

export interface AgentAction {
  type: 'highlight_component' | 'navigate_to_step' | 'mark_part_available';
  partId?: string;
  stepNumber?: number;
  part_id?: string;
  reason?: string;
}

export interface AgentTraceEntry {
  tool: string;
  label: string;
  status: 'called' | 'done' | 'error' | 'action';
  detail?: string;
}

export interface AgentResult {
  answer: string;
  actions: AgentAction[];
  trace: AgentTraceEntry[];
  error?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Snapshot of live app state sent to the agent so its read tools return real data. */
export function buildStateSnapshot(data: AssemblyData, stepIndex: number, checklist: Set<string>) {
  return {
    robot_name: data.robot_name,
    description: data.description,
    parts: data.parts.map((p) => ({
      id: p.id,
      name: p.name,
      quantity: p.quantity,
      quantityUnknown: p.quantityUnknown,
      category: p.category,
      shop: p.shop,
      evidence: p.evidence,
      source_ids: p.source_ids,
      review_required: p.review_required,
      notes: p.notes,
    })),
    steps: data.steps.map((s) => ({
      id: s.id,
      number: s.number,
      title: s.title,
      instruction: s.instruction,
      tip: s.tip,
      tools: s.tools,
      uncertain: s.uncertain,
      safety: s.safety,
      component_ids: s.component_ids,
      installed_components: s.installed_components,
    })),
    review_flags: data.review_flags ?? [],
    relationships: (data.relationships ?? []).map((r) => ({
      id: r.id, from: r.from, to: r.to, type: r.type,
      evidence: r.evidence, confidence: r.confidence, status: r.status, source_ids: r.source_ids,
    })),
    currentStepIndex: stepIndex,
    checklist: [...checklist],
  };
}

export async function askAgent(
  data: AssemblyData,
  _step: AssemblyStep,
  stepIndex: number,
  checklist: Set<string>,
  history: ChatMessage[],
  question: string,
): Promise<AgentResult> {
  try {
    const res = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        history: history.map((m) => ({ role: m.role, content: m.content })),
        state: buildStateSnapshot(data, stepIndex, checklist),
      }),
    });
    const json = (await res.json().catch(() => null)) as
      | (AgentResult & { error?: string })
      | null;
    if (res.ok && json && json.answer) return { answer: json.answer, actions: json.actions ?? [], trace: json.trace ?? [] };
    return {
      answer: '',
      actions: [],
      trace: [],
      error: json?.error ?? `Agent request failed (HTTP ${res.status}). The written instructions above still apply.`,
    };
  } catch (err) {
    return { answer: '', actions: [], trace: [], error: `Agent unreachable: ${(err as Error).message}` };
  }
}
