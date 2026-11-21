"""Shared Pydantic schemas for BuildFromVision (used by Person 2 vision, Person 3 parts, Person 4 workflow).

The vision step (Mistral Large 4, structured output) returns a VisionResult.
`/api/match` and `/api/match/smart` accept it directly as the request body
(optionally with `owned` part IDs), plus the legacy `{"components": [...]}` shape.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

# The 10 catalogue categories (backend/parts/catalog.json -> "categories").
PartCategory = Literal[
    "controller", "motor_driver", "motor", "servo", "sensor",
    "power", "wheel", "chassis", "wiring", "fasteners",
]


class DetectedPart(BaseModel):
    """One component the vision model saw in the photo."""

    name: str = Field(min_length=1, description="What the vision model called it, e.g. 'yellow motor'")
    category: PartCategory
    qty: int = Field(default=1, ge=1)
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)


class VisionResult(BaseModel):
    """Structured output of the vision agent (Person 2)."""

    parts: list[DetectedPart] = Field(default_factory=list)
    robot_guess: Optional[str] = Field(default=None, description="e.g. 'obstacle-avoiding car'")


class MatchRequest(VisionResult):
    """Body of POST /api/match and /api/match/smart."""

    owned: list[str] = Field(default_factory=list, description="Catalogue part IDs the user already owns")
    components: Optional[list[dict]] = Field(
        default=None, description="Legacy shape: [{'name', 'category', 'qty'}] — still accepted"
    )
