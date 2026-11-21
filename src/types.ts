/** Canonical schema for the assembly data exchanged with the other BuildFromVision modules. */

export interface Part {
  id: string;
  name: string;
  quantity: number;
  description?: string;
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
}

export interface AssemblyData {
  robot_name: string;
  description: string;
  parts: Part[];
  steps: AssemblyStep[];
  /** True when the payload came from upstream AI modules and is illustrative, not verified. */
  illustrative: boolean;
}

export interface NormalizeResult {
  data: AssemblyData | null;
  /** Non-fatal issues that were repaired while normalising. */
  warnings: string[];
  /** Fatal problems — when non-empty, `data` is null. */
  errors: string[];
}
