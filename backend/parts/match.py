"""Deterministic parts matcher — the reliable baseline for BuildFromVision.

Turns identified robot components (from the vision step) into a buyable BOM
using the curated catalogue. No LLM involved: category-first matching, then
rapidfuzz over name + aliases, then best-recipe completion.

Input shape:
    {
      "components": [{"name": "yellow motor", "category": "motor", "qty": 2}, ...],
      "owned": ["arduino_uno"]            # optional part IDs the user already has
    }

Output shape (PROJECT_BRIEF.md section 8):
    {"robot_name", "recipe_id", "confidence", "parts", "bom", "bom_total_gbp", "unmatched"}
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from rapidfuzz import fuzz

PARTS_DIR = Path(__file__).parent
CATALOG_PATH = PARTS_DIR / "catalog.json"
RECIPES_PATH = PARTS_DIR / "recipes.json"

SCORE_THRESHOLD = 70  # rapidfuzz score cutoff

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


def get_item(part_id: str) -> dict | None:
    for item in catalog_items():
        if item["id"] == part_id:
            return item
    return None


def _score(query: str, item: dict) -> float:
    """Best score of the query against the item name and aliases.

    token_set_ratio alone gives 100 to subset matches (e.g. alias "arduino"
    matches "arduino nano"), so we blend in plain ratio to prefer exact and
    longer matches.
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
    """Function-tool backing search used by the catalog-matcher agent.

    Returns up to `limit` catalogue entries with a match score. Only IDs that
    exist in the catalogue are ever returned.
    """
    items = catalog_items()
    if category:
        cat = category.lower().strip()
        filtered = [i for i in items if i["category"].lower() == cat]
        if filtered:  # fall back to all items if the category matches nothing
            items = filtered
    scored = sorted((( _score(query, i), i) for i in items), key=lambda t: t[0], reverse=True)
    return [
        {"id": i["id"], "name": i["name"], "category": i["category"], "score": round(s, 1),
         "price_gbp": i["price_gbp"], "shop": i["shop"]}
        for s, i in scored[:limit]
    ]


def _match_component(comp: dict) -> tuple[str | None, float]:
    """Match one component to a catalogue ID. Returns (part_id, score)."""
    name = str(comp.get("name", "")).strip()
    category = str(comp.get("category", "")).strip().lower() or None
    if not name:
        return None, 0.0
    items = catalog_items()
    if category and any(i["category"].lower() == category for i in items):
        pool = [i for i in items if i["category"].lower() == category]
    else:
        pool = items
    best_id, best_score = None, 0.0
    for item in pool:
        s = _score(name, item)
        if s > best_score:
            best_id, best_score = item["id"], s
    if best_score >= SCORE_THRESHOLD:
        return best_id, best_score
    return None, best_score


def _pick_recipe(matched_ids: set[str]) -> dict | None:
    """Pick the recipe with the best overlap with the matched parts."""
    recipes = load_recipes()["recipes"]
    if not recipes:
        return None
    best, best_score = None, -1.0
    for rec in recipes:
        rec_ids = {p["id"] for p in rec["parts"]}
        if not rec_ids:
            continue
        overlap = len(matched_ids & rec_ids)
        # reward overlap, punish recipes that need many parts we did not see
        score = overlap / len(rec_ids) + 0.25 * (overlap / max(len(matched_ids), 1))
        if score > best_score:
            best, best_score = rec, score
    return best


def build_bom(matched: dict[str, int], owned: set[str], recipe: dict | None,
              added_from_recipe: set[str]) -> tuple[list[dict], float]:
    """Build BOM rows + total (owned parts excluded from the total)."""
    cat_order = {c: n for n, c in enumerate(load_catalog()["categories"])}
    rows = []
    total = 0.0
    for part_id, qty in matched.items():
        item = get_item(part_id)
        if item is None:
            continue
        unit = float(item["price_gbp"])
        line = round(unit * qty, 2)
        is_owned = part_id in owned
        if not is_owned:
            total += line
        rows.append({
            "part_id": part_id,
            "name": item["name"],
            "category": item["category"],
            "shop": item["shop"],
            "url": item["url"],
            "unit_price_gbp": unit,
            "qty": qty,
            "line_total_gbp": line,
            "owned": is_owned,
            "added_from_recipe": part_id in added_from_recipe,
        })
    rows.sort(key=lambda r: (cat_order.get(r["category"], 99), r["name"]))
    return rows, round(total, 2)


def match_components(payload: dict | list) -> dict:
    """Deterministic match. Accepts {"components": [...], "owned": [...]} or a bare list."""
    if isinstance(payload, list):
        payload = {"components": payload}
    components = payload.get("components", []) or []
    owned = set(payload.get("owned", []) or [])

    matched: dict[str, int] = {}
    parts_out: list[dict] = []
    unmatched: list[dict] = []
    for comp in components:
        qty = int(comp.get("qty", 1) or 1)
        part_id, score = _match_component(comp)
        if part_id:
            matched[part_id] = matched.get(part_id, 0) + qty
            parts_out.append({
                "id": part_id,
                "name": (get_item(part_id) or {}).get("name", comp.get("name")),
                "category": comp.get("category") or (get_item(part_id) or {}).get("category"),
                "qty": qty,
                "visible_in_photo": True,
            })
        else:
            unmatched.append({"name": comp.get("name"), "category": comp.get("category"),
                              "qty": qty, "best_score": round(score, 1)})

    recipe = _pick_recipe(set(matched))
    added_from_recipe: set[str] = set()
    if recipe is not None:
        for p in recipe["parts"]:
            if p["id"] not in matched:
                matched[p["id"]] = p["qty"]
                added_from_recipe.add(p["id"])

    bom, total = build_bom(matched, owned, recipe, added_from_recipe)
    confidence = round(len(parts_out) / len(components), 2) if components else 0.0
    return {
        "robot_name": recipe["name"] if recipe else "Custom robot",
        "recipe_id": recipe["id"] if recipe else None,
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
