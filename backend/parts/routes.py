"""FastAPI routes for the Parts & Shop service (Person 3).

Mounted by backend/main.py under /api.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from . import agents, match

router = APIRouter(prefix="/api", tags=["parts"])


@router.get("/catalog")
def get_catalog() -> dict:
    """Full parts catalogue."""
    return match.load_catalog()


@router.get("/recipes")
def get_recipes() -> dict:
    """All build recipes."""
    return match.load_recipes()


@router.get("/recipes/{recipe_id}")
def get_recipe(recipe_id: str) -> dict:
    for rec in match.load_recipes()["recipes"]:
        if rec["id"] == recipe_id:
            return rec
    raise HTTPException(status_code=404, detail=f"unknown recipe: {recipe_id}")


@router.post("/match")
def post_match(payload: dict) -> dict:
    """Deterministic BOM (fast, no LLM). Body: {"components": [...], "owned": [...]}."""
    return match.match_components(payload)


@router.post("/match/smart")
def post_match_smart(payload: dict) -> dict:
    """Multi-agent BOM + warnings + substitutions. Falls back to /api/match on any failure."""
    return agents.smart_match(payload)


@router.post("/alternatives")
def post_alternatives(payload: dict) -> dict:
    """Substitutions for one part. Body: {"part_id": "l298n"}."""
    part_id = (payload or {}).get("part_id", "")
    if not part_id:
        raise HTTPException(status_code=400, detail="part_id is required")
    return agents.alternatives_for(part_id)
