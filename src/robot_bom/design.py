"""Optional "best guess" step: let the model settle every open design question.

This module produces two documents, both clearly labelled as the model's assumptions:

1. ``inferred_components.json`` - for each open issue the model picks the most likely
   design choice, then returns one simple, complete component list.
2. ``order_links.json`` - a second query, run after the first, applies the parts-research
   rules (``SOURCING_RULES``) to choose a search term and the best shops for each part.

The guess for the critical parts (motor, driver, power, controller) is then written into
the parts list as assumptions (``apply_design``): flagged in ``assumed_fields``, never
confirmed, and the deterministic checks are re-run on them.

Product pages come only from Mistral's web search tool, restricted to a fixed list of
shops, and each page is fetched to read its stock status. A URL the model writes itself
is never used. Search links for every shop are built in code as a fallback.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Literal
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .extraction import _extract_json, call_structured
from .models import AuditEntry, Component, EvidenceType, ReviewDocument, RobotBOM
from .prompts import CATEGORY_VOCABULARY
from .review import _merge_issues
from .suggest import SHOPS, clean_query, settle_unknowns, shop_links, suggestion_candidates
from .taxonomy import ROLE_CATEGORIES, IdAllocator
from .validation import RequirementsValidator, purchase_blockers
from .vision import VisionAPIError, VisionClient, system_trust_context

log = logging.getLogger(__name__)

DESIGN_DISCLAIMER = (
    "Suggestions, not verified. Every design choice and every line marked 'inferred' is the "
    "most likely guess from the photos and open issues - check it against the real robot. "
    "The suggested parts are also written into the parts list, tagged as not reviewed."
)
LINKS_DISCLAIMER = (
    "`products` are real pages returned by a web search on the approved shops at the time "
    "shown; `stock` is `in_stock` only where the shop's own product page said so when it was "
    "fetched, otherwise `unknown` (several shops block automated checks). Prices are not "
    "read. `links` are search links for each shop. The part choices themselves are model "
    "suggestions for an inferred design - check the specs on the page before ordering."
)

# Hosts whose pages may be offered as products. Anything else a search returns is ignored.
SHOP_HOSTS: dict[str, tuple[str, ...]] = {
    "lcsc": ("lcsc.com",),
    "digikey": ("digikey.co.uk", "digikey.com"),
    "rs": ("uk.rs-online.com",),
    "sparkfun": ("sparkfun.com",),
    "mouser": ("mouser.co.uk", "mouser.com"),
    "amazon": ("amazon.com",),
}
# Roles a robot cannot work without; the best guess for these is written into the parts list.
CRITICAL_ROLES = ("motor", "motor_driver", "power", "controller")
MAX_PRODUCTS_PER_PART = 3
MAX_PARTS_SEARCHED = 30
SEARCH_WORKERS = 4
STOCK_CHECK_TIMEOUT_S = 15.0
_BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/130.0 Safari/537.36",
    "Accept-Language": "en-GB,en;q=0.9",
}


# --------------------------------------------------------------------------
# Schemas
# --------------------------------------------------------------------------


def _as_text(value: object) -> str:
    """Free-text fields: models sometimes answer with an object or a list instead of a sentence."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        return "; ".join(f"{str(k).replace('_', ' ')}: {_as_text(v)}" for k, v in value.items() if _as_text(v))
    if isinstance(value, (list, tuple)):
        return "; ".join(text for text in map(_as_text, value) if text)
    return str(value)


def _free_text(*fields: str):
    return field_validator(*fields, mode="before")(_as_text)


def _text_specs(value: object) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {str(k): _as_text(v) for k, v in value.items() if _as_text(v)}


class DesignChoice(BaseModel):
    model_config = ConfigDict(extra="ignore")

    issue_id: str
    choice: str = Field(min_length=1)
    reason: str = ""

    _text = _free_text("choice", "reason")


class InferredComponent(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str = Field(min_length=1)
    category: str = "other"
    quantity: int = Field(ge=1)
    specs: dict[str, str] = Field(default_factory=dict)
    basis: Literal["observed", "inferred"] = "inferred"
    reason: str = ""
    bom_id: str | None = None  # the parts-list line this entry corresponds to, if any

    _text = _free_text("reason")

    @field_validator("bom_id", mode="before")
    @classmethod
    def _optional_id(cls, value: object) -> str | None:
        return value.strip() if isinstance(value, str) and value.strip() else None

    _specs = field_validator("specs", mode="before")(_text_specs)

    @field_validator("category", mode="before")
    @classmethod
    def _known_category(cls, value: object) -> str:
        return value if isinstance(value, str) and value in CATEGORY_VOCABULARY else "other"


class InferredDesign(BaseModel):
    """Reply to the design-inference query."""

    model_config = ConfigDict(extra="ignore")

    summary: str = ""
    _text = _free_text("summary")
    design_choices: list[DesignChoice] = Field(default_factory=list)
    components: list[InferredComponent] = Field(min_length=1)


class PartSearch(BaseModel):
    model_config = ConfigDict(extra="ignore")

    component: str = Field(min_length=1)
    search_query: str = Field(min_length=1)
    recommended_sites: list[str] = Field(default_factory=list)
    note: str = ""

    _text = _free_text("component", "search_query", "note")

    @field_validator("recommended_sites", mode="before")
    @classmethod
    def _known_sites(cls, value: object) -> list[str]:
        sites = [str(v).strip().lower() for v in value] if isinstance(value, list) else []
        return [s for s in dict.fromkeys(sites) if s in SHOPS]


class SourcingPlan(BaseModel):
    """Reply to the parts-research query."""

    model_config = ConfigDict(extra="ignore")

    power_budget: str = ""
    _text = _free_text("power_budget")
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
    {"bom_id": "<id of the parts-list line this is, or null for a new part>",
     "name": "generic part name", "category": "<category>", "quantity": 1,
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
        "- bom_id: copy the id of the parts-list line the component corresponds to. EVERY line "
        "whose evidence_type is `inferred` or `unknown` (the drive motor, motor driver, power "
        "source and controller placeholders) must be answered by a component carrying its id, "
        "unless your design really has no such part. Use null only for parts not in the list.",
        "- specs: plain numbers as strings, no units. Always use exactly these keys so the "
        "compatibility checks can run: power source (battery / battery holder / power supply): "
        "`voltage_v`, `capacity_mah`; every motor: `voltage_v` (rated) and `current_a` (stall); "
        "every motor driver or relay module that switches motors: `max_voltage_v` and "
        "`max_current_a` (per channel); controller: `logic_level_v`. Choose a driver whose "
        "max_voltage_v is at least the supply voltage and whose max_current_a is at least the "
        "motor current_a. Other useful keys: interface, size. They are your assumptions.",
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


def components_document(bom: RobotBOM, design: InferredDesign, model: str) -> dict:
    return {
        "project_name": bom.project_name,
        "generated_by": model,
        "disclaimer": DESIGN_DISCLAIMER,
        "summary": design.summary,
        "design_choices": [d.model_dump() for d in design.design_choices],
        "components": [c.model_dump() for c in design.components],
    }


# --------------------------------------------------------------------------
# Writing the best guess for the critical parts into the parts list
# --------------------------------------------------------------------------


def _critical(category: str) -> bool:
    return any(category in ROLE_CATEGORIES[role] for role in CRITICAL_ROLES)


def _same_role(a: str, b: str) -> bool:
    return any(a in ROLE_CATEGORIES[role] and b in ROLE_CATEGORIES[role] for role in CRITICAL_ROLES)


def apply_design(
    bom: RobotBOM, design: InferredDesign | None, *, now: str | None = None,
    locked: frozenset[str] = frozenset(), order_links: dict | None = None,
) -> RobotBOM:
    """Return a copy of ``bom`` with the model's best guess written into it.

    * A placeholder / unverified line the model answered takes the guessed name, quantity and
      specs and is marked ``inferred`` with ``assumed_fields`` listing what was guessed.
    * An observed critical line (e.g. a battery holder that was seen) only gains the specs
      and required quantity it was missing; other observed lines are left alone.
    * A guessed critical part with no line of its own (motor, driver, power, controller) is
      added. Non-critical guesses (screws, wire) stay in ``inferred_components.json`` only.
    * A line a human confirmed or rejected (or whose id is in ``locked``) is never overwritten
      by the guess, and nothing becomes ``confirmed``.

    Whatever is still unknown after that (the model left a part out, or ``design`` is None
    because the model could not be reached) is filled with a default suggestion, and every
    suggested part gets shop links: the product pages in ``order_links`` where the web search
    found some, a shop search link otherwise.

    The deterministic checks are then re-run on the result, so the "unknown" criticals close
    and real incompatibilities between the assumed values surface instead. Unreviewed lines
    do not block the BOM; they stay tagged ``needs_review``.
    """
    now = now or datetime.now(timezone.utc).isoformat(timespec="seconds")
    components = [c.model_copy(deep=True) for c in bom.components]
    by_id = {c.id: c for c in components}
    ids = IdAllocator(list(by_id))
    audit: list[AuditEntry] = []
    answered: set[str] = set()

    def target_for(guess: InferredComponent) -> Component | None:
        target = by_id.get(guess.bom_id or "")
        if target is not None and target.status != "rejected" and (
            target.category == guess.category or _same_role(target.category, guess.category)
            or guess.category == "other"
        ):
            return target
        if not _critical(guess.category):
            return None
        # no usable id: fall back to an unanswered unverified line with the same critical role
        for candidate in components:
            if (candidate.id not in answered and candidate.id not in locked and candidate.status == "needs_review"
                    and candidate.evidence_type is not EvidenceType.OBSERVED
                    and _same_role(candidate.category, guess.category)):
                return candidate
        return None

    for guess in design.components if design else []:
        target = target_for(guess)
        if target is None:
            if guess.basis == "observed" or not _critical(guess.category):
                continue
            target = Component(
                id=ids.new(guess.category), category=guess.category, name=guess.name,
                evidence_type=EvidenceType.INFERRED,
            )
            components.append(target)
            by_id[target.id] = target
            fields = ["name"]
        elif target.status != "needs_review" or target.id in answered or target.id in locked:
            continue  # a human already ruled on this line, or it was answered above
        elif target.evidence_type is EvidenceType.OBSERVED and not _critical(target.category):
            continue  # a part that was seen and is not critical needs no guessing
        else:
            fields = []
            if target.evidence_type is not EvidenceType.OBSERVED:
                if target.name != guess.name:
                    target.name = guess.name
                    fields.append("name")
                if guess.category != "other":
                    target.category = guess.category
                target.evidence_type = EvidenceType.INFERRED
        answered.add(target.id)
        if target.required_quantity is None:
            target.required_quantity = guess.quantity
            fields.append("required_quantity")
        for key, value in guess.specs.items():
            if key not in target.specs:
                target.specs[key] = value
                fields.append(f"specs.{key}")
        if not fields:
            continue
        target.assumed_fields = list(dict.fromkeys([*target.assumed_fields, *fields]))
        target.notes.append("AI best guess, not verified" + (f": {guess.reason}" if guess.reason else "."))
        audit.append(AuditEntry(timestamp=now, actor="ai-inference", action="ai_assumption", target=target.id,
                                field=", ".join(fields), old=None, new=guess.name))

    audit += settle_unknowns(components, now=now, locked=locked)
    checks = RequirementsValidator().validate(components, bom.connections, image_views=bom.image_views)
    issues = _merge_issues([i.model_copy(deep=True) for i in bom.issues], checks.issues, components)
    choices = {d.issue_id: d.choice for d in design.design_choices} if design else {}
    for issue in issues:
        # rule-based issues close only when the data satisfies the rule; the model's own
        # questions are answered by the design choice it has now made
        if not issue.resolved and issue.source == "model" and issue.id in choices:
            issue.resolved = True
            issue.resolution_note = "AI best guess (not verified): " + choices[issue.id]
    rows = {str(row.get("name", "")).strip().casefold(): row for row in (order_links or {}).get("components", [])}
    candidates = list(bom.catalog_candidates)
    candidates += suggestion_candidates(components, candidates, now=now, products=rows)
    blockers = purchase_blockers(components, issues)
    data = bom.model_dump(mode="json")
    data.update(
        components=[c.model_dump(mode="json") for c in components],
        issues=[i.model_dump(mode="json") for i in issues],
        catalog_candidates=[c.model_dump(mode="json") for c in candidates],
        audit_trail=data["audit_trail"] + [a.model_dump(mode="json") for a in audit],
        ready_to_purchase=not blockers,
        readiness_blockers=blockers,
    )
    return RobotBOM.model_validate(data)


def apply_design_to_review(
    review: ReviewDocument, design: InferredDesign | None, order_links: dict | None = None
) -> ReviewDocument:
    """Apply the guess to the edited BOM and to the baseline alike, so the audit trail keeps
    attributing the reviewer's own edits to the reviewer and the guesses to ``ai-inference``."""
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return review.model_copy(update={
        "bom": apply_design(review.bom, design, now=now, order_links=order_links),
        # lines the reviewer already ruled on stay untouched in the baseline too, so the two
        # documents differ only by the reviewer's own edits
        "baseline": apply_design(review.baseline, design, now=now, order_links=order_links,
                                 locked=frozenset(c.id for c in review.bom.components if c.status != "needs_review")),
    })


# --------------------------------------------------------------------------
# Real product pages: web search, then a stock check on the page itself
# --------------------------------------------------------------------------

WebSearch = Callable[[str], dict]
StockCheck = Callable[[str], str]

_AVAILABILITY = re.compile(
    r"""(?:schema\.org/|product:availability["']\s+content=["'])\s*"""
    r"""(InStock|OnlineOnly|LimitedAvailability|OutOfStock|SoldOut|Discontinued|BackOrder|PreOrder|PreSale|"""
    r"""in\s?stock|out\s?of\s?stock)""", re.I)
_NOT_A_PRODUCT = re.compile(r"/(search|catalogsearch|categories|category|c|s|b|clp|stores|blog|news|tutorials|learn)(/|\?|$)", re.I)


def shop_of(url: str) -> str | None:
    """Key of the approved shop a URL belongs to, or None."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    host = (parts.hostname or "").lower()
    if parts.scheme != "https":
        return None
    for key, hosts in SHOP_HOSTS.items():
        if any(host == h or host.endswith("." + h) for h in hosts):
            # an Amazon result is only a product when it is a /dp/ page
            return key if key != "amazon" or "/dp/" in parts.path else None
    return None


def product_search_prompt(query: str, name: str, specs: dict[str, str]) -> str:
    distributors = " OR ".join(f"site:{hosts[0]}" for key, hosts in SHOP_HOSTS.items() if key != "amazon")
    return "\n".join([
        f"Find product pages where this part can be ordered now: {name} (search term: {query}).",
        f"Required specs: {json.dumps(specs)}" if specs else "",
        "Use the web search tool, at most twice:",
        f"1. {query} ({distributors})",
        f"2. {query} site:amazon.com",
        "Then answer with ONLY a JSON object: {\"matches\": [\"<url>\", ...]} listing, best first, the URLs "
        "from the search results that are pages for one specific product matching the part and its specs. "
        "Copy URLs exactly from the results. Never write a URL that was not in the search results.",
    ])


def _search_results(response: dict) -> tuple[list[dict], list[str]]:
    """``(results the search tool returned, URLs the model picked)`` from a conversation response."""
    results: list[dict] = []
    answer = ""
    for entry in response.get("outputs") or []:
        if not isinstance(entry, dict):
            continue
        if entry.get("type") == "tool.execution" and entry.get("name") == "web_search":
            raw = (entry.get("info") or {}).get("result")
            try:
                found = json.loads(raw) if isinstance(raw, str) else raw
            except ValueError:
                found = None
            for item in (found.values() if isinstance(found, dict) else found if isinstance(found, list) else []):
                if isinstance(item, dict) and isinstance(item.get("url"), str):
                    results.append(item)
        elif entry.get("type") == "message.output":
            content = entry.get("content")
            if isinstance(content, list):
                content = "".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")
            if isinstance(content, str):
                answer += content
    picked: list[str] = []
    try:
        data = _extract_json(answer)
        if isinstance(data, dict) and isinstance(data.get("matches"), list):
            picked = [u for u in data["matches"] if isinstance(u, str)]
    except Exception:  # the answer is only a ranking hint; the search results are what count
        pass
    return results, picked


def page_stock(url: str, http: httpx.Client) -> str:
    """Stock status stated by the product page's own structured data, else ``unknown``."""
    try:
        response = http.get(url, headers=_BROWSER_HEADERS, timeout=STOCK_CHECK_TIMEOUT_S, follow_redirects=True)
    except httpx.HTTPError:
        return "unknown"
    if response.status_code != 200:
        return "unknown"
    states = {m.group(1).lower().replace(" ", "") for m in _AVAILABILITY.finditer(response.text[:2_000_000])}
    good = states & {"instock", "onlineonly", "limitedavailability"}
    bad = states & {"outofstock", "soldout", "discontinued"}
    if good and not bad:
        return "in_stock"
    if bad and not good:
        return "out_of_stock"
    if states & {"backorder", "preorder", "presale"} and not good:
        return "backorder"
    return "unknown"  # nothing stated, or the page lists several products with different states


def find_products(search: WebSearch, stock: StockCheck, query: str, name: str, specs: dict[str, str]) -> list[dict]:
    """Product pages on the approved shops for one part. Every URL comes from the search tool."""
    results, picked = _search_results(search(product_search_prompt(query, name, specs)))
    by_url = {r["url"]: r for r in results if shop_of(r["url"]) and not _NOT_A_PRODUCT.search(urlsplit(r["url"]).path + "?")}
    ordered = [u for u in dict.fromkeys(picked) if u in by_url] or list(by_url)
    products = []
    for url in ordered[: MAX_PRODUCTS_PER_PART * 2]:
        state = stock(url)
        if state == "out_of_stock":
            continue  # the shop's own page says it cannot be bought
        title = re.sub(r"\s+", " ", str(by_url[url].get("title") or "")).strip()[:160]
        products.append({"site": shop_of(url), "title": title, "url": url, "stock": state})
    products.sort(key=lambda p: {"in_stock": 0, "unknown": 1, "backorder": 2}[p["stock"]])
    return products[:MAX_PRODUCTS_PER_PART]


def add_products(document: dict, search: WebSearch, stock: StockCheck | None = None) -> dict:
    """Fill ``products`` for each row of an order-links document, in parallel."""
    http = None
    if stock is None:
        http = httpx.Client(verify=system_trust_context())
        stock = lambda url: page_stock(url, http)  # noqa: E731
    rows = document["components"][:MAX_PARTS_SEARCHED]
    errors: list[str] = []

    def work(row: dict) -> None:
        try:
            row["products"] = find_products(search, stock, row["search_query"], row["name"], row.get("specs") or {})
        except VisionAPIError as exc:
            errors.append(str(exc))
        except Exception as exc:  # one odd response must not sink the other parts
            log.warning("product search failed for %s: %s", row["name"], exc)
            errors.append(f"{exc.__class__.__name__}")

    try:
        with ThreadPoolExecutor(max_workers=SEARCH_WORKERS) as pool:
            list(pool.map(work, rows))
    finally:
        if http is not None:
            http.close()
    found = sum(1 for row in document["components"] if row["products"])
    document["availability"] = {
        "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "method": "Mistral web search restricted to the approved shops, then a stock check on each product page",
        "parts_with_products": found,
        "parts_total": len(document["components"]),
        "in_stock_confirmed": sum(1 for row in document["components"] for p in row["products"] if p["stock"] == "in_stock"),
        "error": errors[0] if errors and not found else (f"{len(errors)} part search(es) failed" if errors else None),
    }
    return document


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
            "specs": component.specs,
            "products": [],
            "links": shop_links(query),
        })
    return {
        "project_name": bom.project_name,
        "generated_by": model,
        "disclaimer": LINKS_DISCLAIMER,
        "power_budget": plan.power_budget,
        "availability": {"checked_at": None, "method": "not run", "parts_with_products": 0,
                         "parts_total": len(rows), "in_stock_confirmed": 0, "error": None},
        "sites": {key: {"name": name, "url": home} for key, (name, home, _) in SHOPS.items()},
        "components": rows,
    }


def best_guess(
    client: VisionClient, review: ReviewDocument, *, model: str, max_retries: int = 2,
    web_search: bool = True, stock_check: StockCheck | None = None,
) -> tuple[dict[str, dict], ReviewDocument]:
    """Everything the "AI best guess" step produces.

    Returns ``({"inferred_components": ..., "order_links": ...}, review)`` where ``review`` is
    the given review document with the guess for the critical parts written into it.
    """
    result = infer_and_source(client, review.bom, model=model, max_retries=max_retries,
                              web_search=web_search, stock_check=stock_check)
    design = result.pop("design")
    return result, apply_design_to_review(review, design, result["order_links"])


def default_guess(review: ReviewDocument, *, reason: str) -> tuple[dict[str, dict], ReviewDocument]:
    """What ``best_guess`` returns when the model cannot be used: no model call at all.

    The critical unknowns are filled with the built-in default suggestions and each suggested
    part gets shop search links, so a failed model call never leaves the BOM blocked.
    """
    review = apply_design_to_review(review, None)
    bom = review.bom
    note = f"The model could not be used ({reason}), so built-in default suggestions were applied instead."
    rows, parts = [], []
    for c in bom.components:
        if c.status == "rejected":
            continue
        basis = "observed" if c.evidence_type is EvidenceType.OBSERVED else "inferred"
        quantity = c.purchase_quantity or c.required_quantity or c.visible_quantity or 1
        query = clean_query(c.name)
        parts.append({"name": c.name, "category": c.category, "quantity": quantity, "specs": c.specs,
                      "basis": basis, "reason": "", "bom_id": c.id})
        rows.append({"name": c.name, "quantity": quantity, "basis": basis, "search_query": query,
                     "recommended_sites": [], "note": "", "specs": c.specs, "products": [],
                     "links": shop_links(query)})
    return {
        "inferred_components": {
            "project_name": bom.project_name, "generated_by": "built-in defaults", "disclaimer": DESIGN_DISCLAIMER,
            "summary": note, "design_choices": [], "components": parts,
        },
        "order_links": {
            "project_name": bom.project_name, "generated_by": "built-in defaults", "disclaimer": LINKS_DISCLAIMER,
            "power_budget": "",
            "availability": {"checked_at": None, "method": "not run (the model could not be used)",
                             "parts_with_products": 0, "parts_total": len(rows), "in_stock_confirmed": 0,
                             "error": None},
            "sites": {key: {"name": name, "url": home} for key, (name, home, _) in SHOPS.items()},
            "components": rows,
        },
    }, review


def infer_and_source(
    client: VisionClient, bom: RobotBOM, *, model: str, max_retries: int = 2,
    web_search: bool = True, stock_check: StockCheck | None = None,
) -> dict:
    """Run the queries in order.

    Returns ``{"inferred_components": ..., "order_links": ..., "design": InferredDesign}``.
    With ``web_search`` and a client that offers it, each part is also looked up on the
    approved shops and the product pages found are checked for stock.
    """
    design = infer_design(client, bom, max_retries=max_retries)
    # The model decides what it calls a part, so it can relabel a guess as seen. A line stays
    # `observed` only if the BOM has an observed part of the same category.
    seen = {c.category for c in bom.components if c.evidence_type.value == "observed" and c.status != "rejected"}
    for component in design.components:
        if component.basis == "observed" and component.category not in seen:
            component.basis = "inferred"
    plan = plan_sourcing(client, design, max_retries=max_retries)
    links = order_links_document(bom, design, plan, model)
    search = getattr(client, "web_search", None)
    if not web_search:
        links["availability"]["method"] = "switched off (ROBOT_BOM_WEB_SEARCH=0)"
    elif search is None:
        links["availability"]["method"] = "not available with this client (mock mode or a provider without web search)"
    else:
        add_products(links, search, stock_check)
    return {"inferred_components": components_document(bom, design, model), "order_links": links, "design": design}
