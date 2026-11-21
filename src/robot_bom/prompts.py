"""Two-pass prompting strategy: observe first, infer second."""

from __future__ import annotations

import json

CATEGORY_VOCABULARY = [
    "wheel", "chassis", "motor", "servo", "motor_driver", "relay_module", "relay",
    "microcontroller", "single_board_computer", "breadboard", "pcb_module", "sensor",
    "battery", "battery_holder", "power_supply", "switch", "led", "wiring", "connector",
    "fastener", "bracket", "other",
]

PASS1_SYSTEM = (
    "You are an evidence-focused robotics component annotator. List ONLY parts physically "
    "visible in supplied image(s). Include category, visual description, quantity visible, "
    "image reference and approximate location if supportable. Do not infer hidden parts. Do "
    "not guess manufacturer, SKU, electrical ratings, exact dimensions, or exact part numbers "
    "from appearance. Distinguish assemblies (e.g., a relay module containing two blue relay "
    "blocks) from their subcomponents to avoid double counting. Use `null` for unknowable "
    "fields. Return ONLY schema-valid JSON."
)

PASS2_SYSTEM = (
    "You are a robotics assembly and electrical safety reviewer. Given the observed inventory "
    "and evidence, propose *potential* missing mechanical/electrical components and connection "
    "requirements. Mark all unobserved items `inferred` or `unknown`, not `observed`. Identify "
    "ambiguities, compatibility constraints, and the next most useful photo or measurement. "
    "Never convert a plausible part into a confirmed part. Return ONLY schema-valid JSON."
)

_PASS1_SHAPE = """{
  "view": "top" | "underside" | "side" | "front" | "rear" | "close-up" | "unknown",
  "parts": [
    {
      "category": string,
      "name": string,
      "description": string,
      "visible_quantity": integer | null,
      "bbox_xyxy_norm": [x1, y1, x2, y2] | null,
      "parent_assembly": string | null,
      "visible_markings": string | null,
      "confidence": number
    }
  ],
  "notes": [string]
}"""

_PASS2_SHAPE = """{
  "inferred_components": [
    {
      "category": string,
      "name": string,
      "evidence_type": "inferred" | "unknown",
      "rationale": string,
      "related_component_ids": [string]
    }
  ],
  "connections": [
    {
      "source_id": string,
      "target_id": string,
      "relation": "mechanically_attached" | "wired_to" | "drives" | "supports" | "unknown",
      "evidence_type": "observed" | "inferred" | "unknown",
      "rationale": string
    }
  ],
  "issues": [
    {
      "severity": "critical" | "warning" | "info",
      "component_ids": [string],
      "message": string,
      "next_action": string
    }
  ],
  "requested_views": [ { "view": string, "reason": string } ]
}"""


def pass1_user_prompt(image_id: str, known_names: list[tuple[str, str]]) -> str:
    lines = [
        f"Annotate the single image with image_id `{image_id}`.",
        "",
        "Return ONE JSON object with exactly this shape:",
        _PASS1_SHAPE,
        "",
        "Field rules:",
        f"- category: one of {', '.join(CATEGORY_VOCABULARY)}.",
        "- name: short generic part-type name (e.g. \"rubber wheel\"). No brand or model names.",
        "- description: the visual justification - what you see that supports this entry.",
        "- One entry per distinct part type; group identical parts and count them in "
        "visible_quantity. Use null when the count cannot be determined (e.g. a wire bundle). "
        "Never estimate parts that are hidden or out of frame.",
        "- bbox_xyxy_norm: normalised 0..1 box, ONLY for a single item you can localise "
        "confidently. Otherwise null. Do not guess coordinates.",
        "- parent_assembly: if this part is a subcomponent mounted on another listed part "
        "(e.g. relay blocks on a relay module board), the exact `name` of that entry; else null.",
        "- visible_markings: text you can literally read on the part, verbatim; else null. "
        "Do not reconstruct unreadable text.",
        "- confidence: your own 0..1 estimate that the part type is correctly identified.",
        "- If the image shows no robot or hardware, return an empty `parts` list and explain in `notes`.",
    ]
    if known_names:
        lines += [
            "",
            "Part names already used for OTHER photos of this same robot:",
            *[f"- {category}: {name}" for category, name in known_names],
            "If - and only if - you actually see one of these part types in THIS image, reuse "
            "its exact category and name so views can be matched. Do not list a part just "
            "because it appears above.",
        ]
    return "\n".join(lines)


def pass2_user_prompt(inventory: list[dict], views: list[dict]) -> str:
    return "\n".join(
        [
            "Observed inventory (from photos only; quantities are what was visible):",
            json.dumps(inventory, indent=2),
            "",
            "Photos analysed:",
            json.dumps(views, indent=2),
            "",
            "Return ONE JSON object with exactly this shape:",
            _PASS2_SHAPE,
            "",
            "Rules:",
            "- inferred_components: parts that are plausibly required or hidden but NOT in the "
            "observed inventory. Use `inferred` when mechanically/electrically implied, `unknown` "
            "when you cannot tell whether or which part exists. Do not repeat observed parts.",
            f"- category: one of {', '.join(CATEGORY_VOCABULARY)}.",
            "- Do not state quantities, voltages, currents, dimensions, brands, models, SKUs, "
            "prices or shops. Wheel count does not establish motor count.",
            "- connections and component_ids may ONLY use ids from the observed inventory.",
            "- issues: ambiguities and compatibility constraints, each with a concrete next_action.",
            "- requested_views: the most informative missing photos or measurements, most useful first.",
        ]
    )
