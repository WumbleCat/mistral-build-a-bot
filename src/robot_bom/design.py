"""Optional "best guess" step: let the model settle every open design question.

The reviewed BOM stays strictly evidence-based. This module produces two *separate*
documents on request, both clearly labelled as the model's assumptions:

1. ``inferred_components.json`` - for each open issue the model picks the most likely
   design choice, then returns one simple, complete component list.
2. ``order_links.json`` - a second query, run after the first, applies the parts-research
   rules (``SOURCING_RULES``) to choose a search term and the best shops for each part.

Shop links are built here, in code, as *search* links on a fixed list of shops. The model
has no web access, so it is never asked for product pages, prices or stock: any URL it
wrote would be a guess. Nothing in this module changes the BOM or its readiness.
"""

from __future__ import annotations

import json
import re
from typing import Literal
from urllib.parse import quote_plus

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .extraction import call_structured
from .models import RobotBOM
from .prompts import CATEGORY_VOCABULARY
from .vision import VisionClient

# key -> (display name, home page, search URL prefix). The search term is URL-encoded and
# appended. Order is the order used in the output.
SHOPS: dict[str, tuple[str, str, str]] = {
    "lcsc": ("LCSC", "https://www.lcsc.com/", "https://www.lcsc.com/search?q="),
    "digikey": ("DigiKey UK", "https://www.digikey.co.uk/", "https://www.digikey.co.uk/en/products/result?keywords="),
    "rs": ("RS Components UK", "https://uk.rs-online.com/web/", "https://uk.rs-online.com/web/c/?searchTerm="),
    "sparkfun": ("SparkFun", "https://www.sparkfun.com/", "https://www.sparkfun.com/catalogsearch/result/?q="),
    "mouser": ("Mouser UK", "https://www.mouser.co.uk/", "https://www.mouser.co.uk/c/?q="),
    "amazon": ("Amazon.com", "https://www.amazon.com/", "https://www.amazon.com/s?k="),
}

DESIGN_DISCLAIMER = (
    "Model inference, not verified. Every design choice and every line marked 'inferred' is "
    "the model's most likely guess from the photos and open issues - check it against the "
    "real robot before buying anything. This list is separate from the reviewed BOM."
)
LINKS_DISCLAIMER = (
    "Search links only. They open each shop's search results for the suggested term; no "
    "specific product, price or stock level has been checked. Search terms and shop "
    "recommendations are model suggestions for an inferred design."
)

MAX_QUERY_CHARS = 120


# --------------------------------------------------------------------------
# Schemas
# --------------------------------------------------------------------------


def _text_specs(value: object) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {str(k): str(v) for k, v in value.items() if v is not None and str(v).strip()}


class DesignChoice(BaseModel):
    model_config = ConfigDict(extra="ignore")

    issue_id: str
    choice: str = Field(min_length=1)
    reason: str = ""


class InferredComponent(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str = Field(min_length=1)
    category: str = "other"
    quantity: int = Field(ge=1)
    specs: dict[str, str] = Field(default_factory=dict)
    basis: Literal["observed", "inferred"] = "inferred"
    reason: str = ""

    _specs = field_validator("specs", mode="before")(_text_specs)

    @field_validator("category", mode="before")
    @classmethod
    def _known_category(cls, value: object) -> str:
        return value if isinstance(value, str) and value in CATEGORY_VOCABULARY else "other"


class InferredDesign(BaseModel):
    """Reply to the design-inference query."""

    model_config = ConfigDict(extra="ignore")

    summary: str = ""
    design_choices: list[DesignChoice] = Field(default_factory=list)
    components: list[InferredComponent] = Field(min_length=1)


class PartSearch(BaseModel):
    model_config = ConfigDict(extra="ignore")

    component: str = Field(min_length=1)
    search_query: str = Field(min_length=1)
    recommended_sites: list[str] = Field(default_factory=list)
    note: str = ""

    @field_validator("recommended_sites", mode="before")
    @classmethod
    def _known_sites(cls, value: object) -> list[str]:
        sites = [str(v).strip().lower() for v in value] if isinstance(value, list) else []
        return [s for s in dict.fromkeys(sites) if s in SHOPS]


class SourcingPlan(BaseModel):
    """Reply to the parts-research query."""

    model_config = ConfigDict(extra="ignore")

    power_budget: str = ""
    searches: list[PartSearch] = Field(default_factory=list)


# --------------------------------------------------------------------------
# Prompts
# --------------------------------------------------------------------------

DESIGN_SYSTEM = (
    "You are a robotics design engineer completing a parts list for a hobby robot from "
    "incomplete evidence. You are given the parts seen in photos and a list of open issues "
    "and compatibility checks. For EVERY issue, decide the single most likely design choice "
    "- do not answer 'unknown' and do not ask for more photos - then return one simple, "
    "complete list of the components this robot needs, with concrete quantities. Keep parts "
    "that were observed, and add the parts your choices require. Your choices must be "
    "electrically and mechanically consistent with each other. Mark each component "
    "`observed` (it is in the observed list) or `inferred` (your assumption). Do not state "
    "prices, shops, URLs or SKUs. Return ONLY schema-valid JSON."
)

_DESIGN_SHAPE = """{
  "summary": "one or two sentences describing the robot you inferred",
  "design_choices": [
    {"issue_id": "<id from the issue list>", "choice": "the decision you made", "reason": "why it is the most likely"}
  ],
  "components": [
    {"name": "generic part name", "category": "<category>", "quantity": 1,
     "specs": {"voltage_v": "6", "current_a": "1.2"}, "basis": "observed | inferred", "reason": "short"}
  ]
}"""

# The parts-research rules the sourcing query must follow (phases A-D of the user's
# "Teardown Planner Rules"; the plan-authoring phase does not apply to a link list).
SOURCING_RULES = """\
Approved parts-research sources:
- lcsc (https://www.lcsc.com/): cheap components by part number, JLCPCB ecosystem, bulk BOM cost
- digikey (https://www.digikey.co.uk/): parametric search, datasheet PDFs, exact specs (V, I, package)
- rs (https://uk.rs-online.com/web/): UK stock, fast delivery, industrial-grade parts
- sparkfun (https://www.sparkfun.com/): breakout boards + hookup guides/tutorials (best for beginners)
- mouser (https://www.mouser.co.uk/): parametric search, datasheets, wide catalogue
- amazon (https://www.amazon.com/): hobby kits, chassis, wheels, gear motors, battery holders, jumper wires, fasteners

Phase A - Understand the product before choosing anything:
1. Core function: what does it do, end to end, in one sentence?
2. Core technology: sensing? actuation? wireless? logging? This drives the MCU class.
3. IO map: every input and output with its signal type and logic level (3.3 V or 5 V).
4. Power budget: sum the current draw of every subsystem. supply voltage = highest voltage
   any component needs; logic voltage = MCU rail; total current = MCU + sensors + actuators.
   battery runtime (h) = capacity (mAh) / average current (mA); pick a battery with >= 2x
   margin. Li-ion/LiPo REQUIRE a protection circuit (BMS) and a fuse.

Phase B - Parts research protocol, for every component:
1. Prefer breakout/module versions of chips - a hobbyist solders wires, not QFN packages.
2. Search by the 3-5 numbers that matter (voltage, current, logic level, interface, package).
3. Use parametric terms (voltage rating, current, package) rather than a vague name.
4. Prefer parts that are in stock and commonly available; avoid obsolete/one-off parts.

Phase C - Dev board selection: never ask the user to design a PCB; pick a widely available
dev board or module. 5 V digital sensors -> Arduino Uno R3/R4; wireless or 3.3 V sensors ->
ESP32 dev board (38-pin WROOM); tiny, low-power, USB-only -> Raspberry Pi Pico.

Phase D - Safety rules (hard constraints):
- Any load above ~20 mA, any motor, solenoid, relay coil, pump or heater is never driven
  directly from a GPIO: logic-level MOSFET/BJT for DC loads, H-bridge (e.g. DRV8833,
  TB6612FNG, L298N) for DC motors, relay module with flyback diode for isolated loads.
- Motor driver continuous current >= 2x motor stall current; voltage rating >= motor voltage x 1.3.
- 5 V output into a 3.3 V input needs a divider (1 k + 2 k); I2C needs a BSS138 level shifter.
- Common ground between logic and motor supply; fuse the battery line; Li-ion/LiPo need a
  BMS/protection board; reverse-polarity protection where cheap.

Reject: custom PCBs, motors/relays driven straight from a GPIO, missing fuse/BMS on lithium,
5 V signals into 3.3 V pins without a divider or level shifter, parts with no specs."""

SOURCING_SYSTEM = (
    "You are a parts-research agent preparing an order for a hobby robot. Follow these "
    "rules exactly.\n\n" + SOURCING_RULES + "\n\n"
    "You have no web access. Do NOT write URLs, prices, stock levels or shop part numbers: "
    "the application builds the shop links itself from your search terms. Return ONLY "
    "schema-valid JSON."
)

_SOURCING_SHAPE = """{
  "power_budget": "supply voltage, logic voltage, estimated total current and battery runtime, each labelled as an estimate",
  "searches": [
    {"component": "<exact name from the component list>",
     "search_query": "specific term to type into a shop's search box, e.g. 'TB6612FNG dual motor driver breakout'",
     "recommended_sites": ["sparkfun", "amazon"],
     "note": "what to check before buying (rating, logic level, size); say so if a safety rule requires an extra part"}
  ]
}"""


def design_user_prompt(components: list[dict], issues: list[dict]) -> str:
    return "\n".join([
        "Parts list so far (evidence_type `observed` = seen in a photo; `inferred`/`unknown` = "
        "a placeholder that was never seen; null quantity = not established):",
        json.dumps(components, indent=2),
        "",
        "Open issues and compatibility checks - make a design choice for EVERY one:",
        json.dumps(issues, indent=2),
        "",
        "Return ONE JSON object with exactly this shape:",
        _DESIGN_SHAPE,
        "",
        "Rules:",
        "- design_choices: exactly one entry per issue id above, with a concrete decision "
        "(e.g. '2 DC gear motors driving the rear wheels, front wheels free-rolling').",
        "- components: the complete robot as a simple flat list. Replace each placeholder with "
        "the concrete part you chose, or leave it out if your design does not need it.",
        "- quantity: a whole number of 1 or more. Count sub-parts of a module as part of the "
        "module, not separately.",
        f"- category: one of {', '.join(CATEGORY_VOCABULARY)}.",
        "- specs: the few numbers that matter (voltage_v, current_a, capacity_mah, logic_level_v, "
        "interface, size), as strings. They are your assumptions.",
        "- basis: `observed` only for parts whose evidence_type above is `observed`; everything "
        "else is `inferred`.",
        "- name: a generic, searchable part name. Use a brand or model only if it appears above "
        "or the part is a de-facto standard module (e.g. L298N, TB6612FNG, Arduino Uno).",
    ])


def sourcing_user_prompt(design: InferredDesign) -> str:
    components = [
        {"name": c.name, "category": c.category, "quantity": c.quantity, "specs": c.specs, "basis": c.basis}
        for c in design.components
    ]
    return "\n".join([
        "Robot: " + (design.summary or "hobby wheeled robot"),
        "",
        "Design choices already made:",
        json.dumps([{"issue_id": d.issue_id, "choice": d.choice} for d in design.design_choices], indent=2),
        "",
        "Component list to source:",
        json.dumps(components, indent=2),
        "",
        "Work through phases A-D for this robot, then return ONE JSON object with exactly this shape:",
        _SOURCING_SHAPE,
        "",
        "Rules:",
        "- searches: exactly one entry per component, `component` copied exactly from the list.",
        "- search_query: at most 8 words, specific enough to find the right part (include the "
        "rating or module name), with no shop name in it.",
        f"- recommended_sites: one to three of {', '.join(SHOPS)}, best first, chosen by what each "
        "source is best for.",
        "- If the component list violates a safety rule (e.g. lithium cells with no BMS or fuse), "
        "say so in the note of the affected component.",
    ])


# --------------------------------------------------------------------------
# Queries
# --------------------------------------------------------------------------


def _design_inputs(bom: RobotBOM) -> tuple[list[dict], list[dict]]:
    components = [
        {
            "id": c.id, "category": c.category, "name": c.name, "evidence_type": c.evidence_type.value,
            "visible_quantity": c.visible_quantity, "required_quantity": c.required_quantity,
            "manufacturer": c.manufacturer, "model": c.model, "specs": c.specs,
            "seen": [e.description for e in c.evidence][:3],
        }
        for c in bom.components if c.status != "rejected"
    ]
    issues = [
        {"issue_id": i.id, "severity": i.severity, "message": i.message, "component_ids": i.component_ids}
        for i in bom.issues if not i.resolved
    ]
    return components, issues


def infer_design(client: VisionClient, bom: RobotBOM, *, max_retries: int = 2) -> InferredDesign:
    """Query 1: settle every open issue and return a simple component list."""
    components, issues = _design_inputs(bom)
    return call_structured(
        client, [], DESIGN_SYSTEM, design_user_prompt(components, issues), InferredDesign,
        stage="design inference", max_retries=max_retries,
    )


def plan_sourcing(client: VisionClient, design: InferredDesign, *, max_retries: int = 2) -> SourcingPlan:
    """Query 2: apply the parts-research rules to pick search terms and shops."""
    return call_structured(
        client, [], SOURCING_SYSTEM, sourcing_user_prompt(design), SourcingPlan,
        stage="parts research", max_retries=max_retries,
    )


def clean_query(text: str) -> str:
    """One line of plain text, safe to put in a search URL."""
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"[\x00-\x1f\x7f<>\"`]", " ", text)
    return re.sub(r"\s+", " ", text).strip()[:MAX_QUERY_CHARS].strip()


def shop_links(query: str) -> dict[str, str]:
    """Search-result URL on every shop for ``query``. Built in code, never by the model."""
    return {key: prefix + quote_plus(query) for key, (_, _, prefix) in SHOPS.items()}


def components_document(bom: RobotBOM, design: InferredDesign, model: str) -> dict:
    return {
        "project_name": bom.project_name,
        "generated_by": model,
        "disclaimer": DESIGN_DISCLAIMER,
        "summary": design.summary,
        "design_choices": [d.model_dump() for d in design.design_choices],
        "components": [c.model_dump() for c in design.components],
    }


def order_links_document(bom: RobotBOM, design: InferredDesign, plan: SourcingPlan, model: str) -> dict:
    by_name = {s.component.strip().casefold(): s for s in plan.searches}
    rows = []
    for component in design.components:
        search = by_name.get(component.name.strip().casefold())
        query = clean_query(search.search_query) if search else ""
        query = query or clean_query(component.name)
        rows.append({
            "name": component.name,
            "quantity": component.quantity,
            "basis": component.basis,
            "search_query": query,
            "recommended_sites": search.recommended_sites if search else [],
            "note": search.note if search else "",
            "links": shop_links(query),
        })
    return {
        "project_name": bom.project_name,
        "generated_by": model,
        "disclaimer": LINKS_DISCLAIMER,
        "power_budget": plan.power_budget,
        "sites": {key: {"name": name, "url": home} for key, (name, home, _) in SHOPS.items()},
        "components": rows,
    }


def infer_and_source(client: VisionClient, bom: RobotBOM, *, model: str, max_retries: int = 2) -> dict:
    """Run both queries in order. Returns ``{"inferred_components": ..., "order_links": ...}``."""
    design = infer_design(client, bom, max_retries=max_retries)
    # The model decides what it calls a part, so it can relabel a guess as seen. A line stays
    # `observed` only if the BOM has an observed part of the same category.
    seen = {c.category for c in bom.components if c.evidence_type.value == "observed" and c.status != "rejected"}
    for component in design.components:
        if component.basis == "observed" and component.category not in seen:
            component.basis = "inferred"
    plan = plan_sourcing(client, design, max_retries=max_retries)
    return {
        "inferred_components": components_document(bom, design, model),
        "order_links": order_links_document(bom, design, plan, model),
    }
