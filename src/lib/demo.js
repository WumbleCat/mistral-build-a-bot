/**
 * Demo backend.
 *
 * Lets the whole frontend be built and demoed with no Supabase project, no Mistral key and no
 * edge functions deployed. It mirrors the surface of `api.js` and fakes the timing of the real
 * pipeline, so every loading, empty, error and success state is reachable while styling.
 *
 * On by default whenever Supabase credentials are missing, and forceable with
 * VITE_DEMO_MODE=true even once the backend exists -- handy for working offline.
 *
 * State lives in memory only: uploads disappear on reload and the seeded sample comes back.
 */
import { isSupabaseConfigured } from './supabase'
import { titleFromFilename } from './format'

export const DEMO = import.meta.env.VITE_DEMO_MODE === 'true' || !isSupabaseConfigured

export const DEMO_USER = {
  id: '00000000-0000-4000-8000-000000000001',
  email: null,
  is_anonymous: true,
}

/* --------------------------------------------------------------- placeholder */

const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
  <rect width="400" height="300" fill="#12151c"/>
  <g stroke="#39414f" stroke-width="1">
    ${Array.from({ length: 9 }, (_, i) => `<path d="M0 ${i * 36} H400"/>`).join('')}
    ${Array.from({ length: 12 }, (_, i) => `<path d="M${i * 36} 0 V300"/>`).join('')}
  </g>
  <rect x="60" y="235" width="280" height="14" rx="4" fill="#242a36"/>
  <rect x="150" y="150" width="100" height="90" rx="10" fill="#1b202b" stroke="#39414f" stroke-width="2"/>
  <rect x="168" y="96" width="64" height="56" rx="12" fill="#232a38" stroke="#f97316" stroke-width="2"/>
  <circle cx="186" cy="122" r="7" fill="#ff9d3d"/>
  <circle cx="214" cy="122" r="7" fill="#ff9d3d"/>
  <path d="M200 96 V76" stroke="#f97316" stroke-width="3"/>
  <circle cx="200" cy="70" r="6" fill="#45d9a4"/>
  <path d="M150 170 H108 V210" stroke="#7c8697" stroke-width="7" fill="none" stroke-linecap="round"/>
  <path d="M250 170 H292 V210" stroke="#7c8697" stroke-width="7" fill="none" stroke-linecap="round"/>
  <circle cx="108" cy="218" r="13" fill="#242a36" stroke="#58a6ff" stroke-width="2"/>
  <circle cx="292" cy="218" r="13" fill="#242a36" stroke="#58a6ff" stroke-width="2"/>
  <rect x="166" y="186" width="68" height="10" rx="3" fill="#f97316" opacity="0.5"/>
</svg>`

const SAMPLE_IMAGE = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SAMPLE_SVG)}`

/* --------------------------------------------------------------- seeded data */

let seq = 0
const nextId = (prefix) => `${prefix}-${++seq}`

function component(sort_order, name, category, quantity, usd, description, extra = {}) {
  return {
    id: nextId('cmp'),
    name,
    category,
    description,
    quantity,
    unit_price_cents: usd === null ? null : Math.round(usd * 100),
    currency: 'USD',
    specs: extra.specs ?? {},
    search_query: extra.search_query ?? name,
    substitutes: extra.substitutes ?? [],
    is_optional: extra.is_optional ?? false,
    sort_order,
    geometry: null,
    component_links: extra.links ?? [],
  }
}

/**
 * Rough primitives for the sample robot, indexed by sort_order -- the same shape the
 * analyzer is asked to return. No positions: buildLayout places each layer from the
 * assembly step that installs it.
 */
const SAMPLE_GEOMETRY = [
  { shape: 'box', size_mm: { x: 70, y: 22, z: 19 }, finish: 'plastic' },            // TT gearmotor
  { shape: 'cylinder', size_mm: { d: 65, h: 26 }, rotation_deg: { x: 0, y: 0, z: 90 }, finish: 'rubber' },
  { shape: 'plate', size_mm: { x: 45, y: 2, z: 18 }, finish: 'pcb' },               // Nano ESP32
  { shape: 'plate', size_mm: { x: 28, y: 2, z: 20 }, finish: 'pcb' },               // TB6612FNG
  { shape: 'plate', size_mm: { x: 76, y: 2, z: 13 }, finish: 'pcb' },               // QTR-8A
  { shape: 'box', size_mm: { x: 45, y: 20, z: 15 }, finish: 'pcb' },                // HC-SR04
  { shape: 'plate', size_mm: { x: 150, y: 3, z: 100 }, finish: 'acrylic' },         // chassis
  { shape: 'box', size_mm: { x: 78, y: 21, z: 40 }, finish: 'plastic' },            // cell holder
  { shape: 'cylinder', size_mm: { d: 18, h: 65 }, rotation_deg: { x: 0, y: 0, z: 90 }, finish: 'metal' },
  { shape: 'plate', size_mm: { x: 22, y: 3, z: 17 }, finish: 'pcb' },               // buck
  { shape: 'sphere', size_mm: { d: 16 }, finish: 'steel' },                         // ball caster
  { shape: 'cylinder', size_mm: { d: 6, h: 12 }, finish: 'plastic' },               // standoffs
  { shape: 'tube', size_mm: { d: 6, h: 70, inner: 4 }, rotation_deg: { x: 0, y: 0, z: 90 }, finish: 'copper' },
  { shape: 'box', size_mm: { x: 14, y: 7, z: 8 }, finish: 'plastic' },              // JST
  { shape: 'plate', size_mm: { x: 27, y: 2, z: 27 }, finish: 'pcb' },               // OLED
]

function step(step_number, title, instructions, extra = {}) {
  return {
    id: nextId('stp'),
    step_number,
    title,
    instructions,
    component_names: extra.component_names ?? [],
    tools: extra.tools ?? [],
    tips: extra.tips ?? null,
    warning: extra.warning ?? null,
    duration_minutes: extra.duration_minutes ?? null,
    video_prompt: extra.video_prompt ?? null,
  }
}

function sampleComponents() {
  const parts = [
    component(0, 'TT gearmotor, 1:120 (pair)', 'actuator', 2, 4.5,
      'Drives each wheel. 1:120 keeps the robot slow enough to track a line reliably.',
      { specs: { ratio: '1:120', voltage: '3-6V' }, search_query: 'TT gearmotor 1:120 dual shaft',
        substitutes: ['N20 gearmotor 1:100'],
        links: [{ retailer: 'pololu', retailer_label: 'Pololu', url: 'https://www.pololu.com/product/3062', price_cents: 495 }] }),
    component(1, 'TT motor wheel, 65mm', 'wheel', 2, 2.2, 'Press-fits onto the gearmotor D-shaft.',
      { specs: { diameter: '65mm' }, search_query: 'TT motor wheel 65mm' }),
    component(2, 'Arduino Nano ESP32', 'controller', 1, 21.0,
      'Reads the sensor array and drives the motor driver. Wi-Fi lets you tune the PID over the air.',
      { specs: { mcu: 'ESP32-S3', logic: '3.3V' }, search_query: 'Arduino Nano ESP32',
        substitutes: ['Arduino Nano Every', 'Raspberry Pi Pico'],
        links: [{ retailer: 'rs', retailer_label: 'RS', url: 'https://uk.rs-online.com/web/p/arduino/2548252', price_cents: 2099 }] }),
    component(3, 'TB6612FNG motor driver breakout', 'motor-driver', 1, 6.8,
      'Dual H-bridge. More efficient than an L298N and runs cool at this current.',
      { specs: { channels: '2', current: '1.2A continuous' }, search_query: 'TB6612FNG motor driver breakout' }),
    component(4, 'QTR-8A reflectance sensor array', 'sensor', 1, 12.5,
      'Eight IR reflectance pairs. The analogue version gives you sub-sensor resolution for PID.',
      { specs: { channels: '8', pitch: '9.5mm' }, search_query: 'QTR-8A reflectance sensor array' }),
    component(5, 'HC-SR04 ultrasonic sensor', 'sensor', 1, 3.2,
      'Stops the robot before it hits an obstacle on the line.',
      { specs: { range: '2-400cm' }, search_query: 'HC-SR04 ultrasonic sensor' }),
    component(6, 'Acrylic chassis plate, 150x100mm, 3mm', 'chassis', 1, 7.0,
      'Everything bolts to this. Laser-cut or hand-drilled.',
      { specs: { thickness: '3mm' }, search_query: 'acrylic chassis plate 150x100 3mm robot' }),
    component(7, '18650 battery holder, 2-cell', 'power', 1, 2.8,
      'Series pair gives roughly 7.4V for the motor rail.',
      { search_query: '18650 battery holder 2 cell series' }),
    component(8, '18650 Li-ion cell, 3000mAh', 'power', 2, 6.5,
      'Protected cells. Budget about 90 minutes of run time.',
      { specs: { capacity: '3000mAh', nominal: '3.7V' }, search_query: '18650 protected cell 3000mAh' }),
    component(9, 'MP1584EN buck converter', 'power', 1, 2.1,
      'Drops the pack to a clean 5V for the controller and sensors.',
      { specs: { output: '5V 3A' }, search_query: 'MP1584EN buck converter module' }),
    component(10, 'Ball caster, 3/8in', 'hardware', 1, 2.4, 'Third contact point at the front.',
      { search_query: 'ball caster 3/8 inch robot' }),
    component(11, 'M3 nylon standoff and screw kit', 'fastener', 1, 8.0,
      'Mounts the boards clear of the chassis. Nylon avoids shorting pads.',
      { search_query: 'M3 nylon standoff screw assortment kit' }),
    component(12, 'Silicone hookup wire, 26AWG, 6 colours', 'wiring', 1, 9.5,
      'Silicone insulation survives a soldering iron brushing past it.',
      { specs: { gauge: '26AWG' }, search_query: 'silicone hookup wire 26AWG kit' }),
    component(13, 'JST-XH connector kit', 'wiring', 1, null,
      'Makes the motor and battery leads removable. Nice to have, not required.',
      { is_optional: true, search_query: 'JST XH connector kit crimp' }),
    component(14, 'SSD1306 OLED, 0.96in I2C', 'electronics', 1, 5.5,
      'Shows the PID error live, which makes tuning far less painful.',
      { is_optional: true, specs: { interface: 'I2C', resolution: '128x64' },
        search_query: 'SSD1306 0.96 inch I2C OLED' }),
  ]
  return parts.map((c, i) => ({ ...c, geometry: SAMPLE_GEOMETRY[i] ?? null }))
}

function sampleSteps() {
  return [
    step(1, 'Lay out and drill the chassis',
      'Mark the motor bracket holes, the caster hole and the board standoff positions on the acrylic plate. Drill at 3.2mm for M3 clearance. Deburr both faces so the standoffs sit flat.',
      { component_names: ['Acrylic chassis plate, 150x100mm, 3mm'], tools: ['drill', '3.2mm bit', 'deburring tool'],
        duration_minutes: 25, tips: 'Drill acrylic slowly and back it with scrap wood or it will chip.',
        video_prompt: 'Fixed overhead camera on a clean workbench: a marked acrylic plate being drilled, chips clearing away.' }),
    step(2, 'Mount the gearmotors and wheels',
      'Bolt both TT gearmotors to the underside of the plate with their brackets, shafts pointing outward and parallel. Press a 65mm wheel onto each D-shaft until it seats fully.',
      { component_names: ['TT gearmotor, 1:120 (pair)', 'TT motor wheel, 65mm'], tools: ['2mm hex key', 'M3 driver'],
        duration_minutes: 20, tips: 'Sight down the axles before final torque; a degree of toe-in makes the robot drift.',
        video_prompt: 'Close shot of two yellow gearmotors bolting to an acrylic plate, wheels pressing onto the shafts.' }),
    step(3, 'Fit the ball caster',
      'Screw the ball caster to the front underside so the chassis sits level on the bench. Add washers under it if the plate tilts back.',
      { component_names: ['Ball caster, 3/8in'], tools: ['M3 driver'], duration_minutes: 10,
        video_prompt: 'Low angle: a ball caster screwed to the front of a robot chassis, chassis settling level.' }),
    step(4, 'Build the power rail',
      'Wire the two 18650 cells in series through the holder. Feed the pack into the buck converter input and set its output to 5.0V with a multimeter before anything else is connected.',
      { component_names: ['18650 battery holder, 2-cell', '18650 Li-ion cell, 3000mAh', 'MP1584EN buck converter'],
        tools: ['soldering iron', 'multimeter', 'small screwdriver'], duration_minutes: 30,
        warning: 'Set the buck output with no load attached. Feeding 7.4V into a 5V board will destroy it instantly.',
        video_prompt: 'Macro shot of a buck converter trimmer being turned while a multimeter display settles on 5.00V.' }),
    step(5, 'Mount the controller and motor driver',
      'Stand the Arduino Nano ESP32 and the TB6612FNG board off the top plate on M3 nylon standoffs. Leave the USB port reachable from the rear edge.',
      { component_names: ['Arduino Nano ESP32', 'TB6612FNG motor driver breakout', 'M3 nylon standoff and screw kit'],
        tools: ['M3 driver'], duration_minutes: 15,
        tips: 'Keep the driver near the motors and the controller near the sensor to shorten the noisy runs.',
        video_prompt: 'Overhead: two small PCBs lowering onto nylon standoffs on an acrylic robot chassis.' }),
    step(6, 'Wire motors to the driver',
      'Solder each motor pair to the driver outputs, then run the driver inputs to the controller PWM pins. Bring the motor rail straight from the pack, not from the 5V line.',
      { component_names: ['TB6612FNG motor driver breakout', 'Silicone hookup wire, 26AWG, 6 colours'],
        tools: ['soldering iron', 'wire strippers'], duration_minutes: 35,
        warning: 'Disconnect the battery before soldering anything on the powered side.',
        video_prompt: 'Close shot of coloured silicone wires being soldered to a motor driver breakout, solder flowing.' }),
    step(7, 'Fit the sensor array',
      'Bracket the QTR-8A across the front underside, 3mm above the floor and square to the direction of travel. Run its eight analogue lines back to the controller.',
      { component_names: ['QTR-8A reflectance sensor array'], tools: ['M3 driver', 'ruler'], duration_minutes: 25,
        tips: 'Sensor height matters more than anything else here. Too high and the line blurs; too low and it saturates.',
        video_prompt: 'Low front angle: a reflectance sensor bar being set a few millimetres above a white surface with a black line.' }),
    step(8, 'Add the ultrasonic sensor',
      'Mount the HC-SR04 facing forward at the front edge, clear of the sensor bar, and wire its trigger and echo pins to two free digital pins.',
      { component_names: ['HC-SR04 ultrasonic sensor'], tools: ['M3 driver'], duration_minutes: 15,
        video_prompt: 'Front view: a two-eyed ultrasonic sensor clipping onto the front of a small robot.' }),
    step(9, 'Flash the firmware and tune',
      'Upload the line-following sketch, calibrate the sensor array over the line and the background, then raise the proportional gain until the robot tracks without weaving.',
      { component_names: ['Arduino Nano ESP32'], tools: ['USB-C cable', 'laptop'], duration_minutes: 45,
        tips: 'Tune P first with I and D at zero. Add D only once it tracks but overshoots corners.',
        video_prompt: 'A small two-wheeled robot following a black line on white board, correcting smoothly through a curve.' }),
    step(10, 'Tidy the loom and run it',
      'Loom the wiring with the JST connectors or small zip ties so nothing reaches the wheels, drop the cells in, and run the robot over the full course.',
      { component_names: ['JST-XH connector kit', 'Silicone hookup wire, 26AWG, 6 colours'],
        tools: ['side cutters'], duration_minutes: 20,
        video_prompt: 'Time-lapse: loose wires gathered into a tidy loom, then the finished robot completing a line course.' }),
  ]
}

function seedProject() {
  const components = sampleComponents()
  const steps = sampleSteps()

  return {
    id: 'demo-line-follower',
    user_id: DEMO_USER.id,
    title: 'Line-following robot',
    notes: null,
    image_path: 'demo://sample',
    status: 'ready',
    error: null,
    device_name: 'Two-wheel line-following robot',
    device_summary:
      'A differential-drive rover that tracks a black line on a light floor using an eight-channel ' +
      'reflectance array, with an ultrasonic sensor to stop for obstacles. A classic first build: ' +
      'every subsystem is small enough to debug on its own.',
    device_category: 'mobile robot',
    difficulty: 'beginner',
    est_build_minutes: 240,
    skills: ['soldering', 'basic wiring', 'Arduino programming'],
    tools: ['soldering iron', 'multimeter', 'drill', 'M3 driver', 'wire strippers', 'side cutters'],
    total_cost_cents: totalOf(components),
    component_count: components.reduce((s, c) => s + c.quantity, 0),
    currency: 'USD',
    confidence: 0.82,
    analysis: {
      visible_features: [
        'Two yellow TT-style gearmotors with 65mm wheels on a single flat plate',
        'A sensor bar spanning the front edge, close to the floor',
        'An ultrasonic transducer pair above the sensor bar',
        'A small microcontroller board and a second driver board on standoffs',
        'An 18650 pack strapped under the plate',
      ],
      assumptions: [
        'Gear ratio read as roughly 1:120 from the wheel speed in frame, not from a marking',
        'Controller identified by board outline; the exact model may differ',
        'Cell capacity is not visible and is assumed to be 3000mAh',
        'The sensor array is assumed to be the analogue QTR-8A rather than the digital QTR-8RC',
      ],
    },
    model: 'pixtral-large-latest',
    created_at: new Date(Date.now() - 1000 * 60 * 42).toISOString(),
    updated_at: new Date(Date.now() - 1000 * 60 * 40).toISOString(),
    components,
    assembly_steps: steps,
    videos: [
      {
        id: nextId('vid'),
        project_id: 'demo-line-follower',
        step_id: steps[0].id,
        kind: 'step',
        status: 'ready',
        provider: 'mock',
        prompt: steps[0].video_prompt,
        video_url: null,
        thumbnail_url: null,
        error: null,
      },
      {
        id: nextId('vid'),
        project_id: 'demo-line-follower',
        step_id: steps[3].id,
        kind: 'step',
        status: 'failed',
        provider: 'mock',
        prompt: steps[3].video_prompt,
        video_url: null,
        thumbnail_url: null,
        error: 'Provider returned 429: rate limit reached. Try again in a minute.',
      },
    ],
    _imageUrl: SAMPLE_IMAGE,
  }
}

const totalOf = (components) =>
  components.reduce((sum, c) => sum + (c.unit_price_cents ?? 0) * c.quantity, 0)

/* ------------------------------------------ second sample: pure electronics */
const PB_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
  <rect width="400" height="300" fill="#12151c"/>
  <g stroke="#39414f" stroke-width="1">
    ${Array.from({ length: 9 }, (_, i) => `<path d="M0 ${i * 36} H400"/>`).join('')}
    ${Array.from({ length: 12 }, (_, i) => `<path d="M${i * 36} 0 V300"/>`).join('')}
  </g>
  <rect x="96" y="104" width="208" height="104" rx="14" fill="#232a38" stroke="#7c8697" stroke-width="2"/>
  <rect x="96" y="104" width="208" height="30" rx="14" fill="#2b3444"/>
  <rect x="118" y="150" width="86" height="34" rx="5" fill="#0d0f14" stroke="#45d9a4" stroke-width="1.5"/>
  <rect x="126" y="160" width="46" height="14" rx="2" fill="#45d9a4" opacity="0.85"/>
  <rect x="176" y="160" width="20" height="14" rx="2" fill="#39414f"/>
  <rect x="232" y="158" width="26" height="11" rx="5.5" fill="#0d0f14" stroke="#f97316" stroke-width="1.5"/>
  <rect x="266" y="157" width="22" height="13" rx="2" fill="#0d0f14" stroke="#58a6ff" stroke-width="1.5"/>
  <circle cx="245" cy="190" r="6" fill="#39414f" stroke="#7c8697" stroke-width="1.5"/>
  <g opacity="0.6">
    <rect x="118" y="196" width="164" height="4" rx="2" fill="#39414f"/>
  </g>
</svg>`

const PB_IMAGE = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(PB_SVG)}`


const PB_GEOMETRY = [
  { shape: 'box', size_mm: { x: 145, y: 26, z: 72 }, finish: 'enclosure' },
  { shape: 'cylinder', size_mm: { d: 18, h: 65 }, rotation_deg: { x: 0, y: 0, z: 90 }, finish: 'metal' },
  { shape: 'plate', size_mm: { x: 130, y: 1, z: 58 }, finish: 'steel' },
  { shape: 'plate', size_mm: { x: 62, y: 1.6, z: 34 }, finish: 'pcb' },
  { shape: 'plate', size_mm: { x: 48, y: 1.6, z: 28 }, finish: 'pcb' },
  { shape: 'box', size_mm: { x: 9, y: 3.2, z: 7.5 }, finish: 'connector' },
  { shape: 'box', size_mm: { x: 14, y: 6.5, z: 13 }, finish: 'connector' },
  { shape: 'plate', size_mm: { x: 27, y: 2, z: 27 }, finish: 'display' },
  { shape: 'box', size_mm: { x: 11, y: 7, z: 11 }, finish: 'metal' },
  { shape: 'box', size_mm: { x: 6, y: 4, z: 6 }, finish: 'switch' },
  { shape: 'plate', size_mm: { x: 130, y: 0.5, z: 58 }, finish: 'plastic' },
]

function powerBankComponents() {
  const parts = [
    component(0, 'Aluminium enclosure, 145x72x26mm', 'enclosure', 1, 14.0,
      'Extruded shell with end caps. Doubles as the heatsink for the converter.',
      { search_query: 'aluminium extruded enclosure 145x72x26 power bank' }),
    component(1, '18650 Li-ion cell, 3350mAh', 'battery', 6, 6.2,
      'Six cells in 2S3P gives roughly 20,000 mAh at 7.4V nominal.',
      { specs: { capacity: '3350mAh', chemistry: 'Li-ion' },
        search_query: '18650 3350mAh Li-ion cell', substitutes: ['21700 4000mAh cell'] }),
    component(2, 'Nickel strip, 0.15x8mm', 'hardware', 1, 7.5,
      'Spot-welded between cells. Never soldered directly to a cell can.',
      { search_query: 'pure nickel strip 0.15x8mm battery spot welding' }),
    component(3, '2S BMS protection board, 15A', 'pcb', 1, 4.8,
      'Over-charge, over-discharge and short protection, with cell balancing.',
      { specs: { cells: '2S', current: '15A' },
        search_query: '2S BMS 15A balancing protection board' }),
    component(4, 'IP5389 power bank SoC module', 'controller', 1, 9.4,
      'Bidirectional buck-boost with USB-C PD 3.0 negotiation and fuel gauging.',
      { specs: { output: '65W', protocol: 'PD 3.0 / QC 4+' },
        search_query: 'IP5389 power bank module PD 65W',
        links: [{ retailer: 'lcsc', retailer_label: 'LCSC',
                  url: 'https://www.lcsc.com/search?q=IP5389', price_usd: 9.1 }] }),
    component(5, 'USB-C 16-pin receptacle, SMD', 'connector', 1, 0.45,
      'Full 16-pin part, so the CC lines needed for PD are actually broken out.',
      { specs: { pins: '16', rating: '5A' },
        search_query: 'USB-C receptacle 16 pin SMD power delivery' }),
    component(6, 'USB-A receptacle, through-hole', 'connector', 2, 0.35,
      'Legacy outputs for anything that will not take USB-C.',
      { search_query: 'USB-A type A receptacle through hole' }),
    component(7, 'SSD1306 OLED, 0.96in I2C', 'display', 1, 5.5,
      'Shows pack voltage, charge percentage and output wattage.',
      { specs: { interface: 'I2C', resolution: '128x64' },
        search_query: 'SSD1306 0.96 inch I2C OLED' }),
    component(8, 'Power inductor, 2.2uH 12A shielded', 'electronics', 1, 1.1,
      'The buck-boost stage will not reach its rated output on an undersized part.',
      { specs: { inductance: '2.2uH', saturation: '12A' },
        search_query: 'shielded power inductor 2.2uH 12A' }),
    component(9, 'Tactile side button, 6x6mm', 'switch', 1, null,
      'Wakes the display and starts a charge cycle.',
      { is_optional: true, search_query: 'tactile switch 6x6mm side actuated' }),
    component(10, 'Fish paper insulation sheet', 'hardware', 1, 2.4,
      'Between the pack and the boards. Non-negotiable with lithium cells.',
      { search_query: 'fish paper insulation sheet lithium battery' }),
  ]
  return parts.map((c, i) => ({ ...c, geometry: PB_GEOMETRY[i] ?? null }))
}

function powerBankSteps() {
  return [
    step(1, 'Match and group the cells',
      'Measure the resting voltage of all six cells and group them so each parallel bank is within 0.02V of the others. Mismatched cells make the pack balance badly for its whole life.',
      { component_names: ['18650 Li-ion cell, 3350mAh'], tools: ['multimeter'], duration_minutes: 20,
        video_prompt: 'Overhead macro on a workbench: six 18650 cells in a row, a multimeter probe touching each terminal in turn.' }),
    step(2, 'Spot-weld the 2S3P pack',
      'Weld nickel strip across each bank of three cells, then link the two banks in series. Keep the balance tap accessible at the join.',
      { component_names: ['18650 Li-ion cell, 3350mAh', 'Nickel strip, 0.15x8mm'],
        tools: ['spot welder'], duration_minutes: 35,
        warning: 'Never solder directly onto a cell can. The heat damages the cell and can start a fire.',
        video_prompt: 'Close shot of a spot welder pressing nickel strip onto 18650 cells, small bright flashes at each weld.' }),
    step(3, 'Fit the protection board',
      'Solder B-, B+ and the balance tap to the BMS, then insulate the pack face with fish paper before anything else goes in.',
      { component_names: ['2S BMS protection board, 15A', 'Fish paper insulation sheet'],
        tools: ['soldering iron'], duration_minutes: 25,
        tips: 'Check for 7.4V at the BMS output before continuing.',
        video_prompt: 'A small protection PCB soldered to a battery pack, then an insulation sheet laid over it.' }),
    step(4, 'Populate the converter board',
      'Reflow the IP5389 module, the 2.2uH inductor and the USB-C receptacle. The inductor and the SoC share the ground pour that carries their heat away.',
      { component_names: ['IP5389 power bank SoC module', 'Power inductor, 2.2uH 12A shielded', 'USB-C 16-pin receptacle, SMD'],
        tools: ['hot air station', 'solder paste', 'tweezers'], duration_minutes: 40,
        video_prompt: 'Macro: solder paste reflowing under a USB-C connector and a shielded inductor on a green PCB.' }),
    step(5, 'Add the outputs and the display',
      'Fit both USB-A receptacles, then run I2C to the OLED and seat it behind the window in the end cap.',
      { component_names: ['USB-A receptacle, through-hole', 'SSD1306 OLED, 0.96in I2C'],
        tools: ['soldering iron'], duration_minutes: 25,
        video_prompt: 'Two USB-A ports soldered into a board, then a small OLED module clipping in beside them.' }),
    step(6, 'Wire the button and bench test',
      'Solder the tactile switch to the wake line, connect the pack to the converter, and power it up on the bench before the shell goes on.',
      { component_names: ['Tactile side button, 6x6mm'], tools: ['soldering iron', 'multimeter'],
        duration_minutes: 20,
        tips: 'Confirm the display reads the right pack voltage before you close anything up.',
        video_prompt: 'A finger pressing a side button, a small OLED lighting up with a battery percentage.' }),
    step(7, 'Close the enclosure',
      'Slide the stack into the extrusion on its insulation sheet, fit both end caps and screw them down. Check that nothing is pinched.',
      { component_names: ['Aluminium enclosure, 145x72x26mm', 'Fish paper insulation sheet'],
        tools: ['M2 driver'], duration_minutes: 15,
        video_prompt: 'An assembled board-and-cell stack sliding into an aluminium extrusion, end caps screwing on.' }),
  ]
}

function seedPowerBank() {
  const components = powerBankComponents()
  const steps = powerBankSteps()

  return {
    id: 'demo-power-bank',
    user_id: DEMO_USER.id,
    title: 'Power bank teardown',
    notes: null,
    image_path: 'demo://demo-power-bank',
    status: 'ready',
    error: null,
    device_name: 'USB-C 20,000 mAh power bank',
    device_summary:
      'A 2S3P lithium pack behind a bidirectional buck-boost converter that negotiates USB-C ' +
      'Power Delivery up to 65W. The interesting engineering is thermal: the converter and the ' +
      'cells share one aluminium extrusion as a heatsink.',
    device_category: 'power bank',
    difficulty: 'advanced',
    est_build_minutes: 180,
    skills: ['SMD soldering', 'spot welding', 'lithium safety'],
    tools: ['hot air station', 'soldering iron', 'spot welder', 'multimeter', 'M2 driver'],
    total_cost_cents: totalOf(components),
    component_count: components.reduce((s, c) => s + c.quantity, 0),
    currency: 'USD',
    confidence: 0.74,
    analysis: {
      visible_features: [
        'Extruded aluminium shell with removable end caps',
        'Six cylindrical cells visible through the opened case',
        'A converter board carrying one large shielded inductor',
        'USB-C and two USB-A receptacles on one end cap',
        'A small monochrome display beside the ports',
      ],
      assumptions: [
        'Cell capacity read from the stated 20,000 mAh rating, not from a cell marking',
        'The converter SoC is inferred from the board layout and port set; it may be another part',
        'Pack configuration assumed 2S3P from the cell count and the PD output',
        'Nickel strip thickness is not visible and is assumed from the current rating',
      ],
    },
    model: 'pixtral-large-latest',
    created_at: new Date(Date.now() - 1000 * 60 * 9).toISOString(),
    updated_at: new Date(Date.now() - 1000 * 60 * 8).toISOString(),
    components,
    assembly_steps: steps,
    videos: [],
    _imageUrl: PB_IMAGE,
  }
}

/* -------------------------------------------------------------------- store */

const projects = new Map()
const listeners = new Map()

projects.set('demo-line-follower', seedProject())
projects.set('demo-power-bank', seedPowerBank())

function notify(projectId) {
  for (const fn of listeners.get(projectId) ?? []) fn()
}

function patch(projectId, changes) {
  const project = projects.get(projectId)
  if (!project) return
  Object.assign(project, changes, { updated_at: new Date().toISOString() })
  notify(projectId)
}

const clone = (value) => JSON.parse(JSON.stringify(value))

/**
 * Mimics the real pipeline's timing so every intermediate state is visible.
 *
 * It cannot look at the uploaded photo -- there is no vision model without a backend --
 * so it replays one of the canned samples, alternating between them so it is obvious
 * the result is not derived from the image. Projects are flagged `is_demo_sample` and
 * the project page says so.
 */
let sampleTurn = 0

function runFakeAnalysis(projectId) {
  const seed = sampleTurn++ % 2 === 0 ? seedProject() : seedPowerBank()

  const schedule = [
    [900, () => patch(projectId, { status: 'analyzing' })],
    [3200, () => {
      patch(projectId, {
        components: seed.components,
        component_count: seed.components.reduce((s, c) => s + c.quantity, 0),
        device_name: seed.device_name,
        device_category: seed.device_category,
      })
    }],
    [6000, () => patch(projectId, { assembly_steps: seed.assembly_steps })],
    [7600, () => {
      patch(projectId, {
        status: 'ready',
        device_summary: seed.device_summary,
        difficulty: seed.difficulty,
        est_build_minutes: seed.est_build_minutes,
        skills: seed.skills,
        tools: seed.tools,
        confidence: seed.confidence,
        analysis: seed.analysis,
        model: seed.model,
        total_cost_cents: seed.total_cost_cents,
      })
    }],
  ]

  for (const [delay, fn] of schedule) setTimeout(fn, delay)
}

/* ---------------------------------------------------------------- api shims */

export const demoApi = {
  async createProject({ file, title, notes }) {
    const id = nextId('proj')
    projects.set(id, {
      id,
      user_id: DEMO_USER.id,
      title: title?.trim() || titleFromFilename(file?.name ?? ''),
      notes: notes?.trim() || null,
      image_path: `demo://${id}`,
      status: 'queued',
      error: null,
      device_name: null,
      device_summary: null,
      device_category: null,
      difficulty: null,
      est_build_minutes: null,
      skills: [],
      tools: [],
      total_cost_cents: null,
      component_count: 0,
      currency: 'USD',
      confidence: null,
      analysis: null,
      model: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      is_demo_sample: true,
      components: [],
      assembly_steps: [],
      videos: [],
      // Object URL so the upload the user just picked is the one they see.
      _imageUrl: file ? URL.createObjectURL(file) : SAMPLE_IMAGE,
    })

    runFakeAnalysis(id)
    return clone({ ...projects.get(id), _imageUrl: undefined })
  },

  async listProjects() {
    return [...projects.values()]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .map((p) => ({
        id: p.id,
        title: p.title,
        status: p.status,
        device_name: p.device_name,
        image_path: p.image_path,
        total_cost_cents: p.total_cost_cents,
        currency: p.currency,
        component_count: p.component_count,
        created_at: p.created_at,
      }))
  },

  async getProject(id) {
    const project = projects.get(id)
    if (!project) throw new Error('That build does not exist in demo mode.')

    const copy = clone({ ...project, _imageUrl: undefined })
    copy.components = (copy.components ?? []).sort((a, b) => a.sort_order - b.sort_order)
    copy.assembly_steps = (copy.assembly_steps ?? []).sort((a, b) => a.step_number - b.step_number)
    return copy
  },

  async deleteProject(id) {
    projects.delete(id)
    listeners.delete(id)
  },

  async retryAnalysis(id) {
    patch(id, { status: 'queued', error: null, components: [], assembly_steps: [], component_count: 0 })
    runFakeAnalysis(id)
  },

  subscribeToProject(projectId, onChange) {
    if (!listeners.has(projectId)) listeners.set(projectId, new Set())
    listeners.get(projectId).add(onChange)
    return () => listeners.get(projectId)?.delete(onChange)
  },

  async signedImageUrl(path) {
    if (!path?.startsWith('demo://')) return null
    const id = path.slice('demo://'.length)
    return projects.get(id)?._imageUrl ?? SAMPLE_IMAGE
  },

  async requestVideo({ projectId, stepId, kind }) {
    const project = projects.get(projectId)
    if (!project) throw new Error('Unknown build')

    const step = (project.assembly_steps ?? []).find((s) => s.id === stepId)
    const prompt =
      kind === 'walkthrough'
        ? `Continuous time-lapse of the ${project.device_name ?? project.title} assembling itself ` +
          'from loose parts into a finished robot on a clean workbench, fixed camera, soft studio light.'
        : step?.video_prompt ??
          `Fixed camera on a workbench demonstrating: ${step?.title ?? 'this step'}.`

    const videos = project.videos.filter((v) =>
      kind === 'walkthrough' ? v.kind !== 'walkthrough' : v.step_id !== stepId,
    )
    const video = {
      id: nextId('vid'),
      project_id: projectId,
      step_id: kind === 'walkthrough' ? null : stepId,
      kind,
      status: 'generating',
      provider: 'mock',
      provider_job_id: null, // no polling needed; the demo store pushes the update
      prompt,
      video_url: null,
      thumbnail_url: null,
      error: null,
    }
    patch(projectId, { videos: [...videos, video] })

    // Storyboard-only, like VIDEO_PROVIDER=mock on the real backend.
    setTimeout(() => {
      const current = projects.get(projectId)
      if (!current) return
      patch(projectId, {
        videos: current.videos.map((v) => (v.id === video.id ? { ...v, status: 'ready' } : v)),
      })
    }, kind === 'walkthrough' ? 3800 : 2200)

    return clone(video)
  },

  async pollVideo({ projectId, stepId, kind }) {
    const project = projects.get(projectId)
    const video = (project?.videos ?? []).find((v) =>
      kind === 'walkthrough' ? v.kind === 'walkthrough' : v.step_id === stepId,
    )
    return video ? clone(video) : null
  },
}
