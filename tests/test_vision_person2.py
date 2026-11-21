"""Test the Person 2 (vision) real output format end-to-end.

Posts mock/vision_person2_sample.json to /api/match and /api/match/smart and
checks: 200 response, wheels -> 2 packs, inferred parts marked "suggested",
tape in unmatched, relay warning present (smart mode, deterministic rule).

Run from repo root: backend/.venv/bin/python -m unittest tests.test_vision_person2 -v
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

SAMPLE_PATH = os.path.join(os.path.dirname(__file__), "..", "mock", "vision_person2_sample.json")


class TestVisionPerson2(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ["BFV_MOCK"] = "1"  # smart mode stays deterministic/fast in tests
        with open(SAMPLE_PATH) as f:
            cls.sample = json.load(f)
        from fastapi.testclient import TestClient
        from main import app
        from parts import agents
        agents._CACHE.clear()  # ignore stale file cache in tests
        cls.client = TestClient(app)

    def test_sample_file_is_a_plain_list(self):
        self.assertIsInstance(self.sample, list)
        self.assertEqual(len(self.sample), 15)
        for p in self.sample:
            self.assertIn("name", p)
            self.assertIn("evidence", p)
            self.assertIn(p["evidence"], ("visible", "inferred"))

    def test_match_accepts_plain_list_200(self):
        r = self.client.post("/api/match", json=self.sample)
        self.assertEqual(r.status_code, 200, r.text[:400])
        return r.json()

    def test_wheels_become_two_packs(self):
        d = self.client.post("/api/match", json=self.sample).json()
        wheel_rows = [b for b in d["bom"] if b["category"] == "wheel"]
        self.assertTrue(wheel_rows, "expected a wheel row in the BOM")
        row = wheel_rows[0]
        self.assertEqual(row["units_needed"], 4)
        self.assertEqual(row["packs_to_buy"], 2)   # pack_size 2
        self.assertEqual(row["qty"], 2)
        self.assertEqual(row["status"], "identified")  # visible
        self.assertEqual(len(row["source_ids"]), 7)    # W001..D003 passed through

    def test_inferred_parts_marked_suggested(self):
        d = self.client.post("/api/match", json=self.sample).json()
        suggested = [b for b in d["bom"] if b["status"] == "suggested"]
        self.assertTrue(suggested, "expected inferred parts to be 'suggested'")
        # motor was inferred with quantity null -> recipe qty (rover_4wd: 2 pairs)
        motor = next((b for b in d["bom"] if b["part_id"] == "motor_tt_pair"), None)
        self.assertIsNotNone(motor)
        self.assertEqual(motor["status"], "suggested")
        self.assertTrue(motor["needs_check"])  # review_required true
        self.assertIn("no motor cans", motor.get("notes", ""))

    def test_tape_and_unknown_block_in_unmatched(self):
        d = self.client.post("/api/match", json=self.sample).json()
        names = " | ".join(u["name"] for u in d["unmatched"]).lower()
        self.assertIn("duct tape", names)
        self.assertIn("gray rectangular block", names)
        # unmatched keeps notes, never crashes
        tape = next(u for u in d["unmatched"] if "tape" in u["name"].lower())
        self.assertEqual(tape["category"], "misc")
        self.assertIn("Wrapped on the right", tape.get("notes", ""))

    def test_four_wheels_prefer_rover_4wd(self):
        d = self.client.post("/api/match", json=self.sample).json()
        self.assertEqual(d["recipe_id"], "rover_4wd")
        self.assertIn("recipe_confidence", d)
        self.assertIn("closest_recipe", d)
        chassis = [b for b in d["bom"] if b["category"] == "chassis"]
        self.assertEqual(chassis[0]["part_id"], "chassis_4wd")  # swapped to 4WD

    def test_smart_mode_relay_warning(self):
        r = self.client.post("/api/match/smart", json=self.sample)
        self.assertEqual(r.status_code, 200, r.text[:400])
        d = r.json()
        relay_rows = [b for b in d["bom"] if b["category"] == "relay"]
        self.assertTrue(relay_rows, "expected relay row in BOM")
        self.assertTrue(any("Relays can only switch motors on/off" in w for w in d["warnings"]),
                        f"relay warning missing: {d['warnings']}")

    def test_object_form_also_accepted(self):
        body = {"parts": self.sample, "robot_guess": "4wd rover", "owned": []}
        r = self.client.post("/api/match", json=body)
        self.assertEqual(r.status_code, 200, r.text[:400])
        self.assertEqual(r.json()["recipe_id"], "rover_4wd")

    def test_legacy_components_shape_still_works(self):
        r = self.client.post("/api/match", json={"components": [
            {"name": "yellow motor", "category": "motor", "qty": 2}]})
        self.assertEqual(r.status_code, 200)
        self.assertIn("motor_tt_pair", {p["id"] for p in r.json()["parts"]})


if __name__ == "__main__":
    unittest.main()
