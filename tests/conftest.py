"""Shared test helpers. No test touches the network or the real .env."""

from __future__ import annotations

import io
import json

import pytest
from PIL import Image

from robot_bom.ingest import ImageInput, ingest
from robot_bom.models import (
    Component, Evidence, EvidenceType, ImageObservation, InferenceAudit, VisibilityAudit,
)


def png_bytes(colour=(40, 160, 90), size=(64, 48)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, colour).save(buffer, format="PNG")
    return buffer.getvalue()


def make_images(*names: str) -> list[ImageInput]:
    """Distinct tiny images, one per file name."""
    return ingest([(name, png_bytes(colour=(10 + 40 * i, 120, 200 - 30 * i))) for i, name in enumerate(names)])


class ScriptedClient:
    """VisionClient fake: replies come from per-schema queues; calls are recorded."""

    name = "scripted"

    def __init__(self, pass1: list, pass2: list | None = None, verify: list | None = None) -> None:
        self.pass1 = list(pass1)
        self.pass2 = list(pass2 if pass2 is not None else [EMPTY_AUDIT])
        self.verify = list(verify if verify is not None else [{"checks": []}])
        self.calls: list[dict] = []

    def calls_for(self, schema) -> list[dict]:
        return [call for call in self.calls if call["schema"] is schema]

    def analyze(self, images, system_prompt, response_schema, user_prompt=""):
        self.calls.append({"schema": response_schema, "user_prompt": user_prompt, "images": images})
        queue = {ImageObservation: self.pass1, InferenceAudit: self.pass2,
                 VisibilityAudit: self.verify}[response_schema]
        if not queue:
            raise AssertionError(f"no scripted reply left for {response_schema.__name__}")
        reply = queue.pop(0) if len(queue) > 1 else queue[0]
        return reply if isinstance(reply, str) else json.dumps(reply)


EMPTY_AUDIT = {"inferred_components": [], "connections": [], "issues": [], "requested_views": []}


def part(category, name, quantity=1, **extra) -> dict:
    return {"category": category, "name": name, "description": f"visible {name}",
            "visible_quantity": quantity, "confidence": 0.8, **extra}


def view(view_name: str, *parts: dict) -> dict:
    return {"view": view_name, "parts": list(parts), "notes": []}


def observed(component_id: str, category: str, name: str, quantity: int | None = 1,
             image_id: str = "img1", **extra) -> Component:
    return Component(
        id=component_id, category=category, name=name, evidence_type=EvidenceType.OBSERVED,
        evidence=[Evidence(image_id=image_id, description=f"visible {name}")],
        visible_quantity=quantity, **extra,
    )


def hidden(component_id: str, category: str, name: str, **extra) -> Component:
    extra.setdefault("evidence_type", EvidenceType.UNKNOWN)
    return Component(id=component_id, category=category, name=name, **extra)


@pytest.fixture
def top_view_reply() -> dict:
    """The acceptance-test rover: four tyres, green chassis, breadboard, relay assembly."""
    return view(
        "top",
        part("wheel", "rubber wheel", 4),
        part("chassis", "green chassis frame", 1),
        part("breadboard", "solderless breadboard", 1),
        part("relay_module", "relay module board", 1),
        part("relay", "blue relay block", 2, parent_assembly="relay module board"),
        part("wiring", "jumper wires", None),
        part("led", "LED", 3),
    )
