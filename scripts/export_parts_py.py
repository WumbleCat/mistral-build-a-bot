"""Regenerate backend/parts/parts_catalog.py from catalog.json + recipes.json.

catalog.json / recipes.json remain the source of truth. Run from the repo root:

    backend/.venv/bin/python scripts/export_parts_py.py

The generated file is standalone (imports only pydantic + rapidfuzz), so
Person 2 can copy parts_catalog.py alone and use PARTS / RECIPES / find_part.
"""

from __future__ import annotations

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

from parts.match import USD_TO_GBP, to_gbp  # noqa: E402

CATALOG = os.path.join(ROOT, "backend", "parts", "catalog.json")
RECIPES = os.path.join(ROOT, "backend", "parts", "recipes.json")
OUT = os.path.join(ROOT, "backend", "parts", "parts_catalog.py")

HEADER = '''"""Parts catalogue as Python data — GENERATED from catalog.json + recipes.json.

Do NOT edit by hand: edit backend/parts/catalog.json / recipes.json, then run
    backend/.venv/bin/python scripts/export_parts_py.py

Standalone: imports only pydantic + rapidfuzz. Copy this one file if you need
the parts list without the rest of the backend.

    from parts_catalog import PARTS, RECIPES, get_part, parts_by_category, find_part

USD_TO_GBP used for price_gbp was {rate} at generation time.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field
from rapidfuzz import fuzz


class Part(BaseModel):
    """One catalogue part."""

    id: str
    name: str
    category: str
    aliases: list[str] = Field(default_factory=list)
    specs: dict = Field(default_factory=dict)
    price: float                       # original price
    currency: str = "GBP"              # "GBP" | "USD"
    price_gbp: float                   # price converted to GBP at generation time
    shop: str = ""
    sku: Optional[str] = None
    url: str = "TODO"                  # real product URL or "TODO" (never invented)
    verified: bool = False
    alternatives: list[str] = Field(default_factory=list)
    notes: Optional[str] = None


PARTS: list[Part] = {parts_literal}

RECIPES: dict[str, list[tuple[str, int]]] = {recipes_literal}


def get_part(part_id: str) -> Optional[Part]:
    """Catalogue part by id, or None."""
    for p in PARTS:
        if p.id == part_id:
            return p
    return None


def parts_by_category(category: str) -> list[Part]:
    """All parts in one category (e.g. 'motor', 'relay')."""
    return [p for p in PARTS if p.category == category]


def find_part(name: str, limit: int = 5) -> list[tuple[float, Part]]:
    """Fuzzy search over name + aliases. Returns [(score 0-100, Part), ...] best first."""
    q = (name or "").lower().strip()
    scored = []
    for p in PARTS:
        best = 0.0
        for c in [p.name] + p.aliases:
            cl = c.lower()
            if q == cl:
                best = 100.0
                break
            best = max(best, 0.7 * fuzz.token_set_ratio(q, cl) + 0.3 * fuzz.ratio(q, cl))
        scored.append((best, p))
    scored.sort(key=lambda t: (t[0], t[1].verified), reverse=True)
    return scored[:limit]
'''


def main() -> None:
    catalog = json.load(open(CATALOG))
    recipes = json.load(open(RECIPES))["recipes"]

    parts = []
    for i in catalog["items"]:
        price = float(i.get("price", i.get("price_gbp", 0.0)))
        currency = i.get("currency", "GBP")
        parts.append({
            "id": i["id"], "name": i["name"], "category": i["category"],
            "aliases": i.get("aliases", []), "specs": i.get("specs", {}),
            "price": price, "currency": currency,
            "price_gbp": round(to_gbp(price, currency), 2),
            "shop": i.get("shop", ""), "sku": i.get("sku"),
            "url": i.get("url", "TODO"), "verified": bool(i.get("verified", False)),
            "alternatives": i.get("alternatives", []), "notes": i.get("notes"),
        })

    recipes_map = {r["id"]: [(p["id"], int(p["qty"])) for p in r["parts"]] for r in recipes}

    parts_literal = "[\n    Part(**" + json.dumps(parts, indent=4).replace("\n", "\n    ") + "\n]"
    # simpler: dump as list of Part(...) via json -> replace quotes is messy; use repr-style emit
    import pprint
    parts_literal = "[\n" + ",\n".join("    Part(**" + _kw(p) + ")" for p in parts) + "\n]"
    recipes_literal = "{\n" + ",\n".join(
        f"    {rid!r}: {pairs!r}" for rid, pairs in recipes_map.items()) + "\n}"

    content = HEADER.format(rate=USD_TO_GBP, parts_literal=parts_literal, recipes_literal=recipes_literal)
    with open(OUT, "w") as f:
        f.write(content)
    print(f"wrote {OUT}: {len(parts)} parts, {len(recipes_map)} recipes, USD_TO_GBP={USD_TO_GBP}")


def _kw(p: dict) -> str:
    import pprint
    return pprint.pformat(p, width=100)


if __name__ == "__main__":
    main()
