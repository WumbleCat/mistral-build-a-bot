"""Cross-image deduplication (spec test 2) and assembly/subcomponent handling."""

from robot_bom.models import EvidenceType, ImageObservation
from robot_bom.reconcile import InventoryReconciler

from conftest import part, view


def obs(image_id: str, reply: dict) -> ImageObservation:
    observation = ImageObservation.model_validate(reply)
    observation.image_id = image_id
    return observation


def merge(*observations):
    return InventoryReconciler().merge(list(observations))


def test_same_wheels_in_two_images_are_counted_once_with_both_references():
    result = merge(
        obs("img1", view("top", part("wheel", "rubber wheel", 4))),
        obs("img2", view("side", part("wheel", "rubber wheels", 4))),
    )
    assert len(result.components) == 1
    wheel = result.components[0]
    assert wheel.visible_quantity == 4  # not 8
    assert wheel.evidence_type is EvidenceType.OBSERVED
    assert {e.image_id for e in wheel.evidence} == {"img1", "img2"}
    assert any("counted once" in note for note in wheel.notes)
    assert result.issues == []


def test_synonymous_names_match():
    result = merge(
        obs("img1", view("top", part("wheel", "rubber wheel", 4))),
        obs("img2", view("side", part("tyre", "black rubber tyre", 2))),
    )
    assert [c.id for c in result.components] == ["wheel-1"]


def test_uncertain_match_is_flagged_not_silently_merged():
    result = merge(
        obs("img1", view("top", part("pcb_module", "blue sensor board", 1))),
        obs("img2", view("side", part("pcb_module", "voltage regulator", 1))),
    )
    assert [c.id for c in result.components] == ["pcb_module-1", "pcb_module-2"]
    issue = next(i for i in result.issues if i.id.startswith("reconcile.uncertain_match"))
    assert issue.severity == "warning"
    assert set(issue.component_ids) == {"pcb_module-1", "pcb_module-2"}
    assert "NOT merged automatically" in issue.message


def test_different_counts_across_views_use_the_max_and_raise_an_issue():
    result = merge(
        obs("img1", view("top", part("wheel", "rubber wheel", 4))),
        obs("img2", view("side", part("wheel", "rubber wheel", 2))),
    )
    wheel = result.components[0]
    assert wheel.visible_quantity == 4
    issue = next(i for i in result.issues if i.id == "reconcile.count_mismatch.wheel-1")
    assert "img1: 4" in issue.message and "img2: 2" in issue.message


def test_uncountable_quantity_stays_null():
    result = merge(obs("img1", view("top", part("wiring", "jumper wires", None))))
    assert result.components[0].visible_quantity is None


def test_relay_blocks_are_folded_into_the_relay_module_assembly():
    result = merge(obs("img1", view(
        "top",
        part("relay_module", "relay module board", 1),
        part("relay", "blue relay block", 2, parent_assembly="relay module board"),
    )))
    assert [c.category for c in result.components] == ["relay_module"]
    module = result.components[0]
    assert module.visible_quantity == 1
    assert any("2 x blue relay block" in n and "not counted as a separate BOM line" in n for n in module.notes)


def test_unlinked_relay_and_relay_module_raise_a_double_count_warning():
    result = merge(obs("img1", view(
        "top", part("relay_module", "relay module board", 1), part("relay", "relay", 2),
    )))
    assert len(result.components) == 2
    issue = next(i for i in result.issues if i.id.startswith("reconcile.possible_double_count"))
    assert set(issue.component_ids) == {"relay-1", "relay_module-1"}


def test_two_sightings_of_one_part_type_in_the_same_image_are_added():
    result = merge(obs("img1", view(
        "top", part("led", "LED", 2), part("led", "led", 1),
    )))
    assert len(result.components) == 1
    assert result.components[0].visible_quantity == 3
    assert len(result.components[0].evidence) == 2


def test_readable_markings_are_kept_as_a_spec_not_as_a_model_number():
    result = merge(obs("img1", view(
        "close-up", part("pcb_module", "motor driver board", 1, visible_markings="L298N"),
    )))
    component = result.components[0]
    assert component.specs == {"visible_markings": "L298N"}
    assert component.model is None and component.sku is None and component.manufacturer is None


def test_parts_mounted_on_the_chassis_or_breadboard_stay_separate_lines():
    result = merge(obs("img1", view(
        "top",
        part("chassis", "green frame", 1),
        part("breadboard", "solderless breadboard", 1, parent_assembly="green frame"),
        part("relay_module", "relay module", 1, parent_assembly="green frame"),
        part("relay", "relay block", 2, parent_assembly="relay module"),
        part("microcontroller", "controller board", 1, parent_assembly="solderless breadboard"),
    )))
    categories = [c.category for c in result.components]
    assert categories == ["chassis", "breadboard", "relay_module", "microcontroller"]
    by_category = {c.category: c for c in result.components}
    assert "Mounted on / attached to 'green frame'." in by_category["breadboard"].notes
    assert any("2 x relay block" in n for n in by_category["relay_module"].notes)
    assert by_category["chassis"].notes == []


def test_marking_read_on_a_folded_subcomponent_is_kept_in_the_note():
    result = merge(obs("img1", view(
        "top",
        part("relay_module", "relay module", 1),
        part("relay", "relay block", 2, parent_assembly="relay module", visible_markings="SONGLE"),
    )))
    assert any("Marking read on it: 'SONGLE'" in n for n in result.components[0].notes)
