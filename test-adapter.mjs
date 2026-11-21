import { build } from 'esbuild';
import { writeFileSync, readFileSync } from 'node:fs';

await build({
  entryPoints: ['src/lib/adapter.ts'],
  bundle: true,
  format: 'esm',
  outfile: 'node_modules/.tmp-adapter.mjs',
  logLevel: 'silent',
});
const { normalizeAssembly, datasetKey } = await import('./node_modules/.tmp-adapter.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra ?? ''); }
}

// 1. Brief's original example payload (3 steps, no extra parts)
const brief = JSON.parse(readFileSync('public/sample-robot.json', 'utf8'));
const r1 = normalizeAssembly(brief);
check('brief payload parses', r1.data !== null && r1.errors.length === 0, JSON.stringify(r1.errors));
check('brief has 6 steps', r1.data?.steps.length === 6);
check('brief step1 narration kept verbatim', r1.data?.steps[0].narration === 'First, prepare the robot chassis.');
check('brief step2 installed cumulative', JSON.stringify(r1.data?.steps[1].installed_components) === '["chassis","motor"]');

// 2. Minimal 3-step payload exactly as in the brief (controller/battery parts without steps)
const minimal = {
  robot_name: 'Four-Wheel Robot Car',
  description: 'A simple four-wheel Arduino-powered robot',
  parts: [
    { id: 'chassis', name: 'Robot chassis', quantity: 1 },
    { id: 'motor', name: 'DC motor', quantity: 4 },
    { id: 'wheel', name: 'Robot wheel', quantity: 4 },
    { id: 'controller', name: 'Arduino controller', quantity: 1 },
    { id: 'battery', name: 'Battery pack', quantity: 1 },
  ],
  steps: [
    { id: 'step-1', number: 1, title: 'Prepare the chassis', instruction: 'Position the chassis on a flat surface.', narration: 'First, prepare the robot chassis.', component_ids: ['chassis'], installed_components: ['chassis'], visual_prompt: 'Show the chassis on its own.' },
    { id: 'step-2', number: 2, title: 'Attach the motors', instruction: 'Position the motors at their designated mounting points.', narration: 'Next, attach the four DC motors to the chassis.', component_ids: ['motor'], installed_components: ['chassis', 'motor'] },
    { id: 'step-3', number: 3, title: 'Attach the wheels', instruction: 'Connect each wheel to the appropriate motor axle.', component_ids: ['wheel'], installed_components: ['chassis', 'motor', 'wheel'] },
  ],
};
const r2 = normalizeAssembly(minimal);
check('minimal payload parses', r2.data !== null, JSON.stringify(r2.errors));
check('missing narration falls back to instruction', r2.data?.steps[2].narration === 'Connect each wheel to the appropriate motor axle.');
check('fallback warning emitted', r2.warnings.some((w) => w.includes('narration')));

// 3. Alternate keys + missing installed_components (cumulative derivation)
const alt = {
  name: 'Alt Bot',
  components: [{ name: 'Frame', qty: 2 }, { part_id: 'cam', label: 'Camera' }],
  assembly_steps: [
    { title: 'Base', description: 'Lay the frame.', components: [] },
    { title: 'Cam', action: 'Screw the camera on.', parts: ['cam'] },
  ],
};
const r3 = normalizeAssembly(alt);
check('alternate keys parse', r3.data !== null, JSON.stringify(r3.errors));
check('robot name from "name"', r3.data?.robot_name === 'Alt Bot');
check('qty key honoured', r3.data?.parts[0].quantity === 2);
check('part_id/label honoured', r3.data?.parts[1].id === 'cam' && r3.data?.parts[1].name === 'Camera');
check('steps renumbered', r3.data?.steps.map((s) => s.number).join(',') === '1,2');
check('cumulative installed derived', JSON.stringify(r3.data?.steps[1].installed_components) === '["cam","frame"]'); // "frame" was an orphan part — now attached to the final step
check('instruction from description/action', r3.data?.steps[0].instruction === 'Lay the frame.' && r3.data?.steps[1].instruction === 'Screw the camera on.');

// 4. Malformed inputs
check('non-object rejected', normalizeAssembly([1, 2]).errors.length > 0);
check('empty object rejected', normalizeAssembly({}).errors.length > 0);
check('no steps rejected', normalizeAssembly({ parts: [{ id: 'a', name: 'A', quantity: 1 }] }).errors.length > 0);
check('skips non-object entries', normalizeAssembly({ parts: [{ id: 'a', name: 'A', quantity: 1 }, 42], steps: [{ title: 'T', instruction: 'I' }, null] }).data?.steps.length === 1);

// 5. datasetKey stable + distinct
const k1 = datasetKey(r1.data), k2 = datasetKey(r2.data), k3 = datasetKey(r3.data);
check('datasetKey stable', k1 === datasetKey(normalizeAssembly(brief).data));
check('datasetKey distinct', new Set([k1, k2, k3]).size === 3);

// 6. Real hein-parts upstream JSON (origin/hein-parts:mock/sample_bom.json)
const upstream = JSON.parse(readFileSync('public/upstream-sample.json', 'utf8'));
const r4 = normalizeAssembly(upstream);
check('hein-parts payload parses', r4.data !== null && r4.errors.length === 0, JSON.stringify(r4.errors));
check('hein-parts robot name', r4.data?.robot_name === 'Obstacle-avoiding car');
check('hein-parts recipe_id preserved', r4.data?.recipe_id === 'obstacle_avoider_car');
check('hein-parts confidence preserved', r4.data?.confidence === 0.82);
check('hein-parts bom_total preserved', r4.data?.bom_total === 53.6);
check('hein-parts 7 parts', r4.data?.parts.length === 7);
check('hein-parts 6 steps', r4.data?.steps.length === 6);
check('hein-parts "n" mapped to number', r4.data?.steps.map((s) => s.number).join(',') === '1,2,3,4,5,6');
check('hein-parts step ids generated', r4.data?.steps.every((s) => s.id.startsWith('step-')));
check('hein-parts "parts_used" mapped to component_ids', JSON.stringify(r4.data?.steps[0].component_ids) === '["motor_tt","chassis_2wd","screws_m3_kit"]');
check('hein-parts tip preserved', r4.data?.steps[0].tip === 'Make sure both motor shafts point outward.');
check('hein-parts tools preserved', JSON.stringify(r4.data?.steps[0].tools) === '["screwdriver"]');
check('hein-parts anim preserved', Array.isArray(r4.data?.steps[0].anim) && r4.data.steps[0].anim.length === 3 && r4.data.steps[0].anim[0].part_id === 'chassis_2wd');
check('hein-parts qty mapped to quantity', r4.data?.parts.find((p) => p.id === 'motor_tt')?.quantity === 2);
check('hein-parts shop data merged from bom array', r4.data?.parts.find((p) => p.id === 'arduino_uno')?.shop === 'RS Components UK');
check('hein-parts unit price merged', r4.data?.parts.find((p) => p.id === 'arduino_uno')?.unit_price === 18.5);
check('hein-parts category preserved', r4.data?.parts.find((p) => p.id === 'motor_tt')?.category === 'motor');
check('hein-parts narration falls back to instruction', r4.data?.steps[0].narration === r4.data?.steps[0].instruction);
check('hein-parts installed_components derived cumulatively', JSON.stringify(r4.data?.steps[5].installed_components) === JSON.stringify(['motor_tt','chassis_2wd','screws_m3_kit','wheel_65mm','caster_ball','batt_holder_18650','switch_spst','arduino_uno','l298n','hcsr04','breadboard_mini','jumpers_mm','usb_cable']));
check('hein-parts visible_in_photo preserved', r4.data?.parts[0].visible_in_photo === true);

// 7. Relationships (connection map) pass through and validate
const withRels = {
  robot_name: 'Rel Bot',
  parts: [{ id: 'a', name: 'Chassis', quantity: 1 }, { id: 'b', name: 'Motor', quantity: 2 }, { id: 'w', name: 'Wire', quantity: 4 }],
  steps: [{ number: 1, title: 'Mount', instruction: 'Attach motor to chassis.', component_ids: ['a', 'b'] }],
  relationships: [
    { from: 'b', to: 'a', type: 'mounted-on', status: 'visually-confirmed', confidence: 'high', evidence: 'motors bolted to chassis corners', source_ids: ['M001'] },
    { from: 'w', to: 'b', type: 'wired-to', status: 'unknown', confidence: 'low', evidence: 'wires visible but routing unclear' },
    { from: 'ghost', to: 'a', type: 'adjacent', status: 'inferred' },
    'not-an-object',
    { type: 'mounted-on' },
  ],
};
const r5 = normalizeAssembly(withRels);
check('relationships parse', r5.data !== null && r5.data.relationships?.length === 3, JSON.stringify(r5.data?.relationships?.length));
check('rel type preserved', r5.data?.relationships?.[0].type === 'mounted-on');
check('rel status preserved', r5.data?.relationships?.[0].status === 'visually-confirmed');
check('rel source_ids preserved', JSON.stringify(r5.data?.relationships?.[0].source_ids) === '["M001"]');
check('unknown status preserved for unclear wiring', r5.data?.relationships?.[1].status === 'unknown');
check('unknown part refs warned, not dropped', r5.warnings.some((w) => w.includes('ghost')));
check('malformed rels skipped with warning', r5.warnings.some((w) => w.includes('Relationship #4') || w.includes('Relationship #5')));

// 8. Orphan parts (in BOM but referenced by no step) are associated with a relevant step
//    without changing instructions or the part's evidence/quantity/review flags.
const orphan = {
  robot_name: 'Orphan Bot',
  parts: [
    { id: 'chassis', name: 'Chassis', quantity: 1, evidence: 'visible' },
    { id: 'enclosure', name: 'Battery enclosure', quantity: 1, evidence: 'visible' },
    { id: 'cells', name: 'Battery cells inside enclosure', quantity: null, quantityUnknown: true, evidence: 'inferred', review_required: true, source_ids: ['P001'] },
    { id: 'servo', name: 'Steering servo / steering linkage', quantity: null, quantityUnknown: true, evidence: 'inferred', review_required: true, source_ids: ['mechanical.possible_missing_parts'] },
  ],
  steps: [
    { number: 1, title: 'Frame', instruction: 'Assemble the chassis.', component_ids: ['chassis'], installed_components: ['chassis'] },
    { number: 2, title: 'Enclosure', instruction: 'Mount the battery enclosure.', component_ids: ['enclosure'], installed_components: ['chassis', 'enclosure'] },
  ],
  relationships: [
    { from: 'cells', to: 'enclosure', type: 'contains', status: 'inferred', confidence: 'low' },
  ],
};
const r6 = normalizeAssembly(orphan);
check('orphan payload parses', r6.data !== null, JSON.stringify(r6.errors));
const stepOf = (pid) => r6.data?.steps.find((s) => s.component_ids.includes(pid))?.number;
check('relationship-linked orphan attached to related part step', stepOf('cells') === 2, `got ${stepOf('cells')}`);
check('unlinked orphan falls back to final step', stepOf('servo') === 2, `got ${stepOf('servo')}`);
check('orphan association warned', r6.warnings.filter((w) => w.includes('not referenced by any step')).length === 2, JSON.stringify(r6.warnings));
check('orphan instruction text untouched', r6.data?.steps[1].instruction === 'Mount the battery enclosure.');
check('orphan part keeps inferred evidence', r6.data?.parts.find((p) => p.id === 'cells')?.evidence === 'inferred');
check('orphan part keeps null-quantity flag', r6.data?.parts.find((p) => p.id === 'cells')?.quantityUnknown === true);
check('orphan part keeps review_required', r6.data?.parts.find((p) => p.id === 'servo')?.review_required === true);
check('orphan part keeps source_ids', JSON.stringify(r6.data?.parts.find((p) => p.id === 'servo')?.source_ids) === '["mechanical.possible_missing_parts"]');
check('step marked uncertain for inferred orphan', r6.data?.steps[1].uncertain === true);
check('installed_components cumulative after association', r6.data?.steps[1].installed_components.includes('cells') && r6.data?.steps[1].installed_components.includes('servo'));
check('earlier steps not polluted by orphan', !r6.data?.steps[0].installed_components.includes('cells'));
check('every part referenced by >=1 step', r6.data?.parts.every((p) => r6.data.steps.some((s) => s.component_ids.includes(p.id))));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
