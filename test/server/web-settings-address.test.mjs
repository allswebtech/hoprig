// A settings address typed or linked directly: another name of a page opens that page, and a name that is no page
// says so (with a way to the list), never another page shown as if it were the one asked for.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import '../chat/fakedom.mjs';

globalThis.location = { hash: '#/', pathname: '/', protocol: 'http:', hostname: 'localhost', origin: 'http://localhost', href: '' };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });

const { chooseSettingsPage, SETTINGS_ALIASES } = await import('../../web/settings.js');
const { TARGETS } = await import('../../web/getstarted.js');
const pages = [{ id: 'new-sessions' }, { id: 'notifications' }, { id: 'security' }, { id: 'about' }];

test('settings address: its own name, another name of it, none, and one that is no page', () => {
  assert.deepEqual(chooseSettingsPage(pages, 'about'), { chosen: pages[3], missing: false });
  assert.deepEqual(chooseSettingsPage(pages, 'signin-device'), { chosen: pages[2], missing: false }, 'the name Get started uses');
  assert.deepEqual(chooseSettingsPage(pages, ''), { chosen: pages[0], missing: false }, 'the list itself');
  assert.equal(chooseSettingsPage(pages, 'nonsense').missing, true);
  assert.equal(chooseSettingsPage(pages, 'constructor').missing, true, 'a name of the object itself is no alias');
  assert.equal(TARGETS['settings/signin-device'], `#/settings/${SETTINGS_ALIASES['signin-device']}`, 'one table for both');
  const src = fs.readFileSync(new URL('../../web/settings.js', import.meta.url), 'utf8');
  assert.match(src, /if \(missing\) \{\n\s+return fill\(pane, h\('div\.empty', icon\('alert', \{ size: 32 \}\), h\('p', 'This settings page does not exist\.'\),\n\s+h\('a\.btn\.secondary', \{ href: link\('#\/settings'\) \}, 'See all settings'\)\)\);/);
});
