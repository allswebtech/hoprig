// Settings made easier (27 Nov 2026): fewer pages in an order that makes sense, the choices of New sessions kept when
// they are made, the coding tools, the editor and the folders where a person looks for them, one list of what to be
// told, and every old address, old setting and old value still answering. Driven in the page tests' small stand-in
// for the browser; the computer's answers are handed in.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { FakeElement, FakeText } from '../chat/fakedom.mjs';

globalThis.location = { hash: '#/settings', pathname: '/', protocol: 'http:', hostname: 'localhost', origin: 'http://localhost', href: '' };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.innerWidth = 1440;

const calls = [];
const answers = {
  '/api/codetools': { tools: [
    { id: 'claude', name: 'Claude Code', on: true, installed: '2.1', managed: false, providers: ['p'], command: 'claude', about: 'x' },
    { id: 'opencode', name: 'OpenCode', on: false, installed: '1', managed: true, providers: ['p'], command: 'opencode', about: 'y' },
  ] },
  '/api/updates': { mode: 'manual', notify: true, items: [] },
  '/api/settings/bypass': { allow: false, terminals: 0 },
  '/api/work/tell': { ok: true },
};
globalThis.fetch = async (u, opts = {}) => {
  const path = String(u).replace(/^https?:\/\/[^/]+/, '');
  calls.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
  const key = path.split('?')[0];
  return { ok: true, status: 200, json: async () => (key in answers ? answers[key] : {}) };
};

const all = (n, out = []) => {
  if (n && typeof n === 'object') {
    out.push(n);
    for (const c of n.children || []) all(c, out);
  }
  return out;
};
const text = (n) => all(n).filter((x) => x instanceof FakeText).map((x) => x.text).join(' ').replace(/\s+/g, ' ');
const wrap = (nodes) => {
  const el = new FakeElement('div');
  el.append(...nodes.flat().filter(Boolean));
  return el;
};
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const SETTINGS = {
  version: '0.3.6', platform: 'linux', network: { host: '127.0.0.1', port: 7433, allowedOrigins: [], trustProxy: false },
  notifyEvents: ['waiting', 'attention', 'limit', 'ended', 'switched', 'automation'],
  sessionChoices: { permissionModes: ['manual', 'acceptEdits', 'bypassPermissions'], efforts: ['low', 'high'] },
  sessionDefaults: { permissionMode: 'manual' },
  uploads: { dir: '.hoprig-uploads', maxMB: 25 },
  server: { roots: ['/work/one'], reach: 'home', notify: { url: 'https://ntfy.example.invalid/t', format: 'json', events: ['attention'] }, quickActions: [] },
  backend: { kind: 'tmux' },
};

await import('../../web/settings.js');
await import('../../web/sessiondefaults.js');
const { registeredSettingsPages, SETTINGS_ORDER } = await import('../../web/registry.js');
const { chooseSettingsPage, SETTINGS_ALIASES, MOVED_OUT, movedOutHref, partFor } = await import('../../web/settings.js');
const page = (id) => registeredSettingsPages().find((p) => p.id === id);
const render = (id, extra = {}) => wrap(page(id).render({ settings: SETTINGS, state: {}, here: true, isAlive: () => true, ...extra }));
const pressed = (root, label) => all(root).find((x) => x instanceof FakeElement && x.tag === 'button' && text(x) === label);

test('the list: editor, coding tools and about are no pages of their own; the order is the one asked for', () => {
  const ids = registeredSettingsPages().map((p) => p.id);
  for (const gone of ['editor', 'codingtools', 'about']) assert.ok(!ids.includes(gone), `${gone} is no page now`);
  const order = ['new-sessions', 'notifications', 'appearance', 'security'];
  assert.deepEqual(ids.filter((i) => order.includes(i)), order);
  assert.equal(page('new-sessions').title, 'New sessions');
  assert.equal(page('appearance').title, 'Appearance');
  // The pages that apply only sometimes sit beside what they belong with; the order is one table.
  assert.ok(SETTINGS_ORDER['public-link'] > SETTINGS_ORDER.security && SETTINGS_ORDER.workspace > SETTINGS_ORDER['public-link']);
  assert.ok(SETTINGS_ORDER.automations > SETTINGS_ORDER.workspace && SETTINGS_ORDER.tia > SETTINGS_ORDER.automations && SETTINGS_ORDER.updates > SETTINGS_ORDER.tia);
});

test('old addresses: every old page name lands on its new place, and only when no page has that name', () => {
  const pages = ['new-sessions', 'notifications', 'appearance', 'security', 'updates'].map((id) => ({ id }));
  const lands = (sub, part) => chooseSettingsPage(pages, sub, part).chosen.id;
  assert.equal(lands('editor'), 'appearance');
  assert.equal(lands('codingtools'), 'new-sessions');
  assert.equal(lands('about'), 'updates');
  assert.equal(lands('field'), 'updates');
  assert.equal(lands('signin-device'), 'security');
  assert.equal(lands('about', 'this-device'), 'security', 'Log out moved to Security: the old link to it follows');
  assert.equal(lands('new-sessions', 'folders'), 'security', 'the folder list moved to Security');
  assert.equal(lands('new-sessions', 'bypass'), 'new-sessions');
  assert.equal(chooseSettingsPage(pages, 'nonsense').missing, true);
  // A page that still has the name wins (a page of another part of the work).
  assert.equal(chooseSettingsPage([...pages, { id: 'about' }], 'about').chosen.id, 'about');
  assert.equal(MOVED_OUT.work, '#/work/tasks');
  assert.equal(movedOutHref('work', new URLSearchParams('')), '#/work/tasks?show=work-place', 'the old Work page opens the Work settings fold');
  assert.equal(movedOutHref('work', new URLSearchParams('show=owner-id')), '#/work/tasks?show=owner-id', 'a part the old link names is kept');
  assert.equal(partFor('field', null, pages), 'field-send');
  assert.equal(partFor('editor', null, pages), 'code-editor');
  assert.equal(partFor('codingtools', null, pages), 'coding-tools');
  assert.equal(partFor('about', 'this-device', pages), 'this-device');
  assert.equal(partFor('appearance', null, pages), null);
  assert.deepEqual(Object.keys(SETTINGS_ALIASES).sort(), ['about', 'codingtools', 'editor', 'field', 'signin-device']);
});

test('New sessions: a choice is kept when it is made, with a Saved line; no Save button', async () => {
  calls.length = 0;
  const el = render('new-sessions');
  await tick();
  assert.equal(pressed(el, 'Save'), undefined, 'no Save button');
  const words = text(el);
  assert.match(words, /How new sessions start/);
  assert.match(words, /What it may do without asking/);
  assert.match(words, /How hard it thinks/);
  assert.match(words, /More thinking: better on hard problems, slower, uses more of your plan\./);
  assert.match(words, /Which Claude model answers in Claude Code\. A provider that names its own model keeps it\./);
  const effort = all(el).find((x) => x instanceof FakeElement && x.tag === 'select' && x.attrs['data-key'] === 'effort');
  assert.ok(effort, 'the effort choice');
  effort.listeners.change({ target: { value: 'high' } });
  await tick();
  const post = calls.find((c) => c.path === '/api/settings' && c.method === 'POST');
  assert.ok(post, 'saved at once');
  assert.deepEqual(post.body.sessionDefaults, { permissionMode: 'manual', effort: 'high', model: null, lead: false, others: [] });
  const mark = all(el).find((x) => x instanceof FakeElement && x.className.split(' ').includes('saved-mark'));
  assert.equal(mark.textContent, 'Saved: new sessions start this way');
});

test('New sessions: the split-work switch says its cost in one line; titles, uploads and folders are gone from the page', async () => {
  const el = render('new-sessions');
  await tick();
  const words = text(el);
  assert.match(words, /Split work across models/);
  assert.match(words, /Hands smaller parts to other models; on a small task it costs 3 to 6 times more, so leave it off unless the work is big\./);
  assert.doesNotMatch(words, /Lead model/);
  for (const gone of [/Session names/, /short title/, /Files you attach/, /Largest file/, /Folder name/, /Folders \(one full path/, /Advanced/]) assert.doesNotMatch(words, gone);
  assert.match(words, /Security and sign-in → Folders Hoprig may open/, 'one line says where the folders went');
  assert.match(words, /Bypass permissions|Allow bypass permissions/, 'Bypass keeps its own card and acknowledgement');
});

test('New sessions: Coding tools is a card here, one switch per tool', async () => {
  const el = render('new-sessions');
  await tick();
  const words = text(el);
  assert.match(words, /Coding tools/);
  assert.match(words, /Offer Claude Code in New session/);
  assert.match(words, /Offer OpenCode in New session/);
  assert.match(words, /Off hides it from New session; at least one stays on\./);
  const switches = all(el).filter((x) => x instanceof FakeElement && x.tag === 'input' && x.attrs.role === 'switch' && x.dataset.tool);
  assert.deepEqual(switches.map((s) => s.dataset.tool), ['claude', 'opencode']);
  assert.equal(switches[0].attrs['aria-label'], 'Offer Claude Code in New session', 'a name for a screen reader');
});

test('Appearance: Code editor is a card here, in plain names; the desktop keys are folded under Keys', () => {
  const el = render('appearance');
  const words = text(el);
  assert.match(words, /Code editor/);
  for (const plain of ['Text size', 'Tab width', 'Wrap long lines']) assert.match(words, new RegExp(plain));
  for (const vscode of ['Font Size', 'Tab Size', 'Word Wrap']) assert.doesNotMatch(words, new RegExp(vscode));
  assert.match(words, /Desktop keys/);
  const keys = all(el).find((x) => x instanceof FakeElement && x.tag === 'summary' && text(x) === 'Keys');
  assert.ok(keys, 'the table of keys is folded under Keys');
  assert.equal(page('appearance').desc, 'How Hoprig looks and types on this device.');
});

test('Security: the folders Hoprig may open, with the reach choice, and Log out, all on one page', () => {
  const el = render('security');
  const words = text(el);
  assert.match(words, /Folders Hoprig may open/);
  assert.match(words, /Sessions, Tia and automations always stay inside these folders; the choice below is only for Files and the editor\./);
  assert.match(words, /Only these folders/);
  assert.match(words, /Every folder my user can open/);
  assert.match(words, /Log out on this device/);
  assert.ok(all(el).some((x) => x instanceof FakeElement && x.attrs.id === 'folders') || all(el).some((x) => x.attrs && x.attrs.id === 'folders'), 'the part ?show=folders opens');
  const area = all(el).find((x) => x instanceof FakeElement && x.tag === 'textarea' && String(x.value || x.attrs.value).includes('/work/one'));
  assert.ok(area, 'the allowed folders, as server.roots holds them');
  // On another computer's settings, no Log out (it is this device's).
  assert.doesNotMatch(text(render('security', { here: false })), /Log out on this device/);
});

test('Notifications: one list of what to be told, one Save, no push format, the page keeps an old format', async () => {
  calls.length = 0;
  const el = render('notifications');
  await tick();
  const words = text(el);
  assert.match(words, /Tell me when/);
  for (const w of ['Needs your OK', 'Limit reached', 'Something finished and waits for your look', 'A session waits for your answer', 'A digest while work runs', 'A new version is out']) assert.match(words, new RegExp(w));
  assert.doesNotMatch(words, /Work, by itself|Push for|Format|Automatic uses the ntfy format/);
  assert.equal(all(el).filter((x) => x instanceof FakeElement && x.tag === 'button' && text(x) === 'Save').length, 1, 'one Save');
  assert.match(words, /Install the free ntfy app, subscribe to a long random topic name and paste its address here\. Empty: no push\./);
  // The three timings and "Tia writes my digest" are under More.
  const more = all(el).find((x) => x instanceof FakeElement && x.tag === 'summary' && text(x) === 'More');
  assert.ok(more, 'a More fold');
  const fold = more.parentNode;
  assert.match(text(fold), /Waits for your answer after/);
  assert.match(text(fold), /Tia writes my digest/);
  // Turn on one Work item and "A new version is out" off, press Save: one request each, the old format kept.
  const box = (key) => all(el).find((x) => x instanceof FakeElement && x.attrs['data-key'] === key);
  box('work-finished').listeners.change({ target: { checked: true } });
  box('updates-notify').listeners.change({ target: { checked: false } });
  const save = all(el).find((x) => x instanceof FakeElement && x.tag === 'button' && text(x) === 'Save');
  await save.listeners.click({});
  await tick();
  const posted = calls.find((c) => c.path === '/api/settings' && c.method === 'POST');
  assert.equal(posted.body.server.notify.format, 'json', 'an old format stays');
  assert.deepEqual(posted.body.server.notify.work, { finished: true });
  const updates = calls.find((c) => c.path === '/api/updates/settings');
  assert.deepEqual(updates.body, { notify: false }, 'the same key Settings → Updates keeps');
});

test('old settings still read: no title, upload or push-format choice is shown, yet the computer still honours them', async () => {
  const { cleanNotify } = await import('../../src/server/notify.mjs');
  assert.equal(cleanNotify({ url: 'https://ntfy.example.invalid/t', format: 'json' }).format, 'json');
  assert.equal(cleanNotify({ url: 'https://ntfy.example.invalid/t', format: 'ntfy' }).format, 'ntfy');
  const { cleanServerPatch } = await import('../../src/server/settings.mjs');
  const out = cleanServerPatch({ uploadsDir: '.up', uploadMaxMB: 5 });
  assert.equal(out.uploadsDir, '.up');
  assert.equal(out.uploadMaxMB, 5);
  const src = (f) => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
  assert.match(src('src/chat/feature.mjs'), /titles: \(\) => cfg\(\)\.sessionTitles !== false/, 'an old false keeps titles off');
  assert.match(src('src/server/server.mjs'), /b\.sessionTitles/, 'the old key is still accepted');
  const pages = ['sessiondefaults.js', 'settings.js'].map((f) => src(`web/${f}`)).join('\n');
  assert.doesNotMatch(pages, /sessionTitles|uploadsDir|uploadMaxMB/, 'the pages no longer draw them');
});
