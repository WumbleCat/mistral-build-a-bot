"""Mistral multi-agent "parts team" (mistralai-agents SDK, Mistral Large 4).

Five agents, each created by a small `create_*` function and run by a small
`run_*` helper, so Person 4 can later lift them into durable agents inside a
Mistral Workflow:

  1. parts-coordinator      — receives components + deterministic match, returns final JSON
  2. catalog-matcher        — resolves unmatched/ambiguous components via the
                              `search_catalog` client tool (backed by match.py)
  3. price-scout (optional) — `lcsc_search`/`mouser_search` live-pricing client tools
                              (LCSC free; Mouser needs MOUSER_API_KEY); results become live_offers
                              with verified=false. Skips cleanly when unavailable.
  4. substitution-advisor   — up to 2 alternatives per part, catalogue first
  5. bom-auditor            — compatibility warnings (voltage, driver channels,
                              pins, missing wires/screws/switch)

Every agent call is wrapped in a 30s timeout and returns strict JSON via
`output_type`. On ANY failure the caller falls back to the deterministic
match.py result, so the demo never breaks. Results are cached per input hash.

Catalogue money schema (shared contract): items carry `price` + `currency`
(GBP|USD); GBP values are derived with match.to_gbp(price, currency).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from pydantic import BaseModel, Field

import mistralai.agents as agents
from mistralai.agents import Agent

from . import live, match

load_dotenv()

MODEL = os.getenv("BFV_MODEL", "mistral-large-4")  # Mistral Large 4
AGENT_TIMEOUT_S = 30  # per-agent timeout (~20s spec, margin for API latency); fallback still guarantees the demo

ALLOWED_SHOP_DOMAINS = [
    "sparkfun.com", "uk.rs-online.com", "digikey.co.uk", "mouser.co.uk", "lcsc.com",
]

# ---------------------------------------------------------------------------
# Client tools (function tools answered by this process)
# ---------------------------------------------------------------------------


@agents.client_tool
def search_catalog(query: str, category: str | None = None, limit: int = 5) -> list[dict]:
    """Search the BuildFromVision parts catalogue by free-text query and optional
    category. Returns catalogue IDs (only IDs that really exist) with score,
    price_gbp (converted to GBP via match.to_gbp), original currency, shop, sku."""
    return _search_catalog_answer(query, category=category, limit=limit)


def _search_catalog_answer(query: str, category: str | None = None, limit: int = 5) -> list[dict]:
    """match.search_catalog hits in the NEW schema: each hit carries
    id, name, category, score, price_gbp (GBP), currency, shop, sku."""
    hits = match.search_catalog(query, category=category, limit=limit)
    out = []
    for h in hits:
        item = match.get_item(h.get("id", "")) or {}
        if "price" in item and "currency" in item:
            h = {
                **h,
                "price_gbp": round(match.to_gbp(item["price"], item["currency"]), 2),
                "currency": item["currency"],
                "sku": item.get("sku"),
            }
        out.append(h)
    return out


@agents.client_tool
def lcsc_search(keyword: str, limit: int = 5) -> list[dict]:
    """Live LCSC (lcsc.com) component search — free, no API key. Returns live offers:
    {shop, title, part_number, price_gbp, currency, stock, url, verified:false}."""
    from . import live
    return live.lcsc_search(keyword, limit=limit)


@agents.client_tool
def mouser_search(keyword: str, records: int = 5) -> list[dict]:
    """Live Mouser (mouser.co.uk) keyword search via the Mouser Search API (needs
    MOUSER_API_KEY in .env; returns [] when missing or rate-limited). Returns live
    offers: {shop, title, part_number, price_gbp, currency, stock, url, verified:false}."""
    from . import live
    return live.mouser_search(keyword, records=records)


# ---------------------------------------------------------------------------
# Strict-JSON output schemas
# ---------------------------------------------------------------------------


class ResolutionItem(BaseModel):
    name: str
    part_id: str
    qty: int = 1
    reasoning: str = ""


class MatchResolution(BaseModel):
    resolutions: list[ResolutionItem] = Field(default_factory=list)
    still_unmatched: list[str] = Field(default_factory=list)


class PriceQuote(BaseModel):
    part_id: str
    shop: str | None = None
    url: str | None = None
    price_gbp: float | None = None
    source_note: str = "unverified — from web search, human must check"


class PriceScoutResult(BaseModel):
    quotes: list[PriceQuote] = Field(default_factory=list)
    skipped: bool = False
    note: str = ""


class Substitution(BaseModel):
    part_id: str
    reason: str
    alternatives: list[dict] = Field(default_factory=list)  # [{id, name, category, price, currency, unit_price_gbp, delta_gbp, shop, url, sku, verified}]


class SubstitutionAdvice(BaseModel):
    substitutions: list[Substitution] = Field(default_factory=list)


class AuditResult(BaseModel):
    warnings: list[str] = Field(default_factory=list)
    ok: bool = True


class CoordinatorVerdict(BaseModel):
    robot_name: str = "Custom robot"
    recipe_id: str | None = None
    notes: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Agent factories (small functions — Person 4 can reuse them in a Workflow)
# ---------------------------------------------------------------------------

_CATALOG_SUMMARY = ""  # injected at runtime


def _catalog_summary() -> str:
    """One line per catalogue item: id | name | category | price currency | shop | sku."""
    items = match.catalog_items()
    lines = [f'- {i["id"]} | {i["name"]} | {i["category"]} | {i["price"]} {i["currency"]} | {i["shop"]} | {i.get("sku") or "-"}'
             for i in items]
    return "\n".join(lines)


def _fast(**kwargs: Any) -> dict:
    """Shared speed settings: low reasoning, deterministic, few iterations."""
    return {"model": MODEL, "reasoning_effort": "low", **kwargs}


def create_catalog_matcher() -> Agent:
    return Agent(
        **_fast(
            name="catalog-matcher",
            max_iterations=8,
            instructions=(
                "You resolve robot components (from a photo) to catalogue part IDs. "
                "Call the search_catalog tool AT MOST 3 times in total, then immediately give the final JSON answer. "
                "Only return IDs that exist in the catalogue. "
                "Match by category first, then closest name/alias. If nothing fits, put the name in still_unmatched. "
                "Catalogue:\n" + _catalog_summary()
            ),
            tools=[search_catalog],
        )
    )


def create_price_scout() -> Agent:
    return Agent(
        **_fast(
            name="price-scout",
            max_iterations=6,
            instructions=(
                "Call the lcsc_search and/or mouser_search tools AT MOST 4 times in total, then immediately give the final JSON answer. "
                "You find current live prices and stock for parts using lcsc_search (free) and mouser_search (Mouser API key). "
                "Return one quote per part with shop, url, price_gbp and a source_note. "
                "Never invent URLs: if a search returns nothing, return an empty quotes list with skipped=true. "
                "Every quote is unverified and must be checked by a human (verified=false). Catalogue entries stay the fallback."
            ),
            tools=[lcsc_search, mouser_search],
        )
    )


def create_substitution_advisor() -> Agent:
    return Agent(
        **_fast(
            name="substitution-advisor",
            instructions=(
                "You suggest up to 2 substitute parts for a given part when it is owned, unavailable or expensive. "
                "Prefer the catalogue `alternatives` field of the part. Catalogue:\n" + _catalog_summary()
            ),
        )
    )


def create_bom_auditor() -> Agent:
    return Agent(
        **_fast(
            name="bom-auditor",
            instructions=(
                "You audit a robot BOM for electrical and mechanical compatibility. Check: "
                "battery voltage vs motor voltage range and driver motor-input range; "
                "driver channel count >= number of motors; controller logic voltage vs 3.3V sensors/peripherals "
                "(3.3V-only sensors like line_sensor must not be wired to a 5V logic pin); "
                "presence of breadboard, jumper wires and a power source for a buildable kit. "
                "HARD RULE: if the BOM contains any relay-category part, warn: "
                "Relays can only switch motors on/off (no speed control or reverse). "
                "A motor driver like TB6612FNG is recommended."
                "HARD RULE: if the BOM contains driver_l298n_breakout (or legacy l298n) AND a 6V AA pack "
                "(battery_4xaa_barrel / battery_4xaa_leads / batt_holder_4aa), you MUST emit exactly this warning: "
                "\"L298N drops ~2V, so on a 6V AA pack the TT motors get only ~4V and may stall — use driver_tb6612fng (TB6612FNG) instead\". "
                "Return plain-English warnings with concrete fixes. If all good, warnings=[] and ok=true. "
                "BOM (with specs) follows the colon:\n"
            ),
        )
    )


def create_parts_coordinator() -> Agent:
    return Agent(
        **_fast(
            name="parts-coordinator",
            instructions=(
                "You are the coordinator of a parts team for a robot-building app. "
                "You receive the identified components and the deterministic match result. "
                "Decide the robot name and recipe, and summarise notes and warnings. "
                "Return strict JSON only."
            ),
        )
    )


# ---------------------------------------------------------------------------
# Run helpers — each agent's run is small and timeout-wrapped
# ---------------------------------------------------------------------------


async def run_agent(agent: Agent, content: str, output_type: type[BaseModel] | None = None,
                    on_client_tool: Any = None, timeout: float = AGENT_TIMEOUT_S):
    """Run one agent turn with a timeout. Returns the Completed state (or parsed output)."""
    kwargs: dict[str, Any] = {}
    if output_type is not None:
        kwargs["output_type"] = output_type
    if on_client_tool is not None:
        kwargs["on_client_tool"] = on_client_tool
    return await asyncio.wait_for(agent.run(content, **kwargs), timeout=timeout)


def _out(state: Any, output_type: type[BaseModel]) -> BaseModel:
    """Extract structured output from a Completed state, falling back to parsing text."""
    out = getattr(state, "output", None)
    if out is not None:
        return out
    text = getattr(state, "text", "") or ""
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end > start:
        return output_type.model_validate_json(text[start:end + 1])
    return output_type.model_validate_json(text)


# ---------------------------------------------------------------------------
# Smart match — multi-agent pipeline with deterministic fallback
# ---------------------------------------------------------------------------

_CACHE: dict[str, dict] = {}
_CACHE_DIR = Path(__file__).parent / ".cache"
_CACHE_FILE = _CACHE_DIR / "smart_match.json"


def _cache_key(payload: dict) -> str:
    """Hash of the canonical payload: None/empty values dropped, so the startup
    pre-warm inputs hash identically to the same request arriving via HTTP."""
    def canon(o):
        if isinstance(o, dict):
            return {k: canon(v) for k, v in sorted(o.items()) if v not in (None, [], {})}
        if isinstance(o, list):
            return [canon(v) for v in o]
        return o
    return hashlib.sha1(json.dumps(canon(payload), sort_keys=True, default=str).encode()).hexdigest()


def _load_file_cache() -> dict:
    """Load the persistent smart-match cache (JSON file) into memory."""
    try:
        if _CACHE_FILE.exists():
            return json.loads(_CACHE_FILE.read_text())
    except Exception:
        pass
    return {}


def _save_file_cache() -> None:
    """Persist the smart-match cache to disk (best effort)."""
    try:
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        _CACHE_FILE.write_text(json.dumps(_CACHE, default=str))
    except Exception:
        pass


_CACHE.update(_load_file_cache())

# The 3 demo/test inputs (mirrors tests/test_match.py) — pre-warmed at startup,
# obstacle_avoider_car first because it is the live-demo robot.
DEMO_INPUTS: list[dict] = [
    {"parts": [
        {"name": "Arduino Uno", "category": "controller", "qty": 1, "confidence": 0.95},
        {"name": "tb6612 motor driver", "category": "motor_driver", "qty": 1, "confidence": 0.9},
        {"name": "yellow motor", "category": "motor", "qty": 2, "confidence": 0.9},
        {"name": "ultrasonic sensor", "category": "sensor", "qty": 1, "confidence": 0.85},
        {"name": "2wd chassis", "category": "chassis", "qty": 1, "confidence": 0.8},
    ], "robot_guess": "obstacle-avoiding car", "owned": []},
    {"parts": [
        {"name": "arduino", "category": "controller", "qty": 1, "confidence": 0.9},
        {"name": "tt motor", "category": "motor", "qty": 2, "confidence": 0.9},
        {"name": "line sensor", "category": "sensor", "qty": 3, "confidence": 0.85},
        {"name": "flux capacitor", "category": "power", "qty": 1, "confidence": 0.3},
    ], "robot_guess": "line-following car", "owned": []},
    {"parts": [
        {"name": "mearm", "category": "chassis", "qty": 1, "confidence": 0.9},
        {"name": "5v power supply", "category": "power", "qty": 1, "confidence": 0.8},
    ], "robot_guess": "robot arm", "owned": []},
]


async def prewarm() -> None:
    """Pre-warm the smart-match cache for the demo inputs (called at startup).

    Skipped in BFV_MOCK mode or without an API key (the deterministic result is
    cached instead). Never raises — a failed pre-warm must not block the server.
    """
    try:
        for payload in DEMO_INPUTS:
            try:
                await smart_match_async(payload)
            except Exception:
                pass
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Async jobs: POST /api/match/smart?async=true -> job_id; GET /api/jobs/{id}
# ---------------------------------------------------------------------------

_JOBS: dict[str, dict] = {}


def start_smart_job(payload: dict) -> str:
    """Start a background smart-match job. Must be called from a running event loop."""
    job_id = uuid.uuid4().hex[:12]
    _JOBS[job_id] = {
        "job_id": job_id,
        "status": "running",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    asyncio.create_task(_run_job(job_id, payload))
    return job_id


async def _run_job(job_id: str, payload: dict) -> None:
    try:
        result = await smart_match_async(payload)
        _JOBS[job_id].update({"status": "done", "finished_at": datetime.now(timezone.utc).isoformat(),
                               "result": result})
    except Exception as e:
        _JOBS[job_id].update({"status": "error", "error": f"{type(e).__name__}: {e}"})


def get_job(job_id: str) -> dict | None:
    return _JOBS.get(job_id)


def alternatives_for(part_id: str) -> dict:
    """Deterministic substitutions from the catalogue `alternatives` field.
    Each alternative carries id, name, category, price (original currency),
    currency, unit_price_gbp (via match.to_gbp), delta_gbp, shop, url, sku, verified."""
    item = match.get_item(part_id)
    if item is None:
        return {"part_id": part_id, "error": "unknown part_id", "alternatives": []}
    item_gbp = match.to_gbp(item["price"], item["currency"])
    alts = []
    for alt_id in item.get("alternatives", []):
        alt = match.get_item(alt_id)
        if alt:
            alt_gbp = match.to_gbp(alt["price"], alt["currency"])
            alts.append({
                "id": alt["id"], "name": alt["name"], "category": alt["category"],
                "price": alt["price"], "currency": alt["currency"],
                "unit_price_gbp": round(alt_gbp, 2),
                "delta_gbp": round(alt_gbp - item_gbp, 2),
                "shop": alt["shop"], "url": alt["url"],
                "sku": alt.get("sku"), "verified": alt.get("verified", False),
            })
    return {"part_id": part_id, "name": item["name"], "alternatives": alts}


async def _stage_matcher(baseline: dict) -> MatchResolution | None:
    """catalog-matcher: resolve unmatched components to catalogue IDs."""
    if not baseline["unmatched"]:
        return None
    matcher = create_catalog_matcher()
    answers = agents.ClientToolAnswers(
        search_catalog.answer(lambda query, category=None, limit=5:
                              _search_catalog_answer(query, category=category, limit=limit)),
    )
    content = (f"Robot: {baseline['robot_name']} (recipe {baseline['recipe_id']}). "
               f"Resolve these unmatched components to catalogue IDs:\n"
               f"{json.dumps(baseline['unmatched'])}")
    state = await run_agent(matcher, content, MatchResolution, on_client_tool=answers)
    return _out(state, MatchResolution)


async def _stage_scout(bom_rows: list[dict]) -> PriceScoutResult | None:
    """price-scout (optional): find UK prices for TODO-url parts. Skips cleanly."""
    todo_parts = [r for r in bom_rows if r.get("url") == "TODO"]
    if not todo_parts:
        return None
    scout = create_price_scout()
    answers = agents.ClientToolAnswers(
        lcsc_search.answer(lambda keyword, limit=5: live.lcsc_search(keyword, limit=limit)),
        mouser_search.answer(lambda keyword, records=5: live.mouser_search(keyword, records=records)),
    )
    content = ("Find current UK price + product page for these parts (allowed shops only):\n"
               + json.dumps([{"part_id": r["part_id"], "name": r["name"]} for r in todo_parts], indent=2))
    state = await run_agent(scout, content, PriceScoutResult, on_client_tool=answers)
    return _out(state, PriceScoutResult)


async def _stage_substitutions(payload: dict, baseline_json: str) -> SubstitutionAdvice | None:
    """substitution-advisor: alternatives for owned parts."""
    owned = set(payload.get("owned", []) or [])
    if not owned:
        return None
    advisor = create_substitution_advisor()
    content = (f"Suggest up to 2 alternatives for these parts the user already owns or wants to replace: "
               f"{json.dumps(list(owned))}\nBOM:\n{baseline_json}")
    state = await run_agent(advisor, content, SubstitutionAdvice)
    return _out(state, SubstitutionAdvice)


async def _stage_audit(robot_name: str, bom_rows: list[dict]) -> AuditResult | None:
    """bom-auditor: compatibility warnings (incl. L298N + 6V AA pack rule)."""
    bom_with_specs = []
    for row in bom_rows:
        item = match.get_item(row["part_id"]) or {}
        bom_with_specs.append({**row, "specs": item.get("specs", {})})
    auditor = create_bom_auditor()
    content = json.dumps({"robot": robot_name, "bom": bom_with_specs}, indent=2)
    state = await run_agent(auditor, content, AuditResult)
    return _out(state, AuditResult)


async def _safe(coro) -> object:
    """Run a stage, converting any failure into an exception sentinel (never raises)."""
    try:
        return await coro
    except Exception as e:
        return e


async def smart_match_async(payload: dict) -> dict:
    """Multi-agent BOM. Always returns the §8 contract keys; on agent failure the
    affected stage is skipped and the deterministic result is kept (smart flag
    reflects whether any agent contributed). Results cached in memory + JSON file.

    Speed: matcher, price-scout, substitution-advisor and bom-auditor run in
    PARALLEL (asyncio.gather); the parts-coordinator runs last.
    """
    key = _cache_key(payload)
    if key in _CACHE:
        cached = dict(_CACHE[key])
        cached["cached"] = True
        return cached

    baseline = match.match_components(payload)
    result = dict(baseline)
    result["smart"] = False
    result["warnings"] = []
    result["substitutions"] = {}
    result["price_quotes"] = []
    result["agent_trace"] = ["deterministic-baseline"]

    # deterministic rule-based warnings (always on, even in mock mode)
    bom_cats = {r.get("category") for r in result["bom"]}
    bom_ids = {r.get("part_id") for r in result["bom"]}
    if "relay" in bom_cats:
        result["warnings"].append("Relays can only switch motors on/off (no speed control or reverse). A motor driver like TB6612FNG (driver_tb6612fng) is recommended.")
    if bom_ids & {"driver_l298n_breakout", "l298n"} and bom_ids & {"battery_4xaa_barrel", "battery_4xaa_leads", "batt_holder_4aa"}:
        result["warnings"].append("L298N drops ~2V, so on a 6V AA pack the TT motors get only ~4V and may stall — use driver_tb6612fng (TB6612FNG) instead")


    if os.getenv("BFV_MOCK", "0") == "1" or not os.getenv("MISTRAL_API_KEY"):
        result["agent_trace"].append("smart-skipped (BFV_MOCK or no API key) — deterministic only")
        _CACHE[key] = result
        _save_file_cache()
        return result

    components_json = json.dumps(payload.get("components") or payload.get("parts") or [], indent=2, default=str)
    baseline_json = json.dumps(baseline, indent=2)

    # matcher, price-scout, substitution-advisor, bom-auditor — in parallel
    matcher_res, scout_res, subst_res, audit_res = await asyncio.gather(
        _safe(_stage_matcher(baseline)),
        _safe(_stage_scout(baseline["bom"])),
        _safe(_stage_substitutions(payload, baseline_json)),
        _safe(_stage_audit(baseline["robot_name"], baseline["bom"])),
    )

    contributed = False

    # assemble catalog-matcher resolutions into the BOM
    if isinstance(matcher_res, MatchResolution):
        contributed = True
        result["agent_trace"].append(f"catalog-matcher: {len(matcher_res.resolutions)} resolved")
        resolved_names = set()
        for r in matcher_res.resolutions:
            pid = r.part_id
            resolved_names.add(r.name)
            if pid and match.get_item(pid):
                qty = int(r.qty or 1)
                item = match.get_item(pid)
                unit_gbp = match.to_gbp(item["price"], item["currency"])
                line = round(unit_gbp * qty, 2)
                row = {
                    "part_id": pid, "name": item["name"], "category": item["category"],
                    "shop": item["shop"], "url": item["url"],
                    "currency": item["currency"], "unit_price": item["price"],
                    "unit_price_gbp": round(unit_gbp, 2),
                    "qty": qty, "line_total_gbp": line, "owned": False, "added_from_recipe": False,
                    "sku": item.get("sku"), "verified": item.get("verified", False),
                }
                if item.get("price_note"):
                    row["price_note"] = item["price_note"]
                result["bom"].append(row)
                result["bom_total_gbp"] = round(result["bom_total_gbp"] + line, 2)
                result["parts"].append({"id": pid, "name": item["name"], "category": item["category"],
                                        "qty": qty, "visible_in_photo": True})
        result["unmatched"] = [u for u in baseline["unmatched"] if u["name"] not in resolved_names]
    elif matcher_res is not None:
        result["agent_trace"].append(f"catalog-matcher failed ({type(matcher_res).__name__}) — skipped")

    # assemble price-scout quotes (always unverified)
    if isinstance(scout_res, PriceScoutResult):
        if scout_res.skipped or not scout_res.quotes:
            result["agent_trace"].append("price-scout: no live quotes — catalogue entries stay the fallback")
        else:
            contributed = True
            result["price_quotes"] = [q.model_dump() for q in scout_res.quotes]
            result["agent_trace"].append(f"price-scout: {len(scout_res.quotes)} unverified quotes")
    elif scout_res is not None:
        result["agent_trace"].append(f"price-scout: skipped ({type(scout_res).__name__})")

    # assemble substitution advice
    if isinstance(subst_res, SubstitutionAdvice):
        if subst_res.substitutions:
            contributed = True
        for sub in subst_res.substitutions:
            if match.get_item(sub.part_id):
                result["substitutions"][sub.part_id] = [
                    {**a, "url": a.get("url", "TODO")} for a in sub.alternatives
                ] or alternatives_for(sub.part_id)["alternatives"]
        result["agent_trace"].append(f"substitution-advisor: {len(subst_res.substitutions)} advised")
    elif subst_res is not None:
        result["agent_trace"].append(f"substitution-advisor failed ({type(subst_res).__name__}) — skipped")

    # assemble auditor warnings
    if isinstance(audit_res, AuditResult):
        contributed = True
        result["warnings"] = result["warnings"] + list(audit_res.warnings)
        result["agent_trace"].append(f"bom-auditor: {len(audit_res.warnings)} warnings")
    elif audit_res is not None:
        result["agent_trace"].append(f"bom-auditor failed ({type(audit_res).__name__}) — skipped")

    # attach live_offers next to each BOM part (catalogue stays the fallback);
    # live.py caches 1h, rate-limits Mouser to 30/min, and never raises
    async def _attach_live(row: dict) -> None:
        row["live_offers"] = await asyncio.to_thread(live.live_offers_for_part, row["name"])
    await asyncio.gather(*[_attach_live(r) for r in result["bom"]])
    result["agent_trace"].append("live-offers attached to BOM rows")

    # coordinator last — final verdict over everything
    try:
        coordinator = create_parts_coordinator()
        content = (f"Components:\n{components_json}\nDeterministic match:\n{baseline_json}\n"
                   f"Warnings so far: {result['warnings']}")
        state = await run_agent(coordinator, content, CoordinatorVerdict)
        verdict = _out(state, CoordinatorVerdict)
        result["notes"] = verdict.notes
        if verdict.robot_name and verdict.robot_name != "Custom robot":
            result["robot_name"] = verdict.robot_name
        result["agent_trace"].append("parts-coordinator: done")
        contributed = True
    except Exception as e:
        result["agent_trace"].append(f"parts-coordinator failed ({type(e).__name__}) — baseline kept")

    result["smart"] = contributed
    _CACHE[key] = result
    _save_file_cache()
    return result

def smart_match(payload: dict) -> dict:
    """Sync wrapper for FastAPI."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None:  # already in a loop (shouldn't happen with FastAPI sync def)
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(1) as ex:
            return ex.submit(asyncio.run, smart_match_async(payload)).result()
    return asyncio.run(smart_match_async(payload))
