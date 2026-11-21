/** Canonical schema for the assembly data exchanged with the other BuildFromVision modules. */

export interface Part {
  id: string;
  name: string;
  quantity: number;
  description?: string;
  category?: string;
  /** Shop / purchasing metadata from upstream BOM (optional). */
  shop?: string;
  url?: string;
  unit_price?: number;
  visible_in_photo?: boolean;
  // --- image-analysis provenance (from the vision/component-detection JSON) ---
  /** "visible" = visually confirmed in the photo; "inferred" = suspected, not confirmed. */
  evidence?: string;
  /** Detection source ids from the analysis model (e.g. ["W001","W002"]). */
  source_ids?: string[];
  sku?: string | null;
  product_url?: string | null;
  /** True when the analysis model asks a human to review this component. */
  review_required?: boolean;
  notes?: string;
  /** True when the analysis JSON had quantity: null (unknown, NOT zero/one). */
  quantityUnknown?: boolean;
}

export interface AssemblyStep {
  id: string;
  number: number;
  title: string;
  instruction: string;
  /** Narration text for audio. Falls back to `instruction` when missing. */
  narration: string;
  /** Part ids involved in this step (typically the parts being added). */
  component_ids: string[];
  /** Cumulative part ids installed after this step completes. */
  installed_components: string[];
  visual_prompt?: string;
  /** Step-specific tip / guidance from upstream (optional). */
  tip?: string;
  /** Tools required for this step (optional). */
  tools?: string[];
  /** Optional animation / slot metadata from upstream (preserved, not interpreted). */
  anim?: Array<{ part_id: string; slot: string }>;
  /** True when the generating model flagged this step as uncertain / not verified. */
  uncertain?: boolean;
  /** Safety note for the step (e.g. battery / electrical handling). */
  safety?: string;
}

export type RelationshipType =
  | 'mounted-on'
  | 'attached-to'
  | 'above'
  | 'beneath'
  | 'mechanically-connected'
  | 'adjacent'
  | 'wired-to';

export type VerificationStatus = 'visually-confirmed' | 'inferred' | 'unknown';

export interface Relationship {
  id: string;
  /** Source part id (must exist in parts). */
  from: string;
  /** Destination part id (must exist in parts). */
  to: string;
  type: RelationshipType | string;
  /** Supporting evidence text (visual observation or JSON note). */
  evidence?: string;
  confidence?: 'high' | 'medium' | 'low';
  status: VerificationStatus;
  /** Original analysis source_ids this relationship derives from, when available. */
  source_ids?: string[];
}

export interface AssemblyData {
  robot_name: string;
  description: string;
  parts: Part[];
  steps: AssemblyStep[];
  /** True when the payload came from upstream AI modules and is illustrative, not verified. */
  illustrative: boolean;
  /** Upstream metadata (hein-parts / vision module), preserved when present. */
  recipe_id?: string;
  confidence?: number;
  bom_total?: number;
  unmatched?: Array<{ name?: string; category?: string; qty?: number }>;
  warnings?: string[];
  /** Robot photo (data URL) for the current session — never persisted or sent anywhere except /api/generate. */
  photo?: string;
  /** Overall tools/materials identified during generation. */
  tools?: string[];
  /** Components the model/analysis flagged for human review. */
  review_flags?: string[];
  /** Component relationship & connection map (physical + visually-supported electrical). */
  relationships?: Relationship[];
}

export interface NormalizeResult {
  data: AssemblyData | null;
  /** Non-fatal issues that were repaired while normalising. */
  warnings: string[];
  /** Fatal problems — when non-empty, `data` is null. */
  errors: string[];
}
