// The code root-bypass, which the starts of a session and a chat already send with the sentence that names
// Settings → Runs as root, gets the button to that page. The way only opens the page: the move is his own press there.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const { WAYS, wayOf } = await import('../../web/errorways.js');
const read = (f) => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

test('root-bypass leads to Settings → Runs as root, an address of the page', () => {
  assert.deepEqual(WAYS['root-bypass'], { label: 'Runs as root', href: '#/settings/root' });
  assert.deepEqual(wayOf({ error: 'Claude Code refuses bypass permissions mode as root', code: 'root-bypass' }), { perComputer: true, label: 'Runs as root', href: '#/settings/root' });
  const list = /export const PAGE_ADDRESSES = \[([\s\S]*?)\];/.exec(read('web/app.js'))[1];
  assert.ok([...list.matchAll(/'(#\/[^']*)'/g)].some((m) => m[1] === '#/settings/root'), '#/settings/root is in PAGE_ADDRESSES');
  // The page of that address is the one whose heading the label repeats.
  assert.match(read('web/rootsettings.js'), /id: 'root', title: 'Runs as root'/);
});

test('the server sends exactly this code with the sentence that names the place', () => {
  assert.match(read('src/bypassgate.mjs'), /ROOT_BYPASS_LINE = .*Settings → Runs as root/);
  assert.match(read('src/server/server.mjs'), /new HttpError\(409, ROOT_BYPASS_LINE\), \{ details: \{ code: 'root-bypass' \} \}/);
  assert.match(read('src/chat/feature.mjs'), /new HttpError\(409, ROOT_BYPASS_LINE\), \{ details: \{ code: 'root-bypass' \} \}/);
});
