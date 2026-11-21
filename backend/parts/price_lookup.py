"""One-function price lookup for Person 2: components in -> shop products with prices out.

No FastAPI, no server — plain import works:

    import sys; sys.path.insert(0, "backend")
    from parts.price_lookup import lookup_components
    out = lookup_components(vision_parts)   # same order, original fields + matches

Command line:
    python -m backend.parts.price_lookup input.json output.json     (from repo root)
    backend/.venv/bin/python -m backend.parts.price_lookup mock/vision_person2_sample.json mock/price_lookup_example_output.json

Input:  Person 2's component list — [{"name", "category", "quantity", "evidence",
         "source_ids", "sku", "product_url", "review_required", "notes"}, ...]
Output: one item per input component, same order, original fields kept, plus:
        "category_normalised", "matched_part_id", "matches", "best_match", "line_total_gbp"
        matches[] entries: {shop, product, part_number, price_gbp, stock, url,
                            source: "catalogue"|"live", match_quality: "exact"|"similar"}
        best_match = the verified catalogue product when one matched (per spec example),
        else the cheapest live EXACT match; line_total_gbp accounts
        for quantity (null -> 1) and catalogue pack_size. No match -> matches: [].
        Never raises.
"""

from __future__ import annotations

import json
import math
import sys
from typing import Any

try:  # package import (python -m backend.parts.price_lookup / from parts.price_lookup import ...)
    from . import live, match
except ImportError:  # direct script run: python backend/parts/price_lookup.py
    import os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import live  # type: ignore
    import match  # type: ignore

MAX_MATCHES = 6


def _catalogue_match(comp: dict) -> tuple[dict | None, float]:
    """Match one component against the catalogue. Returns (item, score) or (None, score)."""
    part = {
        "name": comp.get("name", ""),
        "category": match.normalise_category(comp.get("category") or ""),
    }
    pid, score = match._match_component(part)
    return (match.get_item(pid) if pid else None), score


def _catalogue_offer(item: dict) -> dict:
    return {
        "shop": item.get("shop", ""),
        "product": item.get("name", ""),
        "part_number": item.get("sku") or item.get("id"),
        "price_gbp": round(match.item_price_gbp(item), 2),
        "stock": item.get("specs", {}).get("stock"),
        "url": item.get("url", "TODO"),
        "source": "catalogue",
        "match_quality": "exact",
        "verified": bool(item.get("verified", False)),
    }


def _live_offers(comp: dict, item: dict | None) -> list[dict]:
    """Mouser + LCSC live offers for one component, annotated with match_quality."""
    cat = match.normalise_category(comp.get("category") or "")
    name = comp.get("name", "")
    offers: list[dict] = []
    seen: set[str] = set()
    keywords = [name]
    if item and item.get("name") and item["name"] != name:
        keywords.append(item["name"])
    for kw in keywords[:2]:
        for o in live.lcsc_search(kw) + live.mouser_search(kw):
            url = o.get("url")
            if url and url in seen:
                continue
            if url:
                seen.add(url)
            offers.append({
                "shop": o.get("shop", ""),
                "product": o.get("title", ""),
                "part_number": o.get("part_number"),
                "price_gbp": o.get("price_gbp"),
                "stock": o.get("stock"),
                "url": url,
                "source": "live",
                "match_quality": live.classify_offer(o, cat, item),
            })
        if offers:
            break
    return offers


def lookup_components(components: list[dict]) -> list[dict]:
    """For each component in Person 2's format, search catalogue + Mouser + LCSC and
    return matches with prices. One output item per input component, same order,
    original fields preserved. Never raises; unmatched components get matches: []."""
    out: list[dict] = []
    for comp in components or []:
        comp = comp.model_dump() if hasattr(comp, "model_dump") else dict(comp or {})
        item = None
        try:
            item, score = _catalogue_match(comp)
        except Exception:
            item, score = None, 0.0

        matches: list[dict] = []
        if item is not None:
            matches.append(_catalogue_offer(item))
        try:
            matches.extend(_live_offers(comp, item))
        except Exception:
            pass  # live search must never break the lookup

        # order: catalogue exact, live exact (cheapest first), live similar
        exact = [m for m in matches if m["match_quality"] == "exact"]
        similar = [m for m in matches if m["match_quality"] != "exact"]
        exact.sort(key=lambda m: (m["source"] != "catalogue", m.get("price_gbp") or 1e9))
        matches = (exact + similar)[:MAX_MATCHES]

        qty = comp.get("quantity", comp.get("qty", 1))
        try:
            units = int(qty) if qty is not None else 1
        except (TypeError, ValueError):
            units = 1
        if units < 1:
            units = 1

        exact_matches = [m for m in matches if m["match_quality"] == "exact"]
        # best = verified catalogue product when matched (per spec example), else cheapest live exact
        cat_matches = [m for m in exact_matches if m["source"] == "catalogue"]
        if cat_matches:
            best = cat_matches[0]
        else:
            best = min(exact_matches, key=lambda m: m.get("price_gbp") or 1e9) if exact_matches else None

        line_total = 0.0
        if best is not None:
            price = best.get("price_gbp") or 0.0
            if best["source"] == "catalogue" and item is not None:
                pack = max(1, match._pack_size(item))
                line_total = round(math.ceil(units / pack) * price, 2)
            else:
                line_total = round(units * price, 2)

        out.append({
            **comp,
            "category_normalised": match.normalise_category(comp.get("category") or ""),
            "matched_part_id": item["id"] if item else None,
            "matches": matches,
            "best_match": best,
            "line_total_gbp": line_total,
        })
    return out


def main(argv: list[str]) -> int:
    """CLI: python -m backend.parts.price_lookup input.json [output.json]"""
    if len(argv) < 2:
        print("usage: python -m backend.parts.price_lookup input.json [output.json]")
        return 2
    with open(argv[1]) as f:
        components = json.load(f)
    result = lookup_components(components)
    text = json.dumps(result, indent=2)
    if len(argv) >= 3:
        with open(argv[2], "w") as f:
            f.write(text)
        print(f"wrote {argv[2]} ({len(result)} components)")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
