"""Example: use the Parts & Shop Python API directly (no HTTP).

Run from the repo root:
    backend/.venv/bin/python examples/use_parts_api.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from parts.parts_api import build_bom, get_catalog, get_recipes, search_live  # noqa: E402

SAMPLE = os.path.join(os.path.dirname(__file__), "..", "mock", "vision_person2_sample.json")


def main() -> None:
    with open(SAMPLE) as f:
        vision_parts = json.load(f)  # Person 2's exact output format: a plain list of dicts

    bom = build_bom(vision_parts)  # instant, deterministic, no AI
    print(f"robot   : {bom['robot_name']} (recipe {bom['recipe_id']}, conf {bom['recipe_confidence']})")
    print(f"total   : £{bom['bom_total_gbp']:.2f} GBP for {len(bom['bom'])} BOM rows")
    print("parts   :")
    for row in bom["bom"]:
        print(f"  - {row['part_id']:<22} x{row['qty']}  £{row['line_total_gbp']:>6.2f}  "
              f"[{row['status']}{', needs_check' if row['needs_check'] else ''}] {row['name'][:48]}")
    print(f"unmatched: {[u['name'] for u in bom['unmatched']]}")

    print(f"\ncatalog : {len(get_catalog())} parts | recipes: {[r['id'] for r in get_recipes()]}")

    offers = search_live("TB6612FNG motor driver board")
    print(f"\nlive search 'TB6612FNG motor driver board': {len(offers['exact'])} exact, {len(offers['similar'])} similar")
    for o in offers["exact"][:3]:
        print(f"  exact   {o['shop']:<10} £{o['price_gbp']:>6.2f} stock {o.get('stock')}  {o.get('title', '')[:50]}")
    for o in offers["similar"][:3]:
        print(f"  similar {o['shop']:<10} £{o['price_gbp']:>6.2f} stock {o.get('stock')}  {o.get('title', '')[:50]}")


if __name__ == "__main__":
    main()
