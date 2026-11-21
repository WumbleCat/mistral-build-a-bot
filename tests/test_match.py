"""Tests for the deterministic matcher (backend/parts/match.py).

Run from the repo root:
    backend/.venv/bin/python -m unittest tests.test_match -v
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from parts.match import match_components, search_catalog  # noqa: E402

# One vision-style input per recipe, incl. a vague name ("yellow motor") and
# one unknown part ("flux capacitor") that must land in `unmatched`.
VISION_INPUTS = {
    "obstacle_avoider_car": {
        "components": [
            {"name": "Arduino Uno", "category": "controller", "qty": 1},
            {"name": "L298N motor driver", "category": "motor_driver", "qty": 1},
            {"name": "yellow motor", "category": "motor", "qty": 2},   # vague alias -> motor_tt
            {"name": "ultrasonic sensor", "category": "sensor", "qty": 1},
            {"name": "2wd chassis", "category": "chassis", "qty": 1},
        ]
    },
    "line_follower_car": {
        "components": [
            {"name": "Arduino Nano", "category": "controller", "qty": 1},
            {"name": "IR line sensor array", "category": "sensor", "qty": 1},
            {"name": "TT motor", "category": "motor", "qty": 2},
            {"name": "flux capacitor", "category": "power", "qty": 1},  # unknown -> unmatched
        ]
    },
    "robot_arm": {
        "components": [
            {"name": "Arduino Uno R3", "category": "controller", "qty": 1},
            {"name": "MG996R servo", "category": "servo", "qty": 4},
            {"name": "robot arm kit", "category": "chassis", "qty": 1},
        ]
    },
}


class TestMatch(unittest.TestCase):
    def test_all_three_recipes_match_under_1s(self):
        import time
        for recipe_id, payload in VISION_INPUTS.items():
            start = time.perf_counter()
            result = match_components(payload)
            elapsed = time.perf_counter() - start
            self.assertLess(elapsed, 1.0, f"{recipe_id} took {elapsed:.2f}s")
            self.assertEqual(result["recipe_id"], recipe_id, f"wrong recipe for {recipe_id}")
            self.assertGreater(result["bom_total_gbp"], 0)
            # total equals sum of non-owned line totals
            expect = round(sum(r["line_total_gbp"] for r in result["bom"] if not r["owned"]), 2)
            self.assertEqual(result["bom_total_gbp"], expect)

    def test_vague_alias_matches_tt_motor(self):
        result = match_components(VISION_INPUTS["obstacle_avoider_car"])
        ids = {p["id"] for p in result["parts"]}
        self.assertIn("motor_tt", ids)
        bom_row = next(r for r in result["bom"] if r["part_id"] == "motor_tt")
        self.assertEqual(bom_row["qty"], 2)
        self.assertEqual(bom_row["line_total_gbp"], 5.00)

    def test_unknown_part_is_unmatched_not_invented(self):
        result = match_components(VISION_INPUTS["line_follower_car"])
        self.assertEqual(len(result["unmatched"]), 1)
        self.assertEqual(result["unmatched"][0]["name"], "flux capacitor")
        self.assertNotIn("flux capacitor", {r["name"] for r in result["bom"]})

    def test_recipe_completion_flags_added_parts(self):
        result = match_components(VISION_INPUTS["robot_arm"])
        added = {r["part_id"] for r in result["bom"] if r["added_from_recipe"]}
        # arm input names only 3 parts; the recipe must supply the rest
        self.assertIn("batt_holder_18650", added)
        self.assertIn("buck_lm2596", added)
        self.assertIn("servo_mg996r", {p["id"] for p in result["parts"]})

    def test_owned_parts_excluded_from_total(self):
        payload = dict(VISION_INPUTS["obstacle_avoider_car"])
        payload["owned"] = ["arduino_uno"]
        result = match_components(payload)
        row = next(r for r in result["bom"] if r["part_id"] == "arduino_uno")
        self.assertTrue(row["owned"])
        self.assertEqual(result["bom_total_gbp"], round(53.60 - 18.50, 2))

    def test_search_catalog_returns_real_ids_only(self):
        hits = search_catalog("ultrasonic distance", category="sensor")
        self.assertTrue(hits)
        self.assertEqual(hits[0]["id"], "hcsr04")
        from parts.match import catalog_items
        valid = {i["id"] for i in catalog_items()}
        for h in hits:
            self.assertIn(h["id"], valid)

    def test_output_matches_data_contract(self):
        result = match_components(VISION_INPUTS["obstacle_avoider_car"])
        for key in ("robot_name", "recipe_id", "confidence", "parts", "bom", "bom_total_gbp", "unmatched"):
            self.assertIn(key, result)
        for row in result["bom"]:
            for key in ("part_id", "shop", "url", "unit_price_gbp", "qty", "line_total_gbp", "owned"):
                self.assertIn(key, row)


if __name__ == "__main__":
    unittest.main()
