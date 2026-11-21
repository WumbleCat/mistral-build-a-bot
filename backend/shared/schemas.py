"""Shared Pydantic schemas for BuildFromVision (Person 2 vision, Person 3 parts, Person 4 workflow).

Two input generations are accepted by /api/match and /api/match/smart:

- NEW (Person 2, real vision output): a plain JSON list of VisionPart, or
  {"parts": [VisionPart...], "robot_guess": ..., "owned": [...]}
- LEGACY: {"parts": [DetectedPart...]} (category is a strict Literal, qty/confidence)
  or {"components": [{"name","category","qty"}], "owned": [...]}
"""

from __future__ import annotations

from typing import Literal, Optional, Union

from pydantic import BaseModel, Field, model_validator

# The 10 original catalogue categories (legacy DetectedPart stays strict).
PartCategory = Literal[
    "controller", "motor_driver", "motor", "servo", "sensor",
    "power", "wheel", "chassis", "wiring", "fasteners",
]


# ---------------------------------------------------------------------------
# NEW: Person 2 vision output
# ---------------------------------------------------------------------------


class VisionPart(BaseModel):
    """One component detected by the vision model (free-text category)."""

    name: str = Field(min_length=1)
    category: str = ""  # free text, e.g. "frame/chassis", "relay_module" — normalised by parts.match
    quantity: Optional[int] = Field(default=None, ge=1)  # null + inferred -> recipe qty or 1
    evidence: Literal["visible", "inferred"] = "visible"
    source_ids: list[str] = Field(default_factory=list)  # frontend highlights these on the photo
    sku: Optional[str] = None
    product_url: Optional[str] = None
    review_required: bool = False
    notes: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def _legacy_qty(cls, values):
        # legacy DetectedPart used "qty" — accept it as quantity
        if isinstance(values, dict) and values.get("quantity") is None and values.get("qty") is not None:
            values = {**values, "quantity": values["qty"]}
        return values


class VisionRequest(BaseModel):
    """Object form of the Person 2 output."""

    parts: list[VisionPart] = Field(default_factory=list)
    robot_guess: Optional[str] = None
    owned: list[str] = Field(default_factory=list, description="Catalogue part IDs the user already owns")


# ---------------------------------------------------------------------------
# LEGACY (kept working)
# ---------------------------------------------------------------------------


class DetectedPart(BaseModel):
    """Legacy detected part (strict category)."""

    name: str = Field(min_length=1)
    category: PartCategory
    qty: int = Field(default=1, ge=1)
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)


class VisionResult(BaseModel):
    """Legacy structured vision output."""

    parts: list[DetectedPart] = Field(default_factory=list)
    robot_guess: Optional[str] = None


class MatchRequest(VisionResult):
    """Legacy match body."""

    owned: list[str] = Field(default_factory=list)
    components: Optional[list[dict]] = Field(default=None)


# ---------------------------------------------------------------------------
# Unified body for /api/match and /api/match/smart
# ---------------------------------------------------------------------------


class MatchBody(BaseModel):
    """Unified match request body: new VisionPart parts, legacy components, or both."""

    parts: list[VisionPart] = Field(default_factory=list)
    robot_guess: Optional[str] = None
    owned: list[str] = Field(default_factory=list)
    components: Optional[list[dict]] = Field(default=None, description="Legacy shape")


MatchPayload = Union[MatchBody, list[VisionPart]]


def normalize_match_payload(body: MatchPayload) -> dict:
    """Normalize the endpoint body to a plain dict for parts.match / parts.agents."""
    if isinstance(body, list):
        return {"parts": [p.model_dump() if hasattr(p, "model_dump") else p for p in body]}
    return body.model_dump()
