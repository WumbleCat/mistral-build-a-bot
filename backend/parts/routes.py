"""FastAPI routes for the Parts & Shop service (Person 3).

Mounted by backend/main.py under /api.

POST /api/match and /api/match/smart accept the shared VisionResult body
(backend/shared/schemas.py): {"parts": [{name, category, qty, confidence}],
"robot_guess": ..., "owned": [...]}. The legacy {"components": [...]} shape is
still accepted.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from shared.schemas import MatchBody, MatchPayload, VisionPart, normalize_match_payload

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
def post_match(payload: MatchPayload, live_offers: bool = Query(False, alias="live")) -> dict:
    """Deterministic BOM (fast, no LLM).

    Body: EITHER a plain list of VisionPart (Person 2 format) OR
    {"parts": [...], "robot_guess": ..., "owned": [...]}. Legacy
    {"components": [...]} is also accepted. With ?live=true each BOM row also
    gets `live_offers` (LCSC/Mouser live search, cached 1h, rate-limited,
    never fails — catalogue stays the fallback).
    """
    result = match.match_components(normalize_match_payload(payload))
    if live_offers:
        from . import live as live_mod
        for row in result["bom"]:
            offers = live_mod.live_offers_for_part(row["name"], row.get("category"), row.get("part_id"))
            exact, similar = live_mod.split_offers(offers)
            row["live_offers"] = exact
            if similar:
                row["live_offers_similar"] = similar
    return result


@router.post("/match/smart")
async def post_match_smart(payload: MatchPayload,
                           async_mode: bool = Query(False, alias="async")) -> dict:
    """Multi-agent BOM + warnings + substitutions. Falls back to /api/match on any failure.

    Accepts the same body shapes as /api/match. With ?async=true returns the fast
    deterministic BOM immediately plus a job_id; poll GET /api/jobs/{job_id}.
    """
    payload = normalize_match_payload(payload)
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


@router.get("/search")
def get_search(q: str = Query(..., min_length=1), limit: int = Query(5, ge=1, le=10)) -> dict:
    """Live shop search: LCSC + Mouser side by side.

    Returns {"q": ..., "lcsc": [...], "mouser": [...]} where each offer is
    {shop, title, part_number, price_gbp, currency, stock, url, verified, source}.
    Results are cached 1h; a failing shop API just yields an empty list — never a 500.
    """
    from . import live as live_mod

    def _safe(fn, *args, **kwargs) -> list:
        try:
            return fn(*args, **kwargs)
        except Exception:
            return []  # a failing shop API yields an empty list, never a 500

    lcsc = _safe(live_mod.lcsc_search, q, limit=limit)
    mouser = _safe(live_mod.mouser_search, q, records=limit)
    # annotate each offer with match_quality against the closest catalogue part
    best = match.search_catalog(q, limit=1)
    item = match.get_item(best[0]["id"]) if best and best[0]["score"] >= match.SCORE_THRESHOLD else None
    for o in lcsc + mouser:
        o["match_quality"] = live_mod.classify_offer(o, (item or {}).get("category"), item)
    exact, similar = live_mod.split_offers(lcsc + mouser)
    return {
        "q": q,
        "lcsc": lcsc,
        "mouser": mouser,
        "exact": exact,      # shown by default
        "similar": similar,  # e.g. bare ICs for module categories — separate list
    }


@router.post("/alternatives")
def post_alternatives(payload: dict) -> dict:
    """Substitutions for one part. Body: {"part_id": "l298n"}."""
    part_id = (payload or {}).get("part_id", "")
    if not part_id:
        raise HTTPException(status_code=400, detail="part_id is required")
    return agents.alternatives_for(part_id)
