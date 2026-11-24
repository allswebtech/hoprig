// The code tia-off, which Tia's routes already send ("Turn Tia on first: …", and her call route's 403), gets the
// button to Settings → Tia, the same place as tia-cap. The way only opens the page: the switch stays as it is.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const { WAYS, wayOf } = await import('../../web/errorways.js');

test('tia-off leads to Settings → Tia, like tia-cap', () => {
  assert.deepEqual(WAYS['tia-off'], { label: 'Settings → Tia', button: "Open Tia's settings", href: '#/settings/tia' });
  assert.deepEqual(wayOf({ error: 'Turn Tia on first', code: 'tia-off' }), { perComputer: true, label: 'Settings → Tia', button: "Open Tia's settings", href: '#/settings/tia' });
  assert.equal(WAYS['tia-off'].href, WAYS['tia-cap'].href);
});

test('every way to Settings → Tia says that place, never "Tia" alone (her chat is another place)', () => {
  for (const [code, w] of Object.entries(WAYS)) {
    if (w.href.split('?')[0] === '#/settings/tia') assert.equal(w.label, 'Settings → Tia', code);
  }
});

test('the server sends exactly this code for Tia being off', () => {
  const s = fs.readFileSync(new URL('../../src/assistant/feature.mjs', import.meta.url), 'utf8');
  assert.match(s, /details: \{ code: 'tia-off' \}/);
  // The sentence says where Tia is turned on and what her tools are for, in plain words.
  assert.ok(s.includes("`Turn ${ASSISTANT_NAME} on first (Settings → ${ASSISTANT_NAME}): your Claude Code can use ${ASSISTANT_NAME}'s tools only while she is on`"));
  assert.doesNotMatch(s, /her tools answer your own Claude Code/);
  assert.match(s, /code: 'tia-off' \}\);/);
});
