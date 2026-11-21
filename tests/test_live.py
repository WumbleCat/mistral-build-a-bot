"""Tests for backend/parts/live.py (LCSC + Mouser live pricing).

No network: HTTP is patched. Run from repo root:
    backend/.venv/bin/python -m unittest tests.test_live -v
"""

import os
import sys
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from parts import live, match  # noqa: E402

LCSC_SAMPLE = {"components": [
    {"lcsc": 141517, "mfr": "TB6612FNG,C,8,EL", "package": "SSOP-24", "is_basic": False,
     "is_preferred": False, "description": "Brushed DC Motor Drivers ROHS", "stock": 3474, "price": 1.1323},
    {"lcsc": 88224, "mfr": "TB6612FNG(O,C,8,EL", "package": "SSOP-24-208mil", "is_basic": False,
     "is_preferred": False, "description": "motor driver", "stock": 100, "price": 0.95},
]}

MOUSER_SAMPLE = {"SearchResults": {"Parts": [
    {"MouserPartNumber": "771-SG90", "PartNumber": "SG90", "Description": "SG90 micro servo",
     "Manufacturer": "TowerPro", "PriceBreaks": [{"Quantity": 1, "Price": "1.20"}],
     "Availability": "In Stock, 5,432", "DetailPageUrl": "https://www.mouser.co.uk/product-detail/771-SG90"},
]}}


class TestParsers(unittest.TestCase):
    def test_parse_lcsc(self):
        offers = live.parse_lcsc(LCSC_SAMPLE)
        self.assertEqual(len(offers), 2)
        o = offers[0]
        self.assertEqual(o["shop"], "LCSC")
        self.assertEqual(o["part_number"], "C141517")
        self.assertEqual(o["stock"], 3474)
        self.assertEqual(o["price_gbp"], round(1.1323 * match.USD_TO_GBP, 2))
        self.assertEqual(o["currency"], "USD")
        self.assertEqual(o["url"], "https://www.lcsc.com/product-detail/C141517.html")
        self.assertFalse(o["verified"])

    def test_parse_lcsc_skips_zero_price(self):
        data = {"components": [{"lcsc": 1, "price": 0, "stock": 5, "mfr": "X"}]}
        self.assertEqual(live.parse_lcsc(data), [])

    def test_parse_mouser(self):
        offers = live.parse_mouser(MOUSER_SAMPLE)
        self.assertEqual(len(offers), 1)
        o = offers[0]
        self.assertEqual(o["shop"], "Mouser UK")
        self.assertEqual(o["part_number"], "771-SG90")
        self.assertEqual(o["stock"], 5432)
        self.assertEqual(o["price_gbp"], round(1.20 * match.USD_TO_GBP, 2))
        self.assertEqual(o["url"], "https://www.mouser.co.uk/product-detail/771-SG90")
        self.assertFalse(o["verified"])

    def test_parse_mouser_empty(self):
        self.assertEqual(live.parse_mouser({}), [])
        self.assertEqual(live.parse_mouser({"SearchResults": {"Parts": []}}), [])


class _FakeResp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class TestSearchBehaviour(unittest.TestCase):
    def setUp(self):
        live._cache.clear()
        live._mouser_calls.clear()
        self._old_key = os.environ.pop("MOUSER_API_KEY", None)

    def tearDown(self):
        if self._old_key:
            os.environ["MOUSER_API_KEY"] = self._old_key

    def test_mouser_skips_without_api_key(self):
        with mock.patch.object(live.httpx, "post") as p:
            self.assertEqual(live.mouser_search("SG90 servo"), [])
            p.assert_not_called()  # no HTTP call at all without a key

    def test_mouser_never_fails_on_api_error(self):
        os.environ["MOUSER_API_KEY"] = "dummy-key"
        with mock.patch.object(live.httpx, "post", return_value=_FakeResp({}, status=401)):
            self.assertEqual(live.mouser_search("SG90 servo"), [])  # error -> []
        with mock.patch.object(live.httpx, "post", side_effect=ConnectionError("down")):
            self.assertEqual(live.mouser_search("SG90 servo"), [])  # network error -> []

    def test_mouser_rate_limit_30_per_min(self):
        os.environ["MOUSER_API_KEY"] = "dummy-key"
        live._mouser_calls.extend([time.time()] * live.MOUSER_MAX_CALLS_PER_MIN)
        with mock.patch.object(live.httpx, "post") as p:
            self.assertEqual(live.mouser_search("SG90 servo"), [])
            p.assert_not_called()  # rate-limited: no HTTP call

    def test_lcsc_caches_1h(self):
        with mock.patch.object(live.httpx, "get", return_value=_FakeResp(LCSC_SAMPLE)) as g:
            a = live.lcsc_search("TB6612FNG")
            b = live.lcsc_search("TB6612FNG")
            self.assertEqual(g.call_count, 1)  # second call served from cache
            self.assertEqual(a, b)
            self.assertEqual(len(a), 2)
            # expired cache -> fetch again
            live._cache[("lcsc", "tb6612fng")] = (time.time() - 3601, a)
            live.lcsc_search("TB6612FNG")
            self.assertEqual(g.call_count, 2)

    def test_lcsc_never_fails(self):
        with mock.patch.object(live.httpx, "get", side_effect=TimeoutError()):
            self.assertEqual(live.lcsc_search("anything"), [])

    def test_live_offers_for_part_merges_and_sorts(self):
        with mock.patch.object(live, "lcsc_search", return_value=[
                {"shop": "LCSC", "price_gbp": 0.85, "title": "chip", "url": "u", "stock": 10, "verified": False}]), \
             mock.patch.object(live, "mouser_search", return_value=[
                {"shop": "Mouser UK", "price_gbp": 0.90, "title": "chip", "url": "u2", "stock": 5, "verified": False}]):
            offers = live.live_offers_for_part("TB6612FNG")
            self.assertEqual([o["shop"] for o in offers], ["LCSC", "Mouser UK"])  # sorted by price

    def test_keywords_extract_part_numbers(self):
        kws = live._keywords_for("SparkFun Motor Driver - Dual TB6612FNG (with Headers)")
        self.assertIn("TB6612FNG", kws)
        kws2 = live._keywords_for("Ultrasonic Distance Sensor HC-SR04 5V (Kitronik 46130)")
        self.assertTrue(any("HC-SR04" in k for k in kws2))

    def test_live_offers_falls_back_to_part_number_keyword(self):
        # full name yields nothing, part-number keyword yields offers
        def fake_lcsc(kw, limit=5):
            return [{"shop": "LCSC", "price_gbp": 0.85, "title": "chip", "url": "u", "stock": 9,
                     "verified": False}] if kw == "TB6612FNG" else []
        with mock.patch.object(live, "lcsc_search", side_effect=fake_lcsc), \
             mock.patch.object(live, "mouser_search", return_value=[]):
            offers = live.live_offers_for_part("SparkFun Motor Driver - Dual TB6612FNG (with Headers)")
            self.assertEqual(len(offers), 1)
            self.assertEqual(offers[0]["shop"], "LCSC")


if __name__ == "__main__":
    unittest.main()
