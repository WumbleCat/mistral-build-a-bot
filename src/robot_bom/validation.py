"""Stage D - deterministic mechanical / electrical requirement checks.

Every rule emits a *warning or question* (a ``ReviewIssue``). No rule ever confirms a
component or fills in a quantity, rating, or part number.

Spec keys understood by the electrical checks (set them in review, as strings):

* power source ......... ``voltage_v``
* motor ................ ``voltage_v`` (rated), ``current_a`` (stall / peak per motor)
* motor driver / relay . ``max_voltage_v``, ``max_current_a`` (per channel), optional ``min_voltage_v``
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .models import Component, Connection, EvidenceType, ReviewIssue, ViewRequest
from .taxonomy import IdAllocator, has_role

UNDERSIDE_WORDS = ("underside", "bottom", "under", "below")

_NUMBER = re.compile(r"[-+]?\d+(?:\.\d+)?")


def parse_number(text: str | None) -> float | None:
    """Read the leading number out of strings like ``"7.4"``, ``"7.4 V"`` or ``"2A"``."""
    if text is None:
        return None
    match = _NUMBER.search(str(text).replace(",", "."))
    return float(match.group()) if match else None


@dataclass
class ValidationResult:
    issues: list[ReviewIssue] = field(default_factory=list)
    requested_views: list[ViewRequest] = field(default_factory=list)


def _established(component: Component) -> bool:
    """Seen in a photo, or explicitly confirmed by a human."""
    return component.evidence_type is EvidenceType.OBSERVED or component.status == "confirmed"


def ensure_critical_placeholders(components: list[Component]) -> list[Component]:
    """Add explicit UNKNOWN lines for critical roles nobody has seen or proposed.

    Placeholders carry no quantities and no identifiers; they exist so that "we do not
    know" is visible in the BOM instead of being silently absent.
    """
    if not any(c.evidence_type is EvidenceType.OBSERVED for c in components):
        return components
    placeholders = [
        ("motor", "motor", "Drive motor(s) - count and type unknown",
         "No drive motor is visible. Wheel count does not establish motor count."),
        ("motor_driver", "motor_driver", "Motor driver / switching stage - unknown",
         "How motor current is switched (H-bridge driver, relays, ESC) is not established."),
        ("power", "power_supply", "Power source - chemistry and voltage unknown",
         "No battery or power source is visible; voltage and chemistry are not established."),
        ("controller", "microcontroller", "Controller board - identity unknown",
         "No controller board could be identified from the photos."),
    ]
    ids = IdAllocator([c.id for c in components])
    result = list(components)
    for role, category, name, note in placeholders:
        if any(has_role(c, role) for c in components):
            continue
        result.append(
            Component(
                id=ids.new(category),
                category=category,
                name=name,
                evidence_type=EvidenceType.UNKNOWN,
                notes=[note, "Placeholder added by a deterministic completeness rule; not a confirmed part."],
            )
        )
    return result


class RequirementsValidator:
    def validate(
        self,
        inventory: list[Component],
        connections: list[Connection],
        *,
        image_views: dict[str, str] | None = None,
    ) -> ValidationResult:
        result = ValidationResult()
        active = [c for c in inventory if c.status != "rejected"]
        if not any(c.evidence_type is EvidenceType.OBSERVED for c in active):
            result.issues.append(
                ReviewIssue(
                    id="inventory.empty", severity="critical", component_ids=[],
                    message="No visible robot parts were identified in the supplied photos.",
                    next_action="Retake the photos (well lit, whole robot in frame) and rerun the analysis.",
                )
            )
            return result

        self._drivetrain(inventory, active, result)
        self._motor_control(active, connections, result)
        self._power(inventory, active, result)
        self._controller(inventory, active, result)
        self._electrical_compatibility(inventory, active, result)
        self._mechanical(active, result)
        self._views(active, image_views or {}, result)
        return result

    # ---- helpers ----------------------------------------------------------

    @staticmethod
    def _role(components: list[Component], role: str) -> list[Component]:
        return [c for c in components if has_role(c, role)]

    @staticmethod
    def _reviewer_ruled_out(inventory: list[Component], role: str) -> bool:
        """True when lines for this role exist and the reviewer rejected all of them."""
        lines = [c for c in inventory if has_role(c, role)]
        return bool(lines) and all(c.status == "rejected" for c in lines)

    # ---- rules ------------------------------------------------------------

    def _drivetrain(self, inventory, active, result: ValidationResult) -> None:
        wheels = self._role(active, "wheel")
        if not wheels or self._reviewer_ruled_out(inventory, "motor"):
            return
        motors = self._role(active, "motor")
        wheel_count = sum(c.visible_quantity or 0 for c in wheels)
        counted = [
            m for m in motors
            if (m.evidence_type is EvidenceType.OBSERVED and m.visible_quantity is not None)
            or (m.status == "confirmed" and m.required_quantity is not None)
        ]
        if not counted:
            result.issues.append(
                ReviewIssue(
                    id="drivetrain.unknown", severity="critical",
                    component_ids=[c.id for c in wheels + motors],
                    message=(
                        f"{wheel_count or 'Some'} wheel(s) are visible but no drive motor count is "
                        "established. Wheels do not imply one motor each: the drivetrain layout "
                        "(2WD, 4WD, skid-steer, free-rolling wheels) is unknown."
                    ),
                    next_action=(
                        "Photograph the underside, then confirm the motor line in review with its "
                        "required_quantity and type."
                    ),
                )
            )
            return
        visible_motors = sum(m.visible_quantity or 0 for m in motors if m.evidence_type is EvidenceType.OBSERVED)
        confirmed = any(m.status == "confirmed" and m.required_quantity is not None for m in motors)
        if not confirmed and wheel_count and visible_motors != wheel_count:
            result.issues.append(
                ReviewIssue(
                    id="drivetrain.layout_unconfirmed", severity="warning",
                    component_ids=[c.id for c in wheels + motors],
                    message=(
                        f"{visible_motors} motor(s) visible for {wheel_count} wheel(s). Which wheels are "
                        "driven, and whether more motors are hidden, is not established."
                    ),
                    next_action="Confirm the number of drive motors and set required_quantity in review.",
                )
            )

    def _motor_control(self, active, connections, result: ValidationResult) -> None:
        relays = self._role(active, "relay")
        drivers = [c for c in self._role(active, "motor_driver") if _established(c)]
        by_id = {c.id: c for c in active}
        if relays and not drivers:
            result.issues.append(
                ReviewIssue(
                    id="motor_control.relay_not_driver", severity="warning",
                    component_ids=[c.id for c in relays],
                    message=(
                        "A relay board is visible but no motor driver. Relay boards are not "
                        "interchangeable with motor drivers: relays only switch on/off (no PWM speed "
                        "control) and need an H-bridge arrangement to reverse direction."
                    ),
                    next_action=(
                        "Check the intended motor control method (on/off relays vs. a PWM motor "
                        "driver) before buying either."
                    ),
                )
            )
        for index, conn in enumerate(connections):
            source, target = by_id.get(conn.source_id), by_id.get(conn.target_id)
            if source and target and conn.relation == "drives" and has_role(source, "relay") and has_role(target, "motor"):
                result.issues.append(
                    ReviewIssue(
                        id=f"motor_control.relay_drives_motor.{index}", severity="warning",
                        component_ids=[source.id, target.id],
                        message=(
                            f"'{source.id}' is recorded as driving '{target.id}'. Relay contacts must be "
                            "rated above the motor's stall current, and relays cannot vary speed."
                        ),
                        next_action="Confirm the relay contact rating against the motor stall current.",
                    )
                )

    def _power(self, inventory, active, result: ValidationResult) -> None:
        if self._reviewer_ruled_out(inventory, "power"):
            return
        sources = self._role(active, "power")
        established = [c for c in sources if _established(c)]
        if not established:
            result.issues.append(
                ReviewIssue(
                    id="power.unknown", severity="critical",
                    component_ids=[c.id for c in sources],
                    message="The power source is not identified: chemistry, voltage and capacity are unknown.",
                    next_action=(
                        "Photograph the battery/holder label, then confirm the power line in review "
                        "and set specs.voltage_v."
                    ),
                )
            )
        elif all(parse_number(c.specs.get("voltage_v")) is None for c in established):
            result.issues.append(
                ReviewIssue(
                    id="power.voltage_unknown", severity="critical",
                    component_ids=[c.id for c in established],
                    message="A power source is present but its operating voltage is not established.",
                    next_action="Read the battery label or measure it, then set specs.voltage_v in review.",
                )
            )

    def _controller(self, inventory, active, result: ValidationResult) -> None:
        if self._reviewer_ruled_out(inventory, "controller"):
            return
        controllers = self._role(active, "controller")
        established = [c for c in controllers if _established(c)]
        if not established:
            result.issues.append(
                ReviewIssue(
                    id="controller.unknown", severity="critical",
                    component_ids=[c.id for c in controllers],
                    message="No controller board is identified; its model, logic voltage and pin count are unknown.",
                    next_action="Take a close-up of the board's labels, then confirm the controller line in review.",
                )
            )
            return
        unidentified = [c for c in established if not c.model]
        if unidentified:
            result.issues.append(
                ReviewIssue(
                    id="controller.identity_unverified", severity="warning",
                    component_ids=[c.id for c in unidentified],
                    message="A controller board is visible but its exact model is not verified.",
                    next_action="Take a readable close-up of the silkscreen/labels and enter the model in review.",
                )
            )

    def _electrical_compatibility(self, inventory, active, result: ValidationResult) -> None:
        if self._reviewer_ruled_out(inventory, "motor"):
            return  # reviewer stated there are no drive motors: nothing to pair
        if not any(has_role(c, r) for c in active for r in ("wheel", "motor", "motor_driver", "relay")):
            return
        motors = self._role(active, "motor")
        drivers = self._role(active, "motor_driver") or self._role(active, "relay")
        sources = self._role(active, "power")
        missing: list[str] = []
        involved: list[str] = []

        def number(component: Component, key: str, label: str) -> float | None:
            raw = component.specs.get(key)
            value = parse_number(raw)
            if raw is not None and value is None:
                result.issues.append(
                    ReviewIssue(
                        id=f"compat.spec_unparseable.{component.id}.{key}", severity="warning",
                        component_ids=[component.id],
                        message=f"specs.{key}='{raw}' on '{component.id}' is not a number.",
                        next_action=f"Enter {label} as a plain number, e.g. \"7.4\".",
                    )
                )
            if value is None:
                missing.append(f"{label} of '{component.id}' (specs.{key})")
                involved.append(component.id)
            return value

        if not motors:
            missing.append("drive motor (not identified)")
        if not drivers:
            missing.append("motor driver / switching stage (not identified)")
        if not sources:
            missing.append("power source (not identified)")

        supply = None
        for source in sources:
            supply = parse_number(source.specs.get("voltage_v")) if supply is None else supply
        if sources and supply is None:
            number(sources[0], "voltage_v", "supply voltage in volts")
        motor_specs = [(m, number(m, "voltage_v", "rated voltage in volts"),
                        number(m, "current_a", "stall/peak current in amps")) for m in motors]
        driver_specs = [(d, number(d, "max_voltage_v", "maximum supply voltage in volts"),
                         number(d, "max_current_a", "per-channel current capacity in amps")) for d in drivers]

        if missing:
            result.issues.append(
                ReviewIssue(
                    id="compat.electrical_unconfirmed", severity="critical",
                    component_ids=sorted(set(involved)),
                    message=(
                        "Electrical compatibility cannot be checked. Power source, operating voltage, "
                        "motor current and driver current capacity must be confirmed before purchase. "
                        "Missing: " + "; ".join(missing) + "."
                    ),
                    next_action="Read the values from labels/datasheets and enter them as specs in review.",
                )
            )

        for driver, max_v, max_a in driver_specs:
            min_v = parse_number(driver.specs.get("min_voltage_v"))
            if supply is not None and max_v is not None and supply > max_v:
                result.issues.append(
                    ReviewIssue(
                        id=f"compat.driver_overvoltage.{driver.id}", severity="critical",
                        component_ids=[driver.id] + [s.id for s in sources],
                        message=f"Supply voltage {supply:g} V exceeds the {max_v:g} V maximum of '{driver.id}'.",
                        next_action="Choose a driver rated above the supply voltage, or lower the supply voltage.",
                    )
                )
            if supply is not None and min_v is not None and supply < min_v:
                result.issues.append(
                    ReviewIssue(
                        id=f"compat.driver_undervoltage.{driver.id}", severity="critical",
                        component_ids=[driver.id] + [s.id for s in sources],
                        message=f"Supply voltage {supply:g} V is below the {min_v:g} V minimum of '{driver.id}'.",
                        next_action="Choose a driver that operates at the supply voltage, or raise the supply voltage.",
                    )
                )
            for motor, _, motor_a in motor_specs:
                if motor_a is not None and max_a is not None and motor_a > max_a:
                    result.issues.append(
                        ReviewIssue(
                            id=f"compat.driver_undersized.{driver.id}.{motor.id}", severity="critical",
                            component_ids=[driver.id, motor.id],
                            message=(
                                f"Motor '{motor.id}' can draw {motor_a:g} A but '{driver.id}' is rated "
                                f"for {max_a:g} A per channel."
                            ),
                            next_action="Choose a driver whose per-channel current rating exceeds the motor stall current.",
                        )
                    )
        for motor, motor_v, _ in motor_specs:
            if supply is None or motor_v is None or motor_v <= 0:
                continue
            if supply > motor_v * 1.2:
                # A driver can limit motor voltage with PWM, so a moderate excess is a
                # question; more than double the rating is treated as a hard mismatch.
                result.issues.append(
                    ReviewIssue(
                        id=f"compat.motor_overvoltage.{motor.id}",
                        severity="critical" if supply > motor_v * 2 else "warning",
                        component_ids=[motor.id] + [s.id for s in sources],
                        message=f"Supply voltage {supply:g} V is more than 20% above the {motor_v:g} V rating of '{motor.id}'.",
                        next_action=(
                            "Match the supply voltage to the motor rating, add regulation, or confirm "
                            "the driver limits motor voltage (PWM duty cap)."
                        ),
                    )
                )
            elif supply < motor_v * 0.6:
                result.issues.append(
                    ReviewIssue(
                        id=f"compat.motor_undervoltage.{motor.id}", severity="warning",
                        component_ids=[motor.id] + [s.id for s in sources],
                        message=f"Supply voltage {supply:g} V is well below the {motor_v:g} V rating of '{motor.id}'; it may stall.",
                        next_action="Confirm the motor runs acceptably at the supply voltage.",
                    )
                )

    def _mechanical(self, active, result: ValidationResult) -> None:
        chassis = [c for c in self._role(active, "chassis") if not c.sku]
        if chassis:
            result.issues.append(
                ReviewIssue(
                    id="chassis.possibly_custom", severity="info",
                    component_ids=[c.id for c in chassis],
                    message=(
                        "The chassis may be a custom fabricated part (3D printed, laser cut or hand "
                        "made). No vendor SKU is assumed for it."
                    ),
                    next_action=(
                        "If it is custom, set purchase_quantity to 0 and note how it is made; "
                        "otherwise enter the verified kit/part number."
                    ),
                )
            )
        result.issues.append(
            ReviewIssue(
                id="compat.mounting_connectors", severity="warning", component_ids=[],
                message=(
                    "Physical mounting (hole patterns, shaft/hub fit, clearances) and connector types "
                    "cannot be verified from photos."
                ),
                next_action=(
                    "Measure mounting holes, shaft diameter and connector pitch before ordering; mark "
                    "this issue resolved in review once checked."
                ),
            )
        )

    def _views(self, active, image_views: dict[str, str], result: ValidationResult) -> None:
        views = [v.lower() for v in image_views.values()]
        has_underside = any(word in view for view in views for word in UNDERSIDE_WORDS)
        if not has_underside:
            result.issues.append(
                ReviewIssue(
                    id="views.underside_missing", severity="warning", component_ids=[],
                    message=(
                        "No underside photo was supplied. A complete-looking top view does not "
                        "establish motors, gearboxes, axles, couplers or underside fasteners."
                    ),
                    next_action="Add an underside photo and rerun the analysis.",
                )
            )
            result.requested_views.append(
                ViewRequest(
                    view="underside",
                    reason="Most informative missing view: shows drive motors, gearboxes, axles, couplers and fasteners.",
                    priority=1,
                )
            )
        boards = [
            c for c in self._role(active, "board")
            if c.evidence_type is EvidenceType.OBSERVED and not c.model
        ]
        if boards:
            result.requested_views.append(
                ViewRequest(
                    view="close-up of PCB labels",
                    reason=(
                        "Readable silkscreen/labels are needed to identify: "
                        + ", ".join(c.id for c in boards) + "."
                    ),
                    priority=1 if has_underside else 2,
                )
            )
        if not any(_established(c) and parse_number(c.specs.get("voltage_v")) is not None
                   for c in self._role(active, "power")):
            result.requested_views.append(
                ViewRequest(
                    view="battery / power source label",
                    reason="Needed to establish chemistry, voltage and capacity.",
                    priority=2,
                )
            )


def purchase_blockers(components: list[Component], issues: list[ReviewIssue]) -> list[str]:
    """Reasons the BOM is not purchasing-ready. Empty list means ready."""
    blockers: list[str] = []
    active = [c for c in components if c.status != "rejected"]
    critical = [i for i in issues if i.severity == "critical" and not i.resolved]
    if critical:
        blockers.append(f"{len(critical)} unresolved critical issue(s): " + ", ".join(i.id for i in critical))
    if not active:
        blockers.append("The BOM has no active components.")
    pending = [c.id for c in active if c.status == "needs_review"]
    if pending:
        blockers.append("Not yet reviewed by a human: " + ", ".join(pending))
    no_quantity = [c.id for c in active if c.status == "confirmed" and c.purchase_quantity is None]
    if no_quantity:
        blockers.append("purchase_quantity not established for: " + ", ".join(no_quantity))
    no_sku = [c.id for c in active if c.status == "confirmed" and (c.purchase_quantity or 0) > 0 and not c.sku]
    if no_sku:
        blockers.append("Exact part number (sku) unknown for items to be purchased: " + ", ".join(no_sku))
    return blockers
