// Settings → Version and updates (web/updates.js, web/field.js) in the page tests' stand-in DOM: one Check now, the
// Automatic sentence true to what the automatic rule does, and the reports to Hoprig's developers as a fold on this
// computer's own settings only, its address and folder still saved. Made-up values only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { hoprigItem } from '../../src/automation/updateitems.mjs';
import { afterCheck } from '../../src/automation/updates.mjs';
import { byClass, texts } from '../chat/fakedom.mjs';

globalThis.location ||= { hash: '', search: '', pathname: '/' };
globalThis.window.dispatchEvent ||= () => true;
const asked = [];
const item = (id, o = {}) => ({ id, title: id, installed: '1.0.0', latest: '1.0.0', updateAvailable: false, canUpdate: true, action: 'update', checkedAt: Date.now(), whenRunning: 'w', ...o });
const updates = { mode: 'manual', notify: false, itemModes: {}, running: false, items: [item('hoprig'), item('claude'), item('cloudflared')] };
const field = {
  settings: { sendTo: 'https://reports.example.com/in', choice: 'ask', choiceAt: 't', choiceFor: 'https://reports.example.com/in', ownNetwork: false, copyDir: '' },
  choice: 'ask', question: false, reports: [], notRead: 0, waiting: [], twice: [],
};
globalThis.fetch = async (u, o = {}) => {
  asked.push({ u, body: o.body ? JSON.parse(o.body) : undefined });
  const data = String(u).includes('/api/field/settings') ? field : String(u).includes('/api/field') ? field : updates;
  return { status: 200, ok: true, json: async () => data };
};
await import('../../web/updates.js');
const { registeredSettingsPages } = await import('../../web/registry.js');
const all = (n, ok) => (n.children ? [...(ok(n) ? [n] : []), ...n.children.flatMap((c) => all(c, ok))] : []);
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};
const render = async (here) => {
  const page = registeredSettingsPages().find((p) => p.id === 'updates');
  const nodes = page.render({ here, settings: { platform: 'linux' }, isAlive: () => true }).filter(Boolean);
  await settle();
  return nodes;
};
const flat = (nodes) => nodes.flatMap((n) => texts(n)).join(' ');
const buttonsNamed = (nodes, re) => nodes.flatMap((n) => all(n, (x) => x.tag === 'button' && re.test(texts(x).join(''))));

test('the page has one Check now and one Update all, and no old page ids are registered', async () => {
  const nodes = await render(true);
  assert.equal(buttonsNamed(nodes, /Check/).length, 1);
  assert.equal(buttonsNamed(nodes, /^Check now$/).length, 1);
  assert.equal(buttonsNamed(nodes, /^Update all$/).length, 1);
  assert.equal(registeredSettingsPages().filter((p) => p.id === 'field').length, 0, 'Field reports is no page of its own');
  assert.equal(registeredSettingsPages().find((p) => p.id === 'updates').title, 'Version and updates');
  assert.match(flat(nodes), /Computer system linux/);
  assert.match(flat(nodes), /Notifications tells you about new versions/);
  assert.ok(!/Tell me about new versions/.test(flat(nodes)), 'that switch lives on Notifications');
});

test('the Automatic sentence says what the automatic rule does', async () => {
  const nodes = await render(true);
  const t = flat(nodes);
  assert.match(t, /every 6 hours and installs updates of the coding tools and the link helper/);
  assert.match(t, /For a new Hoprig it only tells you/);
  assert.ok(!/installs each update by itself/.test(t));
  // The code: Hoprig itself is never installed by the rule (it only tells), a tool is.
  assert.equal(hoprigItem({}).autoOk({ installed: '1' }), false);
  const rows = [
    { id: 'hoprig', title: 'Hoprig', installed: '1', latest: '2', updateAvailable: true, canUpdate: true, auto: false },
    { id: 'claude', title: 'Claude Code', installed: '1', latest: '2', updateAvailable: true, canUpdate: true, auto: true },
  ];
  const { actions } = afterCheck({ rows, settings: { mode: 'auto', notify: false, itemModes: {} }, data: {} });
  assert.deepEqual(actions.map((a) => `${a.type}:${a.id}`).sort(), ['tell:hoprig', 'update:claude']);
});

test('the reports fold shows for this computer only, with its address and folder still saved', async () => {
  const there = await render(false);
  assert.ok(!/Reports to Hoprig/.test(flat(there)));
  const nodes = await render(true);
  assert.match(flat(nodes), /Reports to Hoprig's developers/);
  const input = (k) => nodes.flatMap((n) => all(n, (x) => x.tag === 'input' && x.dataset.keep === k))[0];
  const addr = input('addr');
  addr.value = 'https://reports.example.com/other';
  buttonsNamed(nodes, /^Save the address$/)[0].listeners.click({});
  await settle();
  assert.deepEqual(asked.at(-1).body, { sendTo: 'https://reports.example.com/other' });
  input('copy').value = '/some/folder';
  buttonsNamed(nodes, /^Save the folder$/)[0].listeners.click({});
  await settle();
  assert.deepEqual(asked.at(-1).body, { copyDir: '/some/folder' });
});
