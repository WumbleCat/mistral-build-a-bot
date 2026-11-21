"""Tests for the deterministic matcher (backend/parts/match.py) against the
merged verified catalogue (uniform price + currency schema; all BOM money in GBP).

Run from the repo root:
    backend/.venv/bin/python -m unittest tests.test_match -v
"""

import os
import sys
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from parts import match  # noqa: E402
from parts.match import (  # noqa: E402
    USD_TO_GBP,
    catalog_items,
    get_item,
    match_components,
    search_catalog,
    to_gbp,
)


def _price(item: dict) -> float:
    return float(item.get("price", item.get("price_gbp", 0.0)))


# One vision-style input per recipe (merged catalogue ids).
VISION_INPUTS = {
    "obstacle_avoider_car": {
        "components": [
            {"name": "Arduino Uno", "category": "controller", "qty": 1},
            {"name": "tb6612 motor driver", "category": "motor_driver", "qty": 1},
            {"name": "yellow motor", "category": "motor", "qty": 2},  # pack_size 2 -> buy 1
            {"name": "ultrasonic sensor", "category": "sensor", "qty": 1},
            {"name": "2wd chassis", "category": "chassis", "qty": 1},
        ]
    },
    "line_follower_car": {
        "components": [
            {"name": "arduino", "category": "controller", "qty": 1},
            {"name": "tt motor", "category": "motor", "qty": 1},
            {"name": "line sensor", "category": "sensor", "qty": 3},
            {"name": "flux capacitor", "category": "power", "qty": 1},  # unknown -> unmatched
        ]
    },
    "robot_arm": {
        "components": [
            {"name": "mearm", "category": "chassis", "qty": 1},       # -> mearm_deluxe_kit
            {"name": "5v power supply", "category": "power", "qty": 1},  # -> power_5v_2a
        ]
    },
}


class TestVisionInputs(unittest.TestCase):
    def test_each_input_matches_its_recipe_under_1s(self):
        for recipe_id, payload in VISION_INPUTS.items():
            with self.subTest(recipe=recipe_id):
                start = time.perf_counter()
                result = match_components(payload)
                elapsed = time.perf_counter() - start
                self.assertLess(elapsed, 1.0, f"{recipe_id} took {elapsed:.2f}s")
                self.assertEqual(result["recipe_id"], recipe_id)
                self.assertTrue(result["robot_name"])
                self.assertGreater(result["bom_total_gbp"], 0)
                # total == sum of non-owned line totals
                expect = round(sum(r["line_total_gbp"] for r in result["bom"]
                                   if not r["owned"]), 2)
                self.assertEqual(result["bom_total_gbp"], expect)

    def test_expected_parts_matched(self):
        r = match_components(VISION_INPUTS["obstacle_avoider_car"])
        self.assertEqual({p["id"] for p in r["parts"]},
                         {"arduino_uno", "driver_tb6612fng", "motor_tt_pair",
                          "hc_sr04", "chassis_shadow"})

        r = match_components(VISION_INPUTS["line_follower_car"])
        self.assertEqual({p["id"] for p in r["parts"]},
                         {"arduino_uno", "motor_tt_pair", "line_sensor"})
        line = next(p for p in r["parts"] if p["id"] == "line_sensor")
        self.assertEqual(line["qty"], 3)

        r = match_components(VISION_INPUTS["robot_arm"])
        self.assertEqual({p["id"] for p in r["parts"]},
                         {"mearm_deluxe_kit", "power_5v_2a"})

    def test_unknown_part_lands_in_unmatched_not_invented(self):
        r = match_components(VISION_INPUTS["line_follower_car"])
        self.assertEqual([u["name"] for u in r["unmatched"]], ["flux capacitor"])
        self.assertNotIn("flux capacitor", {row["name"] for row in r["bom"]})
        self.assertNotIn("flux capacitor", {p["name"] for p in r["parts"]})


class TestPackSize(unittest.TestCase):
    def test_yellow_motor_qty2_buys_one_pair(self):
        r = match_components({"components": [
            {"name": "yellow motor", "category": "motor", "qty": 2}]})
        self.assertEqual(r["parts"][0]["id"], "motor_tt_pair")
        self.assertEqual(r["parts"][0]["qty"], 2)          # two motors seen in the photo
        row = next(row for row in r["bom"] if row["part_id"] == "motor_tt_pair")
        self.assertEqual(row["qty"], 1)                    # sold as a pair: ceil(2/2) = 1
        self.assertEqual(row["line_total_gbp"], row["unit_price_gbp"])


class TestCurrency(unittest.TestCase):
    def test_usd_part_converted_with_usd_to_gbp(self):
        # HC-SR04 from SparkFun (id hc_sr04_sparkfun, 5.25 USD)
        r = match_components({"components": [
            {"name": "ultrasonic distance sensor 5v hc-sr04",
             "category": "sensor", "qty": 1}]})
        self.assertEqual(r["parts"][0]["id"], "hc_sr04_sparkfun")
        row = next(row for row in r["bom"] if row["part_id"] == "hc_sr04_sparkfun")
        item = get_item("hc_sr04_sparkfun")
        self.assertEqual(item["price"], 5.25)
        self.assertEqual(item["currency"], "USD")
        self.assertEqual(row["currency"], "USD")
        self.assertEqual(row["unit_price"], 5.25)
        # the rate is imported from parts.match - never hardcoded here
        self.assertEqual(row["unit_price_gbp"], round(5.25 * USD_TO_GBP, 2))
        self.assertEqual(row["unit_price_gbp"], to_gbp(_price(item), item["currency"]))

    def test_gbp_part_passes_through_unchanged(self):
        r = match_components(VISION_INPUTS["obstacle_avoider_car"])
        row = next(row for row in r["bom"] if row["part_id"] == "arduino_uno")
        self.assertEqual(row["currency"], "GBP")
        self.assertEqual(row["unit_price_gbp"], _price(get_item("arduino_uno")))


class TestOwned(unittest.TestCase):
    def test_owned_part_reduces_total_by_its_unit_price(self):
        base = match_components(VISION_INPUTS["obstacle_avoider_car"])
        payload = {**VISION_INPUTS["obstacle_avoider_car"], "owned": ["arduino_uno"]}
        r = match_components(payload)
        row = next(row for row in r["bom"] if row["part_id"] == "arduino_uno")
        self.assertTrue(row["owned"])
        self.assertEqual(row["unit_price_gbp"], 24.88)  # GBP part
        self.assertEqual(row["currency"], "GBP")
        # total drops by exactly the owned part's unit price
        self.assertAlmostEqual(base["bom_total_gbp"] - r["bom_total_gbp"],
                               row["unit_price_gbp"], places=2)
        self.assertEqual(r["bom_total_gbp"],
                         round(base["bom_total_gbp"] - row["unit_price_gbp"], 2))
        # identity: total == sum of non-owned line totals
        expect = round(sum(x["line_total_gbp"] for x in r["bom"] if not x["owned"]), 2)
        self.assertEqual(r["bom_total_gbp"], expect)


class TestOutputContract(unittest.TestCase):
    def test_top_level_keys(self):
        r = match_components(VISION_INPUTS["obstacle_avoider_car"])
        for key in ("robot_name", "recipe_id", "confidence", "parts",
                    "bom", "bom_total_gbp", "unmatched"):
            self.assertIn(key, r)

    def test_bom_row_keys(self):
        r = match_components(VISION_INPUTS["line_follower_car"])
        self.assertTrue(r["bom"])
        for row in r["bom"]:
            for key in ("part_id", "shop", "url", "unit_price_gbp", "qty",
                        "line_total_gbp", "owned", "currency", "verified"):
                self.assertIn(key, row)


class TestSearchCatalog(unittest.TestCase):
    def test_hits_are_real_catalogue_ids_with_price_gbp_and_currency(self):
        valid = {i["id"] for i in catalog_items()}
        for query, category in [("ultrasonic", "sensor"), ("tb6612", "motor_driver"),
                                ("line sensor", "sensor"), ("motor", None)]:
            with self.subTest(query=query, category=category):
                hits = search_catalog(query, category=category)
                self.assertTrue(hits)
                for h in hits:
                    self.assertIn(h["id"], valid)  # only real catalogue ids
                    self.assertIn("price_gbp", h)
                    self.assertIn("currency", h)
                    item = get_item(h["id"])
                    self.assertEqual(h["price_gbp"],
                                     to_gbp(_price(item), item.get("currency", "GBP")))

    def test_usd_hit_shows_converted_gbp_price_and_usd_currency(self):
        top = search_catalog("tb6612", category="motor_driver")[0]
        self.assertEqual(top["id"], "driver_tb6612fng")
        self.assertEqual(top["currency"], "USD")
        self.assertEqual(top["price_gbp"],
                         round(_price(get_item("driver_tb6612fng")) * USD_TO_GBP, 2))


if __name__ == "__main__":
    unittest.main()
