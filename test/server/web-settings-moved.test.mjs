// Settings that moved to where their work is (lane "settings-b" of the easier-settings list): Work's settings at the foot of
// Work > Tasks, the schedules switch on top of Work > Schedules, Automations (While you are away, now one row with the Workspace), the Workspace
// page shorter, the Hands-off and Tia pages with their long paragraphs folded. An old settings file keeps working.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { FakeElement, FakeText, byClass, texts } from '../chat/fakedom.mjs';
import { DEFAULTS, readSettings } from '../../src/automation/settings.mjs';

const read = (f) => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
const reply = (body, status = 200) => ({ status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body) });
const settle = () => new Promise((r) => setTimeout(r, 40));
const words = (n) => texts(n).join(' ').replace(/\s+/g, ' ');
const walk = (n, f, out = []) => {
  if (n instanceof FakeElement) {
    if (f(n)) out.push(n);
    n.children.forEach((c) => walk(c, f, out));
  }
  return out;
};
const folds = (n) => walk(n, (x) => x.tag === 'details' && x.className.split(' ').includes('fold'));
const foldTitle = (d) => words(d.children[0]);
const inFold = (n, title) => folds(n).find((d) => foldTitle(d).trim() === title);
const switches = (n) => walk(n, (x) => x.tag === 'label' && x.className.includes('switchrow'));
const labelOf = (s) => words(byClass(s, 'switchrow-label')[0]).trim();

const AUTO = {
  settings: {
    paused: false, queue: { enabled: true }, schedules: { enabled: true, lateHours: 2, atOnce: 1, list: [] }, retry: { enabled: false }, restore: { enabled: null },
    idle: { shells: false, shellHours: 24, gateway: false, gatewayMinutes: 60 },
    workspace: { map: true, commitMap: false, memory: false, sync: false, push: false, pushBranches: {}, everyHours: 6, credentials: false, onlyHere: false, servers: false },
  },
  schedules: [], queues: {}, restoreOn: false, timeZone: 'UTC',
};
const WORK = {
  settings: { place: 'brain', project: '', path: '', saveSubject: 'Work: {what}', timeZone: '', ownerId: 'me' },
  projects: ['alpha'], place: { label: 'AI brain', fileName: 'work.json' },
};
globalThis.fetch = async (u) => {
  const p = String(u).split('?')[0];
  if (p === '/api/automation') return reply(AUTO);
  if (p === '/api/work') return reply(WORK);
  if (p === '/api/work/access') return reply({ tokens: [], webhooks: [], events: [], limits: { perMinute: 60, perDay: 500 } });
  if (p === '/api/workspace') return reply({ short: '~/Workspace', projectsShort: '~/Workspace/projects', projects: [], folders: [], exists: true });
  if (p === '/api/workspace/map') return reply({ exists: true, counts: {}, repos: [], groups: [], entries: [] });
  if (p === '/api/workspace/computers') return reply({ label: 'laptop', suggestion: 'box2', computers: [{ label: 'laptop', mine: true, here: [], hoprig: '1' }, { label: 'desk', here: [], hoprig: '1' }] });
  if (p === '/api/workspace/credentials') return reply({ folder: 'none' });
  if (p === '/api/pcsetup/projects') return reply({ places: [{ id: '' }] });
  if (p === '/api/machines') return reply({ machines: [] });
  if (p === '/api/handsoff') return reply({ projects: [] });
  return reply({ error: 'no such route' }, 404);
};

const { registeredSettingsPages } = await import('../../web/registry.js');
const work = await import('../../web/work.js');
const auto = await import('../../web/automation.js');
await import('../../web/workspace.js');
await import('../../web/handsoffsettings.js');
await import('../../web/tia.js');
const page = (id) => registeredSettingsPages().find((p) => p.id === id);

test('Work: no settings page of its own; its settings are a folded "Work settings" at the foot of Tasks', async () => {
  assert.equal(page('work'), undefined, 'Settings has no Work page any more');
  const part = work.workSettingsPart({ ...WORK, settings: { ...WORK.settings } });
  await settle();
  const top = folds(part).filter((d) => d.parentNode === part || true).find((d) => foldTitle(d).trim() === 'Work settings');
  assert.ok(top, 'one fold "Work settings"');
  const t = words(top);
  assert.match(t, /Where your tasks are kept/);
  assert.doesNotMatch(t, /Commit subject/, 'the commit subject leaves');
  const more = inFold(top, 'More');
  assert.ok(more, 'a More inside it');
  const m = words(more);
  assert.match(m, /Time zone/);
  assert.match(m, /Your id in a planning file/);
  assert.match(m, /Another program/);
  const open = words(top).replace(m, '');
  assert.match(open, /Where your tasks are kept/, 'the place stays open');
  assert.doesNotMatch(open, /Time zone|Another program/, 'the rest is only in the More');
  const src = read('web/work.js');
  assert.match(src, /!machine\.current/, 'shown only for this computer');
  assert.doesNotMatch(src, /saveSubject: s\.saveSubject/, 'saving the others never sends the commit subject');
  assert.doesNotMatch(src, /href: '#\/settings\/work'/, 'no link to the old page');
});

test('Schedules: the master switch and "at most this many at once" are on top of Work > Schedules', () => {
  const node = auto.schedulesPart(AUTO, { reload() {}, addSchedule() {}, rows: null, computers: [] });
  const box = new FakeElement('div');
  box.append(...[].concat(node).flat().filter(Boolean));
  const w = words(box);
  assert.match(w, /Run schedules/);
  assert.match(w, /Off: nothing starts at a set time/);
  assert.match(w, /At most this many at once/);
  assert.ok(w.indexOf('Run schedules') < w.indexOf('No schedules yet'), 'above the list');
});

test('Automations: the page is renamed, has no queue switch and no schedule switch', async () => {
  const p = page('automations');
  assert.equal(p.title, 'Automations');
  const box = new FakeElement('div');
  box.append(...[].concat(p.render()));
  await settle();
  const labels = switches(box).map(labelOf);
  for (const l of ['Try again after a server error', 'Reopen sessions after a restart', 'Close idle terminals', 'Stop an unused gateway']) assert.ok(labels.includes(l), l);
  assert.ok(!labels.includes('Send the next queued message'), 'the queue switch leaves');
  assert.ok(!labels.includes('Run schedules'), 'the schedules switch moved');
  assert.match(words(box), /Schedules: Work > Schedules|Schedules: .*Work → Schedules/);
  assert.equal(typeof auto.QUEUE_SWITCH, 'undefined');
});

test('an old settings file with the queue off is still read as off, and the queue banner turns it on', () => {
  const s = readSettings({ queue: { enabled: false } });
  assert.equal(s.queue.enabled, false, 'an old false keeps working');
  assert.equal(DEFAULTS.queue.enabled, true, 'new ones start on');
  const node = auto.queuePart({ ...AUTO, settings: { ...AUTO.settings, queue: { enabled: false } } }, () => {});
  const box = new FakeElement('div');
  box.append(...[].concat(node).flat().filter(Boolean));
  assert.match(words(box), /turned off/);
  assert.ok(walk(box, (x) => x.tag === 'button' && /Turn it on/.test(words(x))).length, 'a button that turns it on');
});

test('Settings > Workspace: four switches open, the rest in a More, no "Your computers" list', async () => {
  const p = page('workspace');
  const box = new FakeElement('div');
  box.append(...[].concat(p.render()));
  await settle();
  await settle();
  const all = words(box);
  assert.doesNotMatch(all, /Your computers/, 'that list stays on the Workspace page');
  assert.match(all, /This computer is\s+laptop\s+in your workspace/);
  const by = walk(box, (x) => x.tag === 'section' && /By itself/.test(words(byClass(x, 'panel-title')[0] || new FakeText(''))))[0];
  assert.ok(by, 'the By itself card');
  const more = inFold(by, 'More');
  assert.ok(more, 'a More in it');
  const inMore = new Set(switches(more));
  const open = switches(by).filter((s) => !inMore.has(s)).map(labelOf);
  assert.deepEqual(open, ['Keep the map up to date', 'Save the AI memory by itself', 'Keep the workspace in step', 'Also upload']);
  const hidden = switches(more).map(labelOf);
  assert.ok(hidden.some((l) => /Save a change of the map/.test(l)));
  assert.ok(hidden.some((l) => /once a day/.test(l)) && hidden.some((l) => /once a week/.test(l)));
  assert.ok(hidden.some((l) => /Push my other branches/.test(l)));
  assert.match(words(more), /Every how many hours/);
});

test('Hands-off: the net and the wall are in one More, the first paragraph stays', async () => {
  const p = page('handsoff');
  const box = new FakeElement('div');
  box.append(...[].concat(p.render()));
  await settle();
  const f = inFold(box, 'How it decides what to leave to you');
  assert.ok(f, 'one fold');
  assert.match(words(f), /the net, reads a question/);
  assert.match(words(f), /the wall, reads what a session is about to do/);
  const outside = words(box).replace(words(f), '');
  assert.match(outside, /With Hands-off on, Hoprig answers by itself/);
  assert.doesNotMatch(outside, /the net, reads|the wall, reads/);
});

test('Tia: the OK switch keeps its first sentence, the rest is folded; the git token is under Advanced', () => {
  const src = read('web/tia.js');
  assert.match(src, /When a Work task she started asks for an OK, she answers it, only to look inside the project or run its checks\./);
  assert.match(src, /fold\('tia-signin-advanced', 'Advanced', signinBlock\)/, 'the git sign-in sits inside a fold');
});
