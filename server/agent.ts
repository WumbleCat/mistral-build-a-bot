/**
 * Assembly Orchestrator Agent — server-side tool-calling loop over Mistral
 * chat completions. Read tools execute here against a state snapshot sent by
 * the client; action tools are returned to the client for execution against
 * live app state. The loop is capped to prevent infinite tool-calling.
 */

import { createHash } from 'node:crypto';

import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentStateSnapshot {
  robot_name: string;
  description?: string;
  parts: Array<{
    id: string;
    name: string;
    quantity: number;
    quantityUnknown?: boolean;
    category?: string;
    shop?: string;
    evidence?: string;
    source_ids?: string[];
    review_required?: boolean;
    notes?: string;
  }>;
  steps: Array<{
    id: string;
    number: number;
    title: string;
    instruction: string;
    tip?: string;
    tools?: string[];
    uncertain?: boolean;
    safety?: string;
    component_ids: string[];
    installed_components: string[];
  }>;
  currentStepIndex: number;
  checklist: string[]; // part ids the user has physically confirmed
  review_flags?: string[];
  relationships?: Array<{
    id: string; from: string; to: string; type: string;
    evidence?: string; confidence?: string; status: string; source_ids?: string[];
  }>;
}

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** true = execute server-side against the snapshot; false = return to client as an action */
  serverSide: boolean;
  label: string;
}

interface TraceEntry {
  tool: string;
  label: string;
  status: 'called' | 'done' | 'error' | 'action';
  detail?: string;
}

interface AgentAction {
  type: 'highlight_component' | 'navigate_to_step' | 'mark_part_available';
  partId?: string;
  stepNumber?: number;
  part_id?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

const TOOLS: ToolDef[] = [
  {
    name: 'get_current_assembly_step',
    description: 'Get the assembly step the user is currently viewing: number, title, instruction, tip, tools, parts being added, and what is already installed.',
    parameters: { type: 'object', properties: {} },
    serverSide: true,
    label: 'Checking current assembly step…',
  },
  {
    name: 'get_component_details',
    description: 'Look up one component by its id or name in the BOM: quantity, category, shop, and which steps use it.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Component id or name (or part of it)' } },
      required: ['query'],
    },
    serverSide: true,
    label: 'Looking up component…',
  },
  {
    name: 'get_bom',
    description: 'Get the full bill of materials: every part with id, name, quantity and category.',
    parameters: { type: 'object', properties: {} },
    serverSide: true,
    label: 'Retrieving bill of materials…',
  },
  {
    name: 'get_assembly_instructions',
    description: 'Get the instruction text (and tip/tools) for one assembly step, by step number.',
    parameters: {
      type: 'object',
      properties: { step_number: { type: 'integer', description: 'Step number (1-based)' } },
      required: ['step_number'],
    },
    serverSide: true,
    label: 'Retrieving instructions…',
  },
  {
    name: 'get_required_tools',
    description: 'Get the tools required for the current step (or a given step).',
    parameters: {
      type: 'object',
      properties: { step_number: { type: 'integer', description: 'Optional step number; defaults to current step' } },
    },
    serverSide: true,
    label: 'Checking required tools…',
  },
  {
    name: 'get_assembly_progress',
    description: 'Compare the BOM against the user-confirmed parts checklist and report what is still missing, plus current step progress.',
    parameters: { type: 'object', properties: {} },
    serverSide: true,
    label: 'Checking assembly progress…',
  },
  {
    name: 'get_relationships',
    description: 'Get the component relationship & connection map: physical (mounted-on, above/beneath, adjacent, mechanically-connected) and visually-supported wiring (wired-to), each with evidence, confidence and verification status. Optionally filter to one component.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Optional component id or name to filter relationships for' } },
    },
    serverSide: true,
    label: 'Reading connection map…',
  },
  {
    name: 'highlight_component',
    description: 'Highlight a component in the current illustration / exploded view. Call when the answer refers to a specific part the user should look at.',
    parameters: {
      type: 'object',
      properties: { part_id: { type: 'string', description: 'The BOM part id to highlight' } },
      required: ['part_id'],
    },
    serverSide: false,
    label: 'Highlighting component…',
  },
  {
    name: 'navigate_to_step',
    description: 'Navigate the workbook/walkthrough to a specific assembly step. Use when the user asks to see or go to a step.',
    parameters: {
      type: 'object',
      properties: { step_number: { type: 'integer', description: 'Target step number (1-based)' } },
      required: ['step_number'],
    },
    serverSide: false,
    label: 'Navigating to step…',
  },
  {
    name: 'mark_part_available',
    description: 'Mark a part as physically located in the pre-assembly checklist. Only call when the user explicitly confirms they have the part.',
    parameters: {
      type: 'object',
      properties: { part_id: { type: 'string', description: 'The BOM part id to mark as available' } },
      required: ['part_id'],
    },
    serverSide: false,
    label: 'Updating checklist…',
  },
];

// ---------------------------------------------------------------------------
// Server-side tool execution (read-only, against the snapshot)
// ---------------------------------------------------------------------------

function executeReadTool(name: string, args: Record<string, unknown>, state: AgentStateSnapshot): string {
  const step = state.steps[state.currentStepIndex];
  switch (name) {
    case 'get_current_assembly_step':
      return JSON.stringify({
        step_number: step?.number,
        total_steps: state.steps.length,
        title: step?.title,
        instruction: step?.instruction,
        tip: step?.tip,
        tools: step?.tools ?? [],
        adding: step?.component_ids ?? [],
        already_installed: step?.installed_components ?? [],
      });
    case 'get_component_details': {
      const q = String(args.query ?? '').toLowerCase();
      const part = state.parts.find((p) => p.id.toLowerCase() === q || p.name.toLowerCase().includes(q) || q.includes(p.name.toLowerCase()));
      if (!part) return JSON.stringify({ found: false, query: args.query });
      const usedIn = state.steps.filter((s) => s.component_ids.includes(part.id)).map((s) => ({ step: s.number, title: s.title }));
      return JSON.stringify({ found: true, ...part, used_in_steps: usedIn });
    }
    case 'get_bom':
      return JSON.stringify({ robot: state.robot_name, parts: state.parts, total_parts: state.parts.length });
    case 'get_assembly_instructions': {
      const n = Number(args.step_number);
      const s = state.steps.find((x) => x.number === n);
      if (!s) return JSON.stringify({ found: false, step_number: n });
      return JSON.stringify({ step_number: s.number, title: s.title, instruction: s.instruction, tip: s.tip, tools: s.tools ?? [], component_ids: s.component_ids });
    }
    case 'get_required_tools': {
      const n = args.step_number !== undefined ? Number(args.step_number) : step?.number;
      const s = state.steps.find((x) => x.number === n);
      return JSON.stringify({ step_number: n, tools: s?.tools ?? [], tip: s?.tip });
    }
    case 'get_relationships': {
      const q = String(args.query ?? '').toLowerCase();
      const rels = (state.relationships ?? []).filter((r) => {
        if (!q) return true;
        const p = (id: string) => state.parts.find((x) => x.id === id);
        return r.from.toLowerCase().includes(q) || r.to.toLowerCase().includes(q)
          || (p(r.from)?.name.toLowerCase().includes(q) ?? false)
          || (p(r.to)?.name.toLowerCase().includes(q) ?? false);
      });
      return JSON.stringify({ count: rels.length, relationships: rels });
    }
    case 'get_assembly_progress': {
      const have = new Set(state.checklist);
      const missing = state.parts.filter((p) => !have.has(p.id)).map((p) => ({ id: p.id, name: p.name, quantity: p.quantity }));
      return JSON.stringify({
        current_step: step?.number,
        total_steps: state.steps.length,
        confirmed_parts: state.checklist.length,
        total_parts: state.parts.length,
        missing,
      });
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

const MAX_ITERATIONS = 6;

const SYSTEM_PROMPT = [
  'You are the BuildFromVision Assembly Orchestrator Agent. You help a user assemble a robot step by step.',
  'You have tools. USE THEM to retrieve real data before answering — do not guess.',
  'Workflow: understand the question → call the relevant tools → read the tool results → call more tools if needed → give a concise grounded answer.',
  'Rules:',
  '- Never invent dimensions, positions, orientations, screw sizes or electrical specs.',
  '- If the data does not establish something, say so explicitly.',
  '- Refer to actual component names and ids from tool results.',
  '- Use highlight_component when your answer refers to a part the user should see highlighted.',
  '- Use navigate_to_step when the user asks to see/go to a step.',
  '- Only use mark_part_available when the user explicitly says they have the part.',
  '- All diagrams are schematic/illustrative, not engineering drawings. Never claim mechanical/electrical safety from incomplete info.',
  '- Keep the final answer concise (2-5 sentences), practical, and easy to follow.',
].join('\n');

export interface AgentResponse {
  answer: string;
  actions: AgentAction[];
  trace: TraceEntry[];
  model: string;
  iterations: number;
  error?: string;
}

async function runAgent(
  baseUrl: string,
  key: string,
  model: string,
  question: string,
  history: Array<{ role: string; content: string }>,
  state: AgentStateSnapshot,
): Promise<AgentResponse> {
  const trace: TraceEntry[] = [];
  const actions: AgentAction[] = [];
  const toolDefs = TOOLS.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: question },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools: toolDefs, tool_choice: 'auto', temperature: 0.2, max_tokens: 500 }),
    });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      return { answer: '', actions, trace, model, iterations: i, error: `Mistral request failed (${upstream.status}): ${detail.slice(0, 200)}` };
    }
    const json = (await upstream.json()) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
    };
    const msg = json.choices?.[0]?.message;
    if (!msg) return { answer: '', actions, trace, model, iterations: i, error: 'Empty response from model.' };
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls ?? [] });

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return { answer: (msg.content ?? '').trim(), actions, trace, model, iterations: i + 1 };
    }

    for (const tc of toolCalls) {
      const def = TOOLS.find((t) => t.name === tc.function.name);
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        trace.push({ tool: tc.function.name, label: def?.label ?? tc.function.name, status: 'error', detail: 'invalid arguments' });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: 'Invalid tool arguments.' }) });
        continue;
      }
      if (!def) {
        trace.push({ tool: tc.function.name, label: tc.function.name, status: 'error', detail: 'unknown tool' });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: 'Unknown tool.' }) });
        continue;
      }
      if (def.serverSide) {
        trace.push({ tool: def.name, label: def.label, status: 'called' });
        const result = executeReadTool(def.name, args, state);
        trace.push({ tool: def.name, label: def.label, status: 'done' });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      } else {
        trace.push({ tool: def.name, label: def.label, status: 'action' });
        const action: AgentAction = { type: def.name as AgentAction['type'], reason: def.label };
        if (def.name === 'highlight_component') action.partId = String(args.part_id ?? '');
        if (def.name === 'navigate_to_step') action.stepNumber = Number(args.step_number);
        if (def.name === 'mark_part_available') action.part_id = String(args.part_id ?? '');
        actions.push(action);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ ok: true, note: 'Action queued — the app will perform it.' }),
        });
      }
    }
  }
  return {
    answer: 'I looked into that but ran out of tool steps — here is what I found so far. Try rephrasing your question.',
    actions,
    trace,
    model,
    iterations: MAX_ITERATIONS,
  };
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

const agentCache = new Map<string, AgentResponse>();

export async function handleAgent(req: IncomingMessage, res: ServerResponse, readJson: (r: IncomingMessage) => Promise<Record<string, unknown>>, sendJson: (r: ServerResponse, s: number, b: unknown) => void) {
  const key = process.env.MISTRAL_API_KEY;
  const baseUrl = (process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1').replace(/\/$/, '');
  const model = process.env.MISTRAL_CHAT_MODEL || 'mistral-medium-latest';
  if (!key) {
    sendJson(res, 503, { error: 'Agent unavailable: MISTRAL_API_KEY is not configured on the server.', code: 'NO_API_KEY' });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body.' });
    return;
  }
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) {
    sendJson(res, 400, { error: 'Missing "question".' });
    return;
  }
  const state = body.state as AgentStateSnapshot | undefined;
  if (!state || !Array.isArray(state.parts) || !Array.isArray(state.steps)) {
    sendJson(res, 400, { error: 'Missing or invalid "state" snapshot (parts/steps required).' });
    return;
  }
  const history = Array.isArray(body.history) ? (body.history as Array<{ role: string; content: string }>) : [];
  const cacheKey = createHash('sha256').update(JSON.stringify({ q: question, h: history.slice(-4), s: state })).digest('hex');
  const cached = agentCache.get(cacheKey);
  if (cached) {
    sendJson(res, 200, { ...cached, cached: true });
    return;
  }
  try {
    const result = await runAgent(baseUrl, key, model, question, history, state);
    if (result.error) {
      sendJson(res, 502, result);
      return;
    }
    agentCache.set(cacheKey, result);
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 502, { error: `Agent failed: ${(err as Error).message}`, answer: '', actions: [], trace: [] });
  }
}
