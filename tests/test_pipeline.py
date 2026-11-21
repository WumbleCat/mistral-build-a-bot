"""End-to-end acceptance test for the DIY four-wheel rover, mock mode, config (spec 3, 5, 6, 7)."""

import csv
import io
import json

import pytest

from robot_bom.catalog import NOT_CONFIGURED
from robot_bom.config import ConfigError, Settings, load_settings
from robot_bom.export import CSV_FIELDS, BOMExporter
from robot_bom.models import EvidenceType, RobotBOM
from robot_bom.pipeline import analyze, write_analysis_outputs
from robot_bom.vision import MockVisionClient, build_vision_client

from conftest import ScriptedClient, make_images, part, view

SECRET = "sk-test-do-not-leak-123"


@pytest.fixture
def mock_result():
    return analyze(make_images("rover_top.png"), MockVisionClient(), project_name="rover", mode="mock")


def by_category(bom, category):
    return [c for c in bom.components if c.category == category]


def test_four_wheels_recognised_without_claiming_motors(mock_result):
    bom = mock_result.bom
    wheel = by_category(bom, "wheel")[0]
    assert wheel.evidence_type is EvidenceType.OBSERVED and wheel.visible_quantity == 4

    motors = by_category(bom, "motor")
    assert motors, "the unknown drivetrain must be listed explicitly"
    for motor in motors:
        assert motor.evidence_type is not EvidenceType.OBSERVED
        assert motor.visible_quantity is None and motor.required_quantity is None
    assert any(i.id == "drivetrain.unknown" and i.severity == "critical" for i in bom.issues)


def test_categories_identified_without_brand_model_or_sku(mock_result):
    bom = mock_result.bom
    observed = {c.category for c in bom.components if c.evidence_type is EvidenceType.OBSERVED}
    assert {"wheel", "chassis", "breadboard", "wiring", "relay_module"} <= observed
    for component in bom.components:
        assert component.manufacturer is None and component.model is None and component.sku is None
        assert component.required_quantity is None and component.purchase_quantity is None
        assert component.status == "needs_review"


def test_relay_assembly_is_not_double_counted(mock_result):
    bom = mock_result.bom
    assert by_category(bom, "relay") == []
    module = by_category(bom, "relay_module")[0]
    assert module.visible_quantity == 1
    assert any("blue relay block" in note for note in module.notes)


def test_hidden_details_are_unknown_or_inferred(mock_result):
    bom = mock_result.bom
    hidden = {c.category: c for c in bom.components if c.evidence_type is not EvidenceType.OBSERVED}
    assert {"motor", "power_supply", "microcontroller"} <= set(hidden)
    assert all(c.evidence == [] and c.visible_quantity is None for c in hidden.values())
    open_ids = {i.id for i in bom.unresolved_issues("critical")}
    assert {"power.unknown", "controller.unknown", "compat.electrical_unconfirmed"} <= open_ids


def test_underside_and_label_closeups_are_requested(mock_result):
    views = [v.view.lower() for v in mock_result.bom.requested_views]
    assert views[0] == "underside"
    assert any("pcb labels" in v for v in views)
    assert len(views) == len(set(views)), "model and rule requests must be deduplicated"


def test_every_observed_claim_cites_a_real_image(mock_result):
    bom = mock_result.bom
    for component in bom.components:
        if component.evidence_type is EvidenceType.OBSERVED:
            assert component.evidence
            assert all(e.image_id in bom.image_ids and e.description for e in component.evidence)


def test_draft_is_never_purchase_ready(mock_result):
    assert mock_result.bom.ready_to_purchase is False
    assert mock_result.bom.readiness_blockers


def test_exports_are_valid_and_keep_uncertainty(mock_result, tmp_path):
    written = write_analysis_outputs(mock_result, tmp_path)
    assert set(written) == {"observations.json", "review.json", "bom.json", "bom.csv", "bom.md", "issues.md"}

    bom = RobotBOM.model_validate_json(written["bom.json"].read_text(encoding="utf-8"))
    assert bom == mock_result.bom

    rows = list(csv.DictReader(io.StringIO(written["bom.csv"].read_text(encoding="utf-8"))))
    assert list(rows[0].keys()) == CSV_FIELDS
    assert len(rows) == len(bom.components)
    motor_row = next(r for r in rows if r["category"] == "motor")
    assert motor_row["evidence_type"] == "unknown"
    # unknown is an empty cell, not 0
    assert motor_row["visible_quantity"] == motor_row["required_quantity"] == motor_row["purchase_quantity"] == ""
    assert motor_row["sku"] == ""

    markdown = written["bom.md"].read_text(encoding="utf-8")
    for section in ("Confirmed/visible components", "Inferred/hidden possibilities",
                    "Unknown critical details", "Catalog candidates", "Compatibility checks",
                    "Photos/measurements requested", "Purchase readiness"):
        assert f"## {section}" in markdown
    assert "NOT ready to purchase" in markdown and "MOCK DATA" in markdown
    assert "not a calibrated" in markdown

    observations = json.loads(written["observations.json"].read_text(encoding="utf-8"))
    assert observations["pass1_observations"][0]["image_id"] == bom.image_ids[0]
    assert "open" in written["issues.md"].read_text(encoding="utf-8").lower()


def test_catalog_unavailable_means_no_links_or_prices_but_exports_still_work(mock_result, tmp_path):
    bom = mock_result.bom
    assert bom.catalog_candidates == []
    assert bom.catalog_status == NOT_CONFIGURED

    written = write_analysis_outputs(mock_result, tmp_path)
    for name in ("bom.md", "bom.csv", "bom.json", "issues.md"):
        text = written[name].read_text(encoding="utf-8")
        assert "http://" not in text and "https://" not in text, name
    assert "Catalog lookup not configured" in written["bom.md"].read_text(encoding="utf-8")


def test_top_and_underside_views_deduplicate_wheels():
    result = analyze(make_images("rover_top.png", "rover_underside.png"), MockVisionClient(), mode="mock")
    bom = result.bom
    wheels = by_category(bom, "wheel")
    assert len(wheels) == 1 and wheels[0].visible_quantity == 4
    assert len({e.image_id for e in wheels[0].evidence}) == 2
    assert len(by_category(bom, "chassis")) == 1

    motor = by_category(bom, "motor")[0]
    assert motor.evidence_type is EvidenceType.OBSERVED and motor.visible_quantity == 2
    assert motor.required_quantity is None  # seeing 2 does not establish how many are needed
    issue_ids = {i.id for i in bom.issues}
    assert "drivetrain.unknown" not in issue_ids
    assert "drivetrain.layout_unconfirmed" in issue_ids  # 2 motors, 4 wheels
    assert "views.underside_missing" not in issue_ids


def test_pass2_proposals_never_become_observed_or_quantified():
    audit = {
        "inferred_components": [
            {"category": "motor", "name": "DC gear motor", "evidence_type": "inferred",
             "rationale": "Wheels are usually driven by gear motors.", "related_component_ids": ["wheel-1", "ghost-9"]},
            {"category": "wheel", "name": "rubber wheel", "evidence_type": "inferred", "rationale": "repeat"},
        ],
        "connections": [
            {"source_id": "wheel-1", "target_id": "chassis-1", "relation": "mechanically_attached",
             "evidence_type": "observed", "rationale": "wheels sit at the frame corners"},
            {"source_id": "wheel-1", "target_id": "ghost-9", "relation": "drives", "rationale": "x"},
        ],
        "issues": [{"severity": "warning", "component_ids": ["ghost-9", "wheel-1"],
                    "message": "Axle type unknown.", "next_action": "Photograph an axle."}],
        "requested_views": [{"view": "Underside", "reason": "motors"}],
    }
    client = ScriptedClient(
        pass1=[view("top", part("wheel", "rubber wheel", 4), part("chassis", "green chassis", 1))],
        pass2=[audit],
    )
    bom = analyze(make_images("top.png"), client).bom

    motor = by_category(bom, "motor")[0]
    assert motor.evidence_type is EvidenceType.INFERRED and motor.evidence == []
    assert motor.visible_quantity is None and motor.required_quantity is None
    assert "Related to: wheel-1" in motor.notes
    assert len(by_category(bom, "wheel")) == 1  # observed part was not re-added as inferred

    assert len(bom.connections) == 1
    assert bom.connections[0].evidence_type is EvidenceType.INFERRED  # text-only pass cannot observe
    model_issue = next(i for i in bom.issues if i.source == "model")
    assert model_issue.component_ids == ["wheel-1"]
    assert [v.view.lower() for v in bom.requested_views].count("underside") == 1


def test_underside_synonyms_from_the_model_are_not_requested_twice():
    audit = {"inferred_components": [], "connections": [], "issues": [],
             "requested_views": [{"view": "bottom", "reason": "motors"}, {"view": "side_left", "reason": "axles"}]}
    client = ScriptedClient(pass1=[view("top", part("wheel", "rubber wheel", 4))], pass2=[audit])
    views = [v.view for v in analyze(make_images("top.png"), client).bom.requested_views]
    assert "bottom" not in views and views[0] == "underside"
    assert "side left" in views


# ---- configuration / mock mode (spec test 6) ------------------------------


def test_no_api_key_normal_mode_fails_clearly_and_safely():
    settings = load_settings({}, dotenv=False)
    assert settings.has_api_key is False
    with pytest.raises(ConfigError) as excinfo:
        build_vision_client(settings)
    assert "MISTRAL_API_KEY" in str(excinfo.value) and "--mock" in str(excinfo.value)


def test_no_api_key_mock_mode_works():
    settings = load_settings({}, dotenv=False)
    client = build_vision_client(settings, mock=True)
    assert isinstance(client, MockVisionClient)
    assert analyze(make_images("top.png"), client, mode="mock").bom.components

    assert isinstance(build_vision_client(load_settings({"ROBOT_BOM_MOCK": "1"}, dotenv=False)), MockVisionClient)


def test_mistral_key_is_discovered_and_never_shown():
    settings = load_settings({"MISTRAL_API_KEY": SECRET}, dotenv=False)
    assert settings.api_key == SECRET
    assert settings.base_url == "https://api.mistral.ai/v1"
    assert SECRET not in repr(settings) and SECRET not in str(settings)


def test_vision_variables_override_the_mistral_defaults():
    settings = load_settings({
        "MISTRAL_API_KEY": "a", "VISION_API_KEY": "b", "VISION_API_BASE_URL": "https://llm.example.test/v1/",
        "VISION_MODEL": "some-vision-model",
    }, dotenv=False)
    assert settings.api_key == "b"
    assert settings.base_url == "https://llm.example.test/v1"
    assert settings.vision_model == settings.reasoning_model == "some-vision-model"


def test_existing_mistral_model_variable_is_honoured():
    assert load_settings({}, dotenv=False).vision_model == "mistral-large-latest"
    assert load_settings({"MISTRAL_MODEL": "mistral-large-4"}, dotenv=False).vision_model == "mistral-large-4"
    both = load_settings({"MISTRAL_MODEL": "a", "VISION_MODEL": "b"}, dotenv=False)
    assert both.vision_model == "b"
    assert load_settings({"VISION_VERIFY": "0"}, dotenv=False).verify is False


def test_secret_never_reaches_outputs(tmp_path):
    settings = Settings(api_key=SECRET)
    result = analyze(make_images("top.png"), build_vision_client(settings, mock=True), mode="mock")
    written = write_analysis_outputs(result, tmp_path)
    BOMExporter().export(result.bom, tmp_path)
    for path in written.values():
        assert SECRET not in path.read_text(encoding="utf-8")
