import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';

await build({
  entryPoints: ['src/lib/analysisAdapter.ts'],
  bundle: true,
  format: 'esm',
  outfile: 'node_modules/.tmp-analysis.mjs',
  logLevel: 'silent',
});
const { validateAnalysis, analysisToParts, provenanceLine } = await import('./node_modules/.tmp-analysis.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra ?? ''); }
}

// Schema-accurate sample entry (shape from the brief, not fabricated robot data)
const sampleEntry = {
  name: 'off-road rubber wheel/tire (black, chevron tread)',
  category: 'wheel',
  quantity: 4,
  evidence: 'visible',
  source_ids: ['W001', 'W002'],
  sku: null,
  product_url: null,
  review_required: false,
  notes: 'Four distinct wheels at the four corners.',
};

// 1. Bare array parses
const r1 = validateAnalysis([sampleEntry]);
check('bare array parses', r1.errors.length === 0 && r1.components.length === 1, JSON.stringify(r1.errors));
check('name preserved', r1.components[0].name === sampleEntry.name);
check('source_ids preserved', JSON.stringify(r1.components[0].source_ids) === '["W001","W002"]');
check('evidence preserved', r1.components[0].evidence === 'visible');
check('review_required false preserved', r1.components[0].review_required === false);
check('sku null preserved', r1.components[0].sku === null);

// 2. {components:[...]} wrapper parses
const r2 = validateAnalysis({ components: [sampleEntry] });
check('components wrapper parses', r2.errors.length === 0 && r2.components.length === 1);

// 3. null quantity = unknown, preserved as null
const nullQty = { name: 'drive motor', category: 'motor', quantity: null, evidence: 'inferred', review_required: true, source_ids: ['M001'] };
const r3 = validateAnalysis([nullQty]);
check('null quantity stays null', r3.components[0].quantity === null);
const p3 = analysisToParts(r3.components)[0];
check('null quantity -> quantityUnknown flag', p3.quantityUnknown === true);
check('inferred evidence preserved on part', p3.evidence === 'inferred');
check('review_required preserved on part', p3.review_required === true);
check('source_ids preserved on part', JSON.stringify(p3.source_ids) === '["M001"]');
check('visible_in_photo false for inferred', p3.visible_in_photo === false);

// 4. numeric quantity maps normally, no unknown flag
const p4 = analysisToParts(validateAnalysis([sampleEntry]).components)[0];
check('numeric qty mapped', p4.quantity === 4 && p4.quantityUnknown !== true);
check('visible evidence -> visible_in_photo', p4.visible_in_photo === true);

// 5. provenance line includes flags
const line = provenanceLine(p3);
check('provenance shows inferred + review + unknown qty + sources',
  line.includes('inferred') && line.includes('REVIEW REQUIRED') && line.includes('quantity unknown') && line.includes('M001'), line);

// 6. invalid inputs
const r6a = validateAnalysis('nope');
check('non-array rejected', r6a.errors.length > 0);
const r6b = validateAnalysis([]);
check('empty array errors', r6b.errors.length > 0);
const r6c = validateAnalysis({ foo: 1 });
check('object without components rejected', r6c.errors.length > 0);
const r6d = validateAnalysis([{ category: 'wheel' }, 42, { name: 'ok', quantity: 2 }]);
check('bad entries skipped with warnings, good kept', r6d.components.length === 1 && r6d.warnings.length >= 2, JSON.stringify(r6d.warnings));

// 7. duplicate names get unique ids
const r7 = validateAnalysis([{ name: 'wheel', quantity: 1 }, { name: 'wheel', quantity: 2 }]);
const parts7 = analysisToParts(r7.components);
check('duplicate names unique ids', parts7[0].id !== parts7[1].id, parts7.map(p => p.id).join(','));

// 8. extra unknown fields tolerated
const r8 = validateAnalysis([{ ...sampleEntry, confidence: 0.91, bbox: [1, 2, 3, 4] }]);
check('extra fields tolerated', r8.errors.length === 0 && r8.components[0].confidence === 0.91);

// 9. string quantity coerced, garbage quantity -> null (unknown)
const r9 = validateAnalysis([{ name: 'screw', quantity: '8' }, { name: 'bolt', quantity: 'lots' }]);
check('string number qty coerced', r9.components[0].quantity === 8);
check('garbage qty -> null unknown', r9.components[1].quantity === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
