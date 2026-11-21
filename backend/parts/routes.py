"""FastAPI routes for the Parts & Shop service (Person 3).

Mounted by backend/main.py under /api.

POST /api/match and /api/match/smart accept the shared VisionResult body
(backend/shared/schemas.py): {"parts": [{name, category, qty, confidence}],
"robot_guess": ..., "owned": [...]}. The legacy {"components": [...]} shape is
still accepted.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from shared.schemas import MatchRequest

from . import agents, match

router = APIRouter(prefix="/api", tags=["parts"])


@router.get("/catalog")
def get_catalog() -> dict:
    """Full parts catalogue."""
    return match.load_catalog()


@router.get("/config")
def get_config() -> dict:
    """Public runtime config: the USD->GBP rate used for all price conversions."""
    return {"USD_TO_GBP": match.USD_TO_GBP}


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
def post_match(req: MatchRequest, live_offers: bool = Query(False, alias="live")) -> dict:
    """Deterministic BOM (fast, no LLM). Body: VisionResult (+owned).

    With ?live=true each BOM row also gets `live_offers` (LCSC/Mouser live search,
    cached 1h, rate-limited, never fails — catalogue stays the fallback).
    """
    result = match.match_components(req.model_dump())
    if live_offers:
        from . import live as live_mod
        for row in result["bom"]:
            row["live_offers"] = live_mod.live_offers_for_part(row["name"])
    return result


@router.post("/match/smart")
async def post_match_smart(req: MatchRequest,
                           async_mode: bool = Query(False, alias="async")) -> dict:
    """Multi-agent BOM + warnings + substitutions. Falls back to /api/match on any failure.

    With ?async=true returns the fast deterministic BOM immediately plus a job_id;
    poll GET /api/jobs/{job_id} for the agent-enriched result.
    """
    payload = req.model_dump()
    if async_mode:
        job_id = agents.start_smart_job(payload)
        fast = match.match_components(payload)
        return {"job_id": job_id, "status": "running", "smart": False, **fast}
    return await agents.smart_match_async(payload)


@router.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    """Status of an async /api/match/smart job. Returns the full result when done."""
    job = agents.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown job_id: {job_id}")
    return job


@router.post("/alternatives")
def post_alternatives(payload: dict) -> dict:
    """Substitutions for one part. Body: {"part_id": "l298n"}."""
    part_id = (payload or {}).get("part_id", "")
    if not part_id:
        raise HTTPException(status_code=400, detail="part_id is required")
    return agents.alternatives_for(part_id)
