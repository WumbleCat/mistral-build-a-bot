"""FastAPI app: upload photos, review the draft BOM in the browser, finalize.

Run with ``robot-bom serve`` (or ``uvicorn robot_bom.api:app``).
"""

from __future__ import annotations

import re
import uuid
from pathlib import Path

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse

from .catalog import build_catalog_client
from .config import ConfigError, load_settings
from .export import BOMExporter, write_json
from .extraction import VisionResponseError
from .grounding import build_grounder, grounding_available, sam_available
from .ingest import IngestError, ingest
from .pipeline import analyze, write_analysis_outputs
from .review import ReviewError, finalize, load_review
from .vision import VisionAPIError, build_vision_client

MAX_IMAGES = 8
OUTPUT_ROOT = Path("output") / "web"
_JOB_ID = re.compile(r"^[0-9a-f]{12}$")
_IMAGE_ID = re.compile(r"^[a-z0-9-]{1,120}$")
_INDEX_HTML = Path(__file__).parent / "web" / "index.html"

app = FastAPI(title="Robot BOM builder", version="0.1.0")


@app.get("/", response_class=HTMLResponse, include_in_schema=False)
def index() -> str:
    return _INDEX_HTML.read_text(encoding="utf-8")


@app.get("/health")
def health() -> dict:
    settings = load_settings()
    return {
        "status": "ok",
        "api_key_configured": settings.has_api_key,  # boolean only; the key is never returned
        "vision_model": settings.vision_model,
        "mock_default": settings.mock,
        "catalog_configured": bool(settings.catalog_api_url),
        "grounding_available": grounding_available(),
        "sam_available": sam_available(),
        "grounding_default": settings.grounding,
    }


@app.post("/analyze")
def analyze_route(
    images: list[UploadFile] = File(..., description="One or more photos of the robot"),
    project_name: str = Form("robot"),
    mock: bool = Form(False),
    grounding: bool | None = Form(None, description="true = also run local Grounding DINO + SAM 2; false = VLM/LLM only"),
) -> dict:
    """Run the pipeline on uploaded photos and return the draft BOM plus a review document."""
    if len(images) > MAX_IMAGES:
        raise HTTPException(400, f"at most {MAX_IMAGES} images per request")
    try:
        settings = load_settings()
        use_mock = mock or settings.mock
        client = build_vision_client(settings, mock=use_mock)
        use_grounding = settings.grounding if grounding is None else grounding
        grounder = build_grounder(settings) if use_grounding else None
        ingested = ingest([(upload.filename or f"upload-{n}", upload.file.read())
                           for n, upload in enumerate(images, start=1)])
        result = analyze(
            ingested,
            client,
            project_name=project_name.strip() or "robot",
            catalog=build_catalog_client(settings),
            max_retries=settings.max_retries,
            verify=settings.verify,
            mode="mock" if use_mock else "live",
            vision_model="mock" if use_mock else settings.vision_model,
            grounder=grounder,
        )
    except IngestError as exc:
        raise HTTPException(400, str(exc)) from None
    except ConfigError as exc:
        raise HTTPException(503, str(exc)) from None
    except (VisionResponseError, VisionAPIError) as exc:
        raise HTTPException(502, str(exc)) from None

    job_id = uuid.uuid4().hex[:12]
    out_dir = OUTPUT_ROOT / job_id
    write_analysis_outputs(result, out_dir)
    return {
        "job_id": job_id,
        "output_dir": out_dir.as_posix(),
        "bom": result.bom.model_dump(mode="json"),
        "review": result.review.model_dump(mode="json"),
        "overlays": {image_id: f"/jobs/{job_id}/overlays/{image_id}.jpg" for image_id in result.overlays},
    }


@app.get("/jobs/{job_id}/overlays/{image_id}.jpg", include_in_schema=False)
def overlay_route(job_id: str, image_id: str) -> FileResponse:
    """The uploaded photo with SAM 2 masks blended in (only exists for grounding runs)."""
    if not _JOB_ID.match(job_id) or not _IMAGE_ID.match(image_id):
        raise HTTPException(404, "not found")
    path = OUTPUT_ROOT / job_id / "overlays" / f"{image_id}.jpg"
    if not path.is_file():
        raise HTTPException(404, "not found")
    return FileResponse(path, media_type="image/jpeg")


@app.post("/finalize")
def finalize_route(payload: dict = Body(...)) -> dict:
    """Apply an edited review document. Body: ``{"review": {...}, "job_id": "..."}``."""
    review_data = payload.get("review")
    job_id = payload.get("job_id")
    if not isinstance(review_data, dict):
        raise HTTPException(422, "body must contain a 'review' object")
    if job_id is not None and not (isinstance(job_id, str) and _JOB_ID.match(job_id)):
        raise HTTPException(422, "invalid job_id")
    try:
        review = load_review(review_data)
        bom = finalize(review, catalog=build_catalog_client(load_settings()))
    except ReviewError as exc:
        raise HTTPException(422, str(exc)) from None

    exporter = BOMExporter()
    out_dir = None
    if job_id and (OUTPUT_ROOT / job_id).is_dir():
        out_dir = OUTPUT_ROOT / job_id / "final"
        exporter.export(bom, out_dir)
        write_json(out_dir / "audit.json", [e.model_dump(mode="json") for e in bom.audit_trail])
    return {
        "bom": bom.model_dump(mode="json"),
        "output_dir": out_dir.as_posix() if out_dir else None,
        "exports": {
            "bom.json": exporter.to_json(bom),
            "bom.csv": exporter.to_csv(bom),
            "bom.md": exporter.to_markdown(bom),
            "issues.md": exporter.to_issues_markdown(bom),
        },
    }
