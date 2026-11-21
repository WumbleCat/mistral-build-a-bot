"""Tests for the shared Pydantic schemas (backend/shared/schemas.py) and the
VisionResult-shaped /api/match + async /api/match/smart endpoints.

Run from the repo root:
    backend/.venv/bin/python -m unittest tests.test_schemas -v
"""

import os
import sys
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from pydantic import ValidationError  # noqa: E402

from shared.schemas import DetectedPart, MatchRequest, VisionResult  # noqa: E402
from parts import match  # noqa: E402

VISION_BODY = {
    "parts": [
        {"name": "Arduino Uno", "category": "controller", "qty": 1, "confidence": 0.95},
        {"name": "tb6612 motor driver", "category": "motor_driver", "qty": 1, "confidence": 0.9},
        {"name": "yellow motor", "category": "motor", "qty": 2, "confidence": 0.9},
        {"name": "ultrasonic sensor", "category": "sensor", "qty": 1, "confidence": 0.85},
    ],
    "robot_guess": "obstacle-avoiding car",
    "owned": [],
}


class TestSchemas(unittest.TestCase):
    def test_detected_part_valid(self):
        p = DetectedPart(name="yellow motor", category="motor", qty=2, confidence=0.9)
        self.assertEqual(p.qty, 2)
        self.assertEqual(p.confidence, 0.9)

    def test_detected_part_rejects_bad_category(self):
        with self.assertRaises(ValidationError):
            DetectedPart(name="flux capacitor", category="magic", qty=1, confidence=1.0)

    def test_detected_part_rejects_qty_zero_and_bad_confidence(self):
        with self.assertRaises(ValidationError):
            DetectedPart(name="x", category="motor", qty=0)
        with self.assertRaises(ValidationError):
            DetectedPart(name="x", category="motor", qty=1, confidence=1.5)

    def test_vision_result_optional_robot_guess(self):
        v = VisionResult(parts=[{"name": "servo", "category": "servo"}])
        self.assertIsNone(v.robot_guess)
        self.assertEqual(v.parts[0].qty, 1)  # default

    def test_match_request_accepts_vision_result(self):
        req = MatchRequest(**VISION_BODY)
        self.assertEqual(len(req.parts), 4)
        self.assertEqual(req.owned, [])


class TestMatchAcceptsVisionResult(unittest.TestCase):
    def test_match_components_accepts_parts_shape(self):
        result = match.match_components(VISION_BODY)
        self.assertEqual(result["recipe_id"], "obstacle_avoider_car")  # robot_guess hint
        ids = {p["id"] for p in result["parts"]}
        self.assertIn("arduino_uno", ids)
        self.assertIn("motor_tt_pair", ids)
        self.assertGreater(result["bom_total_gbp"], 0)

    def test_legacy_components_shape_still_works(self):
        legacy = {"components": [{"name": "yellow motor", "category": "motor", "qty": 2}]}
        result = match.match_components(legacy)
        self.assertIn("motor_tt_pair", {p["id"] for p in result["parts"]})


class TestEndpoints(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ["BFV_MOCK"] = "1"  # async job completes instantly, no API calls
        from fastapi.testclient import TestClient
        from main import app
        cls.client = TestClient(app)

    def test_api_match_accepts_vision_result(self):
        r = self.client.post("/api/match", json=VISION_BODY)
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertEqual(d["recipe_id"], "obstacle_avoider_car")
        self.assertIn("bom_total_gbp", d)

    def test_api_match_rejects_bad_category(self):
        bad = {"parts": [{"name": "x", "category": "magic", "qty": 1}]}
        r = self.client.post("/api/match", json=bad)
        self.assertEqual(r.status_code, 422)

    def test_smart_async_mode_returns_job_and_fast_bom(self):
        r = self.client.post("/api/match/smart?async=true", json=VISION_BODY)
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertIn("job_id", d)
        self.assertEqual(d["status"], "running")
        self.assertIn("bom", d)  # fast deterministic BOM is included immediately
        self.assertEqual(d["recipe_id"], "obstacle_avoider_car")
        # poll the job until done (mock mode -> instant)
        job = None
        for _ in range(50):
            job = self.client.get(f"/api/jobs/{d['job_id']}").json()
            if job["status"] in ("done", "error"):
                break
            time.sleep(0.1)
        self.assertEqual(job["status"], "done", job)
        self.assertIn("result", job)
        self.assertEqual(job["result"]["recipe_id"], "obstacle_avoider_car")

    def test_smart_sync_mode_mock(self):
        r = self.client.post("/api/match/smart", json=VISION_BODY)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["smart"])  # BFV_MOCK=1 -> deterministic only

    def test_unknown_job_404(self):
        r = self.client.get("/api/jobs/doesnotexist")
        self.assertEqual(r.status_code, 404)


if __name__ == "__main__":
    unittest.main()
