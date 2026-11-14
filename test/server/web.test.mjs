// The page's DOM helper never renders null/undefined/false as text (a v1 bug showed "null" in three places), and
// no view builds DOM around it: views use fill()/add() from lib.js, never replaceChildren/append/innerHTML.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

// A small stand-in for the browser DOM: just what lib.js's h/fill/add use.
class FakeNode {}
class FakeText extends FakeNode {
  constructor(t) {
    super();
    this.text = t;
  }
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {} });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener(k, fn) {
    this.listeners[k] = fn;
  }
  append(...nodes) {
    for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n)));
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
}
globalThis.Node = FakeNode;
globalThis.document = {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => new FakeText(t),
  getElementById: () => null,
  addEventListener: () => {},
  visibilityState: 'visible',
};
const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));

const { h, fill, add } = await import('../../web/lib.js');

test('h(), fill() and add() skip nothing-children', () => {
  const el = h('div.a.b', null, 'x', null, undefined, false, true, '', ['y', [null, 'z']], 0);
  assert.deepEqual(texts(el), ['x', 'y', 'z', '0']);
  assert.equal(el.className, 'a b');
  const p = h('p', null);
  assert.deepEqual(texts(p), []);
  const c = h('div', { title: 't', onclick: () => {}, hidden: false }, 'k');
  assert.equal(c.attrs.title, 't');
  assert.ok(c.listeners.click);
  assert.equal('hidden' in c.attrs, false);
  fill(el, null, 'only', undefined);
  assert.deepEqual(texts(el), ['only']);
  add(el, false, 'more', null);
  assert.deepEqual(texts(el), ['only', 'more']);
  for (const t of texts(h('div', [null, undefined], h('span', null, undefined)))) assert.ok(!['null', 'undefined', 'false', 'true'].includes(t));
});

test('views build DOM only through the helpers', () => {
  const allowed = new Set(['lib.js', 'icons.js', 'login.js']);
  for (const f of fs.readdirSync(WEB).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(WEB, f), 'utf8');
    assert.doesNotMatch(src, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\(|document\.write\(/, `${f} must not build HTML from strings`);
    if (allowed.has(f)) continue;
    assert.doesNotMatch(src, /\.replaceChildren\(|\.append\(|\.appendChild\(/, `${f} must use fill()/add() from lib.js`);
  }
});

test('every API and WebSocket URL goes through lib.js url()/wsUrl()', () => {
  for (const f of fs.readdirSync(WEB).filter((x) => x.endsWith('.js') && x !== 'lib.js' && x !== 'login.js')) {
    const src = fs.readFileSync(path.join(WEB, f), 'utf8');
    assert.doesNotMatch(src, /fetch\(|new WebSocket\(\s*[`'"]/, `${f} must call api()/wsUrl() instead of fetch or a literal socket URL`);
    assert.doesNotMatch(src, /\.open\(\s*'POST',\s*[`'"]/, `${f} must pass upload URLs through url()`);
  }
});

// Most page files are only read as text here, so a broken one would pass every other test and break the page.
test('every page module parses', () => {
  for (const f of fs.readdirSync(WEB).filter((x) => x.endsWith('.js'))) {
    const r = spawnSync(process.execPath, ['--check', path.join(WEB, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test('the page references only files that exist', () => {
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8') + fs.readFileSync(path.join(WEB, 'login.html'), 'utf8');
  for (const [, ref] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (ref.startsWith('vendor/')) continue; // served from node_modules
    assert.ok(fs.existsSync(path.join(WEB, ref)), ref);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(WEB, 'manifest.webmanifest'), 'utf8'));
  for (const i of manifest.icons) assert.ok(fs.existsSync(path.join(WEB, i.src)), i.src);
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
});

test('pages: groups in order, visible() hides one from the navigation (routing still knows it), badge() gives its number', async () => {
  const { registerPage, navPages, allPages, navChanged, registerSettingsPage, registeredSettingsPages } = await import('../../web/registry.js');
  let on = true;
  let n = 0;
  registerPage({ id: 'probe-page', title: 'Probe', icon: 'info', group: 'more', order: 2, render: () => {}, visible: () => on, badge: () => n });
  registerPage({ id: 'plain-page', title: 'Plain', icon: 'info', group: 'more', order: 1, render: () => {} });
  registerPage({ id: 'broken-page', title: 'Broken', icon: 'info', group: 'more', order: 3, render: () => {}, visible: () => { throw new Error('x'); } });
  registerPage({ id: 'sub-page', title: 'Sub', icon: 'info', navAs: 'plain-page', render: () => {} });
  assert.deepEqual(navPages('more').map((p) => [p.id, p.count]), [['plain-page', 0], ['probe-page', 0], ['broken-page', 0]], 'sorted by order; a page without a group is not in the navigation');
  n = 3;
  assert.equal(navPages('more')[1].count, 3);
  on = false;
  assert.deepEqual(navPages('more').map((p) => p.id), ['plain-page', 'broken-page']);
  assert.ok(allPages().some((p) => p.id === 'probe-page'));
  for (const bad of ['s', 'm', 'new', 'more', 'pc', 'Bad', 'plain-page']) assert.throws(() => registerPage({ id: bad, title: 'x', render: () => {} }), /bad page id/, bad);
  assert.throws(() => registerPage({ id: 'odd-group', title: 'x', group: 'side', render: () => {} }), /bad group/);
  navChanged(); // no window here: a no-op, not an error
  registerSettingsPage({ id: 'probe-z', title: 'Z', icon: 'info', order: 90, render: () => [] });
  registerSettingsPage({ id: 'probe-a', title: 'A', icon: 'info', order: 5, summary: () => 'on', render: () => [] });
  assert.deepEqual(registeredSettingsPages().map((p) => p.id).filter((id) => id.startsWith('probe-')), ['probe-a', 'probe-z']);
  assert.throws(() => registerSettingsPage({ id: 'probe-a', title: 'again', render: () => [] }), /bad settings page id/);
});

// ---------- the pages the owner asked for: where each thing lives ----------
test('structure: the main pages, the second group, the Settings pages, and old addresses that still land', () => {
  const src = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');
  const pages = [...fs.readdirSync(WEB).filter((f) => f.endsWith('.js')).map(src).join('\n').matchAll(/registerPage\(\{\s*id: '([a-z-]+)', title: [^,]+, icon: '[a-z]+'(?:, group: '(main|more)', order: (\d+))?/g)];
  const group = (g) => pages.filter((m) => m[2] === g).sort((a, b) => a[3] - b[3]).map((m) => m[1]);
  assert.deepEqual(group('main'), ['workspace', 'providers', 'computers'], 'Home is the router\'s own, then Workspace · Providers · Computers');
  assert.deepEqual(group('more'), ['automations', 'skills', 'brain', 'tia', 'settings']);
  // Every address in PAGE_ADDRESSES (what Tia's open_screen may open) leads to a page that exists.
  const ids = new Set([...pages.map((m) => m[1]), ...[...fs.readdirSync(WEB).filter((f) => f.endsWith('.js')).map(src).join('\n').matchAll(/registerPage\(\{\s*id: '([a-z-]+)'/g)].map((m) => m[1])]);
  const list = /export const PAGE_ADDRESSES = \[([\s\S]*?)\];/.exec(src('app.js'))[1];
  const addresses = [...list.matchAll(/'(#\/[^']*)'/g)].map((m) => m[1]);
  assert.ok(addresses.length > 20);
  for (const a of addresses) {
    const first = a.slice(2).split('/')[0];
    assert.ok(first === '' || ['new', 'more'].includes(first) || ids.has(first), `${a} leads to a page`);
  }
  const settingsPages = [...fs.readdirSync(WEB).filter((f) => f.endsWith('.js')).map(src).join('\n').matchAll(/registerSettingsPage\(\{\s*id: '([a-z-]+)', title: ([^,]+), icon: '[a-z]+', order: (\d+)/g)]
    .sort((a, b) => a[3] - b[3]).map((m) => m[1]);
  assert.deepEqual(settingsPages, ['new-sessions', 'workspace', 'notifications', 'appearance', 'security', 'tia', 'addons', 'about']);
  const app = src('app.js');
  for (const [from, to] of [['/pc', '/computer'], ['/pc/projects', '/workspace'], ['/settings/accounts', '/providers'], ['/settings/computers', '/computers'], ['/settings/skills', '/skills'], ['/settings/signin', '/settings/security'], ['/settings/auto', '/providers'], ['/tia-settings', '/settings/tia']]) {
    assert.ok(app.includes(`'${from}': '${to}'`), `${from} → ${to}`);
  }
  for (const f of ['shell.js', 'home.js', 'newsession.js', 'accounts.js', 'settings.js']) {
    assert.doesNotMatch(src(f).split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n'), /'[^']*\bhoprig\b[^']*'/, `${f}: the name comes from brand.js`);
  }
});

// ---------- one kit ----------
test('one kit: tabs, results, steps and loading rows come from shell.js; no page keeps its own copy', async () => {
  const src = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');
  for (const f of fs.readdirSync(WEB).filter((x) => x.endsWith('.js') && x !== 'shell.js')) {
    const s = src(f);
    assert.doesNotMatch(s, /const (errorBox|okBox|steps|skeleton|stepper) = \([^)]*\) =>\s*h\(/, `${f}: use the one in shell.js`);
    assert.doesNotMatch(s, /h\('nav\.(cp|au|sk)-tabs/, `${f}: tabs come from tabBar()`);
  }
  for (const f of fs.readdirSync(WEB).filter((x) => x.startsWith('page-') && x.endsWith('.css'))) {
    assert.doesNotMatch(src(f), /\.(cp|au|sk)-tabs?\b|:has\(\.tia-chatwrap\)|\.pj-skel\b/, `${f}: the shared kit is in style.css`);
  }
  const { tabBar, errorBox, okBox, stepHeader, skeletonRows } = await import('../../web/shell.js');
  const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
  const bar = tabBar('Parts', [{ id: 'a', label: 'One', href: '#/x' }, { id: 'b', label: 'Two', href: '#/x/b', count: 3 }], 'b');
  assert.equal(bar.children.length, 2);
  assert.equal(bar.children[1].attrs['aria-current'], 'page');
  assert.deepEqual(texts(bar), ['One', 'Two', '3']);
  assert.ok(texts(errorBox('No', () => {})).includes('Try again'));
  assert.deepEqual(texts(okBox('Done')), ['Done']);
  assert.equal(stepHeader(['A', 'B', 'C'], 1).children.filter((li) => /on/.test(li.className)).length, 2);
  assert.equal(skeletonRows(2).children.length, 2);
  const session = src('session.js');
  assert.match(session, /registeredSessionActions\(\)/, 'feature rows in the more sheet look like the others');
});

test('one floating thing on a phone: Tia is a button in the page head there, the round launcher only on a desktop', async () => {
  const src = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');
  const { registerHeadTool, registeredHeadTools } = await import('../../web/registry.js');
  const before = registeredHeadTools().length;
  registerHeadTool(() => null);
  assert.equal(registeredHeadTools().length, before + 1);
  assert.match(src('shell.js'), /h\('div\.head-icons', registeredHeadTools\(\)/, 'the page head draws the registered buttons next to light/dark');
  assert.match(src('tia.js'), /registerHeadTool\(/);
  const css = src('page-automations.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /@media \(max-width: 899px\) \{\s*\.tia-launch \{ display: none; \}/, 'no round launcher on a phone');
  assert.match(css, /@media \(min-width: 900px\) \{\s*\.tia-headbtn \{ display: none; \}/, 'no head button on a desktop');
});

test('a project page shows its sessions with the same row as Workspace and Home', () => {
  const src = fs.readFileSync(path.join(WEB, 'projects.js'), 'utf8');
  const one = src.slice(src.indexOf('function viewProject('), src.indexOf('// ---- repositories ----'));
  assert.match(one, /sessionRow\(s, profiles/);
  assert.doesNotMatch(one, /listRow\(/);
});

test('New session: a folder outside the projects folder gets the line that leads to "Make it a project"', async () => {
  const { outsideProjects } = await import('../../web/newsession.js');
  const P = '/u/me/Workspace/projects';
  assert.equal(outsideProjects('/u/me/Downloads/thing', P), true);
  assert.equal(outsideProjects('/u/me/Workspace/projects-old', P), true, 'a name that only starts the same is outside');
  assert.equal(outsideProjects(P, P), false);
  assert.equal(outsideProjects(`${P}/shop/code/web`, P), false);
  assert.equal(outsideProjects(`${P}/`, P), false);
  assert.equal(outsideProjects('/u/me', P), false, 'the folders that hold the projects folder are no project to make');
  assert.equal(outsideProjects('/', P), false);
  assert.equal(outsideProjects('C:\\Users\\me\\scratch', 'C:\\Users\\me\\projects'), true);
  assert.equal(outsideProjects('C:\\Users\\me\\projects\\a', 'C:\\Users\\me\\projects'), false);
  assert.equal(outsideProjects('/x', null), false, 'nothing said while the projects folder is not known');
  const ns = fs.readFileSync(path.join(WEB, 'newsession.js'), 'utf8');
  assert.match(ns, /'Make it a project'/);
  assert.match(ns, /#\/new-project\/\$\{encodeURIComponent\(name\)\}/);
  const pj = fs.readFileSync(path.join(WEB, 'projects.js'), 'utf8');
  assert.match(pj, /function viewNewProject\(\{ frame, sub \}\)/, 'New project takes the name from the address');
  assert.match(pj, /if \(!NAME_RE\.test\(named\)\) named = ''/, 'and only a valid project name');
});

// ---------- the AI brain ----------
test('AI brain: a file is shown as safe formatting, never as HTML; the list is grouped the way a person reads it', async () => {
  const { mdView } = await import('../../web/mdtext.js');
  const tags = (n) => (n instanceof FakeText ? [] : [n.tag, ...n.children.flatMap(tags)]);
  const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
  const v = mdView('# Rules\n\n- one `npm test`\n- **two**\n\n<script>alert(1)</script>\n```\n<b>x</b>\n```');
  assert.deepEqual(tags(v).filter((t) => !['div', 'p', 'ul', 'li', 'code', 'strong', 'h2', 'pre'].includes(t)), [], 'only the formatting it makes itself');
  assert.ok(texts(v).includes('<script>alert(1)</script>'), 'markup in the file is text');
  assert.ok(texts(v).includes('<b>x</b>'));
  const { brainGroups } = await import('../../web/brain.js');
  const item = (id, extra = {}) => ({ id, title: id, file: `~/${id}`, size: 1, modified: 0, ...extra });
  const g = brainGroups({
    global: { rules: item('rules'), linked: true, more: [] },
    memory: { home: { count: 2, items: [item('MEMORY.md', { type: 'index' }), item('m1', { name: 'How I work', description: 'Short answers', type: 'user' })] } },
    brain: { about: null, learnings: item('learnings'), activeContext: null, pending: null },
    dailyLogs: { count: 1, items: [item('d1', { date: '2026-11-14' })] },
    projects: [{ name: 'shop', agents: item('agents'), decisions: null, learnings: null, activeContext: null, memory: { count: 0, items: [] } }],
  });
  assert.deepEqual(g.map((x) => x.title), ['What Claude is told everywhere', 'Memory', 'Learnings and current context', 'Daily logs', 'Pending', 'shop']);
  assert.deepEqual(g[1].rows[1], { item: g[1].rows[1].item, title: 'How I work', sub: 'Short answers', chip: 'about you' });
  assert.equal(g[4].rows.length, 0, 'nothing pending: the group says so instead of an empty box');
  const { when, indexOrder } = await import('../../web/brain.js');
  assert.match(when(new Date(Date.now() - 3 * 86400_000).toISOString()), /^3 d/, 'an ISO date from the route');
  assert.match(when(Date.now() - 3 * 86400_000), /^3 d/);
  assert.equal(when('not a date'), '');
  const order = indexOrder('- [How I work](working-style.md) — x\n- [Server](sub/test-server.md) — y');
  assert.deepEqual(order, ['working-style.md', 'test-server.md']);
  const g2 = brainGroups({
    global: { rules: null, linked: false, more: [] },
    memory: { home: { count: 3, items: [item('a', { file: '~/m/test-server.md', name: 'Server' }), item('i', { file: '~/m/MEMORY.md', type: 'index' }), item('b', { file: '~/m/working-style.md', name: 'How I work' })] } },
    brain: { about: null, learnings: null, activeContext: null, pending: null },
    dailyLogs: { count: 0, items: [] }, projects: [],
  }, { memoryOrder: order });
  assert.deepEqual(g2[1].rows.map((r) => r.title), ['Index of the memory', 'How I work', 'Server'], 'the index first, then in its order');
});

// ---------- styles ----------
test('styles: a selected state is never a bare class another rule can also style (the Settings list once took a wizard strip\'s monospace)', () => {
  for (const f of fs.readdirSync(WEB).filter((x) => x.endsWith('.css'))) {
    const css = fs.readFileSync(path.join(WEB, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const sel of css.split('}').map((r) => r.split('{')[0].trim()).filter((x) => x && !x.startsWith('@'))) {
      for (const one of sel.split(',').map((x) => x.trim())) {
        assert.doesNotMatch(one, /^\.(on|off|chosen|current|active|sel|selected)\b/, `${f}: "${one}" styles a bare state class; name the component first`);
        assert.doesNotMatch(one, /\.chosen\b/, `${f}: "${one}": a chosen row is marked with aria-current`);
        // A banner's colour word (".banner.info") alone once also matched a list's grid and stacked every info banner.
        assert.doesNotMatch(one, /^\.(info|warn|ok|error|danger)$/, `${f}: "${one}" is a banner colour; give the part its own name`);
      }
    }
  }
});

// ---------- the session view ----------
test('session view: the header holds back, name and state, the account and one more button; the rest is in the sheet, ending last', () => {
  const src = fs.readFileSync(path.join(WEB, 'session.js'), 'utf8');
  const header = /h\('header\.sessbar',([\s\S]*?)\),\n    needSlot/.exec(src)[1];
  assert.equal((header.match(/btn\(|h\('button|h\('a\./g) || []).length, 2, 'only the back link and the more button are drawn there; the name and the account are their own buttons');
  assert.match(header, /titleBtn/);
  assert.match(header, /profileBtn/);
  assert.doesNotMatch(src, /statusline/, 'no second bar under the header');
  const items = [...src.slice(src.indexOf('async function menu()')).matchAll(/\{ value: '([a-z]+)'/g)].map((m) => m[1]);
  assert.equal(items.at(-1), 'kill', 'ending the session is last');
  assert.match(src, /confirmSheet\(\{\s*title: `End "\$\{name\}"\?`/, 'and confirmed');
  assert.match(src, /title: 'Move to another provider'/);
  assert.match(src, /prefs\.get\('session\.keys', true\)/, 'the key bar folds away and remembers it');
  assert.match(src, /'Needs your OK'/, 'the same words as Home');
});

// ---------- Home ----------
test('Home: groups by what the session needs, plain terminals last, and one plain line about the providers', async () => {
  const { GROUPS, groupOf, accountsLine } = await import('../../web/home.js');
  assert.deepEqual(GROUPS.map((g) => g[1]), ['Needs you', 'Working', 'Waiting for your next message', 'Terminals']);
  assert.equal(groupOf({ status: 'attention' }), 'needs');
  assert.equal(groupOf({ status: 'waiting', limit: { text: 'x' } }), 'needs', 'a limit needs you');
  assert.equal(groupOf({ status: 'waiting' }), 'waiting', 'a finished turn only waits for the next message');
  assert.equal(groupOf({ status: 'working' }), 'working');
  assert.equal(groupOf({ kind: 'shell', status: 'shell' }), 'terminals', 'a plain terminal waits for no message');
  assert.equal(groupOf({ kind: 'shell' }), 'terminals');
  const { stateOf, needsYouFirst } = await import('../../web/lib.js');
  assert.equal(stateOf({ kind: 'shell', status: 'waiting' }).text, 'Terminal');
  assert.deepEqual([{ name: 't', kind: 'shell', activity: 9 }, { name: 'c', kind: 'claude', status: 'waiting', activity: 1 }].sort(needsYouFirst).map((s) => s.name), ['c', 't'], 'after the Claude sessions');
  const { markStarting } = await import('../../web/newsession.js');
  markStarting(null, 'fresh');
  assert.equal(groupOf({ name: 'fresh', machine: null, kind: 'shell', status: 'shell' }), 'working', 'just started from the page: Working, not a plain terminal');
  const acct = (label, pct, extra = {}) => ({ name: label.toLowerCase(), label, kind: 'subscription', usage: pct === null ? null : { fiveHour: { pct } }, ...extra });
  const one = (profiles) => [{ machine: null, machineLabel: 'Desk', profiles, autoSwitch: { order: [] } }];
  assert.deepEqual(accountsLine(one([acct('Max', 40), acct('Team', 10), { name: 'api', label: 'API', kind: 'api' }]), false), { text: '3 providers · all available', warn: false });
  assert.deepEqual(accountsLine(one([acct('Max', 96), acct('Team', 10)]), false), { text: 'Max is at 96% of its 5-hour limit', warn: true });
  assert.match(accountsLine(one([acct('Max', 20, { limited: {} })]), false).text, /^Max is at its limit$/);
  assert.deepEqual(accountsLine(one([]), false).warn, true);
  const two = [{ machine: null, machineLabel: 'Desk', profiles: [acct('Max', 96)] }, { machine: 'lap', machineLabel: 'Lap', profiles: [acct('Team', 5)] }];
  assert.equal(accountsLine(two, true).text, 'Desk: Max is at 96% of its 5-hour limit', 'the computer named once, only where something is near a limit');
  assert.equal(accountsLine([two[1]], true).text, '1 provider · all available');
});

// ---------- Home → Get started ----------
const STEPS = [
  { id: 'claude', title: 'Claude Code installed and signed in', done: true, optional: false, detail: 'Claude Code 2.1.330', action: null },
  { id: 'tools', title: 'Tools for coding', done: true, optional: false, detail: 'all here', action: null },
  { id: 'rules', title: 'Working rules for Claude', done: true, optional: false, detail: 'added', action: null },
  { id: 'project', title: 'A first project', done: false, optional: false, detail: 'none yet', action: { kind: 'page', target: 'pc/projects' } },
  { id: 'skills', title: 'Skills for Claude', done: false, optional: false, detail: 'none yet', action: { kind: 'page', target: 'settings/skills' } },
  { id: 'phone', title: 'Your phone signed in', done: false, optional: false, detail: 'scan a code', action: { kind: 'terminal', run: 'claude-login', label: 'Sign in to Claude' } },
  { id: 'account2', title: 'A second account', done: false, optional: true, detail: '', action: { kind: 'page', target: 'settings/accounts' } },
];

test('Get started: the next step, the count, collapse when done, hidden when closed', async () => {
  const { planGetStarted, actionLabel, TARGETS, getStartedCard } = await import('../../web/getstarted.js');
  const onb = { steps: STEPS, done: 3, total: 6 };
  let p = planGetStarted(onb);
  assert.equal(p.mode, 'open');
  assert.equal(p.next.id, 'project', 'the first required step not done');
  assert.deepEqual([p.done, p.total], [3, 6]);
  assert.deepEqual(p.later.map((s) => s.id), ['account2'], 'optional steps wait under Later');
  assert.equal(p.claudeReady, true);
  const allDone = { steps: STEPS.map((s) => (s.optional ? s : { ...s, done: true, action: null })), done: 6, total: 6 };
  p = planGetStarted(allDone);
  assert.equal(p.mode, 'collapsed');
  assert.equal(p.next, null);
  assert.equal(planGetStarted(onb, { dismissed: true }).mode, 'hidden');
  assert.equal(planGetStarted(null).mode, 'hidden');
  assert.equal(planGetStarted({ steps: [] }).mode, 'hidden');
  assert.equal(actionLabel({ kind: 'terminal', run: 'setup', label: 'Set up Claude Code' }), 'Set up Claude Code');
  assert.equal(actionLabel({ kind: 'page', target: 'pc/setup' }), 'Open');
  assert.equal(actionLabel({ kind: 'request', method: 'POST', path: '/api/x' }), 'Do it');
  for (const t of ['pc/setup', 'pc/projects', 'settings/skills', 'settings/signin-device', 'settings/accounts', 'settings/computers']) assert.ok(TARGETS[t], t);
  assert.deepEqual([TARGETS['pc/projects'], TARGETS['settings/accounts'], TARGETS['settings/signin-device']], ['#/workspace', '#/providers', '#/settings/security']);
  // the card: one prominent button (the next step's), a one-line summary once done, nothing once closed
  const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
  const buttons = (n) => (n instanceof FakeText ? [] : [...(n.tag === 'button' ? [n] : []), ...n.children.flatMap(buttons)]);
  // some steps done: only the next one and a way to the rest, so the sessions stay in view
  const compact = getStartedCard(onb, { firstRun: true });
  assert.ok(/compact/.test(compact.className));
  assert.ok(texts(compact).join(' ').includes('3 of 6'));
  assert.ok(texts(compact).join(' ').includes('A first project'), 'the next step');
  assert.ok(!texts(compact).join(' ').includes('Tools for coding'), 'not the done ones');
  assert.ok(texts(compact).join(' ').includes('Show all 6 steps'));
  const open = getStartedCard(onb, { firstRun: true, expanded: true });
  assert.ok(texts(open).join(' ').includes('Get started'));
  assert.ok(texts(open).join(' ').includes('Tools for coding'));
  assert.ok(texts(open).join(' ').includes('sets everything up'), 'the pitch on the first screen');
  assert.equal(buttons(open).filter((b) => /primary/.test(b.className)).length, 1, 'one prominent button: the next step');
  assert.ok(texts(getStartedCard({ steps: STEPS.map((x) => ({ ...x, done: false })), done: 0, total: 6 }, { firstRun: true })).join(' ').includes('Tools for coding'), 'nothing done yet: every step shows');
  const line = getStartedCard(allDone, {});
  assert.ok(/collapsed/.test(line.className));
  assert.ok(texts(line).join('').includes('all 6 done'));
  assert.equal(getStartedCard(onb, { dismissed: true }), null);
});

// ---------- Settings → Add-ons: the public link ----------
test('add-ons: no "Set up as a provider" for the public link, notes before Start, its own address while it runs', async () => {
  const { addonView } = await import('../../web/addons.js');
  const gateway = addonView({ id: 'trouteai', installed: true, running: true, url: 'http://localhost:20017' });
  assert.deepEqual([gateway.showAccount, gateway.confirmStart, gateway.showAddress], [true, false, false]);
  const notes = ['The address changes every time it starts, and stops working when it stops.'];
  const stopped = addonView({ id: 'publiclink', installed: true, running: false, account: false, notes });
  assert.deepEqual([stopped.showAccount, stopped.confirmStart, stopped.showAddress], [false, true, false]);
  const running = addonView({ id: 'publiclink', installed: true, running: true, account: false, url: 'https://a-b-c.trycloudflare.com', notes });
  assert.equal(running.showAddress, true);
  const src = fs.readFileSync(path.join(WEB, 'addons.js'), 'utf8');
  assert.match(src, /api\('~\/api\/login\/links', \{ base: a\.url \}\)/, 'the sign-in QR is made for that address');
  assert.match(src, /changes each time it starts and is not for permanent use/);
});

// ---------- wording ----------
test('wording: "provider" and "computer" in everything a visitor reads; Auto mode promises "without stopping" only for API', async () => {
  for (const f of fs.readdirSync(WEB).filter((x) => x.endsWith('.js') || x.endsWith('.html'))) {
    const visible = fs.readFileSync(path.join(WEB, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const m of visible.matchAll(/(['"`])((?:(?!\1).)*)\1/g)) {
      const t = m[2];
      if (/^[a-z][\w.-]*$/.test(t) || t.includes('/api/') || t.includes('${')) continue; // identifiers, routes, templates
      assert.doesNotMatch(t, /\bPC\b/, `${f}: "${t}" — say "computer"`);
      assert.doesNotMatch(t, /\b[Pp]rofiles?\b/, `${f}: "${t}" — say "provider"`);
      // "account" is only the Claude (or GitHub) account a person signs in to; what the list holds is a provider.
      assert.doesNotMatch(t, /\b(API|next|one more) accounts?\b|\bunder Accounts\b|\b(On|as) (the|an) account\b|\baccount file\b|which accounts\b/, `${f}: "${t}" — say "provider"`);
    }
  }
  const accounts = fs.readFileSync(path.join(WEB, 'accounts.js'), 'utf8');
  assert.doesNotMatch(accounts, /never stop at a usage limit/);
  assert.match(accounts, /'Stop and ask me'/);
  assert.match(accounts, /Work continues on the next provider in the order below, without you doing anything\. This is called Auto mode\./);
  assert.match(accounts, /On an API provider the session goes on without stopping\./);
  assert.match(accounts, /On another subscription, Claude restarts on that provider/);
  const { subscriptionsNote, manySubscriptions } = await import('../../web/lib.js');
  const sub = (n) => ({ name: n, kind: 'subscription' });
  assert.equal(manySubscriptions([sub('a'), { name: 'api', kind: 'api' }]), false);
  assert.equal(subscriptionsNote([sub('a'), { name: 'api', kind: 'api' }]), null);
  assert.equal(manySubscriptions([sub('a'), { name: 'b', kind: 'login' }]), true);
  const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
  const note = texts(subscriptionsNote([sub('a'), sub('b')])).join('');
  assert.match(note, /restarts Claude as the next one/);
  assert.match(note, /one subscription, then an API provider/);
  assert.match(note, /Is this allowed\?/);
});

// ---------- several computers, a hub, providers that sign in ----------
test('a computer runs sessions only when online, not a hub, with Claude Code and a provider; the reason otherwise', async () => {
  const { runsSessions } = await import('../../web/store.js');
  const p = [{ name: 'max' }];
  assert.deepEqual(runsSessions({ status: 'online', profiles: p }), { ok: true, why: '' });
  assert.equal(runsSessions({ status: 'online', profiles: p }, undefined).ok, true, 'Claude Code not asked yet counts as there');
  assert.match(runsSessions({ status: 'offline', profiles: p }).why, /Not reachable/);
  assert.match(runsSessions({ status: 'online', hub: true, profiles: p }).why, /hub/);
  assert.match(runsSessions({ status: 'online', profiles: p }, null).why, /Claude Code is not installed/);
  assert.match(runsSessions({ status: 'online', profiles: [{ name: 'auto', virtual: true }] }).why, /No provider/);
  const src = fs.readFileSync(path.join(WEB, 'newsession.js'), 'utf8');
  assert.match(src, /groupHead\('Computer'\)/, 'the computer is the first choice');
  assert.match(src, /location\.hash = link\('#\/new', m\.machine\)/, 'the choice is the address, as the computer pill');
  assert.doesNotMatch(src, /select\('Computer'/, 'not hidden under Options any more');
  assert.match(src, /select\('Model'/, 'a model for this one session');
  assert.match(src, /model: st\.model \|\| null/);
  const app = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  assert.match(app, /CODING_PAGES\.includes\(page\.id\) && onHub\(hash\)/, 'a hub opens the coding pages on a computer that codes');
});

test('Get started on a hub: its own three steps, the phone step from the server', async () => {
  const { hubOnboarding, isHub, planGetStarted } = await import('../../web/getstarted.js');
  const onb = { steps: [{ id: 'claude', title: 'Claude Code', done: false, detail: 'Claude Code is not installed' }, { id: 'phone', title: 'Your phone signed in', done: true, detail: '2 browsers signed in' }], done: 1, total: 6 };
  const hub = hubOnboarding(onb, { https: true, joined: false });
  assert.deepEqual(hub.steps.map((s) => [s.id, s.done]), [['reachable', true], ['computer', false], ['phone', true]]);
  assert.deepEqual([hub.done, hub.total], [2, 3]);
  assert.equal(planGetStarted(hub).next.id, 'computer');
  assert.equal(isHub({ hub: true }, null, 1), true, 'marked by setup --hub');
  assert.equal(isHub({}, onb, 2), true, 'an older setup: no Claude Code here, others linked');
  assert.equal(isHub({}, onb, 1), false, 'a fresh computer without Claude Code is no hub');
});

test('providers: "Not signed in" with a Sign in button; usage with its age; a plan without usage says so', async () => {
  const { accountsLine } = await import('../../web/home.js');
  const line = accountsLine([{ machineLabel: 'A', profiles: [{ label: 'Pro', signedIn: false }, { label: 'Max', signedIn: true }] }], false);
  assert.deepEqual(line, { text: 'Pro is not signed in', warn: true }, 'never "all available" while one is not signed in');
  assert.equal(accountsLine([{ profiles: [{ label: 'Max', signedIn: null }] }], false).text, '1 provider · all available', 'not checked yet claims nothing');
  const { profileState } = await import('../../web/lib.js');
  assert.deepEqual(profileState({ signedIn: false, kind: 'login' }), { key: 'signin', text: 'Not signed in' });
  assert.equal(profileState({ signedIn: null, kind: 'login' }).text, 'Available', 'not checked yet is no warning');
  const { usageBars } = await import('../../web/accounts.js');
  const texts = (n) => (!n ? [] : n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
  assert.deepEqual(texts(usageBars(null, false)), ['This plan does not report its usage.']);
  assert.equal(usageBars(null, null), null, 'nothing known yet: nothing');
  const running = texts(usageBars({ fiveHour: { pct: 40 }, at: Date.now() - 2 * 3600_000 }, true, true)).join(' ');
  assert.doesNotMatch(running, /as of/, 'a session of it runs: the figures are fresh');
  assert.match(texts(usageBars({ fiveHour: { pct: 40 }, at: Date.now() - 2 * 3600_000 })).join(' '), /as of 2 h ago/);
  const src = fs.readFileSync(path.join(WEB, 'accounts.js'), 'utf8');
  assert.match(src, /'Sign in'/);
  assert.match(src, /subscription\/start'\), \{ mode: 'signin', name: signIn\.name \}/, 'sign in again: the server\'s own request');
  assert.match(src, /Sign in again to \$\{signIn\.label\}/);
  assert.doesNotMatch(src, /h\(`a\.row\.acct/, 'a row with a button inside is no link element');
});

test('joining: the server\'s whole line when it gives one, its note under it; the fingerprint is sent when typed', () => {
  const src = fs.readFileSync(path.join(WEB, 'computers.js'), 'utf8');
  assert.match(src, /const cmd = c\.command \|\| /);
  assert.match(src, /c\.note \? h\('span\.hint', c\.note\)/);
  assert.match(src, /fingerprint \? \{ fingerprint \} : \{\}/);
  assert.match(src, /Fingerprint \(only when the hub\\'s line has one\)/);
});

test('session view: the short placeholder on a narrow screen', () => {
  const src = fs.readFileSync(path.join(WEB, 'session.js'), 'utf8');
  assert.match(src, /matchMedia\('\(max-width: 599px\)'\)/);
  assert.match(src, /: 'Message Claude'\)/);
});

// ---------- the workspace through git ----------
test('workspace: one line about it, the map in groups, commands that still work when pasted', async () => {
  const { workspaceLine, mapGroups, homeCommand } = await import('../../web/workspace.js');
  const map = { exists: true, entries: [
    { kind: 'brain', label: 'ai_brain', state: 'here' },
    { kind: 'project', label: 'shop', state: 'here' }, { kind: 'repo', label: 'shop/code/api', state: 'here' },
    { kind: 'project', label: 'invoices', state: 'missing' },
    { kind: 'other', label: 'git/tool', state: 'here' }, { kind: 'other', label: 'development/flutter', state: 'here', tool: true },
  ], map: { others: [] } };
  assert.equal(workspaceLine(map, null).text, '1 project in your map is not on this computer');
  const job = { kind: 'sync', result: { data: { todo: 2, repos: [{ label: 'a', todo: [{ kind: 'diverged' }] }, { label: 'b', todo: [{ kind: 'to-push' }] }, { label: 'invoices', todo: [{ kind: 'missing' }] }] } } };
  assert.equal(workspaceLine({ ...map, entries: map.entries.filter((e) => e.state !== 'missing') }, job).text, '2 repositories have changes to look at', '"not here" is not a change to look at');
  assert.equal(workspaceLine({ exists: true, entries: [] }, { kind: 'sync', result: { data: { todo: 0, repos: [] } } }).text, 'In step with git');
  assert.equal(workspaceLine({ exists: true, entries: [] }, null).text, 'Not synced from here yet', 'never "in step" without a sync');
  assert.equal(workspaceLine({ exists: false, entries: [] }, null).noMap, true);
  const g = mapGroups(map);
  assert.deepEqual(g.map((x) => x.id), ['brain', 'project', 'other', 'tool']);
  assert.deepEqual(g[1].rows.map((r) => [r.label, r.repos.map((x) => x.label)]), [['shop', ['shop/code/api']], ['invoices', []]]);
  assert.deepEqual(g[3].rows.map((r) => r.label), ['development/flutter'], 'a tool has a group of its own');
  assert.equal(homeCommand('git -C "/h/me/Workspace/ai_brain" add workspace.json', '/h/me'), 'git -C ~/"Workspace/ai_brain" add workspace.json');
  const { notHereLine } = await import('../../web/workspace.js');
  const texts = (n) => (!n ? [] : n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
  const line = notHereLine({ notHere: ['invoices', 'invoices/code/api'], map: { projects: [{ name: 'invoices', url: 'https://git.example.com/x/invoices.git' }], others: [] } });
  assert.deepEqual(texts(line), ['Stays in the map, not on this computer: invoices', 'Get invoices'], 'a project once, its repositories come with it');
  assert.equal(notHereLine({ notHere: [] }), null);
  const src = fs.readFileSync(path.join(WEB, 'workspace.js'), 'utf8');
  assert.doesNotMatch(src, /Writing removes it from the map/, 'only Forget takes something out of the map');
  assert.match(src, /import \{ startButton, syncRows \} from '\.\/projects\.js'/, 'the same result rows as a project\'s Sync');
  assert.match(src, /no password is typed into this dashboard|Nothing was moved/);
  assert.match(fs.readFileSync(path.join(WEB, 'gitsetup.js'), 'utf8'), /no password is typed into this dashboard/);
});

test('Git and GitHub: three rows, done only when all are; a step of Get started', async () => {
  const { gitRows, gitDone } = await import('../../web/gitsetup.js');
  const good = { git: true, identity: { set: true, name: 'A', email: 'a@example.invalid' }, gh: { installed: true, signedIn: true, account: 'a' }, brain: { exists: true, git: true, remote: 'https://git.example.com/a/b.git', upstream: 'origin/main', ahead: 0, behind: 0, changes: 0 } };
  assert.equal(gitDone(good), true);
  const out = { ...good, gh: { installed: true, signedIn: false, account: null }, brain: { exists: true, git: true, remote: null } };
  assert.deepEqual(gitRows(out).map((r) => [r.ok, r.text]), [[true, 'A · a@example.invalid'], [false, 'Not signed in'], [false, 'Not on a git server yet']]);
  assert.match(gitRows({ ...good, brain: { ...good.brain, ahead: 2 } })[2].text, /2 to upload/);
  const { withGitStep, actionLabel } = await import('../../web/getstarted.js');
  const onb = { steps: [{ id: 'claude', done: true }], done: 1, total: 1 };
  const w = withGitStep(onb, out);
  assert.deepEqual([w.done, w.total, w.steps[1].id, w.steps[1].action.kind], [1, 2, 'git', 'git']);
  assert.equal(withGitStep(onb, null), onb, 'an older computer: the list as it came');
  assert.equal(actionLabel({ kind: 'git' }), 'Set up git and GitHub');
});
