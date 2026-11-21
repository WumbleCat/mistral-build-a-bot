# Parts & Shop API (Person 3) — BuildFromVision

Base URL (this machine): **`http://172.29.1.72:8000`** · locally `http://localhost:8000`
Interactive Swagger UI: **`http://172.29.1.72:8000/docs`**

Run it: `cd backend && .venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000`
Env: `.env` with `MISTRAL_API_KEY` (agents) and optional `MOUSER_API_KEY` (live Mouser prices). `BFV_MOCK=1` disables all agent calls.

## Input format — Person 2 vision output (shared, `backend/shared/schemas.py`)

`/api/match` and `/api/match/smart` accept EITHER a **plain JSON list of parts** OR
`{"parts": [...], "robot_guess": ..., "owned": [...]}`:

```json
[
  {
    "name": "off-road rubber wheel/tire (black, chevron tread)",
    "category": "wheel",
    "quantity": 4,
    "evidence": "visible",
    "source_ids": ["W001", "W002", "W003", "W004"],
    "sku": null,
    "product_url": null,
    "review_required": false,
    "notes": "Four distinct wheels at the four corners."
  },
  {
    "name": "drive motor(s)",
    "category": "motor",
    "quantity": null,
    "evidence": "inferred",
    "source_ids": ["mechanical.possible_missing_parts"],
    "sku": null, "product_url": null, "review_required": true,
    "notes": "Four wheels imply drive, but no motor cans are visible."
  }
]
```

- `category` is **free text** — normalised to catalogue categories (`frame/chassis`→`chassis`, `battery/power enclosure`→`power`, `relay_module`→`relay`, `steering`→`servo`, `mechanical hardware`→`fasteners`, `tape`→`misc`, …; unknown → `other`). Catalogue categories: the original 10 + `relay, switch, misc, other`.
- `quantity: null` + `evidence: "inferred"` → the recipe's qty (or 1). `quantity >= 1` otherwise; a wrong type → HTTP 422.
- `evidence`: `visible` → BOM row `status: "identified"`; `inferred` → `status: "suggested"`. `review_required: true` → `needs_check: true` (+ `notes` passed through). `source_ids` are kept on the row so the frontend can highlight them on the photo.
- Unit→pack conversion: `units_needed` vs `packs_to_buy` on every row (4 wheels with `pack_size: 2` → 2 packs; `qty` = packs).
- 4+ wheels detected → prefers the `rover_4wd` recipe; response includes `recipe_confidence` and `closest_recipe`.
- Parts with no catalogue match (e.g. duct tape, unknown gray block) land in `unmatched` with their notes — never a crash.
- Legacy shapes still accepted: `{"parts": [{"name","category","qty","confidence"}]}` (strict 10-category Literal) and `{"components": [{"name","category","qty"}]}`.
- A full real example: `mock/vision_person2_sample.json` (used by `tests/test_vision_person2.py`).

## Which endpoint when

| You want | Endpoint |
|---|---|
| Instant BOM (deterministic, <50 ms) | `POST /api/match` |
| BOM + agent warnings/substitutions, but don't block the UI | `POST /api/match/smart?async=true` → poll `GET /api/jobs/{job_id}` |
| Full agent result, waiting is OK | `POST /api/match/smart` (cached; demo inputs are pre-warmed at startup) |
| Live prices/stock from LCSC + Mouser ("where can I buy this?") | `GET /api/search?q=...` |
| "I don't have part X, what can I use?" (voice coach) | `POST /api/alternatives` |
| Whole catalogue / recipes | `GET /api/catalog`, `GET /api/recipes`, `GET /api/recipes/{id}` |
| USD→GBP rate in use | `GET /api/config` |

## Endpoints with examples

### `GET /api/health`
```
curl localhost:8000/api/health
→ {"ok": true}
```

### `GET /api/config`
```
curl localhost:8000/api/config
→ {"USD_TO_GBP": 0.75}
```

### `GET /api/catalog`
```
curl localhost:8000/api/catalog
→ {"shop_domains": {...}, "categories": [...10...], "items": [{"id":"arduino_uno","name":"Arduino UNO Rev3 (A000066)","category":"controller","price":24.88,"currency":"GBP","shop":"RS Components UK","sku":"715-4081","url":"https://uk.rs-online.com/web/p/arduino/7154081","verified":true,...}, ...56 items]}
```

### `GET /api/recipes` / `GET /api/recipes/{id}`
```
curl localhost:8000/api/recipes/obstacle_avoider_car
→ {"id":"obstacle_avoider_car","name":"Obstacle-avoiding car","difficulty":"beginner","parts":[{"id":"arduino_uno","qty":1},{"id":"driver_tb6612fng","qty":1},...],"power_notes":"..."}
```

### `POST /api/match` — instant deterministic BOM (optionally `?live=true` to attach live_offers)
```
curl -X POST localhost:8000/api/match -H 'Content-Type: application/json' -d '{
  "parts": [{"name":"yellow motor","category":"motor","qty":2,"confidence":0.9},
            {"name":"ultrasonic sensor","category":"sensor","qty":1,"confidence":0.85}],
  "robot_guess": "obstacle-avoiding car", "owned": [] }'
→ {
  "robot_name": "Obstacle-avoiding car", "recipe_id": "obstacle_avoider_car", "confidence": 1.0,
  "parts": [{"id":"motor_tt_pair",...}, ...],
  "bom": [{"part_id":"arduino_uno","name":"Arduino UNO Rev3 (A000066)","shop":"RS Components UK",
           "url":"https://uk.rs-online.com/web/p/arduino/7154081","sku":"715-4081",
           "currency":"GBP","unit_price":24.88,"unit_price_gbp":24.88,"qty":1,
           "line_total_gbp":24.88,"owned":false,"added_from_recipe":true,"verified":true,
           "live_offers":[{"shop":"Mouser UK","part_number":"782-ABX00062","price_gbp":29.49,"stock":359,"url":"...","verified":false}]}, ...],
  "bom_total_gbp": 74.81,
  "unmatched": []
}
```
All money fields (`unit_price_gbp`, `line_total_gbp`, `bom_total_gbp`) are **GBP** (USD converted with `USD_TO_GBP`). `live_offers` appear with `?live=true` or in smart mode; catalogue row is always the fallback. Packs: 2 motors → qty 1 of a `pack_size: 2` pair.

### `POST /api/match/smart?async=true` — agents in background
```
curl -X POST "localhost:8000/api/match/smart?async=true" -H 'Content-Type: application/json' -d '{...VisionResult...}'
→ {"job_id":"3f9c1e2b7a4d","status":"running","smart":false,"robot_name":...,"bom":[...fast BOM...],"bom_total_gbp":74.81,...}

curl localhost:8000/api/jobs/3f9c1e2b7a4d
→ {"job_id":"3f9c1e2b7a4d","status":"done","result":{"smart":true,"warnings":["..."],"substitutions":{...},"agent_trace":[...],"bom":[... with live_offers ...], ...}}
```
Sync version `POST /api/match/smart` waits for the agents (matcher/price-scout/substitutions/auditor in parallel, coordinator last; 30 s per-agent timeout; deterministic fallback on any failure). Results are cached (memory + `backend/parts/.cache/smart_match.json`); the 3 demo inputs are pre-warmed at startup, so repeat calls return in ~0 ms with `"cached": true`.

### `GET /api/search?q=<keyword>` — live prices side by side
```
curl "localhost:8000/api/search?q=SG90%20servo"
→ {"q":"SG90 servo",
   "lcsc":   [{"shop":"LCSC","title":"...","part_number":"C141517","price_gbp":0.85,"currency":"USD","stock":3474,"url":"https://www.lcsc.com/product-detail/C141517.html","verified":false,"source":"LCSC live search API"}, ...],
   "mouser": [{"shop":"Mouser UK","title":"...","part_number":"426-SER0043","price_gbp":2.33,"currency":"USD","stock":240,"url":"https://www.mouser.co.uk/...","verified":false,"source":"Mouser Search API"}, ...]}
```
Cached 1 h; Mouser rate-limited to 30 calls/min and needs `MOUSER_API_KEY`; a failing shop just returns `[]` (never a 500).

### `POST /api/alternatives` — substitutions (voice coach "I don't have this")
```
curl -X POST localhost:8000/api/alternatives -H 'Content-Type: application/json' -d '{"part_id":"driver_l298n_breakout"}'
→ {"part_id":"driver_l298n_breakout","name":"SparkFun Full-Bridge Motor Driver Breakout - L298N",
   "alternatives":[{"id":"driver_tb6612fng","name":"...","price":14.5,"currency":"USD","unit_price_gbp":10.88,"delta_gbp":5.63,"shop":"SparkFun","url":"...","sku":"ROB-14450","verified":true}]}
```

## Notes for teammates

- BOM/audit rule of thumb: the bom-auditor warns when L298N + a 6 V AA pack are combined (~2 V drop starves the motors) and suggests `driver_tb6612fng`.
- Never invent URLs: catalogue URLs are real (`verified:true`) or `"TODO"` (`verified:false`); live offers are always `verified:false` for human checking.
- `.env` is gitignored; only `.env.example` is committed.

## Use from Python (no HTTP)

`backend/parts/parts_api.py` is the public interface — pass Person 2's vision output straight in (a plain list of dicts with `name, category, quantity, evidence, source_ids, sku, product_url, review_required, notes`, or `VisionPart` models):

```python
import sys, json; sys.path.insert(0, "backend")
from parts.parts_api import build_bom, build_bom_smart, search_live, get_catalog, get_recipes

vision_parts = json.load(open("mock/vision_person2_sample.json"))
bom = build_bom(vision_parts)                 # instant, deterministic, no AI (<50 ms)
bom = build_bom(vision_parts, owned=["arduino_uno"])
smart = build_bom_smart(vision_parts)         # agents + live prices, cached, async-safe, never fails
offers = search_live("TB6612FNG")             # {"q", "lcsc", "mouser", "exact", "similar"}
catalog = get_catalog()                       # list[dict], all 59 parts
recipes = get_recipes()                       # list[dict]
```

Full runnable example: `backend/.venv/bin/python examples/use_parts_api.py`

`build_bom` returns `{robot_name, recipe_id, recipe_confidence, closest_recipe, confidence, parts, bom, bom_total_gbp, unmatched}`; each BOM row has `unit_price_gbp, qty, packs_to_buy, units_needed, status ("identified"|"suggested"), needs_check, source_ids, live_offers (exact) / live_offers_similar` in smart mode.

## Parts list in Python

`backend/parts/parts_catalog.py` is **generated** from `catalog.json` + `recipes.json` (source of truth) by `backend/.venv/bin/python scripts/export_parts_py.py`. It is standalone (pydantic + rapidfuzz only) — copy that one file if you just need the list:

```python
from parts_catalog import PARTS, RECIPES, Part, get_part, parts_by_category, find_part

PARTS            # list[Part] — Part(id, name, category, aliases, specs, price, currency,
                 #   price_gbp, shop, sku, url, verified, alternatives, notes)
RECIPES          # dict[str, list[tuple[str, int]]] — recipe id -> [(part_id, qty)]
get_part("driver_tb6612fng")          # -> Part or None
parts_by_category("relay")            # -> [Part, ...]
find_part("yellow motor")             # -> [(score, Part), ...] fuzzy, best first
```

## price_lookup — one function, no server

`backend/parts/price_lookup.py` is a plain import (no FastAPI) for calling from Python directly. Input = Person 2's component JSON list; output = one item per component, same order, original fields kept, plus priced shop matches:

```python
import sys; sys.path.insert(0, "backend")
from parts.price_lookup import lookup_components

import json
components = json.load(open("mock/vision_person2_sample.json"))
result = lookup_components(components)
# result[i] keeps every original field (name, category, quantity, evidence,
# source_ids, sku, product_url, review_required, notes) and adds:
#   category_normalised  str            free-text category -> catalogue category
#   matched_part_id      str | None     catalogue part id, None if no match
#   matches              list[dict]     {shop, product, part_number, price_gbp, stock,
#                                        url, source: "catalogue"|"live",
#                                        match_quality: "exact"|"similar"}
#                                        catalogue exact first, then live exact
#                                        (cheapest first), then similar; max 6
#   best_match           dict | None    the verified catalogue product when matched,
#                                        else cheapest live exact match
#   line_total_gbp       float          quantity (null -> 1) x price, with catalogue
#                                        pack_size -> packs (4 wheels -> 2 pairs)
# Components with no match get matches: [] and best_match: None — never crashes.
```

Command line (from the repo root):

```bash
backend/.venv/bin/python -m backend.parts.price_lookup mock/vision_person2_sample.json mock/price_lookup_example_output.json
```

Example output is committed at `mock/price_lookup_example_output.json` (generated from `mock/vision_person2_sample.json`, real Mouser + LCSC live offers included). Live search uses the cached `live.py` Mouser/LCSC clients (1 h cache, 30 Mouser calls/min, needs `MOUSER_API_KEY` in `.env` for Mouser; LCSC is free). If a live API fails, that shop just contributes no offers.
