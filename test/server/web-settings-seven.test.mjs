// Settings as seven rows (the easy design): New sessions (Hands-off folded in), Notifications, Appearance, Security and
// sign-in (the Public link folded in), Tia, Automations (the Workspace folded in), Version and updates. Add-ons is no
// row. Every old address lands on the merged row with its part in view. Driven in the page tests' small stand-in DOM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { FakeElement, FakeText } from '../chat/fakedom.mjs';

globalThis.location = { hash: '#/settings', pathname: '/', protocol: 'http:', hostname: 'localhost', origin: 'http://localhost', href: '' };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.innerWidth = 393;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

for (const f of ['settings', 'sessiondefaults', 'handsoffsettings', 'publiclink', 'addons', 'automation', 'workspace', 'updates', 'tia', 'rootsettings']) await import(`../../web/${f}.js`);
const { registeredSettingsPages } = await import('../../web/registry.js');
const { chooseSettingsPage, partFor, settingsRows, MERGED_INTO, pageBody } = await import('../../web/settings.js');

const src = (f) => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
const all = (n, out = []) => {
  if (n && typeof n === 'object') {
    out.push(n);
    for (const c of n.children || []) all(c, out);
  }
  return out;
};
const text = (n) => all(n).filter((x) => x instanceof FakeText).map((x) => x.text).join(' ').replace(/\s+/g, ' ');
const pages = registeredSettingsPages();
const ids = (list) => list.map((p) => p.id);

test('the list holds seven rows: the merged ones and Add-ons are no row; Runs as root shows only when it applies', () => {
  assert.deepEqual(ids(settingsRows(pages)).filter((i) => i !== 'root'), ['new-sessions', 'notifications', 'appearance', 'security', 'tia', 'automations', 'updates']);
  for (const gone of ['handsoff', 'public-link', 'workspace', 'addons']) assert.ok(!ids(settingsRows(pages)).includes(gone), `${gone} is no row`);
  assert.equal(settingsRows(pages).length, 8, 'seven rows, and the one that applies only as root');
  assert.deepEqual(MERGED_INTO, { handsoff: 'new-sessions', 'public-link': 'security', workspace: 'automations' });
  assert.equal(pages.find((p) => p.id === 'automations').title, 'Automations');
});

test('old addresses: each opens the merged row with its own part in view; Add-ons stays its own page', () => {
  const lands = (sub, part) => chooseSettingsPage(pages, sub, part).chosen.id;
  assert.equal(lands('handsoff'), 'new-sessions');
  assert.equal(partFor('handsoff', null, pages), 'handsoff');
  assert.equal(lands('public-link'), 'security');
  assert.equal(partFor('public-link', null, pages), 'public-link');
  assert.equal(lands('public-link', 'public-link-switch'), 'security', 'a part the old link names is kept');
  assert.equal(partFor('public-link', 'public-link-switch', pages), 'public-link-switch');
  assert.equal(lands('workspace'), 'automations');
  assert.equal(partFor('workspace', null, pages), 'workspace');
  assert.equal(lands('automations'), 'automations');
  assert.equal(partFor('automations', null, pages), null);
  assert.equal(lands('addons'), 'addons');
  assert.equal(chooseSettingsPage(pages, 'addons').missing, false);
  assert.equal(lands('security'), 'security');
  // The old moved names still lead on, to the merged row too.
  assert.equal(lands('new-sessions', 'folders'), 'security');
  assert.equal(lands('editor'), 'appearance');
  assert.equal(chooseSettingsPage(pages, 'nonsense').missing, true);
});

test('a merged row draws its part as a closed fold with the old name, and opens it when the old address asked', () => {
  const ctx = { settings: { server: { roots: [] }, network: { host: '127.0.0.1', port: 1, allowedOrigins: [] }, version: '1' }, state: {}, here: true, isAlive: () => true };
  const host = pages.find((p) => p.id === 'security');
  const wrap = (nodes) => {
    const el = new FakeElement('div');
    el.append(...nodes.flat().filter(Boolean));
    return el;
  };
  const closed = wrap(pageBody(host, pages, ctx, { open: null }));
  const fold = all(closed).find((x) => x instanceof FakeElement && x.tag === 'details' && x.attrs.id === 'public-link');
  assert.ok(fold, 'a fold with the id of the old address');
  assert.ok(!fold.open, 'closed on first paint');
  assert.match(text(fold.children[0]), /^\s*Public link\s*$/);
  const opened = wrap(pageBody(host, pages, ctx, { open: 'public-link', part: 'public-link' }));
  const fold2 = all(opened).find((x) => x instanceof FakeElement && x.tag === 'details' && x.attrs.id === 'public-link');
  assert.equal(fold2.open, true, 'the old address opens it');
  assert.match(text(fold2), /Switch|link/i, 'its content is drawn at once then');
});

test('a row that holds nothing merged draws only itself; Security points to Add-ons', () => {
  const ctx = { settings: { server: { roots: [] }, network: { host: '127.0.0.1', port: 1, allowedOrigins: [] }, version: '1' }, state: {}, here: true, isAlive: () => true };
  const n = pageBody(pages.find((p) => p.id === 'notifications'), pages, ctx, {});
  assert.ok(Array.isArray(n));
  const el = new FakeElement('div');
  el.append(...pageBody(pages.find((p) => p.id === 'security'), pages, ctx, {}).flat().filter(Boolean));
  assert.ok(all(el).some((x) => x instanceof FakeElement && x.tag === 'a' && /#\/settings\/addons$/.test(x.attrs.href || '')), 'a link to Add-ons');
});

test('Settings has no intro line on this computer and no page lists the parts that moved out', () => {
  const s = src('web/settings.js');
  assert.doesNotMatch(s, /How this dashboard and its sessions behave/);
  assert.doesNotMatch(s, /introOnPhone/);
  assert.doesNotMatch(src('web/automation.js'), /title: 'While you are away'/);
});
