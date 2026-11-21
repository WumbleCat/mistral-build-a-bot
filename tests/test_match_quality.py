"""Tests for live-offer match_quality classification (bare ICs -> 'similar').

Run from repo root: backend/.venv/bin/python -m unittest tests.test_match_quality -v
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from parts import live, match  # noqa: E402

DRIVER_ITEM = match.get_item("driver_tb6612fng")
WHEEL_ITEM = match.get_item("wheel_65mm_pair")


class TestClassifyOffer(unittest.TestCase):
    def test_bare_ic_for_motor_driver_is_similar(self):
        # the exact wrong match reported: Mouser 757-TB67H481FNGEL (a Toshiba IC)
        offer = {"title": "TB67H481FNGEL Toshiba Brushed DC Motor Driver IC",
                 "part_number": "757-TB67H481FNGEL", "manufacturer": "Toshiba"}
        self.assertEqual(live.classify_offer(offer, "motor_driver", DRIVER_ITEM), "similar")

    def test_module_title_is_exact(self):
        offer = {"title": "SparkFun Motor Driver - Dual TB6612FNG (with Headers) [board]",
                 "part_number": "ROB-14450"}
        self.assertEqual(live.classify_offer(offer, "motor_driver", DRIVER_ITEM), "exact")

    def test_mfr_part_number_match_is_exact(self):
        offer = {"title": "TB6612FNG chip", "part_number": "771-TB6612FNG", "manufacturer": "Toshiba"}
        self.assertEqual(live.classify_offer(offer, "motor_driver", DRIVER_ITEM), "exact")

    def test_controller_bare_mcu_similar_but_dev_board_exact(self):
        mcu = {"title": "ATMEGA328P-AU microcontroller IC", "part_number": "556-ATMEGA328P-AU"}
        dev = {"title": "Arduino Uno Rev3 development board", "part_number": "ABX00062"}
        self.assertEqual(live.classify_offer(mcu, "controller", match.get_item("arduino_uno")), "similar")
        self.assertEqual(live.classify_offer(dev, "controller", match.get_item("arduino_uno")), "exact")

    def test_non_strict_category_always_exact(self):
        offer = {"title": "65mm rubber tire", "part_number": "X"}
        self.assertEqual(live.classify_offer(offer, "wheel", WHEEL_ITEM), "exact")

    def test_split_offers(self):
        offers = [
            {"title": "a board", "match_quality": "exact", "price_gbp": 5.0},
            {"title": "bare ic", "match_quality": "similar", "price_gbp": 0.9},
        ]
        exact, similar = live.split_offers(offers)
        self.assertEqual(len(exact), 1)
        self.assertEqual(len(similar), 1)

    def test_live_offers_annotated_and_exact_first(self):
        bare = {"shop": "Mouser UK", "title": "TB67H481FNGEL IC", "part_number": "757-TB67H481FNGEL",
                "price_gbp": 0.93, "stock": 7906, "url": "u1", "verified": False}
        board = {"shop": "Mouser UK", "title": "TB6612FNG motor driver board", "part_number": "X",
                 "price_gbp": 9.0, "stock": 10, "url": "u2", "verified": False}
        with unittest.mock.patch.object(live, "lcsc_search", return_value=[]), \
             unittest.mock.patch.object(live, "mouser_search", return_value=[bare, board]):
            offers = live.live_offers_for_part("SparkFun Motor Driver - Dual TB6612FNG (with Headers)",
                                               part_category="motor_driver", part_id="driver_tb6612fng")
            self.assertTrue(all("match_quality" in o for o in offers))
            self.assertEqual(offers[0]["match_quality"], "exact")  # exact sorted first
            exact, similar = live.split_offers(offers)
            self.assertEqual(similar[0]["part_number"], "757-TB67H481FNGEL")


if __name__ == "__main__":
    unittest.main()
