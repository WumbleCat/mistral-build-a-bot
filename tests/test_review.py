"""Human review and finalization (spec test 9)."""

import json

import pytest

from robot_bom.models import EvidenceType
from robot_bom.pipeline import analyze, write_analysis_outputs
from robot_bom.review import ReviewError, finalize, load_review
from robot_bom.vision import MockVisionClient

from conftest import make_images


@pytest.fixture
def review_data(tmp_path) -> dict:
    """A freshly generated review.json as a plain dict, as a reviewer would open it."""
    result = analyze(make_images("rover_top.png"), MockVisionClient(), project_name="rover", mode="mock")
    written = write_analysis_outputs(result, tmp_path)
    return json.loads(written["review.json"].read_text(encoding="utf-8"))


def component(data: dict, component_id: str) -> dict:
    return next(c for c in data["bom"]["components"] if c["id"] == component_id)


def issue(data: dict, issue_id: str) -> dict:
    return next(i for i in data["bom"]["issues"] if i["id"] == issue_id)


def complete_review(data: dict) -> dict:
    """Confirm every line with verified details, as a diligent reviewer would."""
    for c in data["bom"]["components"]:
        c.update(status="confirmed", required_quantity=c["visible_quantity"] or 1, purchase_quantity=0)
    component(data, "wheel-1").update(purchase_quantity=4, sku="WHL-65", manufacturer="Acme", model="65mm")
    component(data, "motor-1").update(
        required_quantity=2, purchase_quantity=2, sku="GM-TT-6V", specs={"voltage_v": "6", "current_a": "1.2"})
    component(data, "motor_driver-1").update(
        purchase_quantity=1, sku="DRV-2CH", specs={"max_voltage_v": "12", "max_current_a": "2"})
    component(data, "power_supply-1").update(purchase_quantity=1, sku="BAT-2S", specs={"voltage_v": "7.4"})
    component(data, "microcontroller-1").update(purchase_quantity=1, sku="MCU-1", model="DevBoard v3")
    return data


def test_review_file_explains_itself_and_keeps_a_baseline(review_data):
    assert review_data["instructions"]
    assert review_data["bom"] == review_data["baseline"]


def test_corrections_persist_in_the_final_bom(review_data):
    component(review_data, "wheel-1").update(
        status="confirmed", visible_quantity=4, required_quantity=4, purchase_quantity=4,
        manufacturer="Acme", model="65mm rubber", sku="WHL-65")
    component(review_data, "led-1")["status"] = "rejected"
    component(review_data, "chassis-1").update(status="confirmed", purchase_quantity=0)

    bom = finalize(load_review(review_data))
    by_id = {c.id: c for c in bom.components}

    wheel = by_id["wheel-1"]
    assert (wheel.status, wheel.sku, wheel.manufacturer, wheel.model) == ("confirmed", "WHL-65", "Acme", "65mm rubber")
    assert (wheel.required_quantity, wheel.purchase_quantity) == (4, 4)
    assert wheel.evidence_type is EvidenceType.OBSERVED  # photo evidence is unchanged by review
    assert by_id["led-1"].status == "rejected"
    assert by_id["chassis-1"].purchase_quantity == 0
    assert bom.metadata["stage"] == "final"


def test_unresolved_critical_issue_keeps_ready_to_purchase_false(review_data):
    component(review_data, "wheel-1").update(status="confirmed", purchase_quantity=4, sku="WHL-65")

    bom = finalize(load_review(review_data))

    assert bom.ready_to_purchase is False
    assert {i.id for i in bom.unresolved_issues("critical")} >= {"drivetrain.unknown", "power.unknown"}
    assert any("unresolved critical" in b for b in bom.readiness_blockers)


def test_audit_trail_records_every_correction(review_data):
    component(review_data, "wheel-1").update(status="confirmed", sku="WHL-65")
    component(review_data, "led-1")["status"] = "rejected"
    review_data["reviewer"] = "sam"

    bom = finalize(load_review(review_data), now="2026-01-01T00:00:00+00:00")
    trail = [(e.actor, e.action, e.target, e.field, e.old, e.new) for e in bom.audit_trail]

    assert ("sam", "component_confirmed", "wheel-1", "status", "needs_review", "confirmed") in trail
    assert ("sam", "component_modified", "wheel-1", "sku", None, "WHL-65") in trail
    assert ("sam", "component_rejected", "led-1", "status", "needs_review", "rejected") in trail
    assert bom.audit_trail[-1].action == "finalized"
    assert all(e.timestamp == "2026-01-01T00:00:00+00:00" for e in bom.audit_trail)


def test_refinalizing_does_not_duplicate_audit_entries(review_data):
    component(review_data, "wheel-1")["status"] = "confirmed"
    first = finalize(load_review(review_data))
    again = {**review_data, "bom": first.model_dump(mode="json")}
    second = finalize(load_review(again))
    confirmations = [e for e in second.audit_trail if e.action == "component_confirmed"]
    assert len(confirmations) == 1


def test_fully_verified_review_becomes_ready_to_purchase(review_data):
    bom = finalize(load_review(complete_review(review_data)))

    assert bom.unresolved_issues("critical") == []
    assert bom.readiness_blockers == []
    assert bom.ready_to_purchase is True
    resolved = {i.id for i in bom.issues if i.resolved}
    assert {"drivetrain.unknown", "power.unknown", "controller.unknown"} <= resolved


def test_confirmed_but_incompatible_pairing_blocks_purchase(review_data):
    complete_review(review_data)
    component(review_data, "power_supply-1")["specs"] = {"voltage_v": "24"}  # into a 12 V driver, 6 V motors

    bom = finalize(load_review(review_data))

    open_ids = {i.id for i in bom.unresolved_issues("critical")}
    assert "compat.driver_overvoltage.motor_driver-1" in open_ids
    assert bom.ready_to_purchase is False


def test_missing_sku_on_an_item_to_buy_blocks_purchase(review_data):
    complete_review(review_data)
    component(review_data, "wheel-1")["sku"] = "unknown"  # placeholder text is stored as null

    bom = finalize(load_review(review_data))

    assert next(c for c in bom.components if c.id == "wheel-1").sku is None
    assert bom.ready_to_purchase is False
    assert any("sku" in b and "wheel-1" in b for b in bom.readiness_blockers)


def test_rule_based_critical_issue_cannot_be_waved_through(review_data):
    issue(review_data, "drivetrain.unknown").update(resolved=True, resolution_note="looks fine")

    bom = finalize(load_review(review_data))
    drivetrain = next(i for i in bom.issues if i.id == "drivetrain.unknown")

    assert drivetrain.resolved is False
    assert "check still fails" in drivetrain.resolution_note and "looks fine" in drivetrain.resolution_note


def test_reviewer_can_resolve_warnings_and_model_raised_issues(review_data):
    issue(review_data, "model.1").update(resolved=True, resolution_note="traced the wiring by hand")
    issue(review_data, "compat.mounting_connectors").update(resolved=True, resolution_note="measured")

    bom = finalize(load_review(review_data))
    final = {i.id: i for i in bom.issues}

    assert final["model.1"].resolved and final["model.1"].resolution_note == "traced the wiring by hand"
    assert final["compat.mounting_connectors"].resolved
    assert any(e.action == "issue_resolved" and e.target == "model.1" for e in bom.audit_trail)


def test_hand_edited_ready_flag_is_ignored(review_data):
    review_data["bom"]["ready_to_purchase"] = True
    bom = finalize(load_review(review_data))
    assert bom.ready_to_purchase is False


def test_reviewer_added_part_not_in_photos_stays_non_observed(review_data):
    review_data["bom"]["components"].append({
        "id": "switch-1", "category": "switch", "name": "power toggle switch",
        "evidence_type": "inferred", "status": "confirmed", "required_quantity": 1, "purchase_quantity": 1,
        "sku": "SW-01",
    })
    bom = finalize(load_review(review_data))
    switch = next(c for c in bom.components if c.id == "switch-1")
    assert switch.evidence_type is EvidenceType.INFERRED and switch.visible_quantity is None
    assert any(e.action == "component_added" and e.target == "switch-1" for e in bom.audit_trail)


def test_invalid_review_edit_is_rejected_with_a_clear_message(review_data):
    component(review_data, "wheel-1")["evidence"] = []  # observed claim with its evidence deleted
    with pytest.raises(ReviewError, match="marked observed but has no image evidence"):
        load_review(review_data)


def test_review_file_errors_are_reported(tmp_path):
    with pytest.raises(ReviewError, match="not found"):
        load_review(tmp_path / "missing.json")
    broken = tmp_path / "review.json"
    broken.write_text("{ not json", encoding="utf-8")
    with pytest.raises(ReviewError, match="not valid JSON"):
        load_review(broken)
