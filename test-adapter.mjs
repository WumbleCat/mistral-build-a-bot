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
check('cumulative installed derived', JSON.stringify(r3.data?.steps[1].installed_components) === '["cam"]');
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
