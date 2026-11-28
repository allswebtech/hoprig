// "She answers her own sessions" (Settings → Tia, assistant.answersHers): off until the owner turns it on, set only on
// his own page (her door cannot send it), and its words say what she then answers by herself and what stays his card.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { checkRoute } from '../../src/assistant/door.mjs';
import { DEFAULTS, HELP, cleanTiaPatch, resolveTia } from '../../src/assistant/tia.mjs';

const accounts = { profiles: [{ name: 'sub', kind: 'subscription' }], autoSwitch: { enabled: false, order: [] } };
const stubCtx = () => ({ config: () => ({ server: { roots: ['/home/owner/projects'] }, sessionDefaults: { permissionMode: 'default' }, assistant: { enabled: true } }) });
const refused = (fn) => assert.throws(fn, (e) => e.status === 403 && e.code === 'tia-route');

test('the switch is off at first and reads as off for anything but true', () => {
  assert.equal(DEFAULTS.answersHers, false);
  assert.equal(resolveTia({}, accounts).answersHers, false);
  assert.equal(resolveTia({ answersHers: 'yes' }, accounts).answersHers, false);
  assert.equal(resolveTia({ answersHers: true }, accounts).answersHers, true);
});

test('the owner\'s Save takes only true or false for it', () => {
  assert.deepEqual(cleanTiaPatch({ answersHers: true }), { answersHers: true });
  assert.deepEqual(cleanTiaPatch({ answersHers: false }), { answersHers: false });
  assert.throws(() => cleanTiaPatch({ answersHers: 'on' }), /answersHers must be true or false/);
});

test('her door cannot turn it on: not by her settings route, not by the dashboard\'s', () => {
  refused(() => checkRoute('POST', '/api/assistant/settings', { answersHers: true }, stubCtx()));
  refused(() => checkRoute('POST', '/api/settings', { assistant: { answersHers: true } }, stubCtx()));
  refused(() => checkRoute('POST', '/m/box2/api/settings', { assistant: { answersHers: true } }, stubCtx()));
});

test('its words say what she answers, that each answer is in Activity, and every kind that stays his card', () => {
  const w = HELP.answersHers;
  for (const re of [/Work task/, /started for you/, /look inside the project/, /project's own checks/, /"Ask me"/, /Activity/, /money/, /sign-in/, /push or merge/, /release/, /sent out/, /delete outside/, /administrator rights/, /Off until you turn it on/, /stops it at once/]) assert.match(w, re);
  // Hoprig's own note and a move at a limit are not built: the words promise neither.
  assert.doesNotMatch(w, /note|limit|provider/);
});

test('Settings → Tia: the switch under the level, saved at once by its own press (one press stops it)', () => {
  const src = fs.readFileSync(new URL('../../web/tia.js', import.meta.url), 'utf8');
  assert.match(src, /toggle\('She answers the OKs of her Work runs', s\.answersHers === true, async \(on\) => \{\s*try \{\s*await api\(`\$\{A\}\/settings`, \{ answersHers: on \}\);/);
  assert.match(src, /more: v\.help\.answersHers \}, \{ key: 'tia-answers-hers' \}\)/);
  assert.match(src, /fold\('tia-level-more', 'What each level means', levelHelp\)\),\s*answersHers,/);
});
