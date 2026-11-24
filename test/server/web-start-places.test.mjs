// Sentences on Get started, Settings, Updates and voice typing that name another place get a link or a button that
// opens it, at the switch or panel itself (?show=<id>) where they name one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { FakeElement } from '../chat/fakedom.mjs';

globalThis.location = { hash: '#/', pathname: '/', protocol: 'http:', hostname: 'localhost', origin: 'http://localhost', href: '' };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const links = (n) => (n instanceof FakeElement ? [...(n.tag === 'a' ? [n.attrs.href] : []), ...n.children.flatMap(links)] : []);

test('voice typing: "Settings → Security" and "Settings → Appearance" lines carry a link there', async () => {
  globalThis.window.webkitSpeechRecognition = class {};
  globalThis.window.isSecureContext = false;
  const { micButton, voicePanel } = await import('../../web/voice.js');
  const t = new FakeElement('textarea');
  t.value = '';
  const m = micButton(t);
  m.el.listeners.click();
  assert.deepEqual(links(m.note), ['#/settings/security']);
  delete globalThis.window.isSecureContext;
  assert.equal(voicePanel().attrs.id, 'voice-typing', 'the panel the Appearance link shows');
  assert.match(read('web/voice.js'), /'language-not-supported': \['#\/settings\/appearance\?show=voice-typing', 'Open Appearance'\]/);
});

test('Settings: "turn on Settings → Public link" opens its switch; About\'s This device panel can be shown', async () => {
  const { addressHint } = await import('../../web/settings.js');
  const { PUBLIC_LINK_SWITCH } = await import('../../web/computers.js');
  assert.deepEqual(links(addressHint({ network: { host: '127.0.0.1', port: 7433 } })), [PUBLIC_LINK_SWITCH]);
  assert.equal(addressHint({ network: { host: '0.0.0.0', port: 7433 } }), 'Other devices on the network can open the page.');
  const server = { why: 'a server', ways: [], forward: '' };
  assert.deepEqual(links(addressHint({ network: { host: '127.0.0.1', port: 7433, server } })), [PUBLIC_LINK_SWITCH], 'a server closed to the network: the same sentence, the same link');
  assert.match(read('web/settings.js'), /panel\(\{ id: 'this-device', icon: 'logout', title: 'This device' \}/);
});

test('Updates and Get started: the Notifications line links there, the closed toast has a button to About', () => {
  assert.match(read('web/updates.js'), /\(Settings → Notifications says where\)[^\n]*\n\s+h\('a', \{ href: link\('#\/settings\/notifications'\) \}, 'Open Notifications'\)/);
  assert.match(read('web/getstarted.js'), /toast\('Closed\. Settings → About brings it back\.', \{ ms: 8000, action: \{ label: 'Open About', run: \(\) => \(location\.hash = link\('#\/settings\/about\?show=this-device'\)\) \} \}\)/);
});
