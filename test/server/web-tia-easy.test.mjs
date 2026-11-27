// Tia made easy (lane tia of the easy design): her page is out of the menu and has a one-line head; her Off screen is a
// heading, one line and one button; Settings -> Tia opens with her switch and the level, then closed folds in a fixed
// order; her Activity also shows Done by Tia; the mission limits and roles come from mission.js as one part.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { FakeElement, FakeText, byClass, texts } from '../chat/fakedom.mjs';

const read = (f) => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
const reply = (body, status = 200) => ({ status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body) });
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 5));
};
const words = (n) => texts(n).join(' ').replace(/\s+/g, ' ');
const walk = (n, f, out = []) => {
  if (n instanceof FakeElement) {
    if (f(n)) out.push(n);
    n.children.forEach((c) => walk(c, f, out));
  }
  return out;
};
const isFold = (x) => x.tag === 'details' && x.className.split(' ').includes('fold');
// The words a person sees: what sits inside a closed fold is left out.
const shown = (n) => (n instanceof FakeElement ? (isFold(n) ? foldTitle(n) : n.children.map(shown).join(' ')) : n.text || '');
const foldTitle = (d) => words(d.children[0]).trim();

const SETTINGS = {
  settings: { enabled: true, level: 'ask', allowed: ['sub'], accounts: ['sub'], runsOnSet: '', model: '', lead: false, others: [], maxSteps: 20, maxMinutes: 60, computers: [], dailyCapUsd: null, answersHers: false },
  help: { enabled: 'Tia is on. She may start sessions.', levelAsk: 'ask text', levelWork: 'work text', levelHandsoff: 'hands text', levelShort: { ask: 'Asks first.', work: 'Does the work.', handsoff: 'Hands off.' }, dailyCapUsd: 'cap text', accounts: 'accounts text', computers: 'c', runsOn: 'r', maxSteps: 's', maxMinutes: 'm', model: 'mo', usage: 'u', client: 'cl' },
  levels: ['ask', 'work', 'handsoff'], accounts: [{ name: 'sub', label: 'Sub', kind: 'subscription' }], automatic: { runsOn: 'sub' }, autoOn: false, computers: [],
  spend: { cap: null, today: { spent: 0, held: 0, unmeasured: 0 } },
  usage: { today: { turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0 }, week: { turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0 }, conversations: [] },
  client: null,
};
const MISSIONS = {
  settings: { on: true, offStops: false, projects: {}, capUsd: 2, capTokens: 0, atOnce: 1, minutes: 30, hours: null, providers: [], selfAccept: [], rolesOff: [] },
  providers: [], slots: 1, projects: [], missions: [], broken: [], team: [{ role: 'developer', on: true, tasks: 0, runs: 0, judged: 0, passedFirst: 0, tokens: 0, cost: 0, minutes: 0 }], corrected: {}, steps: [],
};
const routes = {};
globalThis.fetch = async (u) => {
  const p = String(u).split('?')[0].replace(/^~/, '');
  const r = routes[p];
  if (r === undefined) return reply({ error: 'no such route' }, 404);
  return reply(typeof r === 'function' ? r() : structuredClone(r));
};
Object.assign(routes, {
  '/api/assistant/settings': SETTINGS,
  '/api/work/missions': MISSIONS,
  '/api/operator/attention': { reflexes: null, byTia: [] },
  '/api/herrights': { level: 'off', sudoPresent: false, fullOffered: false, sentence: 'x' },
  '/api/hersignin': { file: '' },
});

const { registeredSettingsPages, pageById } = await import('../../web/registry.js');
const tia = await import('../../web/tia.js');
const mission = await import('../../web/mission.js');
const src = read('web/tia.js');

test('her page is out of the menu and lights Settings; her head is one short line that keeps the promise', () => {
  const p = pageById('tia');
  assert.equal(p.group, null, 'no menu item of her own');
  assert.equal(p.navAs, 'settings');
  assert.equal(typeof tia.HEAD_LINE, 'string');
  assert.ok(tia.HEAD_LINE.split(' ').length <= 9, tia.HEAD_LINE);
  assert.match(tia.HEAD_LINE, /risky/);
  assert.match(src, /intro: HEAD_LINE,/);
  const frame = src.slice(src.indexOf('  frame({\n    title: ['), src.indexOf('fillWindow: !sub'));
  assert.doesNotMatch(frame, /experimental/, 'no tag on her page head');
  assert.doesNotMatch(src.slice(src.indexOf('function paintState'), src.indexOf('async function overview')), /experimental/, 'nor on her Off screen');
});

test('her Off screen is a heading, one line and one button', () => {
  const off = src.slice(src.indexOf("h('div.tia-off',"), src.indexOf('return false;', src.indexOf("h('div.tia-off',")));
  assert.equal((off.match(/h\('h2\./g) || []).length, 1);
  assert.equal((off.match(/h\('p'/g) || []).length, 1);
  assert.equal((off.match(/h\('a\.btn/g) || []).length, 1);
});

test('Settings -> Tia: her switch and the level first, then five closed folds in one order', async () => {
  const page = registeredSettingsPages().find((x) => x.id === 'tia');
  const out = [].concat(await page.render({ isAlive: () => true })).flat().filter(Boolean);
  await settle();
  const box = new FakeElement('div');
  box.append(...out);
  const top = out.filter((n) => !(n instanceof FakeElement && isFold(n)));
  const topWords = top.map(shown).join(' ');
  assert.match(topWords, /Tia is on/, 'her switch is on the first screen');
  assert.match(topWords, /Ask me/, 'the level is on the first screen');
  assert.doesNotMatch(topWords, /Asks first\./, 'the three level lines are not on the first screen');
  const folds = out.filter((n) => n instanceof FakeElement && isFold(n));
  assert.deepEqual(folds.map(foldTitle), ['What she may do alone', 'Limits and roles', 'Rights', 'Self-improvement', 'Usage and token']);
  assert.ok(folds.every((d) => !d.open), 'every fold is closed at first');
  const w = words(box);
  assert.doesNotMatch(w, /experimental/);
});

test('Settings -> Tia off: only her switch and the folds, no level', async () => {
  routes['/api/assistant/settings'] = { ...SETTINGS, settings: { ...SETTINGS.settings, enabled: false } };
  const page = registeredSettingsPages().find((x) => x.id === 'tia');
  const out = [].concat(await page.render({ isAlive: () => true })).flat().filter(Boolean);
  await settle();
  const topWords = out.filter((n) => !(n instanceof FakeElement && isFold(n))).map(shown).join(' ');
  assert.doesNotMatch(topWords, /Ask me/);
  routes['/api/assistant/settings'] = SETTINGS;
});

test('the limits and roles part: her switches and limits without a second fold of its own, the team numbers folded', async () => {
  assert.equal(typeof mission.missionLimits, 'function');
  const part = mission.missionLimits();
  await settle();
  const w = words(part);
  assert.match(w, /Tia works by herself/);
  assert.match(w, /Spend cap per day/);
  assert.match(w, /Roles/);
  const inner = walk(part, isFold).map(foldTitle);
  assert.ok(!inner.includes('Tia\'s switches and limits'), inner.join('|'));
  assert.ok(inner.includes('Her team: roles and numbers'), inner.join('|'));
  const team = walk(part, isFold).find((d) => foldTitle(d) === 'Her team: roles and numbers');
  assert.ok(!team.open);
});

test('Activity also shows Done by Tia, above her own log, and hides it when empty', () => {
  const act = src.slice(src.indexOf('async function activityView'), src.indexOf('const draw = () =>'));
  assert.match(act, /byTiaList\(/);
  assert.match(act, /Done by Tia/);
  assert.match(act, /\/api\/operator\/attention/);
  assert.match(act, /byTia\.length|\.byTia \|\| \[\]\)\.length/, 'only when something was done');
});

test('her Settings row has one short line, and keeps the experimental tag', () => {
  const page = registeredSettingsPages().find((x) => x.id === 'tia');
  assert.ok(page.desc.split(' ').length <= 12, page.desc);
  assert.equal(page.tag, 'experimental');
});
