# Robot BOM

## Visible parts

- off-road rubber wheel/tire (black, chevron tread): 4 (source IDs: ['W001', 'W002', 'W003', 'W004', 'D001', 'D002', 'D003', 'D006', 'D007', 'D012', 'D013', 'D014'])
- green tubular frame / roll-cage chassis: 1 (source IDs: ['C001', 'D008'])
- black rectangular battery/power enclosure: 1 (source IDs: ['P001', 'D004', 'D005'])
- solderless breadboard: 1 (source IDs: ['B001'])
- blue PCB module (likely single-channel relay, Songle-style): 2 (source IDs: ['M001', 'M002', 'D009', 'D010', 'D011'])
- gray rectangular block (function unknown): 1 (source IDs: ['O001'])
- multicolored jumper wire harness: 1 (source IDs: ['WIR001'])
- silver duct tape: 1 (source IDs: ['T001'])

## Inferred / unknown

- drive motor(s) — Four wheels imply drive, but no motor cans, gearboxes, or hub motors are visible; axles/hubs hidden. Motor count and ratings unknown and not inferred.
- steering servo / steering linkage — No servo horn, tie rods, or steering knuckles visible; front wheels may be fixed or steered by a hidden mechanism.
- motor driver / ESC — Blue modules may be relays, but no motor leads or ESC are clearly visible; the link between control electronics and any drive motors is not shown.
- axles / wheel hubs — Wheel mounting hardware is obscured by tires and the green frame.
- battery cells inside enclosure — Black enclosure is sealed; cell count, chemistry, voltage, and capacity are not visible.
- main controller / receiver (MCU) — Breadboard carries components and LEDs but no clearly identifiable microcontroller or receiver board driving the modules is visible.
- power switch — No obvious switch is visible in the wiring; power control method is unknown.

## Checks

- Unknown source ID: drive motor(s)
- Unknown source ID: steering servo / steering linkage
- Unknown source ID: motor driver / ESC
- Unknown source ID: axles / wheel hubs
- Unknown source ID: battery cells inside enclosure
- Unknown source ID: main controller / receiver (MCU)
- Unknown source ID: power switch
- Exact functions, manufacturers, and SKUs of the blue PCB modules are not legible; they may be relay/driver/controller boards but this is not confirmed.
- Individual wire endpoints are obscured by tape, the breadboard, and overlapping modules.
- Wheel hubs, axles, and any motors are mostly hidden; no motor specifications, quantities, or ratings are inferred.
- Contents of the black top enclosure are not visible, so battery count, chemistry, and capacity are unknown.
- The gray rectangular block could be a heatsink, shield, or enclosure; its purpose is uncertain.
- The silver tape appears to be holding the front/right assembly, but the exact secured part is not fully visible.
- Are there drive motors inside the wheel hubs or mounted to the chassis, and how many are there?
- What is the exact function of the gray rectangular block (O001) beneath the breadboard?
- Are the two blue PCB modules relay modules, motor drivers, or controllers, and what are their exact pin connections?
- Is there a steering servo or linkage hidden under the duct tape or frame, and are the front wheels steerable?
- What is the voltage, chemistry, and capacity of the battery pack inside the black enclosure P001?
- Which component acts as the main controller driving the blue modules?
- What exactly is being secured by the silver duct tape on the right/front section?
- Do the relay modules switch motor power directly, or do they drive another hidden stage?