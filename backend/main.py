"""BuildFromVision backend entrypoint (Person 3 scope: Parts & Shop service).

Run from the backend/ directory:
    uvicorn main:app --reload --port 8000
    uvicorn main:app --host 0.0.0.0 --port 8000   # for the demo / teammates
"""

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from parts import agents
from parts.routes import router as parts_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Pre-warm the smart-match cache for the 3 demo inputs (background task,
    # so the server starts immediately).
    asyncio.create_task(agents.prewarm())
    yield


app = FastAPI(title="BuildFromVision — Parts & Shop", version="0.2.0", lifespan=lifespan)

# Frontend dev server (Vite) runs on :5173 (preview on :4173) — allow it during
# the hackathon, plus any LAN IP the dev server is reached on (host: true).
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:4173",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:4173",
    ],
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1|\d{1,3}(\.\d{1,3}){3})(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(parts_router)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}
