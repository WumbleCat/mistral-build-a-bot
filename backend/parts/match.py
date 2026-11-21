"""Deterministic parts matcher — the reliable baseline for BuildFromVision.

Turns identified robot components (Person 2 vision output) into a buyable BOM
using the curated catalogue. No LLM involved: category normalisation, then
category-first matching with rapidfuzz over name + aliases, then best-recipe
completion (incl. the 4-wheel rover rule).

Catalogue schema (uniform per item):
    {id, name, category, aliases:[], specs:{}, price:<number>, currency:"GBP"|"USD",
     price_note?:str, shop, sku?:str, url:"https://..."|"TODO", alternatives:[ids], verified:bool}

All money fields in the output are GBP (converted with USD_TO_GBP); BOM rows
also carry the original currency/price, sku, verified and price_note.

Accepted input shapes (see backend/shared/schemas.py):
    - plain list of VisionPart: [{"name","category","quantity","evidence","source_ids",
      "sku","product_url","review_required","notes"}, ...]
    - {"parts": [...], "robot_guess": ..., "owned": [...]}
    - legacy {"components": [{"name","category","qty"}], "owned": [...]}

Output shape (PROJECT_BRIEF.md section 8 + vision metadata):
    {"robot_name", "recipe_id", "recipe_confidence", "closest_recipe", "confidence",
     "parts", "bom", "bom_total_gbp", "unmatched"}
    bom rows: §8 keys (part_id, shop, url, unit_price_gbp, qty, line_total_gbp, owned)
    + currency, unit_price, sku, verified, price_note?, units_needed, packs_to_buy,
      status ("identified"|"suggested"), needs_check, notes?, source_ids
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any

from rapidfuzz import fuzz

PARTS_DIR = Path(__file__).parent
CATALOG_PATH = PARTS_DIR / "catalog.json"
RECIPES_PATH = PARTS_DIR / "recipes.json"

SCORE_THRESHOLD = 70        # rapidfuzz cutoff when NO category pool is used
CAT_POOL_THRESHOLD = 55     # relaxed cutoff inside a known category pool

# Researched ~0.745-0.765 on 2026-11-21; set to today's rate before the demo.
USD_TO_GBP = 0.75

# ---------------------------------------------------------------------------
# Category normaliser: free-text vision categories -> catalogue categories
# ---------------------------------------------------------------------------

CATEGORY_ALIASES: dict[str, list[str]] = {
    "wheel": ["wheel", "wheels", "tyre", "tires", "tyres", "tire"],
    "chassis": ["chassis", "frame", "frame/chassis", "body", "roll cage", "roll-cage", "robot base"],
    "power": ["power", "battery", "battery cells", "battery/power enclosure", "power enclosure",
              "battery enclosure", "cells", "power supply", "psu"],
    "wiring": ["wiring", "breadboard", "wires", "jumper wires", "jumper wire harness",
               "solderless breadboard", "harness"],
    "relay": ["relay", "relay_module", "relay module"],
    "switch": ["switch", "power switch", "slide switch"],
    "servo": ["servo", "steering", "steering servo", "steering linkage"],
    "fasteners": ["fasteners", "mechanical hardware", "hardware", "screws", "screw kit", "axles", "hubs"],
    "misc": ["misc", "tape", "duct tape"],
    "motor": ["motor", "motors", "drive motor", "drive motors", "gearmotor"],
    "motor_driver": ["motor_driver", "motor driver", "esc"],
    "controller": ["controller", "mcu", "receiver", "main controller", "main board"],
    "sensor": ["sensor", "sensors"],
    "other": ["other", "unknown"],
}

_ALIAS_TO_CAT: dict[str, str] = {}
for _cat, _aliases in CATEGORY_ALIASES.items():
    _ALIAS_TO_CAT[_cat] = _cat
    for _a in _aliases:
        _ALIAS_TO_CAT[_a] = _cat


def normalise_category(text: str | None) -> str:
    """Free-text category -> one of the catalogue categories (fuzzy; unknown -> 'other')."""
    t = (text or "").lower().strip()
    if not t:
        return "other"
    if t in _ALIAS_TO_CAT:
        return _ALIAS_TO_CAT[t]
    for tok in re.findall(r"[a-z0-9]+", t):
        if tok in _ALIAS_TO_CAT:
            return _ALIAS_TO_CAT[tok]
    best, best_cat = 0.0, None
    for alias, cat in _ALIAS_TO_CAT.items():
        s = fuzz.token_set_ratio(t, alias)
        if s > best:
            best, best_cat = s, cat
    return best_cat if best >= 75 else "other"


# ---------------------------------------------------------------------------
# Catalogue loading
# ---------------------------------------------------------------------------

_catalog_cache: dict | None = None
_recipes_cache: dict | None = None


def load_catalog() -> dict:
    global _catalog_cache
    if _catalog_cache is None:
        _catalog_cache = json.loads(CATALOG_PATH.read_text())
    return _catalog_cache


def load_recipes() -> dict:
    global _recipes_cache
    if _recipes_cache is None:
        _recipes_cache = json.loads(RECIPES_PATH.read_text())
    return _recipes_cache


def catalog_items() -> list[dict]:
    return load_catalog()["items"]


def catalog_categories() -> list[str]:
    return load_catalog().get("categories", [])


def get_item(part_id: str) -> dict | None:
    for item in catalog_items():
        if item["id"] == part_id:
            return item
    return None


def _item_price(item: dict) -> tuple[float, str]:
    """(original price, currency); legacy price_gbp tolerated."""
    if "price" in item:
        return float(item["price"]), str(item.get("currency", "GBP"))
    return float(item.get("price_gbp", 0.0)), "GBP"


def item_price_gbp(item: dict) -> float:
    price, currency = _item_price(item)
    return to_gbp(price, currency)


def to_gbp(price: float, currency: str) -> float:
    """Convert an original-currency price to GBP (USD at USD_TO_GBP, 2dp)."""
    if str(currency or "GBP").upper() == "USD":
        return round(float(price) * USD_TO_GBP, 2)
    return float(price)


def _pack_size(item: dict) -> int:
    try:
        p = int(item.get("specs", {}).get("pack_size", 1) or 1)
    except (TypeError, ValueError):
        p = 1
    return p if p > 0 else 1


# ---------------------------------------------------------------------------
# Scoring / matching
# ---------------------------------------------------------------------------


def _score(query: str, item: dict) -> float:
    """Best score of the query against the item name and aliases.

    token_set_ratio alone gives 100 to subset matches (alias "arduino" matches
    "arduino nano"), so we blend in plain ratio to prefer exact/longer matches.
    """
    q = query.lower().strip()
    best = 0.0
    for c in [item["name"]] + list(item.get("aliases", [])):
        cl = c.lower()
        if q == cl:
            return 100.0
        best = max(best, 0.7 * fuzz.token_set_ratio(q, cl) + 0.3 * fuzz.ratio(q, cl))
    return best


def search_catalog(query: str, category: str | None = None, limit: int = 5) -> list[dict]:
    """Catalogue search (client tool for the catalog-matcher agent).

    Only IDs that exist in the catalogue are returned. `category` may be free
    text (it is normalised). Hits carry price_gbp (converted), currency, sku.
    """
    items = catalog_items()
    if category:
        cat = normalise_category(category)
        filtered = [i for i in items if i["category"].lower() == cat]
        if filtered:
            items = filtered
    scored = sorted(
        ((_score(query, i), i) for i in items),
        key=lambda t: (t[0], bool(t[1].get("verified", False))),
        reverse=True,
    )
    hits = []
    for s, i in scored[:limit]:
        price, currency = _item_price(i)
        hits.append({
            "id": i["id"], "name": i["name"], "category": i["category"], "score": round(s, 1),
            "price_gbp": to_gbp(price, currency), "currency": currency,
            "shop": i["shop"], "sku": i.get("sku"),
        })
    return hits


def _match_component(part: dict) -> tuple[str | None, float]:
    """Match one normalised part to a catalogue ID. Returns (part_id, score).

    If the normalised category exists in the catalogue, only that pool is
    searched (with a relaxed threshold — the category already disambiguates);
    otherwise all items are searched at SCORE_THRESHOLD. Ties prefer verified.
    """
    name = str(part.get("name", "")).strip()
    if not name:
        return None, 0.0
    cat = part.get("category") or "other"
    cats = catalog_categories()
    items = catalog_items()
    if cat in cats:
        pool = [i for i in items if i["category"].lower() == cat]
        threshold = CAT_POOL_THRESHOLD
    else:
        pool = items
        threshold = SCORE_THRESHOLD
    best_id, best_score, best_verified = None, 0.0, False
    for item in pool:
        s = _score(name, item)
        v = bool(item.get("verified", False))
        if s > best_score or (s == best_score and v and not best_verified):
            best_id, best_score, best_verified = item["id"], s, v
    if best_score >= threshold:
        return best_id, best_score
    return None, best_score


# ---------------------------------------------------------------------------
# Recipe selection
# ---------------------------------------------------------------------------


def _pick_recipe(matched: dict[str, dict], hint: str | None = None) -> tuple[dict | None, float, str | None]:
    """Pick the best recipe. Returns (recipe, recipe_confidence, closest_recipe_id).

    - robot_guess hint fuzzy-matching a recipe id/name wins.
    - 4+ wheel units detected -> prefer rover_4wd.
    - otherwise best overlap score.
    """
    recipes = load_recipes()["recipes"]
    if not recipes:
        return None, 0.0, None
    if hint:
        h = hint.lower().strip()
        for rec in recipes:
            if fuzz.token_set_ratio(h, rec["id"].replace("_", " ")) >= 70 or \
               fuzz.token_set_ratio(h, rec["name"].lower()) >= 70:
                return rec, 1.0, None
    wheel_units = sum(
        (info.get("units") or 0)
        for pid, info in matched.items()
        if (get_item(pid) or {}).get("category") == "wheel"
    )
    scored = []
    for rec in recipes:
        rec_ids = {p["id"] for p in rec["parts"]}
        if not rec_ids:
            continue
        overlap = len(set(matched) & rec_ids)
        score = overlap / len(rec_ids) + 0.25 * (overlap / max(len(matched), 1))
        scored.append((score, rec))
    scored.sort(key=lambda t: t[0], reverse=True)
    if not scored:
        return None, 0.0, None
    def _closest_excluding(excl_id: str) -> str | None:
        for _, rec in scored:
            if rec["id"] != excl_id:
                return rec["id"]
        return None

    if wheel_units >= 4:
        for score, rec in scored:
            if rec["id"] == "rover_4wd":
                return rec, round(score, 2), _closest_excluding("rover_4wd")
    return scored[0][1], round(scored[0][0], 2), _closest_excluding(scored[0][1]["id"])


# ---------------------------------------------------------------------------
# BOM building
# ---------------------------------------------------------------------------


def build_bom(matched: dict[str, dict], owned: set[str],
              added_from_recipe: set[str]) -> tuple[list[dict], float]:
    """Build BOM rows + GBP total (owned parts excluded from the total).

    `matched` maps part_id -> info {units, evidence, source_ids, review_required,
    notes, ...}. Component-sourced quantities are unit counts converted to packs
    via specs.pack_size (row gets units_needed + packs_to_buy, qty = packs).
    Recipe-completed quantities are already pack-aware and pass through.
    """
    cat_order = {c: n for n, c in enumerate(catalog_categories())}
    rows = []
    total = 0.0
    for part_id, info in matched.items():
        item = get_item(part_id)
        if item is None:
            continue
        unit_orig, currency = _item_price(item)
        unit_gbp = to_gbp(unit_orig, currency)
        pack = _pack_size(item)
        if part_id in added_from_recipe:
            packs = int(info.get("units") or 1)
            units_needed = packs * pack
        else:
            units = int(info.get("units") or 1)
            packs = math.ceil(units / pack)
            units_needed = units
        line = round(unit_gbp * packs, 2)
        is_owned = part_id in owned
        if not is_owned:
            total += line
        evidence = info.get("evidence", "visible")
        row = {
            "part_id": part_id,
            "name": item["name"],
            "category": item["category"],
            "shop": item["shop"],
            "url": item.get("url", "TODO"),
            "currency": currency,
            "unit_price": unit_orig,
            "unit_price_gbp": unit_gbp,
            "sku": item.get("sku"),
            "verified": bool(item.get("verified", False)),
            "qty": packs,
            "units_needed": units_needed,
            "packs_to_buy": packs,
            "line_total_gbp": line,
            "owned": is_owned,
            "added_from_recipe": part_id in added_from_recipe,
            "status": "identified" if evidence == "visible" else "suggested",
            "needs_check": bool(info.get("review_required", False)),
            "source_ids": list(info.get("source_ids", [])),
        }
        if info.get("notes"):
            row["notes"] = info["notes"]
        if item.get("price_note"):
            row["price_note"] = item["price_note"]
        rows.append(row)
    rows.sort(key=lambda r: (cat_order.get(r["category"], 99), r["name"]))
    return rows, round(total, 2)


# ---------------------------------------------------------------------------
# Input normalisation
# ---------------------------------------------------------------------------


def _normalize_parts(payload: dict | list) -> tuple[list[dict], set[str], str | None]:
    """Normalize any accepted input shape to a list of part dicts.

    Each part: {name, raw_category, category (normalised), units (None when
    quantity null + inferred), evidence, source_ids, review_required, notes}.
    """
    if isinstance(payload, list):
        payload = {"parts": payload}
    raw = payload.get("components") or payload.get("parts") or []
    parts = []
    for p in raw:
        p = p.model_dump() if hasattr(p, "model_dump") else dict(p or {})
        qty = p.get("quantity", p.get("qty", 1))
        evidence = p.get("evidence", "visible") or "visible"
        try:
            units = int(qty) if qty is not None else None
        except (TypeError, ValueError):
            units = 1
        if units is None and evidence == "inferred":
            units = None  # resolve from recipe qty (or 1) later
        elif units is None:
            units = 1
        raw_cat = p.get("category") or ""
        parts.append({
            "name": p.get("name", ""),
            "raw_category": raw_cat,
            "category": normalise_category(raw_cat),
            "units": units,
            "evidence": evidence,
            "source_ids": list(p.get("source_ids") or []),
            "review_required": bool(p.get("review_required", False)),
            "notes": p.get("notes"),
        })
    owned = set(payload.get("owned") or [])
    hint = payload.get("robot_guess")
    return parts, owned, hint


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------


def match_components(payload: dict | list) -> dict:
    """Deterministic match. Accepts any shape from _normalize_parts."""
    parts_in, owned, recipe_hint = _normalize_parts(payload)

    matched: dict[str, dict] = {}
    parts_out: list[dict] = []
    unmatched: list[dict] = []
    for part in parts_in:
        pid, score = _match_component(part)
        if pid:
            item = get_item(pid) or {}
            info = matched.setdefault(pid, {
                "units": 0, "evidence": "inferred", "source_ids": [],
                "review_required": False, "notes": None,
            })
            if part["units"] is not None:
                info["units"] = (info["units"] or 0) + part["units"]
            if part["evidence"] == "visible":
                info["evidence"] = "visible"
            info["source_ids"] = list(dict.fromkeys(info["source_ids"] + part["source_ids"]))
            info["review_required"] = info["review_required"] or part["review_required"]
            info["notes"] = info["notes"] or part["notes"]
            parts_out.append({
                "id": pid,
                "name": item.get("name", part["name"]),
                "category": item.get("category", part["category"]),
                "qty": part["units"] if part["units"] is not None else 1,
                "evidence": part["evidence"],
                "source_ids": part["source_ids"],
                "review_required": part["review_required"],
                "visible_in_photo": part["evidence"] == "visible",
            })
        else:
            unmatched.append({
                "name": part["name"],
                "category": part["category"],
                "raw_category": part["raw_category"],
                "qty": part["units"] if part["units"] is not None else 1,
                "evidence": part["evidence"],
                "notes": part["notes"],
                "source_ids": part["source_ids"],
                "review_required": part["review_required"],
                "best_score": round(score, 1),
            })

    recipe, recipe_confidence, closest_recipe = _pick_recipe(matched, hint=recipe_hint)
    added_from_recipe: set[str] = set()
    if recipe is not None:
        recipe_parts = {p["id"]: p["qty"] for p in recipe["parts"]}
        # resolve inferred/null quantities from the recipe (or 1)
        for pid, info in matched.items():
            if info["units"] is None:
                info["units"] = recipe_parts.get(pid, 1)
        # chassis swap: if the recipe wants a different chassis than the one
        # matched from the photo (e.g. 4WD rover frame vs 2WD kit), prefer the recipe's
        recipe_chassis = next((pid for pid in recipe_parts
                               if (get_item(pid) or {}).get("category") == "chassis"), None)
        if recipe_chassis:
            for pid in [p for p in matched if (get_item(p) or {}).get("category") == "chassis" and p != recipe_chassis]:
                del matched[pid]
                parts_out = [p for p in parts_out if p["id"] != pid]
            if recipe_chassis not in matched:
                matched[recipe_chassis] = {"units": recipe_parts[recipe_chassis], "evidence": "inferred",
                                           "source_ids": [], "review_required": False, "notes": None}
                added_from_recipe.add(recipe_chassis)
        # add missing recipe parts
        for pid, qty in recipe_parts.items():
            if pid not in matched:
                matched[pid] = {"units": qty, "evidence": "inferred", "source_ids": [],
                                "review_required": False, "notes": None}
                added_from_recipe.add(pid)

    bom, total = build_bom(matched, owned, added_from_recipe)
    confidence = round(len(parts_out) / len(parts_in), 2) if parts_in else 0.0
    return {
        "robot_name": recipe["name"] if recipe else "Custom robot",
        "recipe_id": recipe["id"] if recipe else None,
        "recipe_confidence": recipe_confidence,
        "closest_recipe": closest_recipe,
        "confidence": confidence,
        "parts": parts_out,
        "bom": bom,
        "bom_total_gbp": total,
        "unmatched": unmatched,
    }


if __name__ == "__main__":
    import sys
    payload = json.loads(sys.stdin.read()) if not sys.argv[1:] else json.loads(Path(sys.argv[1]).read_text())
    print(json.dumps(match_components(payload), indent=2))
