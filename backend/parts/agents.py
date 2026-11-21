"""Mistral multi-agent "parts team" (mistralai-agents SDK, Mistral Large 4).

Five agents, each created by a small `create_*` function and run by a small
`run_*` helper, so Person 4 can later lift them into durable agents inside a
Mistral Workflow:

  1. parts-coordinator      — receives components + deterministic match, returns final JSON
  2. catalog-matcher        — resolves unmatched/ambiguous components via the
                              `search_catalog` client tool (backed by match.py)
  3. price-scout (optional) — `web_search` client tool, restricted to the allowed
                              shop domains; anything found is marked verified=false.
                              If web search is unavailable it skips cleanly.
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
from typing import Any

import httpx
from dotenv import load_dotenv
from pydantic import BaseModel, Field

import mistralai.agents as agents
from mistralai.agents import Agent

from . import match

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
def web_search(query: str, max_results: int = 5) -> list[dict]:
    """Web search restricted to the allowed UK shop domains. Used by price-scout
    to find current product pages and prices. Results are NEVER marked verified."""
    return _web_search_impl(query, max_results)


def _web_search_impl(query: str, max_results: int = 5) -> list[dict]:
    """Best-effort search via DuckDuckGo HTML, restricted to allowed shops.
    Any failure returns [] so price-scout skips cleanly."""
    try:
        site_filter = " OR ".join(f"site:{d}" for d in ALLOWED_SHOP_DOMAINS)
        q = f"{query} ({site_filter}) price GBP buy"
        with httpx.Client(timeout=8, follow_redirects=True,
                          headers={"User-Agent": "Mozilla/5.0 (buildfromvision)"}) as client:
            r = client.get("https://html.duckduckgo.com/html/", params={"q": q})
        if r.status_code != 200:
            return []
        import re
        results = []
        for m in re.finditer(r'class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', r.text, re.S):
            url, title = m.group(1), re.sub(r"<[^>]+>", "", m.group(2)).strip()
            if any(d in url for d in ALLOWED_SHOP_DOMAINS):
                results.append({"title": title, "url": url})
            if len(results) >= max_results:
                break
        return results
    except Exception:
        return []


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
                "Call the web_search tool AT MOST 4 times in total, then immediately give the final JSON answer. "
                "You find current UK prices and product pages for parts on the allowed shops ONLY: "
                + ", ".join(ALLOWED_SHOP_DOMAINS)
                + ". Use the web_search tool. Return one quote per part. "
                  "Never invent URLs: if search returns nothing, return an empty quotes list with skipped=true. "
                  "Every quote is unverified and must be checked by a human (verified=false)."
            ),
            tools=[web_search],
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


def _cache_key(payload: dict) -> str:
    return hashlib.sha1(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


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


async def smart_match_async(payload: dict) -> dict:
    """Multi-agent BOM. Always returns the §8 contract keys; on any agent failure
    it returns the deterministic result with smart=false."""
    key = _cache_key(payload)
    if key in _CACHE:
        return _CACHE[key]

    baseline = match.match_components(payload)
    result = dict(baseline)
    result["smart"] = False
    result["warnings"] = []
    result["substitutions"] = {}
    result["price_quotes"] = []
    result["agent_trace"] = ["deterministic-baseline"]

    if os.getenv("BFV_MOCK", "0") == "1" or not os.getenv("MISTRAL_API_KEY"):
        result["agent_trace"].append("smart-skipped (BFV_MOCK or no API key) — deterministic only")
        _CACHE[key] = result
        return result

    try:
        components_json = json.dumps(payload.get("components", []), indent=2)
        baseline_json = json.dumps(baseline, indent=2)

        # 2. catalog-matcher resolves anything unmatched
        if baseline["unmatched"]:
            matcher = create_catalog_matcher()
            answers = agents.ClientToolAnswers(
                search_catalog.answer(lambda query, category=None, limit=5:
                                      _search_catalog_answer(query, category=category, limit=limit)),
            )
            content = (f"Robot: {baseline['robot_name']} (recipe {baseline['recipe_id']}). "
                       f"Resolve these unmatched components to catalogue IDs:\n"
                       f"{json.dumps(baseline['unmatched'])}")
            state = await run_agent(matcher, content, MatchResolution, on_client_tool=answers)
            res = _out(state, MatchResolution)
            result["agent_trace"].append(f"catalog-matcher: {len(res.resolutions)} resolved")
            resolved_names = set()
            for r in res.resolutions:
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

        # 3. price-scout (optional) — TODO urls only; skips cleanly if web_search unavailable
        todo_parts = [r for r in result["bom"] if r["url"] == "TODO"]
        if todo_parts:
            try:
                scout = create_price_scout()
                answers = agents.ClientToolAnswers(
                    web_search.answer(lambda query, max_results=5: _web_search_impl(query, max_results)),
                )
                content = ("Find current UK price + product page for these parts (allowed shops only):\n"
                           + json.dumps([{"part_id": r["part_id"], "name": r["name"]} for r in todo_parts], indent=2))
                state = await run_agent(scout, content, PriceScoutResult, on_client_tool=answers)
                quotes = _out(state, PriceScoutResult)
                if quotes.skipped or not quotes.quotes:
                    result["agent_trace"].append("price-scout: skipped (web_search unavailable/empty) — URLs stay TODO")
                else:
                    result["price_quotes"] = [q.model_dump() for q in quotes.quotes]
                    result["agent_trace"].append(f"price-scout: {len(quotes.quotes)} unverified quotes")
            except Exception as e:  # clean skip
                result["agent_trace"].append(f"price-scout: skipped ({type(e).__name__})")

        # 4. substitution-advisor for owned parts
        owned = set(payload.get("owned", []) or [])
        if owned:
            advisor = create_substitution_advisor()
            content = (f"Suggest up to 2 alternatives for these parts the user already owns or wants to replace: "
                       f"{json.dumps(list(owned))}\nBOM:\n{baseline_json}")
            state = await run_agent(advisor, content, SubstitutionAdvice)
            advice = _out(state, SubstitutionAdvice)
            for sub in advice.substitutions:
                if match.get_item(sub.part_id):
                    result["substitutions"][sub.part_id] = [
                        {**a, "url": a.get("url", "TODO")} for a in sub.alternatives
                    ] or alternatives_for(sub.part_id)["alternatives"]
            result["agent_trace"].append(f"substitution-advisor: {len(advice.substitutions)} advised")

        # 5. bom-auditor — compatibility warnings
        bom_with_specs = []
        for row in result["bom"]:
            item = match.get_item(row["part_id"]) or {}
            bom_with_specs.append({**row, "specs": item.get("specs", {})})
        auditor = create_bom_auditor()
        content = json.dumps({"robot": result["robot_name"], "bom": bom_with_specs}, indent=2)
        state = await run_agent(auditor, content, AuditResult)
        audit = _out(state, AuditResult)
        result["warnings"] = audit.warnings
        result["agent_trace"].append(f"bom-auditor: {len(audit.warnings)} warnings")

        # 1. coordinator — final verdict (notes only; baseline fields are authoritative)
        coordinator = create_parts_coordinator()
        content = (f"Components:\n{components_json}\nDeterministic match:\n{baseline_json}\n"
                   f"Warnings so far: {result['warnings']}")
        state = await run_agent(coordinator, content, CoordinatorVerdict)
        verdict = _out(state, CoordinatorVerdict)
        result["notes"] = verdict.notes
        if verdict.robot_name and verdict.robot_name != "Custom robot":
            result["robot_name"] = verdict.robot_name
        result["agent_trace"].append("parts-coordinator: done")

        result["smart"] = True
    except Exception as e:
        result["smart"] = False
        result["agent_trace"].append(f"fallback-to-deterministic ({type(e).__name__}: {e})")

    _CACHE[key] = result
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
