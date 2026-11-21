"""CLI and HTTP API, run offline against the mock client."""

import json

import pytest
from fastapi.testclient import TestClient

import robot_bom.api as api
import robot_bom.cli as cli
from robot_bom.config import Settings
from robot_bom.ingest import IngestError, ingest, load_images

from conftest import png_bytes


@pytest.fixture(autouse=True)
def no_real_configuration(monkeypatch):
    """Never read the developer's .env or environment in these tests."""
    monkeypatch.setattr(cli, "load_settings", lambda: Settings())
    monkeypatch.setattr(api, "load_settings", lambda: Settings())


@pytest.fixture
def photo(tmp_path):
    path = tmp_path / "rover_top.png"
    path.write_bytes(png_bytes())
    return path


# ---- ingestion ------------------------------------------------------------


def test_ingest_assigns_ids_and_drops_byte_identical_duplicates():
    same = png_bytes()
    images = ingest([("Top View.png", same), ("copy.png", same), ("side.png", png_bytes(colour=(1, 2, 3)))])
    assert [i.image_id for i in images] == ["img1-top-view", "img3-side"]
    assert all(i.mime_type == "image/jpeg" and i.data[:2] == b"\xff\xd8" for i in images)


def test_ingest_downscales_large_images():
    image = ingest([("big.png", png_bytes(size=(4000, 3000)))])[0]
    assert max(image.width, image.height) == 1600


def test_ingest_rejects_bad_input(tmp_path):
    with pytest.raises(IngestError, match="not a readable image"):
        ingest([("notes.txt", b"this is not an image")])
    with pytest.raises(IngestError, match="at least one image"):
        ingest([])
    with pytest.raises(IngestError, match="image not found"):
        load_images([tmp_path / "missing.jpg"])


# ---- CLI ------------------------------------------------------------------


def test_cli_analyze_then_finalize(photo, tmp_path, capsys):
    out = tmp_path / "output"
    assert cli.main(["analyze", str(photo), "--mock", "--out", str(out), "--project-name", "rover"]) == 0
    for name in ("observations.json", "review.json", "bom.json", "bom.csv", "bom.md", "issues.md"):
        assert (out / name).is_file(), name
    printed = capsys.readouterr().out
    assert "Ready to purchase: NO" in printed and "rubber wheel (x4" in printed

    review_path = out / "review.json"
    review = json.loads(review_path.read_text(encoding="utf-8"))
    wheel = next(c for c in review["bom"]["components"] if c["id"] == "wheel-1")
    wheel.update(status="confirmed", sku="WHL-65", purchase_quantity=4)
    review_path.write_text(json.dumps(review), encoding="utf-8")

    final = out / "final"
    assert cli.main(["finalize", str(review_path), "--out", str(final), "--reviewer", "sam"]) == 0
    bom = json.loads((final / "bom.json").read_text(encoding="utf-8"))
    assert next(c for c in bom["components"] if c["id"] == "wheel-1")["sku"] == "WHL-65"
    assert bom["ready_to_purchase"] is False
    audit = json.loads((final / "audit.json").read_text(encoding="utf-8"))
    assert any(e["actor"] == "sam" and e["action"] == "component_confirmed" for e in audit)
    assert "WHL-65" in (final / "bom.csv").read_text(encoding="utf-8")


def test_cli_without_key_fails_clearly_and_writes_nothing(photo, tmp_path, capsys):
    out = tmp_path / "output"
    assert cli.main(["analyze", str(photo), "--out", str(out)]) == 2
    error = capsys.readouterr().err
    assert "No vision API key is configured" in error and "--mock" in error
    assert not out.exists()


def test_cli_reports_missing_image(tmp_path, capsys):
    assert cli.main(["analyze", str(tmp_path / "nope.jpg"), "--mock", "--out", str(tmp_path / "o")]) == 2
    assert "image not found" in capsys.readouterr().err


# ---- HTTP API -------------------------------------------------------------


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "OUTPUT_ROOT", tmp_path / "web")
    return TestClient(api.app)


def upload(client, mock="true", name="rover_top.png", data=None):
    return client.post(
        "/analyze",
        files=[("images", (name, data or png_bytes(), "image/png"))],
        data={"project_name": "rover", "mock": mock},
    )


def test_index_page_and_health(client):
    page = client.get("/")
    assert page.status_code == 200 and "Robot BOM builder" in page.text
    health = client.get("/health").json()
    assert health["status"] == "ok" and health["api_key_configured"] is False


def test_api_analyze_and_finalize_round_trip(client, tmp_path):
    response = upload(client)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["bom"]["ready_to_purchase"] is False
    assert (tmp_path / "web" / body["job_id"] / "review.json").is_file()

    review = body["review"]
    next(c for c in review["bom"]["components"] if c["id"] == "wheel-1")["status"] = "confirmed"
    final = client.post("/finalize", json={"review": review, "job_id": body["job_id"]})
    assert final.status_code == 200, final.text
    result = final.json()
    assert next(c for c in result["bom"]["components"] if c["id"] == "wheel-1")["status"] == "confirmed"
    assert set(result["exports"]) == {"bom.json", "bom.csv", "bom.md", "issues.md"}
    assert (tmp_path / "web" / body["job_id"] / "final" / "audit.json").is_file()


def test_api_without_key_returns_503_not_mock_data(client):
    response = upload(client, mock="false")
    assert response.status_code == 503
    assert "No vision API key is configured" in response.json()["detail"]


def test_api_rejects_non_images_and_bad_reviews(client):
    assert upload(client, name="notes.txt", data=b"hello").status_code == 400
    assert client.post("/finalize", json={"review": {"bom": {}}}).status_code == 422
    assert client.post("/finalize", json={"review": {}, "job_id": "../../etc"}).status_code == 422


# ---- web app launch -------------------------------------------------------


def test_index_page_is_the_upload_app(client):
    page = client.get("/").text
    for marker in ('id="drop"', 'id="images"', "multiple", 'id="analyze-btn"', 'id="finalize-btn"', 'id="photos"'):
        assert marker in page, marker


def test_serve_picks_the_next_port_when_the_preferred_one_is_busy():
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as taken:
        taken.bind(("127.0.0.1", 0))
        busy = taken.getsockname()[1]
        assert cli.find_free_port("127.0.0.1", busy) != busy
    assert cli.find_free_port("127.0.0.1", busy) == busy  # free again once released


def test_serve_command_starts_uvicorn_and_can_open_the_browser(monkeypatch, capsys):
    import threading
    import webbrowser

    import uvicorn

    started, opened = {}, []
    monkeypatch.setattr(uvicorn, "run", lambda app, **kwargs: started.update(app=app, **kwargs))
    monkeypatch.setattr(webbrowser, "open", opened.append)
    monkeypatch.setattr(threading, "Timer", lambda delay, fn, args=(): type("T", (), {"start": lambda self: fn(*args)})())

    assert cli.main(["serve", "--open", "--port", "8765"]) == 0

    assert started["app"] == "robot_bom.api:app" and started["host"] == "127.0.0.1"
    assert opened == [f"http://127.0.0.1:{started['port']}"]
    assert f"running at http://127.0.0.1:{started['port']}" in capsys.readouterr().out
