# Bill of materials - mock-rover

> **MOCK DATA** - produced by the offline mock client, not by analysing the photos.

- Stage: **final**
- Images: `img1-rover-top-synthetic` (top view)
- Vision model: mock
- Ready to purchase: **NO**

Quantities shown as `unknown` are not established - unknown is not zero. Identifiers shown as `unknown` were not verified and have deliberately not been guessed.

## Confirmed/visible components

Visible in at least one photo. The part *type* is recognised; make/model is only listed when a human entered it in review.

| ID | Category | Name | Visible qty | Required qty | Purchase qty | Manufacturer | Model | SKU | Review status | Model confidence* | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `wheel-1` | wheel | rubber wheel | 4 | 4 | 4 | unknown | unknown | unknown | confirmed | 0.93 | [img1-rover-top-synthetic] Four chunky black treaded tyres, one at each corner of the frame. |
| `chassis-1` | chassis | green chassis frame | 1 | 1 | 0 | unknown | unknown | unknown | confirmed | 0.90 | [img1-rover-top-synthetic] Flat green frame/plate that everything is mounted on. |
| `breadboard-1` | breadboard | solderless breadboard | 1 | unknown | unknown | unknown | unknown | unknown | needs_review | 0.88 | [img1-rover-top-synthetic] White solderless breadboard near the centre with components plugged in. |
| `relay_module-1` | relay_module | relay module board | 1 | unknown | unknown | unknown | unknown | unknown | needs_review | 0.80 | [img1-rover-top-synthetic] Blue PCB carrying relay blocks with screw terminals, wired to the breadboard. |
| `wiring-1` | wiring | jumper wires | unknown | unknown | unknown | unknown | unknown | unknown | needs_review | 0.85 | [img1-rover-top-synthetic] Bundle of multicoloured jumper wires between breadboard and relay board; count not determinable. |

Notes:

- `chassis-1`: Reviewer: custom 3D-printed frame, nothing to buy.
- `relay_module-1`: Contains 2 x blue relay block (subcomponent seen in img1-rover-top-synthetic; not counted as a separate BOM line).

## Inferred/hidden possibilities

Plausible but **not seen and not confirmed**. Do not buy from this table.

| ID | Category | Name | Visible qty | Required qty | Purchase qty | Manufacturer | Model | SKU | Review status | Model confidence* | Rationale |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `fastener-1` | fastener | mounting screws, nuts and standoffs | unknown | unknown | unknown | unknown | unknown | unknown | needs_review | n/a | Boards and wheels must be fixed to the frame; fasteners are not visible from this view. Proposed by the inference pass; not seen in any photo, not confirmed. |

## Unknown critical details

| ID | Category | Name | Visible qty | Required qty | Purchase qty | Manufacturer | Model | SKU | Review status | Model confidence* | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `motor_driver-1` | motor_driver | motor driver / motor switching stage | unknown | unknown | unknown | unknown | unknown | unknown | needs_review | n/a | Something must switch motor current; a relay board is visible but its role is not established. Proposed by the inference pass; not seen in any photo, not confirmed. |
| `microcontroller-1` | microcontroller | controller board | unknown | unknown | unknown | unknown | unknown | unknown | needs_review | n/a | No controller board is identifiable; it may be hidden or off-frame. Proposed by the inference pass; not seen in any photo, not confirmed. |
| `motor-1` | motor | Drive motor(s) - count and type unknown | unknown | unknown | unknown | unknown | unknown | unknown | needs_review | n/a | No drive motor is visible. Wheel count does not establish motor count. Placeholder added by a deterministic completeness rule; not a confirmed part. |
| `power_supply-1` | power_supply | Power source - chemistry and voltage unknown | unknown | unknown | unknown | unknown | unknown | unknown | needs_review | n/a | No battery or power source is visible; voltage and chemistry are not established. Placeholder added by a deterministic completeness rule; not a confirmed part. |

- **[CRITICAL - OPEN]** `drivetrain.unknown` (components: `wheel-1`, `motor-1`): 4 wheel(s) are visible but no drive motor count is established. Wheels do not imply one motor each: the drivetrain layout (2WD, 4WD, skid-steer, free-rolling wheels) is unknown.
  - Next action: Photograph the underside, then confirm the motor line in review with its required_quantity and type.
- **[CRITICAL - OPEN]** `power.unknown` (components: `power_supply-1`): The power source is not identified: chemistry, voltage and capacity are unknown.
  - Next action: Photograph the battery/holder label, then confirm the power line in review and set specs.voltage_v.
- **[CRITICAL - OPEN]** `controller.unknown` (components: `microcontroller-1`): No controller board is identified; its model, logic voltage and pin count are unknown.
  - Next action: Take a close-up of the board's labels, then confirm the controller line in review.
- **[CRITICAL - OPEN]** `compat.electrical_unconfirmed` (components: `motor-1`, `motor_driver-1`, `power_supply-1`): Electrical compatibility cannot be checked. Power source, operating voltage, motor current and driver current capacity must be confirmed before purchase. Missing: supply voltage in volts of 'power_supply-1' (specs.voltage_v); rated voltage in volts of 'motor-1' (specs.voltage_v); stall/peak current in amps of 'motor-1' (specs.current_a); maximum supply voltage in volts of 'motor_driver-1' (specs.max_voltage_v); per-channel current capacity in amps of 'motor_driver-1' (specs.max_current_a).
  - Next action: Read the values from labels/datasheets and enter them as specs in review.

## Catalog candidates

Catalog lookup not configured. No store links or prices are listed.

## Compatibility checks

- **[WARNING - OPEN]** `motor_control.relay_not_driver` (components: `relay_module-1`): A relay board is visible but no motor driver. Relay boards are not interchangeable with motor drivers: relays only switch on/off (no PWM speed control) and need an H-bridge arrangement to reverse direction.
  - Next action: Check the intended motor control method (on/off relays vs. a PWM motor driver) before buying either.
- **[INFO - OPEN]** `chassis.possibly_custom` (components: `chassis-1`): The chassis may be a custom fabricated part (3D printed, laser cut or hand made). No vendor SKU is assumed for it.
  - Next action: If it is custom, set purchase_quantity to 0 and note how it is made; otherwise enter the verified kit/part number.
- **[WARNING - resolved]** `compat.mounting_connectors`: Physical mounting (hole patterns, shaft/hub fit, clearances) and connector types cannot be verified from photos.
  - Next action: Measure mounting holes, shaft diameter and connector pitch before ordering; mark this issue resolved in review once checked.
  - Note: Measured hole spacing and connector pitch by hand.
- **[WARNING - OPEN]** `views.underside_missing`: No underside photo was supplied. A complete-looking top view does not establish motors, gearboxes, axles, couplers or underside fasteners.
  - Next action: Add an underside photo and rerun the analysis.
- **[WARNING - OPEN]** `model.1`: Wire routing between the relay board and the rest of the electronics cannot be traced from the photo.
  - Next action: Sketch or photograph the wiring so each relay terminal's load is known.

(4 open critical check(s) are listed under *Unknown critical details*.)

## Photos/measurements requested

1. **underside** - Most informative missing view: shows drive motors, gearboxes, axles, couplers and fasteners.
2. **close-up of PCB labels** - Readable silkscreen/labels are needed to identify: relay_module-1.
3. **battery / power source label** - Needed to establish chemistry, voltage and capacity.

## Purchase readiness

**NOT ready to purchase.** This BOM is incomplete and must not be used as an order list.

Blocking reasons:

- 4 unresolved critical issue(s): drivetrain.unknown, power.unknown, controller.unknown, compat.electrical_unconfirmed
- Not yet reviewed by a human: breadboard-1, relay_module-1, wiring-1, motor_driver-1, microcontroller-1, fastener-1, motor-1, power_supply-1
- Exact part number (sku) unknown for items to be purchased: wheel-1

## Rejected in review

- `led-1` LED

---
\* Model confidence is the vision model's own estimate. It is **not a calibrated probability** and is separate from the human review status.
