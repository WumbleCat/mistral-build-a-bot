"""Vision response validation and retries (spec test 1)."""

import pytest

from robot_bom.extraction import VisionResponseError, call_structured, extract_observations
from robot_bom.models import ImageObservation, InferenceAudit
from robot_bom.pipeline import analyze
from robot_bom.prompts import PASS1_SYSTEM, PASS2_SYSTEM

from conftest import EMPTY_AUDIT, ScriptedClient, make_images, part, view


def test_malformed_reply_is_retried_with_validation_feedback(top_view_reply):
    bad = view("top", {"category": "wheel", "name": "wheel", "description": "tyres", "visible_quantity": -4})
    client = ScriptedClient(pass1=[bad, top_view_reply])

    observations = extract_observations(client, make_images("top.png"), max_retries=2)

    assert len(client.calls) == 2
    retry_prompt = client.calls[1]["user_prompt"]
    assert "previous reply was rejected" in retry_prompt
    assert "parts.0.visible_quantity" in retry_prompt
    assert [p.name for p in observations[0].parts][:2] == ["rubber wheel", "green chassis frame"]


def test_non_json_reply_is_retried(top_view_reply):
    client = ScriptedClient(pass1=["Sure! Here is what I see: four wheels.", top_view_reply])
    observations = extract_observations(client, make_images("top.png"))
    assert len(client.calls) == 2 and observations[0].parts


def test_fenced_json_is_accepted(top_view_reply):
    import json

    client = ScriptedClient(pass1=["```json\n" + json.dumps(top_view_reply) + "\n```"])
    assert extract_observations(client, make_images("top.png"))[0].view == "top"
    assert len(client.calls) == 1


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
    first, second = (call["user_prompt"] for call in client.calls)
    assert "already used for OTHER photos" not in first
    assert "- wheel: rubber wheel" in second


def test_system_prompts_carry_the_truthfulness_rules():
    assert "List ONLY parts physically visible" in PASS1_SYSTEM
    assert "Do not guess manufacturer, SKU" in PASS1_SYSTEM
    assert "Never convert a plausible part into a confirmed part" in PASS2_SYSTEM
    assert ImageObservation.model_fields.keys() >= {"view", "parts"}
