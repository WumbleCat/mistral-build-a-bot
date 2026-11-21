"""Schema constraints (spec tests 4 and 5 plus referential integrity)."""

import pytest
from pydantic import ValidationError

from robot_bom.models import (
    CatalogCandidate, Component, Connection, Evidence, EvidenceType, ObservedPart, ReviewIssue,
    RobotBOM,
)

from conftest import hidden, observed


def test_observed_part_without_image_evidence_is_rejected():
    with pytest.raises(ValidationError, match="marked observed but has no image evidence"):
        Component(id="wheel-1", category="wheel", name="wheel",
                  evidence_type=EvidenceType.OBSERVED, visible_quantity=4)


def test_inferred_part_cannot_carry_a_visible_quantity():
    with pytest.raises(ValidationError, match="visible_quantity must be null"):
        Component(id="motor-1", category="motor", name="motor",
                  evidence_type=EvidenceType.INFERRED, visible_quantity=4)


@pytest.mark.parametrize("field", ["visible_quantity", "required_quantity", "purchase_quantity"])
def test_quantities_must_be_non_negative(field):
    kwargs = {"quantity": -1} if field == "visible_quantity" else {field: -1}
    with pytest.raises(ValidationError):
        observed("wheel-1", "wheel", "wheel", **kwargs)


def test_quantities_default_to_null_not_zero():
    component = hidden("motor-1", "motor", "drive motor")
    assert component.visible_quantity is None
    assert component.required_quantity is None
    assert component.purchase_quantity is None


@pytest.mark.parametrize("placeholder", ["unknown", "N/A", "", "  TBD ", "none"])
def test_unknown_sku_is_null_never_a_placeholder_string(placeholder):
    component = observed("wheel-1", "wheel", "wheel", sku=placeholder, model=placeholder,
                         manufacturer=placeholder)
    assert component.sku is None and component.model is None and component.manufacturer is None


def test_real_identifiers_are_kept():
    assert observed("wheel-1", "wheel", "wheel", sku=" WHL-65MM ").sku == "WHL-65MM"


@pytest.mark.parametrize("bbox", [(0.1, 0.1, 1.2, 0.5), (-0.1, 0, 0.5, 0.5), (0.6, 0.1, 0.4, 0.5)])
def test_evidence_bbox_must_be_in_range_and_ordered(bbox):
    with pytest.raises(ValidationError):
        Evidence(image_id="img1", description="x", bbox_xyxy_norm=bbox)


def test_model_supplied_unusable_bbox_becomes_null_not_a_guess():
    parsed = ObservedPart(category="wheel", name="wheel", description="x",
                          bbox_xyxy_norm=[0.2, 0.2, 1.7, 0.9])
    assert parsed.bbox_xyxy_norm is None


def test_confidence_must_be_between_zero_and_one():
    with pytest.raises(ValidationError):
        observed("wheel-1", "wheel", "wheel", confidence=1.4)


def _bom(**overrides) -> RobotBOM:
    data = dict(project_name="t", image_ids=["img1"], components=[observed("wheel-1", "wheel", "wheel", 4)])
    data.update(overrides)
    return RobotBOM(**data)


def test_component_ids_must_be_unique():
    with pytest.raises(ValidationError, match="duplicate component ids"):
        _bom(components=[observed("wheel-1", "wheel", "a"), observed("wheel-1", "wheel", "b")])


def test_evidence_must_reference_a_real_image():
    with pytest.raises(ValidationError, match="not in image_ids"):
        _bom(components=[observed("wheel-1", "wheel", "wheel", image_id="img9")])


def test_connections_must_reference_existing_components():
    connection = Connection(source_id="wheel-1", target_id="motor-9", relation="drives",
                            evidence_type=EvidenceType.INFERRED, rationale="x")
    with pytest.raises(ValidationError, match="unknown component id 'motor-9'"):
        _bom(connections=[connection])


def test_issue_and_catalog_references_are_checked():
    with pytest.raises(ValidationError, match="issue references unknown component"):
        _bom(issues=[ReviewIssue(severity="info", component_ids=["nope"], message="m", next_action="n")])
    candidate = CatalogCandidate(component_id="nope", vendor="v", title="t",
                                 product_url="https://example.test/p", evidence_notes="n")
    with pytest.raises(ValidationError, match="catalog candidate references unknown component"):
        _bom(catalog_candidates=[candidate])


def test_catalog_url_must_be_absolute():
    with pytest.raises(ValidationError, match="absolute http"):
        CatalogCandidate(component_id="wheel-1", vendor="v", title="t",
                         product_url="/products/1", evidence_notes="n")


def test_ready_to_purchase_cannot_coexist_with_open_critical_issue():
    critical = ReviewIssue(severity="critical", message="m", next_action="n")
    confirmed = observed("wheel-1", "wheel", "wheel", status="confirmed")
    with pytest.raises(ValidationError, match="unresolved critical"):
        _bom(components=[confirmed], issues=[critical], ready_to_purchase=True)


def test_ready_to_purchase_cannot_coexist_with_unreviewed_components():
    with pytest.raises(ValidationError, match="need review"):
        _bom(ready_to_purchase=True)
