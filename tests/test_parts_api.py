"""Tests for the public Python interface (backend/parts/parts_api.py) and the
generated parts_catalog.py.

Run from repo root: backend/.venv/bin/python -m unittest tests.test_parts_api -v
"""

import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from parts import live, match  # noqa: E402
from parts import parts_api  # noqa: E402
from parts.parts_catalog import PARTS, RECIPES, find_part, get_part, parts_by_category  # noqa: E402

SAMPLE = os.path.join(os.path.dirname(__file__), "..", "mock", "vision_person2_sample.json")


class TestPartsApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ["BFV_MOCK"] = "1"
        from parts import agents
        agents._CACHE.clear()
        with open(SAMPLE) as f:
            cls.sample = json.load(f)

    def test_build_bom_accepts_person2_list(self):
        bom = parts_api.build_bom(self.sample)
        self.assertEqual(bom["recipe_id"], "rover_4wd")
        self.assertGreater(bom["bom_total_gbp"], 0)
        wheel = next(b for b in bom["bom"] if b["category"] == "wheel")
        self.assertEqual((wheel["units_needed"], wheel["packs_to_buy"]), (4, 2))

    def test_build_bom_owned(self):
        bom = parts_api.build_bom(self.sample, owned=["arduino_uno"])
        row = next(b for b in bom["bom"] if b["part_id"] == "arduino_uno")
        self.assertTrue(row["owned"])

    def test_build_bom_smart_mock_uses_cache(self):
        a = parts_api.build_bom_smart(self.sample)
        b = parts_api.build_bom_smart(self.sample)
        self.assertEqual(b.get("cached"), True)
        self.assertIn("warnings", a)
        self.assertTrue(any("Relays can only switch" in w for w in a["warnings"]))

    def test_search_live_shape(self):
        with mock.patch.object(live, "lcsc_search", return_value=[
                {"shop": "LCSC", "price_gbp": 0.85, "title": "TB6612FNG", "url": "u", "stock": 5, "verified": False}]), \
             mock.patch.object(live, "mouser_search", return_value=[]):
            r = parts_api.search_live("TB6612FNG")
            self.assertEqual(r["q"], "TB6612FNG")
            self.assertIn("exact", r)
            self.assertIn("similar", r)
            self.assertEqual(len(r["lcsc"]), 1)

    def test_get_catalog_and_recipes(self):
        cat = parts_api.get_catalog()
        recs = parts_api.get_recipes()
        self.assertEqual(len(cat), len(match.catalog_items()))
        self.assertEqual({r["id"] for r in recs}, {"obstacle_avoider_car", "line_follower_car", "robot_arm", "rover_4wd"})


class TestPartsCatalogPy(unittest.TestCase):
    def test_parts_matches_catalog_json_exactly(self):
        cat = json.load(open(os.path.join(os.path.dirname(__file__), "..", "backend", "parts", "catalog.json")))
        by_id = {p.id: p for p in PARTS}
        self.assertEqual(len(PARTS), len(cat["items"]))
        for item in cat["items"]:
            p = by_id[item["id"]]
            self.assertEqual(p.name, item["name"])
            self.assertEqual(p.category, item["category"])
            self.assertEqual(p.aliases, item.get("aliases", []))
            self.assertEqual(p.specs, item.get("specs", {}))
            self.assertEqual(p.price, float(item["price"]))
            self.assertEqual(p.currency, item.get("currency", "GBP"))
            self.assertEqual(p.price_gbp, round(match.to_gbp(item["price"], item.get("currency", "GBP")), 2))
            self.assertEqual(p.shop, item.get("shop", ""))
            self.assertEqual(p.sku, item.get("sku"))
            self.assertEqual(p.url, item.get("url", "TODO"))
            self.assertEqual(p.verified, bool(item.get("verified", False)))
            self.assertEqual(p.alternatives, item.get("alternatives", []))

    def test_recipes_matches_recipes_json(self):
        rec = json.load(open(os.path.join(os.path.dirname(__file__), "..", "backend", "parts", "recipes.json")))
        self.assertEqual(set(RECIPES), {r["id"] for r in rec["recipes"]})
        for r in rec["recipes"]:
            self.assertEqual(RECIPES[r["id"]], [(p["id"], p["qty"]) for p in r["parts"]])

    def test_helpers(self):
        self.assertEqual(get_part("arduino_uno").category, "controller")
        self.assertIsNone(get_part("nope"))
        self.assertIn("relay_module_1ch", [p.id for p in parts_by_category("relay")])
        top = find_part("yellow motor")
        self.assertEqual(top[0][1].id, "motor_tt_pair")


class TestRelayMapping(unittest.TestCase):
    """Person 2 sample: the 2 blue relay boards must match relay catalogue parts."""

    def test_relay_boards_match_not_unmatched(self):
        with open(SAMPLE) as f:
            sample = json.load(f)
        bom = parts_api.build_bom(sample)
        relay_rows = [b for b in bom["bom"] if b["category"] == "relay"]
        self.assertTrue(relay_rows, "relay boards should match a relay catalogue part")
        self.assertEqual(relay_rows[0]["qty"], 2)
        self.assertIn(relay_rows[0]["part_id"], ("relay_module_1ch", "relay_module_2ch"))
        unmatched_names = " | ".join(u["name"].lower() for u in bom["unmatched"])
        self.assertNotIn("relay", unmatched_names)


if __name__ == "__main__":
    unittest.main()
