"""Default suggestions for whatever is still unknown, so an open question never blocks the BOM.

When a critical part (drive motor, motor driver, power source, controller) or one of the
ratings the compatibility checks need is still unknown after the photos, the model's best
guess and the review, this module proposes a common hobby part or value for it instead of
leaving the BOM blocked. Every value it writes is listed in the component's
``assumed_fields`` and recorded in the audit trail; nothing is marked confirmed.

It also builds the shop links for suggested parts. Search links are built in code; product
pages are only ever ones a web search returned (see ``design.find_products``).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import quote_plus

from .models import AuditEntry, CatalogCandidate, Component, EvidenceType
from .taxonomy import IdAllocator, has_role
from .validation import _established, parse_number

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
MAX_QUERY_CHARS = 120

SUGGESTION_NOTE = "Suggested by the app, not verified"
DEFAULT_ACTION = "default_suggestion"
# Shops a search link is listed for when no product page was found for a suggested part.
SEARCH_LINK_SHOPS = ("amazon", "sparkfun")


def clean_query(text: str) -> str:
    """One line of plain text, safe to put in a search URL."""
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"[\x00-\x1f\x7f<>\"`]", " ", text)
    return re.sub(r"\s+", " ", text).strip()[:MAX_QUERY_CHARS].strip()


def shop_links(query: str) -> dict[str, str]:
    """Search-result URL on every shop for ``query``. Built in code, never by the model."""
    return {key: prefix + quote_plus(query) for key, (_, _, prefix) in SHOPS.items()}


# --------------------------------------------------------------------------
# Default parts
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class DefaultPart:
    category: str
    name: str
    quantity: int
    specs: dict[str, str] = field(default_factory=dict)


def _num(value: float) -> str:
    return f"{value:g}"


def _default_power() -> DefaultPart:
    return DefaultPart("battery_holder", "4 x AA battery holder with switch, 6 V", 1,
                       {"voltage_v": "6", "capacity_mah": "2000"})


def _default_controller() -> DefaultPart:
    return DefaultPart("microcontroller", "Arduino Uno R3", 1, {"logic_level_v": "5"})


def _default_motor(supply: float | None, driver_limit: float | None = None) -> DefaultPart:
    # rated at the supply voltage and within the driver that is already there, so the
    # suggestion is consistent with the rest; 6 V TT motors below 6 V
    volts = supply if supply is not None and supply > 6 else 6.0
    amps = min(1.5, driver_limit) if driver_limit else 1.5
    name = "TT DC gear motor with gearbox, 3-6 V" if volts <= 6 else f"DC gear motor, {_num(volts)} V"
    return DefaultPart("motor", name, 2, {"voltage_v": _num(volts), "current_a": _num(amps)})


def _default_driver(supply: float | None, motor_current: float | None) -> DefaultPart:
    if (motor_current or 0) <= 2 and (supply or 0) <= 35:
        return DefaultPart("motor_driver", "L298N dual H-bridge motor driver module", 1,
                           {"max_voltage_v": "35", "max_current_a": "2"})
    return DefaultPart("motor_driver", "BTS7960 43 A H-bridge motor driver module", 1,
                       {"max_voltage_v": "27", "max_current_a": "43"})


def _default_relay() -> DefaultPart:
    return DefaultPart("relay_module", "5 V relay module, 10 A contacts", 1,
                       {"max_voltage_v": "30", "max_current_a": "10"})


# --------------------------------------------------------------------------
# Filling in what is still unknown
# --------------------------------------------------------------------------


def settle_unknowns(
    components: list[Component], *, now: str, locked: frozenset[str] = frozenset()
) -> list[AuditEntry]:
    """Fill every critical unknown in ``components`` (in place) with a default suggestion.

    * A critical role with no line at all gets a suggested part.
    * A line nobody has seen or confirmed (a placeholder, or a part the model only proposed)
      becomes the suggested part.
    * A line that was seen or confirmed keeps its identity and only gains the ratings the
      compatibility checks need and it does not have.
    * A suggested motor driver that cannot take the supply voltage or the motor current is
      swapped for one that can, so two suggestions never block each other.
    * A suggested part gets a purchase quantity (its required quantity).

    Rejected lines and ids in ``locked`` are never touched, and a role the reviewer ruled out
    (all of its lines rejected) is not re-added. Returns one audit entry per changed line;
    running it again on the result changes nothing.
    """
    active = [c for c in components if c.status != "rejected"]
    if not any(c.evidence_type is EvidenceType.OBSERVED for c in active):
        return []  # nothing was seen in the photos: there is no robot to complete
    ids = IdAllocator([c.id for c in components])
    changes: dict[str, dict[str, object]] = {}

    def role(name: str) -> list[Component]:
        return [c for c in components if c.status != "rejected" and has_role(c, name)]

    def ruled_out(name: str) -> bool:
        lines = [c for c in components if has_role(c, name)]
        return bool(lines) and all(c.status == "rejected" for c in lines)

    def record(component: Component, key: str, value: object) -> None:
        changes.setdefault(component.id, {})[key] = value
        if key not in component.assumed_fields and key != "created":
            component.assumed_fields.append(key)

    def fill_specs(component: Component, specs: dict[str, str], keys: tuple[str, ...] | None = None) -> None:
        for key in keys or tuple(specs):
            if parse_number(component.specs.get(key)) is None:
                component.specs[key] = specs[key]
                record(component, f"specs.{key}", specs[key])

    def create(default: DefaultPart) -> Component:
        component = Component(id=ids.new(default.category), category=default.category, name=default.name,
                              evidence_type=EvidenceType.INFERRED)
        components.append(component)
        record(component, "created", True)
        become(component, default)
        return component

    def become(component: Component, default: DefaultPart) -> None:
        """Turn a line nobody has seen or confirmed into the suggested part."""
        if component.name != default.name and "created" not in changes.get(component.id, {}):
            component.notes.append(f"{SUGGESTION_NOTE}: this line was listed as '{component.name}'.")
            component.name = default.name
        record(component, "name", component.name)
        if component.evidence_type is not EvidenceType.INFERRED:
            component.evidence_type = EvidenceType.INFERRED
            record(component, "evidence_type", "inferred")
        if component.required_quantity is None:
            component.required_quantity = default.quantity
            record(component, "required_quantity", default.quantity)
        if component.purchase_quantity is None:
            component.purchase_quantity = component.required_quantity
            record(component, "purchase_quantity", component.purchase_quantity)
        fill_specs(component, default.specs)

    def settle(component: Component, default: DefaultPart, keys: tuple[str, ...]) -> None:
        if component.id in locked:
            return
        if _established(component):
            fill_specs(component, default.specs, keys)
        else:
            become(component, default)

    # ---- power source: someone must supply a known voltage ----
    supply: float | None = None
    if not ruled_out("power"):
        sources = role("power")
        holder = next((c for c in sources if parse_number(c.specs.get("voltage_v")) is not None), None)
        if holder is None:
            holder = sources[0] if sources else create(_default_power())
        settle(holder, _default_power(), ("voltage_v",))
        supply = parse_number(holder.specs.get("voltage_v"))

    # ---- controller: one identified board ----
    if not ruled_out("controller"):
        boards = role("controller")
        if not boards:
            create(_default_controller())
        elif not any(_established(c) for c in boards):
            settle(boards[0], _default_controller(), ())

    # ---- drivetrain: motors and the stage that switches them ----
    wheeled = any(role(r) for r in ("wheel", "motor", "motor_driver", "relay"))
    if wheeled and not ruled_out("motor"):
        drivers = role("motor_driver") or role("relay")
        limits = [parse_number(d.specs.get("max_current_a")) for d in drivers]
        motor_default = _default_motor(supply, min((a for a in limits if a), default=None))
        motors = role("motor") or [create(motor_default)]
        for motor in motors:
            settle(motor, motor_default, ("voltage_v", "current_a"))
            counted = motor.visible_quantity is not None or motor.required_quantity is not None
            if not counted and motor.id not in locked:
                motor.required_quantity = motor_default.quantity
                record(motor, "required_quantity", motor.required_quantity)
        currents = [parse_number(m.specs.get("current_a")) for m in motors]
        peak = max((a for a in currents if a is not None), default=None)
        if not drivers and not ruled_out("motor_driver"):
            drivers = [create(_default_driver(supply, peak))]
        for driver in drivers:
            default = _default_relay() if has_role(driver, "relay") else _default_driver(supply, peak)
            settle(driver, default, ("max_voltage_v", "max_current_a"))
            max_v, max_a = (parse_number(driver.specs.get(k)) for k in ("max_voltage_v", "max_current_a"))
            min_v = parse_number(driver.specs.get("min_voltage_v"))
            unfit = ((supply is not None and max_v is not None and supply > max_v)
                     or (supply is not None and min_v is not None and supply < min_v)
                     or (peak is not None and max_a is not None and peak > max_a))
            if unfit and is_suggested(driver) and driver.id not in locked and default.name != driver.name:
                # a suggestion that does not fit the rest is replaced, not left as a blocker
                driver.notes.append(f"{SUGGESTION_NOTE}: replaced '{driver.name}', which cannot take the "
                                    "supply voltage or motor current assumed for this robot.")
                driver.name = default.name
                record(driver, "name", driver.name)
                driver.specs.pop("min_voltage_v", None)
                for key, value in default.specs.items():
                    driver.specs[key] = value
                    record(driver, f"specs.{key}", value)

    for component in components:
        if (is_suggested(component) and component.id not in locked and component.purchase_quantity is None
                and component.required_quantity is not None):
            component.purchase_quantity = component.required_quantity
            record(component, "purchase_quantity", component.purchase_quantity)

    by_id = {c.id: c for c in components}
    audit = []
    for component_id, new in changes.items():
        component = by_id[component_id]
        component.notes.append(
            f"{SUGGESTION_NOTE}: " + ", ".join(k for k in new if k != "created")
            + " filled in with a common hobby part/value because it was unknown. Check it against the real robot."
        )
        audit.append(AuditEntry(timestamp=now, actor="robot-bom", action=DEFAULT_ACTION, target=component_id,
                                field=", ".join(k for k in new if k != "created"), old=None, new=new))
    return audit


def default_values(audit_trail: list[AuditEntry]) -> dict[str, dict[str, object]]:
    """``{component id: {field: value}}`` written by earlier default-suggestion steps."""
    values: dict[str, dict[str, object]] = {}
    for entry in audit_trail:
        if entry.action == DEFAULT_ACTION and isinstance(entry.new, dict):
            values.setdefault(entry.target, {}).update(entry.new)
    return values


# --------------------------------------------------------------------------
# Where to buy a suggested part
# --------------------------------------------------------------------------


def is_suggested(component: Component) -> bool:
    """True when the part itself (not just one of its ratings) is a suggestion."""
    return component.status == "needs_review" and "name" in component.assumed_fields


def is_suggestion_candidate(candidate: CatalogCandidate) -> bool:
    return candidate.evidence_notes.startswith(SUGGESTION_NOTE)


def suggestion_candidates(
    components: list[Component],
    existing: list[CatalogCandidate],
    *,
    now: str,
    products: dict[str, dict] | None = None,
) -> list[CatalogCandidate]:
    """Shop links for suggested parts that have none in ``existing``.

    ``products`` maps a casefolded part name to its row of an order-links document: the
    product pages a web search found are listed first. Without any, a search link on the
    hobby shops is listed, so a suggested part always comes with somewhere to buy it.
    """
    have = {c.component_id for c in existing}
    out: list[CatalogCandidate] = []
    for component in components:
        if component.id in have or not is_suggested(component):
            continue
        row = (products or {}).get(component.name.strip().casefold()) or {}
        query = clean_query(str(row.get("search_query") or "")) or clean_query(component.name)
        for rank, product in enumerate(row.get("products") or []):
            if product.get("site") not in SHOPS:
                continue
            out.append(CatalogCandidate(
                component_id=component.id, vendor=SHOPS[product["site"]][0],
                title=product.get("title") or component.name, product_url=product["url"],
                evidence_notes=(f"{SUGGESTION_NOTE}: product page found by web search for '{query}'; stock on the "
                                f"page: {str(product.get('stock', 'unknown')).replace('_', ' ')}. Check the specs "
                                "before ordering."),
                query=query, queried_at=now, match_score=round(max(0.2, 1 - 0.1 * rank), 2),
            ))
        if any(c.component_id == component.id for c in out):
            continue
        links = shop_links(query)
        for key in SEARCH_LINK_SHOPS:
            out.append(CatalogCandidate(
                component_id=component.id, vendor=SHOPS[key][0], title=f"Search: {query}",
                product_url=links[key],
                evidence_notes=f"{SUGGESTION_NOTE}: shop search link for the suggested part, not a specific product.",
                query=query, queried_at=now, match_score=0.1,
            ))
    return out
