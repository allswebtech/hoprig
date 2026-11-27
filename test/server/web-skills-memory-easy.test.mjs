// Skills and Memory as the two last tabs of Projects (the design that makes Hoprig easy): one Skills list with a search
// box, Installed, Worth adding and the drafts as a group, the settings under one closed Advanced fold; Memory with its
// groups folded and a file opened only on a tap; the tabs first on both pages; the four old Skills addresses and #/brain
// still landing right. Run in the page tests' small stand-in for the browser (test/chat/fakedom.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeElement, texts } from '../chat/fakedom.mjs';

globalThis.location ||= { hash: '', search: '', pathname: '/' };
globalThis.history ||= { replaceState() {} };
globalThis.window ||= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
const scrolled = [];
FakeElement.prototype.scrollIntoView = function scrollIntoView() {
  scrolled.push(this);
};
const { pageById } = await import('../../web/registry.js');
const skills = await import('../../web/skillhub.js');
const brain = await import('../../web/brain.js');

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 40; i++) await tick();
};
const all = (n, ok) => (n && n.children ? [...(ok(n) ? [n] : []), ...n.children.flatMap((c) => all(c, ok))] : []);
const say = (n) => texts(n).join(' ');
const heads = (n) => all(n, (x) => x.className.split(' ').includes('group-head')).map(say);

const skill = (name, description = 'Does a job.') => ({ name, description, edited: [], managed: true, source: { type: 'bundled', version: '1' } });
const ANSWERS = {
  '/api/skillhub': { user: { skills: [skill('webapp-testing'), skill('flutter-help')], dir: '/home/a/.claude/skills' }, project: null, home: '/home/a', settings: { weekly: false }, projects: [] },
  '/api/skillhub/suggest': { suggestions: [
    { id: 'owner/webapp-testing', name: 'webapp-testing', for: 'Test web apps.', why: ['it has a web page'], installed: true, scope: 'user' },
    { id: 'owner/postgres', name: 'postgres', for: 'Work with Postgres.', why: ['it has SQL'], installed: false, scope: 'user' }], stacks: {}, ideas: [] },
  '/api/skillhub/worth': { results: [{ name: 'nextjs-tips', description: 'Tips.', why: ['next in package.json'], hub: 'h1', hubName: 'Hub One', path: 'nextjs-tips', commit: 'abc', project: null }], lines: [], at: null },
  '/api/operator/corrections': { week: { skill: {} } },
  '/api/skills/learned': { drafts: [], looking: false, recent: [], on: false },
  '/api/skills/proposals': null,
  '/api/pcsetup/projects': { workspaces: [], repos: [] },
};
function stub(over = {}) {
  const table = { ...ANSWERS, ...over };
  const asked = [];
  globalThis.fetch = async (u) => {
    const path = String(u).replace(/^.*?(\/api\/)/, '/api/').split('?')[0];
    asked.push(path);
    const a = table[path];
    if (a === undefined || a === null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => (typeof a === 'function' ? a() : a) };
  };
  return asked;
}
const open = async (id, sub = '') => {
  let shown = null;
  const stop = pageById(id).render({ frame: (o) => (shown = o), sub });
  globalThis.document.body.replaceChildren(...shown.body.filter(Boolean)); // on the page, as in a browser
  await settle();
  return { shown, body: shown.body.filter(Boolean), stop };
};

test('both pages are registered under Projects, not listed as menu pages of their own', () => {
  for (const id of ['skills', 'brain']) {
    const p = pageById(id);
    assert.equal(p.navAs, 'workspace', `${id} lights up Projects`);
    assert.equal(p.group, null, `${id} is not a menu item`);
  }
  assert.equal(pageById('brain').title, 'Memory');
});

test('projectsTabs: Projects, Skills, Memory as links, the current one marked', () => {
  assert.equal(skills.projectsTabs, brain.projectsTabs, 'one function, exported by both pages');
  const bar = skills.projectsTabs('memory');
  const items = all(bar, (n) => n.tag === 'a');
  assert.deepEqual(items.map(say), ['Projects', 'Skills', 'Memory']);
  assert.deepEqual(items.map((a) => a.attrs.href), ['#/workspace', '#/skills', '#/brain']);
  assert.deepEqual(items.filter((a) => a.attrs['aria-current'] === 'page').map(say), ['Memory']);
});

test('Skills: the tabs are the first thing, then the search box, Installed and Worth adding, with no old tab', async () => {
  stub();
  const { body } = await open('skills');
  assert.equal(body[0].className, 'tabs', 'nothing above the tabs');
  assert.deepEqual(all(body[0], (n) => n.tag === 'a').map(say), ['Projects', 'Skills', 'Memory']);
  const page = body.map(say).join(' | ');
  assert.ok(all(body[1], (n) => n.tag === 'input' && n.attrs.type === 'search').length, 'the search box comes straight after the tabs');
  const h = body.flatMap(heads);
  assert.deepEqual(h, ['Installed 2', 'Worth adding 2'], 'the groups, in this order');
  assert.ok(page.indexOf('Installed') < page.indexOf('Worth adding'), 'Worth adding is below Installed');
  for (const gone of ['Suggested', 'Learned', 'Skills for:', 'Switch on', 'Kept in', 'Remove', 'Check for updates ']) assert.ok(!page.slice(0, page.indexOf('Advanced')).includes(gone), `not on the first screen: ${gone}`);
  assert.equal(all(body[0], (n) => n.tag === 'select').length, 0, 'no Skills for picker');
});

test('Worth adding holds only what is not installed, the catalog picks and the weekly finds', async () => {
  stub();
  const { body } = await open('skills');
  const worth = say(body.find((n) => heads(n).some((x) => x.startsWith('Worth adding'))));
  assert.match(worth, /postgres/);
  assert.match(worth, /nextjs-tips/);
  assert.match(worth, /from Hub One/);
  assert.doesNotMatch(worth, /webapp-testing/, 'an installed skill is not offered again');
});

test('an installed row has no Remove on it: a press opens its sheet', async () => {
  stub();
  const { body } = await open('skills');
  const installed = body.find((n) => heads(n).some((x) => x.startsWith('Installed')));
  const buttons = all(installed, (n) => n.tag === 'button').map(say);
  assert.ok(buttons.every((b) => !/Remove|Update/.test(b)), 'no Remove and no Update on a row');
  assert.equal(all(installed, (n) => n.tag === 'button' && n.className.split(' ').includes('row')).length, 2, 'two rows that open a sheet');
});

test('Advanced is one closed fold holding the update check, the tools, the weekly switch and the learn settings', async () => {
  stub();
  const { body } = await open('skills');
  const adv = body.at(-1);
  assert.equal(adv.tag, 'details');
  assert.ok(!adv.open && !('open' in adv.attrs), 'closed on first paint');
  const inside = say(adv);
  for (const w of ['Check for updates', 'Tools these skills use', 'Look for updates and new skills once a week']) assert.ok(inside.includes(w), w);
  assert.equal(all(body, (n) => n.tag === 'details' && (n.open || 'open' in n.attrs)).length, 0, 'no fold is open');
});

test('drafts are a group only while some wait', async () => {
  stub();
  let { body } = await open('skills');
  assert.ok(!body.map(say).join(' ').includes('Drafts from your work'), 'none waiting: no group, no empty card');
  stub({ '/api/skills/learned': { drafts: [], looking: false, recent: [], on: true } });
  ({ body } = await open('skills'));
  assert.ok(!body.map(say).join(' ').includes('Drafts'), 'learning on and nothing waiting: still nothing drawn');
  const draft = { id: 'd1', name: 'my-draft', state: 'ready', kind: 'new', createdAt: '2026-11-20T00:00:00Z', source: { trigger: 'session' }, why: 'because', risky: false, riskyWhy: [], counts: { high: 0, medium: 0 }, findings: [], tests: [], skillMd: '---\nname: x\n---\nBody', cost: null };
  stub({ '/api/skills/learned': { drafts: [draft], looking: false, recent: [], on: true } });
  ({ body } = await open('skills'));
  assert.deepEqual(body.flatMap(heads), ['Installed 2', 'Worth adding 2', 'Drafts from your work 1']);
});

test('the four old addresses open the one list with their part in view', async () => {
  for (const part of ['installed', 'suggested', 'find', 'learned']) {
    stub();
    scrolled.length = 0;
    const { body } = await open('skills', part);
    assert.equal(body[0].className, 'tabs', `${part}: the same page`);
    assert.deepEqual(body.flatMap(heads), ['Installed 2', 'Worth adding 2'], `${part}: the same groups`);
    const adv = body.at(-1);
    if (part === 'find') assert.equal(globalThis.document.activeElement.attrs.type, 'search', 'find: the search box has the cursor');
    if (part === 'suggested') assert.ok(scrolled.length, 'suggested: Worth adding is scrolled to');
    if (part === 'learned') assert.ok(adv.open, 'learned: the Advanced fold with the learn settings is open');
    else assert.ok(!adv.open, `${part}: Advanced stays closed`);
  }
});

test('a project folder after a part, or alone, still scopes the list to that project', async () => {
  stub({ '/api/skillhub': { user: { skills: [skill('mine')], dir: '/h' }, project: { skills: [skill('here')] }, home: '/h', settings: { weekly: false }, projects: [] } });
  for (const sub of ['%2Fp%2Fshop', 'installed/%2Fp%2Fshop']) {
    const { body } = await open('skills', sub);
    assert.equal(body[0].className, 'tabs');
    assert.match(say(body[1]), /^Skills for\s+shop/, sub);
    assert.ok(body.flatMap(heads).includes('In this project 1'), sub);
  }
});

const BRAIN = {
  brain: { exists: true, about: { id: 'a', title: 'About' }, learnings: null, activeContext: { id: 'c', title: 'Context' }, pending: null },
  global: { rules: { id: 'r', title: 'Rules' }, linked: true, more: [] },
  memory: { home: { count: 2, items: [{ id: 'm1', name: 'one', type: 'user', description: 'x', file: 'one.md' }, { id: 'm2', name: 'two', type: 'project', file: 'two.md' }] } },
  dailyLogs: { count: 0, items: [] },
  projects: [{ name: 'shop', agents: { id: 'sa', title: 'Rules' }, memory: { items: [] } }],
  skills: { used: 3, count: 3, brainOnly: 1 },
};
test('Memory: tabs first, the rules open, the other groups closed with counts, empty ones and projects and skills not drawn', async () => {
  const asked = stub({ '/api/brain': BRAIN, '/api/workspace/link': { brain: true, entries: [], tools: [], todo: 0 } });
  const { body } = await open('brain');
  assert.equal(body[0].className, 'tabs');
  assert.deepEqual(all(body[0], (n) => n.tag === 'a' && n.attrs['aria-current'] === 'page').map(say), ['Memory']);
  const list = say(body[1]);
  assert.ok(heads(body[1]).some((x) => x.startsWith('Rules for every tool')), 'the rules group is open');
  const folds = all(body[1], (n) => n.tag === 'details');
  const names = folds.map((f) => say(f.children[0]));
  assert.ok(names.includes('What they remembered (2)'), 'Memory is a fold with its count');
  assert.ok(names.includes('Learnings and current context (1)') || names.some((x) => x.startsWith('Learnings and current context')));
  for (const f of folds) assert.ok(!f.open && !('open' in f.attrs), 'closed on first paint');
  for (const gone of ['Daily logs', 'Pending', 'shop', 'Skills', 'claude code uses']) assert.ok(!list.toLowerCase().includes(gone.toLowerCase()), `not drawn: ${gone}`);
  assert.ok(!asked.includes('/api/brain/item'), 'no file is opened by itself');
  assert.match(say(body[1].children[1] || body[1]), /Pick a file to read it here/);
});

test('Memory: a file opens on its address, and the fold that holds it is open', async () => {
  const asked = stub({ '/api/brain': BRAIN, '/api/workspace/link': { brain: true, entries: [], tools: [], todo: 0 }, '/api/brain/item': { id: 'm2', title: 'two', file: 'two.md', size: 5, text: 'Hello' } });
  const { body } = await open('brain', 'm2');
  assert.ok(asked.includes('/api/brain/item'));
  const memory = all(body[1], (n) => n.tag === 'details').find((f) => say(f.children[0]).startsWith('What they remembered'));
  assert.ok(memory.open, 'the fold of the open file is open');
  assert.match(say(body[1]), /Hello/);
});

test('joined: Skills and Memory are reached from the menu through the tabs the Projects page draws first', async () => {
  await import('../../web/projects.js');
  const { navPages } = await import('../../web/registry.js');
  stub();
  const { body } = await open('workspace');
  assert.equal(body[0].className, 'tabs', 'the Projects page draws its tabs first');
  const tabs = all(body[0], (n) => n.tag === 'a');
  assert.deepEqual(tabs.map(say), ['Projects', 'Skills', 'Memory']);
  const menu = navPages('main').map((p) => p.id);
  assert.ok(menu.includes('workspace'), 'Projects is in the menu');
  assert.ok(!menu.includes('skills') && !menu.includes('brain'), 'Skills and Memory are not menu items of their own');
  const byTab = Object.fromEntries(tabs.map((a) => [say(a), a.attrs.href.replace('#/', '')]));
  assert.equal(pageById(byTab.Skills).render, pageById('skills').render, 'the Skills tab is the Skills page');
  assert.equal(pageById(byTab.Memory).title, 'Memory', 'the Memory tab is the Memory page');
  assert.equal(pageById('skills').navAs, 'workspace');
  assert.equal(pageById('brain').navAs, 'workspace');
});
