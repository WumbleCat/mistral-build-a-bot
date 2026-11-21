# Unresolved issues - mock-rover

## Critical (4)

- **[CRITICAL - OPEN]** `drivetrain.unknown` (components: `wheel-1`, `motor-1`): 4 wheel(s) are visible but no drive motor count is established. Wheels do not imply one motor each: the drivetrain layout (2WD, 4WD, skid-steer, free-rolling wheels) is unknown.
  - Next action: Photograph the underside, then confirm the motor line in review with its required_quantity and type.
- **[CRITICAL - OPEN]** `power.unknown` (components: `power_supply-1`): The power source is not identified: chemistry, voltage and capacity are unknown.
  - Next action: Photograph the battery/holder label, then confirm the power line in review and set specs.voltage_v.
- **[CRITICAL - OPEN]** `controller.unknown` (components: `microcontroller-1`): No controller board is identified; its model, logic voltage and pin count are unknown.
  - Next action: Take a close-up of the board's labels, then confirm the controller line in review.
- **[CRITICAL - OPEN]** `compat.electrical_unconfirmed` (components: `motor-1`, `motor_driver-1`, `power_supply-1`): Electrical compatibility cannot be checked. Power source, operating voltage, motor current and driver current capacity must be confirmed before purchase. Missing: supply voltage in volts of 'power_supply-1' (specs.voltage_v); rated voltage in volts of 'motor-1' (specs.voltage_v); stall/peak current in amps of 'motor-1' (specs.current_a); maximum supply voltage in volts of 'motor_driver-1' (specs.max_voltage_v); per-channel current capacity in amps of 'motor_driver-1' (specs.max_current_a).
  - Next action: Read the values from labels/datasheets and enter them as specs in review.

## Warning (4)

- **[WARNING - OPEN]** `model.1`: Wire routing between the relay board and the rest of the electronics cannot be traced from the photo.
  - Next action: Sketch or photograph the wiring so each relay terminal's load is known.
- **[WARNING - OPEN]** `motor_control.relay_not_driver` (components: `relay_module-1`): A relay board is visible but no motor driver. Relay boards are not interchangeable with motor drivers: relays only switch on/off (no PWM speed control) and need an H-bridge arrangement to reverse direction.
  - Next action: Check the intended motor control method (on/off relays vs. a PWM motor driver) before buying either.
- **[WARNING - OPEN]** `compat.mounting_connectors`: Physical mounting (hole patterns, shaft/hub fit, clearances) and connector types cannot be verified from photos.
  - Next action: Measure mounting holes, shaft diameter and connector pitch before ordering; mark this issue resolved in review once checked.
- **[WARNING - OPEN]** `views.underside_missing`: No underside photo was supplied. A complete-looking top view does not establish motors, gearboxes, axles, couplers or underside fasteners.
  - Next action: Add an underside photo and rerun the analysis.

## Info (1)

- **[INFO - OPEN]** `chassis.possibly_custom` (components: `chassis-1`): The chassis may be a custom fabricated part (3D printed, laser cut or hand made). No vendor SKU is assumed for it.
  - Next action: If it is custom, set purchase_quantity to 0 and note how it is made; otherwise enter the verified kit/part number.

## Photos/measurements requested

1. **underside** - Most informative missing view: shows drive motors, gearboxes, axles, couplers and fasteners.
2. **close-up of PCB labels** - Readable silkscreen/labels are needed to identify: relay_module-1.
3. **battery / power source label** - Needed to establish chemistry, voltage and capacity.

Ready to purchase: **NO**
