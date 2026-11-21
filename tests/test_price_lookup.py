"""Tests for parts/price_lookup.py (single-function component -> priced matches).

Run from repo root: backend/.venv/bin/python -m unittest tests.test_price_lookup -v
"""

import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from parts import live  # noqa: E402
from parts.price_lookup import lookup_components  # noqa: E402

SAMPLE = os.path.join(os.path.dirname(__file__), "..", "mock", "vision_person2_sample.json")

NO_LIVE = {"side_effect": lambda *a, **k: []}


class TestLookupComponents(unittest.TestCase):
    def setUp(self):
        live._cache.clear()

    def test_order_and_original_fields_kept(self):
        comps = [
            {"name": "solderless breadboard", "category": "breadboard", "quantity": 1,
             "evidence": "visible", "source_ids": ["B001"], "sku": None, "product_url": None,
             "review_required": False, "notes": "white breadboard"},
            {"name": "silver duct tape", "category": "tape", "quantity": 1,
             "evidence": "visible", "source_ids": ["T001"], "sku": None, "product_url": None,
             "review_required": False, "notes": "wrapped on frame"},
        ]
        with mock.patch.object(live, "lcsc_search", **NO_LIVE), mock.patch.object(live, "mouser_search", **NO_LIVE):
            out = lookup_components(comps)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]["name"], "solderless breadboard")  # original fields kept
        self.assertEqual(out[0]["source_ids"], ["B001"])
        self.assertEqual(out[0]["notes"], "white breadboard")
        self.assertEqual(out[0]["category_normalised"], "wiring")
        self.assertEqual(out[0]["matched_part_id"], "breadboard_400")
        m = out[0]["matches"][0]
        self.assertEqual(m["source"], "catalogue")
        self.assertEqual(m["match_quality"], "exact")
        self.assertEqual(m["shop"], "SparkFun")
        self.assertEqual(m["part_number"], "PRT-12002")
        self.assertGreater(m["price_gbp"], 0)
        self.assertEqual(out[0]["best_match"]["part_number"], "PRT-12002")
        self.assertEqual(out[0]["line_total_gbp"], m["price_gbp"])  # qty 1
        # tape: no catalogue match, live mocked empty -> matches [], never crash
        self.assertIsNone(out[1]["matched_part_id"])
        self.assertEqual(out[1]["matches"], [])
        self.assertIsNone(out[1]["best_match"])
        self.assertEqual(out[1]["line_total_gbp"], 0.0)

    def test_quantity_null_treated_as_1(self):
        comps = [{"name": "drive motor(s)", "category": "motor", "quantity": None, "evidence": "inferred"}]
        with mock.patch.object(live, "lcsc_search", **NO_LIVE), mock.patch.object(live, "mouser_search", **NO_LIVE):
            out = lookup_components(comps)
        self.assertEqual(out[0]["matched_part_id"], "motor_tt_pair")
        # qty null -> 1 unit; pack_size 2 -> 1 pack
        self.assertEqual(out[0]["line_total_gbp"], out[0]["best_match"]["price_gbp"])

    def test_pack_size_line_total(self):
        comps = [{"name": "off-road rubber wheel/tire", "category": "wheel", "quantity": 4}]
        with mock.patch.object(live, "lcsc_search", **NO_LIVE), mock.patch.object(live, "mouser_search", **NO_LIVE):
            out = lookup_components(comps)
        self.assertEqual(out[0]["matched_part_id"], "wheel_65mm_pair")
        unit = out[0]["best_match"]["price_gbp"]  # pair price
        self.assertEqual(out[0]["line_total_gbp"], round(2 * unit, 2))  # 4 wheels -> 2 pairs

    def test_live_matches_annotated_and_similar_separated(self):
        comps = [{"name": "tb6612 motor driver", "category": "motor_driver", "quantity": 1}]
        live_offers = [
            {"shop": "Mouser UK", "title": "TB67H481FNGEL IC", "part_number": "757-TB67H481FNGEL",
             "price_gbp": 0.93, "stock": 7906, "url": "u1", "verified": False},
            {"shop": "Mouser UK", "title": "TB6612FNG motor driver board", "part_number": "X1",
             "price_gbp": 12.0, "stock": 10, "url": "u2", "verified": False},
        ]
        with mock.patch.object(live, "lcsc_search", **NO_LIVE), \
             mock.patch.object(live, "mouser_search", return_value=live_offers):
            out = lookup_components(comps)
        matches = out[0]["matches"]
        self.assertEqual(matches[0]["source"], "catalogue")  # catalogue exact first
        live_matches = [m for m in matches if m["source"] == "live"]
        self.assertEqual(len(live_matches), 2)
        q = {m["part_number"]: m["match_quality"] for m in live_matches}
        self.assertEqual(q["757-TB67H481FNGEL"], "similar")
        self.assertEqual(q["X1"], "exact")
        self.assertEqual(out[0]["best_match"]["source"], "catalogue")  # cheapest exact

    def test_person2_sample_never_crashes(self):
        with open(SAMPLE) as f:
            sample = json.load(f)
        with mock.patch.object(live, "lcsc_search", **NO_LIVE), mock.patch.object(live, "mouser_search", **NO_LIVE):
            out = lookup_components(sample)
        self.assertEqual(len(out), len(sample))
        for orig, o in zip(sample, out):
            self.assertEqual(o["name"], orig["name"])
            self.assertIn("matches", o)
        relay = next(o for o in out if "relay" in o["name"].lower())
        self.assertEqual(relay["matched_part_id"], "relay_module_1ch")


if __name__ == "__main__":
    unittest.main()
