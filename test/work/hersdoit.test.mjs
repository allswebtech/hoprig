// A Work task Tia has a session do (manage_work start, through her door) and a goal she gives (manage_work goal) open
// a chat that is hers: the start asks the chat feature for a chat of hers, so it is marked and signed in as hers. The
// same starts from the owner's own page open a chat of his. The route decides, from who sent the request, never the body.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from './helpers.mjs';

const t = tempWork('work-hersdoit');
test.after(() => t.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore } = await import('../../src/work/store.mjs');
const { workRuns } = await import('../../src/work/doit.mjs');
const { planRunner } = await import('../../src/work/planai.mjs');
const { doRoutes } = await import('../../src/work/dofeature.mjs');

const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
const cfg = { work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' } };
saveConfig(cfg);
writeProfile('sub', { label: 'Main' });
const store = () => workStore(resolvePlace(cfg), { projects: projectNames() });

const opened = [];
const chat = {
  async open(o) {
    opened.push(o);
    return { sent: true, id: crypto.randomUUID(), messageId: crypto.randomUUID() };
  },
  peek: () => ({ busy: true, pending: false, lastEnd: null, lastText: '', conversationId: 'conv1' }),
  follow: () => () => {},
  turnEnd: () => null,
};
const runs = workRuns({ config: () => cfg, chat, defaultProvider: async () => 'sub', log: () => {} });
test.after(() => runs.close());
const planner = planRunner({ config: () => cfg, chat, defaultProvider: async () => 'sub', now: () => new Date('2026-11-18T09:00:00Z') });
test.after(() => planner.close());

test('Do it through her door opens a chat of hers; from his page, a chat of his', async () => {
  for (const [who, hers] of [['tia', true], ['page', false]]) {
    const { item } = await store().add({ title: `Fix the cart (${who})`, project: 'shop' });
    const routes = doRoutes({ runs, readJson: async (req) => req.body, refOf: (m, at) => ({ id: m[1], at }), ownerOnly: () => {}, resume: async () => {}, fromTia: (req) => req.who === 'tia' });
    const url = `/api/work/items/${item.id}/do`;
    const [, re, fn] = routes.find(([m, r]) => m === 'POST' && r.test(url));
    const before = opened.length;
    // A body cannot say whose the session is: the word is refused, nothing starts.
    await assert.rejects(fn({ who, body: { at: item.at, brief: 'Make the cart total right.', hers: true } }, re.exec(url)), /"hers" is not something this takes/);
    assert.equal(opened.length, before, 'nothing opened for a body that names hers');
    await fn({ who, body: { at: item.at, brief: 'Make the cart total right.' } }, re.exec(url));
    assert.equal(opened.length, before + 1, 'one chat opened');
    assert.equal(opened.at(-1).hers === true, hers, `${who}: hers is ${hers}`);
  }
});

test('a goal she gives plans in a chat of hers; his plans in a chat of his', async () => {
  await planner.start({ goal: 'Make the shop faster', project: 'shop' }, { hers: true });
  assert.equal(opened.at(-1).hers, true);
  await planner.start({ goal: 'Make the shop smaller', project: 'shop' });
  assert.equal(opened.at(-1).hers, undefined);
});
