// Work's refusals that already carry a code get their place's button: an Accept interrupted earlier (interrupted,
// src/work/planstore.mjs) opens Work, whose page shows its record and Drop; a planning tool's file that needs his id
// (owner-id, src/work/model.mjs) opens Settings → Work at that field. The Accept and the task sheet show the button
// beside the words; the task sheet closes first.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const { wayOf } = await import('../../web/errorways.js');
const { addItem } = await import('../../src/work/model.mjs');
const read = (f) => fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');

test('interrupted opens Work, owner-id the field of Settings → Work', () => {
  assert.deepEqual(wayOf({ code: 'interrupted' }), { perComputer: true, label: 'Work', href: '#/work' });
  assert.deepEqual(wayOf({ code: 'owner-id' }), { perComputer: true, label: 'Settings → Work', button: "Open Work's settings", href: '#/settings/work?show=owner-id' });
  assert.match(read('work.js'), /h\('input\.field\.mono', \{ id: 'owner-id', value: s\.ownerId/);
  // The server's refusal carries the code the route sends (errorBody spreads details).
  const doc = { items: [{ id: 'a1', title: 'Ship', owner: 'alex', status: 'open' }] };
  assert.throws(() => addItem(doc, { title: 'Renew the domain' }, { today: '2026-11-17', ownerId: 'me', projects: [] }),
    (e) => e.status === 409 && e.details.code === 'owner-id' && /Settings → Work/.test(e.message) && !/hoprig |<id>|say your id/.test(e.message));
});

test('the Accept and the task sheet show the way of the error itself', () => {
  assert.match(read('workpropose.js'), /const way = wayLink\(x\);\n\s*fill\(err, x\.message, way \? \[' ', way\] : null\);\n\s*accept\.disabled = false;/);
  assert.match(read('workitems.js'), /const way = wayLink\(x\);\n\s*if \(way\) way\.addEventListener\('click', \(\) => close\(false\)\);\n\s*fill\(err, x\.message, way \? \[' ', way\] : null\);/);
});
