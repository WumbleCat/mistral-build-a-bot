"""BuildFromVision backend entrypoint (Person 3 scope: Parts & Shop service).

Run from the backend/ directory:
    uvicorn main:app --reload --port 8000
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from parts.routes import router as parts_router

app = FastAPI(title="BuildFromVision — Parts & Shop", version="0.1.0")

# Frontend dev server (Vite) runs on :5173 — allow it during the hackathon.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(parts_router)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}
