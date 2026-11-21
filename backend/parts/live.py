"""Live shop pricing (price-scout backing) — LCSC (free) + Mouser (API key).

- lcsc_search(keyword): GET https://jlcsearch.tscircuit.com/api/search?q=<kw>&limit=5&full=true  (no key)
- mouser_search(keyword): Mouser Search API v1 keyword search, MOUSER_API_KEY from .env.
  Skips cleanly (returns []) when the key is missing or the API errors.

Guarantees:
- Results normalized to "live_offers": {shop, title, part_number, price_gbp, currency,
  stock, url, verified:false, source}. Catalogue entries remain the fallback.
- 1-hour in-memory cache per (shop, keyword).
- Mouser rate limit: max 30 calls per rolling 60s window.
- NEVER raises — any error -> [] (the BOM must never fail because a live API errored).
"""

from __future__ import annotations

import os
import re
import time
from typing import Any

import httpx
from dotenv import load_dotenv

from . import match

load_dotenv()

LCSC_SEARCH_URL = "https://jlcsearch.tscircuit.com/api/search"
MOUSER_SEARCH_URL = "https://api.mouser.com/api/v1/search/keyword"

CACHE_TTL_S = 3600  # 1 hour
MOUSER_MAX_CALLS_PER_MIN = 30
HTTP_TIMEOUT_S = 10

_cache: dict[tuple[str, str], tuple[float, list[dict]]] = {}
_mouser_calls: list[float] = []  # timestamps of recent Mouser API calls (sliding window)


def _mouser_api_key() -> str | None:
    key = os.getenv("MOUSER_API_KEY", "").strip()
    return key or None


def _cached(key: tuple[str, str], fetch) -> list[dict]:
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < CACHE_TTL_S:
        return hit[1]
    try:
        offers = fetch()
    except Exception:
        offers = []  # never fail the BOM on a live API error
    _cache[key] = (now, offers)
    return offers


def _mouser_rate_limited() -> bool:
    now = time.time()
    global _mouser_calls
    _mouser_calls = [t for t in _mouser_calls if now - t < 60]
    return len(_mouser_calls) >= MOUSER_MAX_CALLS_PER_MIN


def _record_mouser_call() -> None:
    _mouser_calls.append(time.time())


# ---------------------------------------------------------------------------
# Response parsers (pure functions — unit-tested without network)
# ---------------------------------------------------------------------------


def parse_lcsc(data: dict) -> list[dict]:
    """jlcsearch response -> normalized live_offers. Prices on LCSC are USD."""
    offers = []
    for c in (data or {}).get("components", []) or []:
        try:
            lcsc_id = c.get("lcsc")
            price_usd = float(c.get("price", 0) or 0)
            if price_usd <= 0:
                continue
            offers.append({
                "shop": "LCSC",
                "title": " ".join(x for x in [c.get("mfr"), c.get("description")] if x)[:120],
                "part_number": f"C{lcsc_id}" if lcsc_id is not None else None,
                "price_gbp": round(match.to_gbp(price_usd, "USD"), 2),
                "currency": "USD",
                "stock": c.get("stock"),
                "url": f"https://www.lcsc.com/product-detail/C{lcsc_id}.html" if lcsc_id is not None else None,
                "verified": False,
                "source": "LCSC live search API",
            })
        except Exception:
            continue
    return offers


def _mouser_stock(avail: Any) -> int | None:
    if avail is None:
        return None
    if isinstance(avail, (int, float)):
        return int(avail)
    m = re.search(r"(\d[\d,]*)", str(avail))
    return int(m.group(1).replace(",", "")) if m else None


def parse_mouser(data: dict) -> list[dict]:
    """Mouser Search API v1 response -> normalized live_offers. Prices are USD."""
    offers = []
    parts = ((data or {}).get("SearchResults") or {}).get("Parts") or []
    for p in parts:
        try:
            part_number = p.get("MouserPartNumber") or p.get("PartNumber")
            breaks = p.get("PriceBreaks") or []
            price_usd = None
            if breaks:
                price_usd = float(str(breaks[0].get("Price", "")).replace("£", "").replace("$", "").replace(",", "") or 0)
            if not price_usd or price_usd <= 0:
                continue
            url = (p.get("DetailPageUrl") or p.get("ProductDetailUrl")
                   or (f"https://www.mouser.co.uk/product-detail/{part_number}" if part_number else None))
            offers.append({
                "shop": "Mouser UK",
                "title": (p.get("Description") or part_number or "")[:120],
                "part_number": part_number,
                "manufacturer": p.get("Manufacturer"),
                "price_gbp": round(match.to_gbp(price_usd, "USD"), 2),
                "currency": "USD",
                "stock": _mouser_stock(p.get("Availability")),
                "url": url,
                "verified": False,
                "source": "Mouser Search API",
            })
        except Exception:
            continue
    return offers


# ---------------------------------------------------------------------------
# Public search functions (cached, rate-limited, never raise)
# ---------------------------------------------------------------------------


def lcsc_search(keyword: str, limit: int = 5) -> list[dict]:
    """Free LCSC search via jlcsearch.tscircuit.com. Returns live_offers ([])."""
    keyword = (keyword or "").strip()
    if not keyword:
        return []

    def fetch() -> list[dict]:
        r = httpx.get(LCSC_SEARCH_URL, params={"q": keyword, "limit": limit, "full": "true"},
                      timeout=HTTP_TIMEOUT_S, headers={"User-Agent": "buildfromvision/0.1"})
        r.raise_for_status()
        return parse_lcsc(r.json())

    return _cached(("lcsc", keyword.lower()), fetch)


def mouser_search(keyword: str, records: int = 5) -> list[dict]:
    """Mouser keyword search. Skips cleanly without MOUSER_API_KEY; rate-limited
    to 30 calls/min; any API error -> []. Returns live_offers ([])."""
    keyword = (keyword or "").strip()
    if not keyword:
        return []
    if not _mouser_api_key():
        return []  # skip: no key configured
    if _mouser_rate_limited():
        return []  # skip: rate limit reached

    def fetch() -> list[dict]:
        _record_mouser_call()
        r = httpx.post(
            MOUSER_SEARCH_URL,
            params={"apiKey": _mouser_api_key()},
            json={"SearchByKeywordRequest": {"keyword": keyword, "records": records}},
            timeout=HTTP_TIMEOUT_S,
            headers={"Content-Type": "application/json", "User-Agent": "buildfromvision/0.1"},
        )
        r.raise_for_status()
        return parse_mouser(r.json())

    return _cached(("mouser", keyword.lower()), fetch)


def _keywords_for(name: str) -> list[str]:
    """Search keywords for a catalogue part name: the full name first, then
    part-number-ish tokens (e.g. 'TB6612FNG', 'HC-SR04') which is what the
    live search APIs actually index."""
    name = (name or "").strip()
    if not name:
        return []
    kws = [name]
    tokens = re.findall(r"[A-Za-z0-9][A-Za-z0-9\-]{3,}", name)
    pn = [t for t in tokens if re.search(r"\d", t) or t.isupper() or "-" in t.upper()]
    if pn:
        joined = " ".join(pn[:3])
        if joined != name:
            kws.append(joined)
        longest = max(pn, key=len)
        if longest not in kws:
            kws.append(longest)
    return kws[:3]


# ---------------------------------------------------------------------------
# Match quality: for module-type categories, reject bare-IC live hits
# ---------------------------------------------------------------------------

# Categories where a bare IC is NOT an acceptable substitute for the module.
STRICT_CATEGORIES = {"motor_driver", "controller", "sensor", "relay"}
MODULE_WORDS_RE = re.compile(r"\b(module|board|breakout|devkit|dev board|development)\b", re.I)


def _pn_like_tokens(text: str) -> set[str]:
    """Part-number-looking tokens of a catalogue name, e.g. TB6612FNG, HC-SR04."""
    out = set()
    for t in re.findall(r"[A-Za-z0-9][A-Za-z0-9\-]{3,}", text or ""):
        if any(c.isdigit() for c in t) or t.isupper():
            out.add(t.upper())
    return out


def classify_offer(offer: dict, part_category: str | None, part_item: dict | None) -> str:
    """'exact' or 'similar' for a live offer against a catalogue part.

    For motor_driver/controller/sensor/relay, an offer is 'exact' only if its
    description says module/board/breakout/devkit/development, OR its text
    contains a part-number token of the catalogue item (e.g. TB6612FNG).
    Bare ICs (e.g. Mouser 757-TB67H481FNGEL for driver_tb6612fng) -> 'similar'.
    All other categories: 'exact'.
    """
    cat = (part_category or "").lower()
    if cat not in STRICT_CATEGORIES:
        return "exact"
    title = (offer.get("title") or "") + " " + (offer.get("manufacturer") or "")
    if MODULE_WORDS_RE.search(title):
        return "exact"
    item_tokens = _pn_like_tokens((part_item or {}).get("name", ""))
    offer_text = f"{offer.get('title', '')} {offer.get('part_number', '')} {offer.get('manufacturer', '')}".upper()
    if any(tok in offer_text for tok in item_tokens):
        return "exact"
    return "similar"


def split_offers(offers: list[dict]) -> tuple[list[dict], list[dict]]:
    """Split annotated offers into (exact, similar)."""
    exact = [o for o in offers if o.get("match_quality") == "exact"]
    similar = [o for o in offers if o.get("match_quality") != "exact"]
    return exact, similar


def live_offers_for_part(part_name: str, part_category: str | None = None,
                         part_id: str | None = None, max_per_shop: int = 3) -> list[dict]:
    """live_offers for one catalogue part: LCSC + Mouser, annotated with
    match_quality ('exact'|'similar'), exact first then cheapest.
    Never raises; the catalogue entry remains the fallback. Tries the full
    name, then part-number keywords, stopping at the first keyword with offers."""
    from . import match as _match
    item = _match.get_item(part_id) if part_id else None
    offers: list[dict] = []
    seen_urls: set[str] = set()
    for kw in _keywords_for(part_name):
        for o in lcsc_search(kw) + mouser_search(kw):
            url = o.get("url")
            if url and url in seen_urls:
                continue
            if url:
                seen_urls.add(url)
            o["match_quality"] = classify_offer(o, part_category or (item or {}).get("category"), item)
            offers.append(o)
        if offers:
            break
    offers.sort(key=lambda o: (o.get("match_quality") != "exact", o.get("price_gbp") or 1e9))
    return offers[: max_per_shop * 2]
