"""Vision response validation and retries (spec test 1)."""

import pytest

from robot_bom.extraction import VisionResponseError, call_structured, extract_observations
from robot_bom.models import EvidenceType, ImageObservation, InferenceAudit, VisibilityAudit
from robot_bom.pipeline import analyze
from robot_bom.prompts import PASS1_SYSTEM, PASS2_SYSTEM

from conftest import EMPTY_AUDIT, ScriptedClient, make_images, part, view


def test_malformed_reply_is_retried_with_validation_feedback(top_view_reply):
    bad = view("top", {"category": "wheel", "name": "wheel", "description": "tyres", "visible_quantity": -4})
    client = ScriptedClient(pass1=[bad, top_view_reply])

    observations = extract_observations(client, make_images("top.png"), max_retries=2)

    pass1_calls = client.calls_for(ImageObservation)
    assert len(pass1_calls) == 2
    retry_prompt = pass1_calls[1]["user_prompt"]
    assert "previous reply was rejected" in retry_prompt
    assert "parts.0.visible_quantity" in retry_prompt
    assert [p.name for p in observations[0].parts][:2] == ["rubber wheel", "green chassis frame"]


def test_non_json_reply_is_retried(top_view_reply):
    client = ScriptedClient(pass1=["Sure! Here is what I see: four wheels.", top_view_reply])
    observations = extract_observations(client, make_images("top.png"))
    assert len(client.calls_for(ImageObservation)) == 2 and observations[0].parts


def test_fenced_json_is_accepted(top_view_reply):
    import json

    client = ScriptedClient(pass1=["```json\n" + json.dumps(top_view_reply) + "\n```"])
    assert extract_observations(client, make_images("top.png"))[0].view == "top"
    assert len(client.calls_for(ImageObservation)) == 1


def test_persistently_malformed_reply_raises_helpful_error_and_no_bom():
    client = ScriptedClient(pass1=[{"view": "top", "parts": "four wheels"}])

    with pytest.raises(VisionResponseError) as excinfo:
        analyze(make_images("top.png"), client, max_retries=1)

    message = str(excinfo.value)
    assert "did not return schema-valid JSON after 2 attempt(s)" in message
    assert "parts" in message and "No BOM was produced" in message
    assert len(client.calls) == 2  # bounded: 1 try + 1 retry, then stop


def test_image_id_comes_from_ingestion_not_from_the_model(top_view_reply):
    client = ScriptedClient(pass1=[{**top_view_reply, "image_id": "made-up-by-model"}])
    images = make_images("top.png")
    assert extract_observations(client, images)[0].image_id == images[0].image_id


def test_pass2_cannot_mark_an_unseen_part_observed():
    sneaky = {**EMPTY_AUDIT, "inferred_components": [
        {"category": "motor", "name": "DC motor", "evidence_type": "observed", "rationale": "wheels need motors"}]}
    honest = {**EMPTY_AUDIT, "inferred_components": [
        {"category": "motor", "name": "DC motor", "evidence_type": "inferred", "rationale": "wheels need motors"}]}
    client = ScriptedClient(pass1=[], pass2=[sneaky, honest])

    audit = call_structured(client, [], PASS2_SYSTEM, "inventory", InferenceAudit, stage="pass 2")

    assert len(client.calls) == 2
    assert "inferred_components.0.evidence_type" in client.calls[1]["user_prompt"]
    assert audit.inferred_components[0].evidence_type == "inferred"


def test_pass2_failure_degrades_to_deterministic_checks(top_view_reply):
    client = ScriptedClient(pass1=[top_view_reply], pass2=["not json at all"])

    result = analyze(make_images("top.png"), client, max_retries=0)

    assert result.audit is None
    assert any(i.id == "audit.unavailable" for i in result.bom.issues)
    assert any(i.id == "drivetrain.unknown" for i in result.bom.issues)
    assert result.bom.ready_to_purchase is False


def test_second_image_prompt_offers_known_names_for_matching(top_view_reply):
    client = ScriptedClient(pass1=[top_view_reply, view("underside", part("wheel", "rubber wheel", 4))])
    extract_observations(client, make_images("top.png", "underside.png"))
    first, second = (call["user_prompt"] for call in client.calls_for(ImageObservation))
    assert "already used for OTHER photos" not in first
    assert "- wheel: rubber wheel" in second


def test_system_prompts_carry_the_truthfulness_rules():
    assert "List ONLY parts physically visible" in PASS1_SYSTEM
    assert "Do not guess manufacturer, SKU" in PASS1_SYSTEM
    assert "Never convert a plausible part into a confirmed part" in PASS2_SYSTEM
    assert ImageObservation.model_fields.keys() >= {"view", "parts"}


# ---- visibility re-check ---------------------------------------------------

HALLUCINATING_REPLY = view(
    "top",
    part("wheel", "rubber wheel", 4),
    part("motor", "DC motor", 4),          # index 1: implied by the wheels, not actually seen
    part("chassis", "green frame", 1),
)
MOTORS_NOT_VISIBLE = {"checks": [
    {"index": 0, "directly_visible": True, "reason": "four tyres at the corners"},
    {"index": 1, "directly_visible": False, "reason": "no motor housing can be seen; only implied by the wheels"},
    {"index": 2, "directly_visible": True, "reason": "green frame fills the image"},
]}


def test_recheck_removes_claims_that_are_not_directly_visible():
    client = ScriptedClient(pass1=[HALLUCINATING_REPLY], verify=[MOTORS_NOT_VISIBLE])

    observation = extract_observations(client, make_images("top.png"))[0]

    assert [p.name for p in observation.parts] == ["rubber wheel", "green frame"]
    assert [(u.category, u.name) for u in observation.unconfirmed] == [("motor", "DC motor")]
    assert observation.verification == "ok"
    recheck = client.calls_for(VisibilityAudit)[0]
    assert len(recheck["images"]) == 1 and '"claimed_quantity": 4' in recheck["user_prompt"]


def test_unconfirmed_motor_claim_is_demoted_to_inferred_without_a_count():
    client = ScriptedClient(pass1=[HALLUCINATING_REPLY], verify=[MOTORS_NOT_VISIBLE])

    bom = analyze(make_images("top.png"), client).bom

    motor = next(c for c in bom.components if c.category == "motor")
    assert motor.evidence_type is EvidenceType.INFERRED and motor.evidence == []
    assert motor.visible_quantity is None and motor.required_quantity is None  # the "4" is gone
    assert any("could not confirm it is directly visible" in note for note in motor.notes)
    issue_ids = {i.id for i in bom.issues}
    assert f"verify.unconfirmed.{motor.id}" in issue_ids
    assert "drivetrain.unknown" in issue_ids  # an unconfirmed claim does not settle the drivetrain


def test_recheck_can_be_switched_off():
    client = ScriptedClient(pass1=[HALLUCINATING_REPLY], verify=[MOTORS_NOT_VISIBLE])
    observation = extract_observations(client, make_images("top.png"), verify=False)[0]
    assert len(observation.parts) == 3 and observation.verification == "not_run"
    assert client.calls_for(VisibilityAudit) == []


def test_failed_recheck_keeps_the_parts_and_raises_a_warning(top_view_reply):
    client = ScriptedClient(pass1=[top_view_reply], verify=["no json here"])

    result = analyze(make_images("top.png"), client, max_retries=0)

    assert result.observations[0].verification == "failed"
    assert any(c.category == "wheel" for c in result.bom.components)
    assert any(i.id.startswith("verify.unavailable.") and i.severity == "warning" for i in result.bom.issues)


def test_model_cannot_pre_fill_the_recheck_fields(top_view_reply):
    sneaky = {**top_view_reply, "verification": "ok", "unconfirmed": []}
    client = ScriptedClient(pass1=[sneaky])
    observation = extract_observations(client, make_images("top.png"), verify=False)[0]
    assert observation.verification == "not_run"
