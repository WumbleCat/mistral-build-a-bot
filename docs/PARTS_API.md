# Parts & Shop API (Person 3) — BuildFromVision

Base URL (this machine): **`http://172.29.1.72:8000`** · locally `http://localhost:8000`
Interactive Swagger UI: **`http://172.29.1.72:8000/docs`**

Run it: `cd backend && .venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000`
Env: `.env` with `MISTRAL_API_KEY` (agents) and optional `MOUSER_API_KEY` (live Mouser prices). `BFV_MOCK=1` disables all agent calls.

## Input format — `VisionResult` (shared, `backend/shared/schemas.py`)

The vision agent (Person 2) returns this; `/api/match` and `/api/match/smart` accept it as the POST body:

```json
{
  "parts": [
    { "name": "yellow motor", "category": "motor", "qty": 2, "confidence": 0.9 }
  ],
  "robot_guess": "obstacle-avoiding car",
  "owned": ["arduino_uno"]
}
```

- `category` is one of: `controller, motor_driver, motor, servo, sensor, power, wheel, chassis, wiring, fasteners`
- `qty >= 1`, `confidence` 0–1, `robot_guess` optional, `owned` = catalogue IDs the user already has (excluded from the total)
- Legacy `{"components": [{"name","category","qty"}]}` is still accepted. Invalid category/qty → HTTP 422.

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
