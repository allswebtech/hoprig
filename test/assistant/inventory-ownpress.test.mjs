// Two rows of the inventory say an act is his own press ("not": "his-review"): moving a key file out of the AI brain
// and naming a link as his own. Her door refuses both routes, on this computer and through another one, and no tool of
// hers names them, so the rows say what she really can and cannot do.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { checkRoute } from '../../src/assistant/door.mjs';
import { TOOLS } from '../../src/assistant/tools.mjs';

const INVENTORY = JSON.parse(fs.readFileSync(new URL('../../src/assistant/inventory.json', import.meta.url), 'utf8')).rows;
const ROUTES = ['/api/workspace/git/brain/moveout', '/api/workspace/mylink'];

for (const route of ROUTES) {
  test(`POST ${route}: her door refuses it, here and on another computer, and the row says it is his`, () => {
    for (const url of [route, `/m/box2${route}`]) {
      assert.throws(() => checkRoute('POST', url, { name: 'shop' }, { config: () => ({}), settingsOf: () => null }), (e) => e.status === 403, url);
    }
    const row = INVENTORY.find((r) => r.act === `POST ${route}`);
    assert.ok(row, 'a row');
    assert.equal(row.not, 'his-review');
    assert.ok(!row.hers, 'no tool of hers in the row');
  });
}

test('no tool of hers names either route', () => {
  const text = JSON.stringify(TOOLS.map((t) => [t.name, t.description, Object.keys(t.actions || {})]));
  for (const r of ['moveout', 'mylink']) assert.ok(!text.includes(r), r);
});
