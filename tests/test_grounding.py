"""Optional Grounding DINO + SAM 2 stage, exercised with a fake detector (no model weights)."""

import pytest
from fastapi.testclient import TestClient

import robot_bom.api as api
import robot_bom.cli as cli
from robot_bom.config import ConfigError, Settings, load_settings
from robot_bom.grounding import PALETTE, Detection, GroundingResult, assign_detections, phrase_for
from robot_bom.models import EvidenceType, RobotBOM
from robot_bom.pipeline import analyze, write_analysis_outputs
from robot_bom.vision import MockVisionClient

from conftest import ScriptedClient, make_images, part, png_bytes, view

WHEEL_BOXES = [(0.05, 0.05, 0.25, 0.35), (0.75, 0.05, 0.95, 0.35), (0.05, 0.65, 0.25, 0.95), (0.75, 0.65, 0.95, 0.95)]


class FakeGrounder:
    name = "fake-dino + fake-sam"

    def __init__(self, detections, error=None):
        self.detections, self.error = detections, error
        self.calls, self.rendered = [], []

    def locate(self, image, phrases):
        self.calls.append((image.image_id, phrases))
        if self.error:
            raise self.error

        def render(regions):
            self.rendered.append(regions)
            return b"\xff\xd8fake-jpeg"

        return GroundingResult(detections=list(self.detections), render_overlay=render)


def wheels(count=4, label="rubber wheel"):
    return [Detection(label=label, bbox_xyxy_norm=box, score=0.6 - i * 0.05, mask_score=0.9)
            for i, box in enumerate(WHEEL_BOXES[:count])]


TOP = view("top", part("wheel", "rubber wheel", 4, bbox_xyxy_norm=[0.1, 0.1, 0.9, 0.9]),
           part("chassis", "green chassis frame", 1, bbox_xyxy_norm=[0.2, 0.1, 0.8, 0.9]))


def run(grounder, reply=TOP):
    return analyze(make_images("top.png"), ScriptedClient(pass1=[reply]), grounder=grounder)


def component(bom, category):
    return next(c for c in bom.components if c.category == category)


# ---- label -> part assignment ----------------------------------------------


def test_phrase_for_makes_short_detector_prompts():
    assert phrase_for("blue PCB module (partially obscured)") == "blue pcb module"
    assert phrase_for("black terminal connector block") == "terminal connector block"
    assert phrase_for("LED") == "led"


def test_partial_labels_map_to_the_listed_part():
    names = ["rubber treaded wheel", "green chassis frame"]
    hits = [Detection("wheel", WHEEL_BOXES[0], 0.5), Detection("chassis frame", (0.2, 0.1, 0.8, 0.9), 0.4)]
    assigned = assign_detections(names, hits)
    assert [d.label for d in assigned[0]] == ["wheel"] and [d.label for d in assigned[1]] == ["chassis frame"]


def test_detections_for_unlisted_or_ambiguous_labels_are_dropped():
    names = ["2-channel relay module", "blue PCB module"]
    hits = [Detection("electric motor", WHEEL_BOXES[0], 0.9),   # not a listed part
            Detection("module", WHEEL_BOXES[1], 0.8),           # fits both listed modules equally
            Detection("relay module", WHEEL_BOXES[2], 0.7)]
    assigned = assign_detections(names, hits)
    assert list(assigned) == [0] and [d.label for d in assigned[0]] == ["relay module"]


def test_duplicate_regions_are_collapsed():
    same = [Detection("rubber wheel", WHEEL_BOXES[0], 0.6), Detection("rubber wheel", WHEEL_BOXES[0], 0.5)]
    assert len(assign_detections(["rubber wheel"], same)[0]) == 1


# ---- pipeline --------------------------------------------------------------


def test_vlm_only_is_the_default_mode():
    bom = run(None).bom
    assert bom.metadata["detection_mode"] == "vlm_only" and bom.metadata["grounder"] == "none"
    assert all(e.source == "vlm" for c in bom.components for e in c.evidence)
    assert component(bom, "wheel").evidence[0].bbox_xyxy_norm == (0.1, 0.1, 0.9, 0.9)  # the VLM's own box


def test_grounding_adds_one_region_per_located_instance():
    grounder = FakeGrounder(wheels())
    result = run(grounder)
    bom = result.bom

    assert grounder.calls == [(bom.image_ids[0], ["rubber wheel", "green chassis frame"])]
    assert bom.metadata["detection_mode"] == "vlm+grounding" and bom.metadata["grounder"] == grounder.name
    wheel = component(bom, "wheel")
    vlm = [e for e in wheel.evidence if e.source == "vlm"]
    located = [e for e in wheel.evidence if e.source == "grounding_dino"]
    assert len(vlm) == 1 and vlm[0].bbox_xyxy_norm is None      # rough VLM box replaced
    assert [e.bbox_xyxy_norm for e in located] == WHEEL_BOXES
    assert "detector score 0.60" in located[0].description and "not calibrated" in located[0].description
    assert wheel.visible_quantity == 4 and wheel.evidence_type is EvidenceType.OBSERVED
    # a part the detector did not find keeps the vision model's box
    assert component(bom, "chassis").evidence[0].bbox_xyxy_norm == (0.2, 0.1, 0.8, 0.9)
    assert result.overlays == {bom.image_ids[0]: b"\xff\xd8fake-jpeg"}
    assert not any(i.id.startswith("grounding.") for i in bom.issues)


def test_detector_never_adds_parts_or_changes_counts():
    grounder = FakeGrounder(wheels(2) + [Detection("electric motor", (0.4, 0.4, 0.6, 0.6), 0.95)])
    bom = run(grounder).bom

    # only the two matched wheel regions are drawn - never the unmatched "electric motor" hit -
    # in the colour the web page uses for the first component
    assert grounder.rendered == [[(WHEEL_BOXES[0], PALETTE[0]), (WHEEL_BOXES[1], PALETTE[0])]]

    assert [c for c in bom.components if c.category == "motor" and c.evidence_type is EvidenceType.OBSERVED] == []
    wheel = component(bom, "wheel")
    assert wheel.visible_quantity == 4   # vision model's count is untouched
    issue = next(i for i in bom.issues if i.id == "grounding.count_mismatch.wheel-1")
    assert issue.severity == "info" and "outlined 2 region(s)" in issue.message and "counted 4" in issue.message
    assert any(i.id == "drivetrain.unknown" for i in bom.issues)


def test_detector_failure_falls_back_to_vlm_boxes_with_a_warning():
    bom = run(FakeGrounder([], error=RuntimeError("out of memory"))).bom
    assert all(e.source == "vlm" for c in bom.components for e in c.evidence)
    assert component(bom, "wheel").evidence[0].bbox_xyxy_norm == (0.1, 0.1, 0.9, 0.9)
    assert any(i.id.startswith("grounding.unavailable.") and i.severity == "warning" for i in bom.issues)


def test_model_reply_cannot_inject_detector_regions():
    sneaky = view("top", {**part("wheel", "rubber wheel", 4),
                          "detections": [{"bbox_xyxy_norm": [0, 0, 1, 1], "score": 0.99}]})
    bom = run(None, sneaky).bom
    assert all(e.source == "vlm" for e in component(bom, "wheel").evidence)


def test_overlays_and_grounded_bom_are_exported(tmp_path):
    result = run(FakeGrounder(wheels()))
    written = write_analysis_outputs(result, tmp_path)
    image_id = result.bom.image_ids[0]
    assert written[f"overlays/{image_id}.jpg"].read_bytes() == b"\xff\xd8fake-jpeg"
    assert RobotBOM.model_validate_json(written["bom.json"].read_text(encoding="utf-8")) == result.bom
    markdown = written["bom.md"].read_text(encoding="utf-8")
    assert "local Grounding DINO / SAM 2 (fake-dino + fake-sam)" in markdown
    assert "(+4 Grounding DINO region(s)" in markdown


def test_vlm_only_export_says_so(tmp_path):
    written = write_analysis_outputs(run(None), tmp_path)
    assert "Detection mode: vision/language model only" in written["bom.md"].read_text(encoding="utf-8")
    assert not (tmp_path / "overlays").exists()


# ---- configuration, CLI and API switches -----------------------------------


def test_grounding_is_off_unless_configured():
    assert load_settings({}, dotenv=False).grounding is False
    on = load_settings({"ROBOT_BOM_GROUNDING": "1", "GROUNDING_BOX_THRESHOLD": "0.3"}, dotenv=False)
    assert on.grounding is True and on.box_threshold == 0.3
    assert on.dino_model == "IDEA-Research/grounding-dino-tiny" and on.sam_model == "facebook/sam2.1-hiera-tiny"


@pytest.fixture
def photo(tmp_path):
    path = tmp_path / "rover_top.png"
    path.write_bytes(png_bytes())
    return path


@pytest.fixture
def offline(monkeypatch):
    monkeypatch.setattr(cli, "load_settings", lambda: Settings())
    monkeypatch.setattr(api, "load_settings", lambda: Settings())


def test_cli_flag_switches_between_modes(photo, tmp_path, monkeypatch, capsys, offline):
    built = []
    monkeypatch.setattr(cli, "build_grounder", lambda settings: built.append(1) or FakeGrounder(wheels()))

    assert cli.main(["analyze", str(photo), "--mock", "--out", str(tmp_path / "a")]) == 0
    assert built == [] and "detection: VLM/LLM only" in capsys.readouterr().out

    assert cli.main(["analyze", str(photo), "--mock", "--grounding", "--out", str(tmp_path / "b")]) == 0
    assert built == [1] and "detection: VLM + Grounding DINO/SAM 2" in capsys.readouterr().out
    assert list((tmp_path / "b" / "overlays").glob("*.jpg"))


def test_cli_no_grounding_overrides_the_environment_default(photo, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cli, "load_settings", lambda: Settings(grounding=True))
    monkeypatch.setattr(cli, "build_grounder", lambda settings: pytest.fail("grounder must not be built"))
    assert cli.main(["analyze", str(photo), "--mock", "--no-grounding", "--out", str(tmp_path / "o")]) == 0
    assert "detection: VLM/LLM only" in capsys.readouterr().out


def test_cli_explains_missing_libraries(photo, tmp_path, monkeypatch, capsys, offline):
    def unavailable(settings):
        raise ConfigError("Grounding DINO + SAM 2 mode needs torch and transformers")

    monkeypatch.setattr(cli, "build_grounder", unavailable)
    assert cli.main(["analyze", str(photo), "--mock", "--grounding", "--out", str(tmp_path / "o")]) == 2
    assert "needs torch and transformers" in capsys.readouterr().err
    assert not (tmp_path / "o").exists()


@pytest.fixture
def client(tmp_path, monkeypatch, offline):
    monkeypatch.setattr(api, "OUTPUT_ROOT", tmp_path / "web")
    return TestClient(api.app)


def post(client, **form):
    return client.post("/analyze", files=[("images", ("rover_top.png", png_bytes(), "image/png"))],
                       data={"project_name": "rover", "mock": "true", **form})


def test_api_vlm_only_by_default(client, monkeypatch):
    monkeypatch.setattr(api, "build_grounder", lambda settings: pytest.fail("grounder must not be built"))
    body = post(client).json()
    assert body["bom"]["metadata"]["detection_mode"] == "vlm_only" and body["overlays"] == {}
    assert post(client, grounding="false").json()["bom"]["metadata"]["detection_mode"] == "vlm_only"


def test_api_grounding_mode_returns_and_serves_mask_overlays(client, monkeypatch):
    monkeypatch.setattr(api, "build_grounder", lambda settings: FakeGrounder(wheels()))
    body = post(client, grounding="true").json()

    assert body["bom"]["metadata"]["detection_mode"] == "vlm+grounding"
    image_id = body["bom"]["image_ids"][0]
    url = body["overlays"][image_id]
    assert url == f"/jobs/{body['job_id']}/overlays/{image_id}.jpg"
    served = client.get(url)
    assert served.status_code == 200 and served.headers["content-type"] == "image/jpeg"
    assert served.content == b"\xff\xd8fake-jpeg"
    assert client.get(f"/jobs/{body['job_id']}/overlays/nope.jpg").status_code == 404
    assert client.get("/jobs/not-a-job/overlays/x.jpg").status_code == 404

    # the grounded review document still finalizes
    final = client.post("/finalize", json={"review": body["review"], "job_id": body["job_id"]})
    assert final.status_code == 200, final.text


def test_api_reports_missing_libraries_as_503(client, monkeypatch):
    def unavailable(settings):
        raise ConfigError("Grounding DINO + SAM 2 mode needs torch and transformers")

    monkeypatch.setattr(api, "build_grounder", unavailable)
    response = post(client, grounding="true")
    assert response.status_code == 503 and "needs torch and transformers" in response.json()["detail"]


def test_health_reports_detection_capabilities(client, monkeypatch):
    monkeypatch.setattr(api, "grounding_available", lambda: False)
    health = client.get("/health").json()
    assert health["grounding_available"] is False and health["grounding_default"] is False
    page = client.get("/").text
    assert 'id="detection"' in page and "VLM / LLM only" in page and "Grounding DINO + SAM 2" in page


def test_mock_client_with_grounder_keeps_the_acceptance_guarantees():
    bom = analyze(make_images("rover_top.png"), MockVisionClient(), mode="mock", grounder=FakeGrounder(wheels())).bom
    assert component(bom, "wheel").visible_quantity == 4
    motor = component(bom, "motor")
    assert motor.evidence_type is not EvidenceType.OBSERVED and motor.visible_quantity is None
    assert all(c.sku is None and c.model is None for c in bom.components)
