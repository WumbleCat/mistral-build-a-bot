# mistral-build-a-bot (BuildFromVision)

Snap a photo of a robot → get a real parts list with UK shop links and prices → build it step by step in 3D with a voice coach.

## Parts service (Person 3: Parts & Shop)

Lives in `backend/parts/`:

```
backend/parts/
├── catalog.json      40 parts, 10 categories, real shops — URLs are "TODO" until a human verifies them
├── recipes.json      line_follower_car, obstacle_avoider_car, robot_arm
├── match.py          deterministic matcher (rapidfuzz) — the reliable baseline
├── agents.py         Mistral multi-agent parts team (mistralai-agents SDK, mistral-large-4)
├── routes.py         FastAPI routes
└── check_links.py    link checker for the catalogue
```

### Run

```bash
cd backend
uv venv .venv --python 3.13            # first time only
uv pip install --python .venv/bin/python fastapi 'uvicorn[standard]' python-multipart \
    httpx pydantic rapidfuzz python-dotenv mistralai mistralai-agents
cp ../.env.example ../.env              # add your MISTRAL_API_KEY (never commit .env)
.venv/bin/uvicorn main:app --reload --port 8000
```

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | liveness |
| GET | `/api/catalog` | full catalogue |
| GET | `/api/recipes` | all recipes |
| GET | `/api/recipes/{id}` | one recipe |
| POST | `/api/match` | deterministic BOM (fast) |
| POST | `/api/match/smart` | multi-agent BOM + warnings + substitutions (falls back to `/api/match`) |
| POST | `/api/alternatives` | substitutions for one part |

### Examples

```bash
# deterministic match
curl -s localhost:8000/api/match -H 'Content-Type: application/json' -d '{
  "components": [
    {"name": "Arduino Uno", "category": "controller", "qty": 1},
    {"name": "L298N motor driver", "category": "motor_driver", "qty": 1},
    {"name": "yellow motor", "category": "motor", "qty": 2},
    {"name": "ultrasonic sensor", "category": "sensor", "qty": 1}
  ],
  "owned": ["arduino_uno"]
}'

# multi-agent smart match (needs MISTRAL_API_KEY; BFV_MOCK=1 skips agents cleanly)
curl -s localhost:8000/api/match/smart -H 'Content-Type: application/json' -d '{
  "components": [{"name": "MG996R servo", "category": "servo", "qty": 4},
                 {"name": "robot arm kit", "category": "chassis", "qty": 1}]
}'

# alternatives for one part
curl -s localhost:8000/api/alternatives -H 'Content-Type: application/json' -d '{"part_id": "l298n"}'
```

### Tests & link checker

```bash
cd <repo root>
backend/.venv/bin/python -m unittest tests.test_match -v
cd backend && .venv/bin/python -m parts.check_links
```

### Rules

- Never invent shop URLs: catalogue URLs are `"TODO"` until a human pastes a verified link (`verified: true`).
- Never commit `.env` or `.venv` (see `.gitignore`).
- `mock/sample_bom.json` is the shared data contract for the frontend and workflow teams.

### Live pricing (LCSC + Mouser)

`backend/parts/live.py` powers the price-scout agent with two client tools:

- `lcsc_search(keyword)` — free, no key: `GET https://jlcsearch.tscircuit.com/api/search?q=...&limit=5&full=true`
- `mouser_search(keyword)` — Mouser Search API v1 keyword search; reads `MOUSER_API_KEY` from `.env` and **skips cleanly (returns []) when the key is missing or the API errors**

Every BOM row can carry `live_offers` (`{shop, title, part_number, price_gbp, currency, stock, url, verified:false}`) next to the catalogue entry (the fallback):

```bash
curl -X POST "localhost:8000/api/match?live=true" -H 'Content-Type: application/json' \
  -d '{"parts":[{"name":"tb6612 motor driver","category":"motor_driver","qty":1}]}'
# smart match attaches live_offers automatically
```

Guarantees: 1-hour in-memory cache per (shop, keyword), max 30 Mouser calls per rolling minute, and live API failures **never** fail the BOM. The old DuckDuckGo `web_search` tool was removed.
