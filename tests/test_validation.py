"""Deterministic requirement checks (spec tests 3 and 8)."""

from robot_bom.models import Connection, EvidenceType
from robot_bom.validation import (
    RequirementsValidator, ensure_critical_placeholders, parse_number, purchase_blockers,
)

from conftest import hidden, observed

TOP_ONLY = {"img1": "top"}


def validate(components, connections=(), views=TOP_ONLY):
    return RequirementsValidator().validate(list(components), list(connections), image_views=views)


def ids(result):
    return {i.id: i for i in result.issues}


def top_view_inventory():
    return ensure_critical_placeholders([
        observed("wheel-1", "wheel", "rubber wheel", 4),
        observed("chassis-1", "chassis", "green chassis frame", 1),
        observed("relay_module-1", "relay_module", "relay module board", 1),
    ])


def test_four_wheels_without_underside_leave_the_drivetrain_unknown():
    inventory = top_view_inventory()
    motors = [c for c in inventory if c.category == "motor"]

    assert len(motors) == 1
    motor = motors[0]
    assert motor.evidence_type is EvidenceType.UNKNOWN
    # no invented motor count of any kind
    assert (motor.visible_quantity, motor.required_quantity, motor.purchase_quantity) == (None, None, None)
    assert motor.sku is None and motor.model is None and motor.specs == {}

    issue = ids(validate(inventory))["drivetrain.unknown"]
    assert issue.severity == "critical"
    assert "do not imply one motor each" in issue.message
    assert "underside" in issue.next_action.lower()


def test_placeholders_cover_power_controller_and_driver_without_quantities():
    inventory = top_view_inventory()
    placeholders = [c for c in inventory if c.evidence_type is EvidenceType.UNKNOWN]
    assert {c.category for c in placeholders} == {"motor", "motor_driver", "power_supply", "microcontroller"}
    assert all(c.status == "needs_review" and c.required_quantity is None for c in placeholders)
    found = ids(validate(inventory))
    assert found["power.unknown"].severity == "critical"
    assert found["controller.unknown"].severity == "critical"


def test_no_placeholder_when_the_role_is_already_listed():
    inventory = ensure_critical_placeholders([
        observed("wheel-1", "wheel", "wheel", 4),
        hidden("motor-1", "motor", "DC gear motor", evidence_type=EvidenceType.INFERRED),
    ])
    assert [c.id for c in inventory if c.category == "motor"] == ["motor-1"]


def test_relay_board_is_not_treated_as_a_motor_driver():
    issue = ids(validate(top_view_inventory()))["motor_control.relay_not_driver"]
    assert issue.severity == "warning"
    assert "not interchangeable with motor drivers" in issue.message
    assert issue.component_ids == ["relay_module-1"]


def test_relay_recorded_as_driving_a_motor_raises_a_question():
    inventory = [
        observed("relay_module-1", "relay_module", "relay board", 1),
        observed("motor-1", "motor", "DC motor", 2),
    ]
    connection = Connection(source_id="relay_module-1", target_id="motor-1", relation="drives",
                            evidence_type=EvidenceType.INFERRED, rationale="wired together")
    assert "motor_control.relay_drives_motor.0" in ids(validate(inventory, [connection]))


def test_missing_underside_view_is_requested_first():
    result = validate(top_view_inventory())
    assert "views.underside_missing" in ids(result)
    assert result.requested_views[0].view == "underside" and result.requested_views[0].priority == 1
    assert any("PCB labels" in v.view for v in result.requested_views)


def test_underside_view_supplied_removes_that_request():
    result = validate(top_view_inventory(), views={"img1": "top", "img2": "underside"})
    assert "views.underside_missing" not in ids(result)
    assert all(v.view != "underside" for v in result.requested_views)


def test_chassis_is_flagged_as_possibly_custom_without_a_sku():
    issue = ids(validate(top_view_inventory()))["chassis.possibly_custom"]
    assert issue.severity == "info" and "No vendor SKU is assumed" in issue.message


def electrical_inventory(battery_v, motor_v, motor_a, driver_max_v, driver_max_a):
    return [
        observed("wheel-1", "wheel", "wheel", 4, status="confirmed"),
        observed("motor-1", "motor", "DC gear motor", 2, status="confirmed",
                 specs={"voltage_v": motor_v, "current_a": motor_a}),
        observed("motor_driver-1", "motor_driver", "dual H-bridge driver", 1, status="confirmed",
                 specs={"max_voltage_v": driver_max_v, "max_current_a": driver_max_a}),
        observed("battery-1", "battery", "battery pack", 1, status="confirmed",
                 specs={"voltage_v": battery_v}),
        observed("microcontroller-1", "microcontroller", "controller", 1, status="confirmed", model="X1"),
    ]


def test_unspecified_electrical_values_block_purchase():
    inventory = top_view_inventory()
    issue = ids(validate(inventory))["compat.electrical_unconfirmed"]
    assert issue.severity == "critical"
    assert "must be confirmed before purchase" in issue.message


def test_incorrect_motor_driver_pairing_is_an_unresolved_critical_issue():
    # 12 V battery into a 6 V-max driver, and 3 A stall motors on a 1 A driver.
    inventory = electrical_inventory("12 V", "6", "3A", "6", "1")
    result = validate(inventory)
    found = ids(result)

    over_voltage = found["compat.driver_overvoltage.motor_driver-1"]
    undersized = found["compat.driver_undersized.motor_driver-1.motor-1"]
    assert over_voltage.severity == undersized.severity == "critical"
    assert not over_voltage.resolved and not undersized.resolved
    assert "12 V exceeds the 6 V maximum" in over_voltage.message
    assert "3 A" in undersized.message and "1 A" in undersized.message
    assert "compat.motor_overvoltage.motor-1" in found  # 12 V on 6 V motors

    blockers = purchase_blockers(inventory, result.issues)
    assert blockers and "unresolved critical" in blockers[0]


def test_compatible_pairing_raises_no_critical_issue():
    result = validate(electrical_inventory("7.4", "6", "1.2", "12", "2"))
    critical = [i.id for i in result.issues if i.severity == "critical"]
    assert critical == []


def test_unparseable_spec_is_reported_not_guessed():
    inventory = electrical_inventory("about seven", "6", "1.2", "12", "2")
    found = ids(validate(inventory))
    assert "compat.spec_unparseable.battery-1.voltage_v" in found
    assert "compat.electrical_unconfirmed" in found


def test_rules_never_confirm_or_modify_components():
    inventory = top_view_inventory()
    before = [c.model_dump() for c in inventory]
    validate(inventory)
    assert [c.model_dump() for c in inventory] == before


def test_reviewer_rejecting_motors_closes_the_drivetrain_question():
    inventory = top_view_inventory()
    for component in inventory:
        if component.category in ("motor", "motor_driver"):
            component.status = "rejected"
    found = ids(validate(inventory))
    assert "drivetrain.unknown" not in found and "compat.electrical_unconfirmed" not in found


def test_no_visible_parts_is_a_critical_issue():
    assert list(ids(validate([]))) == ["inventory.empty"]


def test_parse_number():
    assert parse_number("7.4 V") == 7.4
    assert parse_number("2A") == 2.0
    assert parse_number("1,5") == 1.5
    assert parse_number("unknown") is None and parse_number(None) is None
