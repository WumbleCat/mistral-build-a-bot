"""Public Python interface to the Parts & Shop service — for teammates who want
to call the parts code directly (no HTTP). Person 2 (vision) can pass its exact
output format straight in.

    import sys; sys.path.insert(0, "backend")
    from parts.parts_api import build_bom, build_bom_smart, search_live, get_catalog, get_recipes

    bom = build_bom(vision_parts)            # instant, deterministic, no AI
    bom = build_bom_smart(vision_parts)      # agents + live prices (uses cache)
    offers = search_live("SG90 servo")       # Mouser + LCSC live offers

Accepted `vision_parts` shapes: a plain list of dicts in Person 2's format
([{"name", "category", "quantity", "evidence", "source_ids", "sku",
   "product_url", "review_required", "notes"}, ...]) or list of VisionPart models.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any, Union

from . import agents, live, match

if TYPE_CHECKING:  # type hints only; no runtime import path requirements
    from shared.schemas import VisionPart

VisionParts = Union[list[dict], "list[VisionPart]"]


def _as_dicts(vision_parts: VisionParts) -> list[dict]:
    """Accept list[dict] or list[VisionPart] (pydantic) -> list[dict]."""
    out = []
    for p in vision_parts or []:
        out.append(p.model_dump() if hasattr(p, "model_dump") else dict(p))
    return out


def build_bom(vision_parts: VisionParts, owned: list[str] | None = None) -> dict:
    """Instant deterministic BOM. No AI, no network. <50 ms.

    Args:
        vision_parts: Person 2's vision output — a plain list of part dicts
            ({"name", "category", "quantity", "evidence", ...}) or VisionPart models.
        owned: catalogue part IDs the user already owns (excluded from the total).

    Returns:
        dict with robot_name, recipe_id, recipe_confidence, closest_recipe,
        confidence, parts, bom (rows incl. unit_price_gbp, qty, packs_to_buy,
        status, needs_check, source_ids, ...), bom_total_gbp, unmatched.
    """
    payload = {"parts": _as_dicts(vision_parts), "owned": list(owned or [])}
    return match.match_components(payload)


def build_bom_smart(vision_parts: VisionParts, owned: list[str] | None = None) -> dict:
    """Multi-agent BOM + live prices. Uses the Mistral agents (catalog-matcher,
    price-scout, substitution-advisor, bom-auditor in parallel, coordinator last)
    and attaches live_offers / live_offers_similar per row. Results are cached
    (memory + file), so repeated calls with the same input return instantly.
    Falls back to the deterministic build_bom result on any agent failure.

    Async-safe: callable from sync code and from inside a running event loop.
    Set BFV_MOCK=1 to skip the agents (deterministic result, still cached).
    """
    payload = {"parts": _as_dicts(vision_parts), "owned": list(owned or [])}
    try:
        asyncio.get_running_loop()
        running = True
    except RuntimeError:
        running = False
    if not running:
        return asyncio.run(agents.smart_match_async(payload))
    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(1) as ex:
        return ex.submit(asyncio.run, agents.smart_match_async(payload)).result()


def search_live(keyword: str, limit: int = 5) -> dict:
    """Live shop search: Mouser (needs MOUSER_API_KEY in .env) + LCSC (free).

    Returns {"q", "lcsc": [...], "mouser": [...], "exact": [...], "similar": [...]}.
    Every offer carries match_quality ("exact"|"similar") — for module categories
    (motor_driver/controller/sensor/relay) bare-IC hits are "similar" and listed
    separately. Cached 1 h; a failing shop API yields [] — never raises.
    """
    lcsc = live.lcsc_search(keyword, limit=limit)
    mouser = live.mouser_search(keyword, records=limit)
    best = match.search_catalog(keyword, limit=1)
    item = match.get_item(best[0]["id"]) if best and best[0]["score"] >= match.SCORE_THRESHOLD else None
    for o in lcsc + mouser:
        o["match_quality"] = live.classify_offer(o, (item or {}).get("category"), item)
    exact, similar = live.split_offers(lcsc + mouser)
    return {"q": keyword, "lcsc": lcsc, "mouser": mouser, "exact": exact, "similar": similar}


def get_catalog() -> list[dict]:
    """The full parts catalogue as a list of item dicts (id, name, category,
    aliases, specs, price, currency, shop, sku, url, verified, alternatives)."""
    return match.catalog_items()


def get_recipes() -> list[dict]:
    """All build recipes: [{id, name, difficulty, description, parts: [{id, qty}], power_notes?}]."""
    return match.load_recipes()["recipes"]
