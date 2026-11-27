// The page's one model picker (web/modelpicker.js) and its places: the options it draws from a provider's list, a
// saved model the list leaves out, and that no place offers the three fixed names any more.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const { NOT_LISTED, optionText, pickerOptions } = await import('../../web/modelpicker.js');

test('the options are the provider\'s own models, with what each says of itself', () => {
  const view = { models: [{ id: 'relay-main-2', label: 'Relay Main 2', window1m: true, images: true, efforts: ['low', 'high'] }, { id: 'relay-1', label: 'relay-1' }] };
  const o = pickerOptions(view, 'relay-1', 'Default');
  assert.deepEqual(o.map(([v]) => v), ['', 'relay-main-2', 'relay-1']);
  assert.equal(o[1][1], 'Relay Main 2 (relay-main-2) · 1M window · pictures · efforts low, high');
  assert.equal(optionText({ id: 'x', label: 'x' }), 'x');
});

test('a saved model the list leaves out is shown as it is, marked, never replaced', () => {
  const o = pickerOptions({ source: 'endpoint', models: [{ id: 'relay-1', label: 'relay-1' }], notListed: ['relay-gone-9'] }, 'relay-gone-9', 'Default');
  assert.deepEqual(o.at(-1), ['relay-gone-9', `relay-gone-9 (${NOT_LISTED})`]);
  assert.equal(NOT_LISTED, 'not in this provider\'s list');
  // Marked only where the server's check would refuse it: a family name on a gateway's list works, so it is not.
  const fam = pickerOptions({ source: 'endpoint', models: [{ id: 'relay-1', label: 'relay-1' }], notListed: [] }, 'haiku', 'Default');
  assert.deepEqual(fam.at(-1), ['haiku', 'haiku']);
  // Without a list (the fallback) a name is not "left out" by anyone: an exact name typed in is shown as typed.
  const f = pickerOptions({ source: 'fallback', models: [{ id: 'opus', label: 'Opus' }] }, 'claude-exact-7', 'Default');
  assert.deepEqual(f.at(-1), ['claude-exact-7', 'claude-exact-7 (typed)']);
});

test('every picker of the page takes the provider\'s list; none offers the three fixed names', () => {
  for (const f of ['tia.js', 'workpropose.js', 'workdo.js', 'sessiondefaults.js']) {
    const src = fs.readFileSync(path.join(WEB, f), 'utf8');
    assert.match(src, /modelPicker\(\{/, `${f} uses the picker`);
    assert.doesNotMatch(src, /\[\.\.\.MODELS\]|MODELS\.map\(/, `${f}: no fixed list`);
  }
});

test('a family is described in one place only: the subscription\'s data, which the fallback and Auto take too', () => {
  const holders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(m?js)$/.test(e.name) && /'(Opus|Sonnet|Haiku): [a-z]/.test(fs.readFileSync(p, 'utf8'))) holders.push(path.relative(path.join(WEB, '..'), p));
    }
  };
  walk(WEB);
  walk(path.join(WEB, '..', 'src'));
  assert.deepEqual(holders, [], 'a second list of family labels');
});


test('the note under a subscription\'s list names no Claude Code version: the computer may have another', () => {
  const src = fs.readFileSync(path.join(WEB, 'modelpicker.js'), 'utf8');
  assert.doesNotMatch(src, /read for version/);
  assert.match(src, /The models Claude Code offers a subscription\./);
});
