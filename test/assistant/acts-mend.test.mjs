// What a check found in the acts file: an act that opens the computer to the internet, handles a key or adds a computer
// is never answered alone or by a card; a read never keeps a secret field.
import assert from 'node:assert/strict';
import test from 'node:test';

const { loadActs, loadInventory, rowAnswer } = await import('../../src/assistant/acts.mjs');
const rows = loadActs().rows;
const row = (source) => {
  const r = rows.find((x) => x.source === source);
  assert.ok(r, `no row ${source}`);
  return r;
};

test('the public link is turned on by his own press: the row only turns it off', () => {
  const r = row('POST /api/public-link');
  assert.deepEqual(r.input.properties.on, { const: false });
  assert.match(r.why, /on is his own press/);
});

test('a command that holds a never part is open, as at the base', () => {
  const want = { 'hoprig public': 'open-out', 'hoprig machines': 'pair', 'hoprig workspace': 'sign-in', 'hoprig addons': 'sign-in' };
  for (const [src, never] of Object.entries(want)) {
    const r = row(src);
    assert.equal(r.facts.never, never, src);
    assert.equal(rowAnswer(r), 'open', src);
    assert.equal(r.tool, undefined, src);
    assert.ok(r.why && r.why.length >= 20 && r.why.length <= 200, src);
    assert.equal(loadInventory().rows.find((i) => i.act === src).facts.never, never, src);
  }
});

test('an add-on action is never answered by a card: it sets up the public link', () => {
  const r = row('POST /api/addons/<id>/do/<id>');
  assert.equal(r.facts.never, 'open-out');
  assert.equal(rowAnswer(r), 'open');
});

test('the reads of settings and of an add-on job keep no secret field', () => {
  const s = row('GET /api/settings');
  assert.ok(!s.pick.includes('*') && !s.pick.some((p) => /^server(\.notify)?$/.test(p) || p.startsWith('server.notify')));
  const j = row('GET /api/addons/<id>/job');
  assert.ok(!j.pick.includes('*') && !j.pick.includes('first') && !j.pick.includes('lines'));
});
