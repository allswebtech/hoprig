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
// Every page module, also in the page's folders (web/chat/): "chat/page.js".
const pageFiles = (ext = '.js') => fs.readdirSync(WEB, { recursive: true }).map(String).filter((x) => x.endsWith(ext)).sort();

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
  for (const f of pageFiles()) {
    const src = fs.readFileSync(path.join(WEB, f), 'utf8');
    assert.doesNotMatch(src, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\(|document\.write\(/, `${f} must not build HTML from strings`);
    if (allowed.has(f)) continue;
    assert.doesNotMatch(src, /\.replaceChildren\(|\.append\(|\.appendChild\(/, `${f} must use fill()/add() from lib.js`);
  }
});

test('every API and WebSocket URL goes through lib.js url()/wsUrl()', () => {
  for (const f of pageFiles().filter((x) => x !== 'lib.js' && x !== 'login.js')) {
    const src = fs.readFileSync(path.join(WEB, f), 'utf8');
    assert.doesNotMatch(src, /fetch\(|new WebSocket\(\s*[`'"]/, `${f} must call api()/wsUrl() instead of fetch or a literal socket URL`);
    assert.doesNotMatch(src, /\.open\(\s*'POST',\s*[`'"]/, `${f} must pass upload URLs through url()`);
  }
});

// Most page files are only read as text here, so a broken one would pass every other test and break the page.
test('every page module parses', () => {
  for (const f of pageFiles()) {
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
  const pages = [...pageFiles().map(src).join('\n').matchAll(/registerPage\(\{\s*id: '([a-z-]+)', title: [^,]+, icon: '[a-z]+'(?:, group: '(main|more)', order: (\d+))?/g)];
  const group = (g) => pages.filter((m) => m[2] === g).sort((a, b) => a[3] - b[3]).map((m) => m[1]);
  assert.deepEqual(group('main'), ['work', 'workspace', 'providers', 'computers'], 'Home is the router\'s own, then Work · Workspace · Providers · Computers');
  // Automations has no page of its own any more: Work → Schedules, Settings → Automations, Work → Activity.
  // The menu is Home, Work, Workspace, Providers, Computers and Settings last (shell.js menuItems); no More page.
  // Skills and Memory are tabs of Projects (navAs: 'workspace'); Tia has no item of her own (her button and Settings -> Tia).
  assert.deepEqual(group('more'), ['settings']);
  assert.match(src('tia.js'), /registerPage\(\{\s*id: 'tia', title: NAME, icon: 'sparkle', navAs: 'settings'/);
  // Every address in PAGE_ADDRESSES (what Tia's open_screen may open) leads to a page that exists.
  const ids = new Set([...pages.map((m) => m[1]), ...[...pageFiles().map(src).join('\n').matchAll(/registerPage\(\{\s*id: '([a-z-]+)'/g)].map((m) => m[1])]);
  const list = /export const PAGE_ADDRESSES = \[([\s\S]*?)\];/.exec(src('app.js'))[1];
  const addresses = [...list.matchAll(/'(#\/[^']*)'/g)].map((m) => m[1]);
  assert.ok(addresses.length > 20);
  for (const a of addresses) {
    const first = a.slice(2).split('/')[0];
    assert.ok(first === '' || ['new'].includes(first) || a === '#/more' || ids.has(first), `${a} leads to a page`);
  }
  // The Settings pages, in the order of the list (registry.js SETTINGS_ORDER wins over a file's own number): the design's
  // order, nothing else. Editor, Coding tools, About, Work and Field reports are cards of other pages now.
  const order = /export const SETTINGS_ORDER = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(src('registry.js'))[1];
  const rank = Object.fromEntries([...order.matchAll(/'?([a-z-]+)'?: (\d+)/g)].map((m) => [m[1], Number(m[2])]));
  const fileOrder = [...pageFiles().map(src).join('\n').matchAll(/registerSettingsPage\(\{\s*id: '([a-z-]+)', title: ([^,]+), icon: '[a-z]+', order: (\d+)/g)].map((m) => [m[1], Number(m[3])]);
  const settingsPages = fileOrder.map(([id, o]) => [id, rank[id] ?? o]).sort((a, b) => a[1] - b[1]).map((m) => m[0]);
  assert.deepEqual(settingsPages, ['new-sessions', 'root', 'notifications', 'appearance', 'security', 'public-link', 'handsoff', 'workspace', 'automations', 'tia', 'updates', 'addons']);
  for (const gone of ['editor', 'codingtools', 'about', 'work', 'field', 'golive', 'learn']) assert.ok(!settingsPages.includes(gone), `${gone} is not a page of its own`);
  const app = src('app.js');
  for (const [from, to] of [['/pc', '/computer'], ['/pc/projects', '/workspace'], ['/settings/accounts', '/providers'], ['/settings/computers', '/computers'], ['/settings/skills', '/skills'], ['/settings/signin', '/settings/security'], ['/settings/auto', '/providers'], ['/tia-settings', '/settings/tia'], ['/settings/claude', '/settings/updates'], ['/settings/golive', '/work/golive'], ['/settings/learn', '/skills/learned']]) {
    assert.ok(app.includes(`'${from}': '${to}'`), `${from} → ${to}`);
  }
  for (const f of ['shell.js', 'home.js', 'newsession.js', 'accounts.js', 'settings.js']) {
    assert.doesNotMatch(src(f).split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n'), /'[^']*\bhoprig\b[^']*'/, `${f}: the name comes from brand.js`);
  }
});

// ---------- one kit ----------
test('one kit: tabs, results, steps and loading rows come from shell.js; no page keeps its own copy', async () => {
  const src = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');
  for (const f of pageFiles().filter((x) => x !== 'shell.js')) {
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
  // the system's own error is folded under Details, not the line a person reads
  const raw = "EACCES: permission denied, open '/x/tasks.json'";
  const box = errorBox('Hoprig could not read your task list.', () => {}, raw);
  const banner = box.children.find((c) => c && /error-box/.test(c.className));
  assert.ok(!texts(banner).join(' ').includes('EACCES'), 'the raw error is not in the line');
  const folded = box.children.find((c) => c && c.tag === 'details');
  assert.ok(folded && texts(folded).join(' ').includes(raw), 'it is under Details');
  assert.equal(errorBox('No').children.filter((c) => c && c.tag === 'details').length, 0, 'no Details without details');
  assert.doesNotMatch(src('work.js'), /errorBox\(`Could not load Work: \$\{e\.message\}`/, 'Work shows a plain line, the error folded');
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
  assert.match(src('shell.js'), /h\('div\.head-icons', registeredHeadTools\(\)/, 'the page head draws the registered buttons next to the Settings gear');
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
  const ns = fs.readFileSync(path.join(WEB, 'newsession-popup.js'), 'utf8');
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
  const c = texts(mdView('Rules.\n<!-- hoprig: memory -->\n## Memory\nKeep it.\n<!-- /hoprig: memory --> trailing'));
  assert.ok(!c.some((t) => t.includes('<!-- hoprig: memory -->')), 'a marker line is not shown');
  assert.ok(c.some((t) => t.includes('<!-- /hoprig: memory --> trailing')), 'a comment with text after it stays text');
  const multi = texts(mdView('<!-- a comment\n<img src=x onerror=alert(1)>\n-->'));
  assert.deepEqual(multi, ['<!-- a comment <img src=x onerror=alert(1)> -->'], 'a comment over several lines is shown as text, never read as markup');
  assert.deepEqual(texts(mdView('## Title ##  \n# ##\n# C# #')), ['Title', '##', 'C#'], 'closing #s go; a heading of only #s stays');
  const t = performance.now();
  assert.deepEqual(texts(mdView(`# a${' '.repeat(50_000)}x`)), [`a${' '.repeat(50_000)}x`]);
  assert.ok(performance.now() - t < 100, `a heading with a long run of blanks: ${(performance.now() - t).toFixed(0)} ms`);
  const { brainGroups } = await import('../../web/brain.js');
  const item = (id, extra = {}) => ({ id, title: id, file: `~/${id}`, size: 1, modified: 0, ...extra });
  const g = brainGroups({
    global: { rules: item('rules'), linked: true, more: [] },
    memory: { home: { count: 2, items: [item('MEMORY.md', { type: 'index' }), item('m1', { name: 'How I work', description: 'Short answers', type: 'user' })] } },
    brain: { about: null, learnings: item('learnings'), activeContext: null, pending: null },
    dailyLogs: { count: 1, items: [item('d1', { date: '2026-11-14' })] },
    projects: [{ name: 'shop', agents: item('agents'), decisions: null, learnings: null, activeContext: null, memory: { count: 0, items: [] } }],
  });
  assert.deepEqual(g.map((x) => x.title), ['What your coding tools are told everywhere', 'What they remembered', 'Learnings and current context', 'Daily logs', 'Pending', 'shop']);
  assert.deepEqual(g[1].rows[1], { item: g[1].rows[1].item, title: 'How I work', sub: 'Short answers', chip: 'about you' });
  assert.equal(g[4].rows.length, 0, 'nothing pending: the group says so instead of an empty box');
  // A coding tool's links to make: the count and the names agree (two to make, two named; the linked one is not).
  const { todoWords } = await import('../../web/brainlink.js');
  const entries = [
    { tools: ['claude'], what: 'rules', action: 'link' }, { tools: ['claude'], what: 'skills', action: 'already' },
    { tools: ['claude', 'opencode'], what: 'memory', action: 'link' }, { tools: ['claude'], what: 'settings', action: 'conflict' },
  ];
  assert.equal(todoWords({ id: 'claude', todo: 2, left: 1 }, entries), 'Not linked yet: 2 links to make (rules, memory), 1 in the way');
  assert.equal(todoWords({ id: 'opencode', todo: 1, left: 0 }, entries), 'Not linked yet: 1 link to make (memory)');
  // Short names where the server gives them: a count of words, not a run-on list of long phrases.
  const short = [{ tools: ['opencode'], what: 'a line in OpenCode\'s settings that names Claude Code\'s rules folder and each project\'s memory index', short: 'settings', action: 'link' }, { tools: ['opencode'], what: 'the rules OpenCode gets everywhere', short: 'rules', action: 'link' }];
  assert.equal(todoWords({ id: 'opencode', todo: 2, left: 0 }, short), 'Not linked yet: 2 links to make (settings, rules)');
  const { toolNames } = await import('../../web/brainlink.js');
  assert.equal(toolNames([{ tools: ['claude'] }, { tools: ['opencode'] }]), 'Claude Code and OpenCode', 'the Skills banner names every coding tool it links');
  assert.equal(toolNames([{ tool: 'claude' }]), 'Claude Code');
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
  for (const f of pageFiles('.css')) {
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
  assert.ok(items.includes('another'), 'a second session in the same folder');
  assert.match(src, /api\('\/api\/sessions', \{ dir: s\.cwd, mode: 'new', \.\.\.older \}\)/, 'in the same folder, on the folder\'s default provider (the server chooses it)');
  assert.match(src, /const older = !\('recommendedIn' in d\) && d\.recommended \? \{ profile: d\.recommended \} : \{\};/, 'an older computer, which needs a provider named, gets its recommended one');
  assert.match(src, /confirmSheet\(\{\s*title: `End "\$\{name\}"\?`/, 'and confirmed');
  assert.match(src, /title: 'Move to another provider'/);
  assert.match(src, /prefs\.get\('session\.keys', !finePointer\)/, 'the key bar folds away and remembers it: off by default with a mouse and keyboard, on on a phone');
  assert.match(src, /h\('strong', stateOf\(s\)\.text\)/, 'the same words as Home: the banner\'s head is the state\'s own text');
});

// ---------- Home ----------
test('Home: groups by what the session needs, plain terminals last, and one plain line about the providers', async () => {
  const { GROUPS, groupOf, accountsLine } = await import('../../web/home.js');
  assert.deepEqual(GROUPS.map((g) => g[1]), ['Needs you', 'Working', 'Finished', 'Terminals']);
  assert.equal(groupOf({ status: 'attention' }), 'needs');
  assert.equal(groupOf({ status: 'waiting', limit: { text: 'x' } }), 'needs', 'a limit needs you');
  assert.equal(groupOf({ status: 'waiting' }), 'waiting', 'a finished turn only waits for the next message');
  assert.equal(groupOf({ status: 'working' }), 'working');
  assert.equal(groupOf({ kind: 'shell', status: 'shell' }), 'terminals', 'a plain terminal waits for no message');
  assert.equal(groupOf({ kind: 'shell' }), 'terminals');
  const { stateOf, needsYouFirst } = await import('../../web/lib.js');
  assert.equal(stateOf({ kind: 'shell', status: 'waiting' }).text, 'Terminal');
  // Subagents go on after the reply ended: it is in the Working group and says where the work is.
  assert.equal(groupOf({ status: 'working', background: 2 }), 'working');
  assert.deepEqual([stateOf({ status: 'working', background: 2 }).text, stateOf({ status: 'working' }).text], ['Working in the background', 'Working']);
  assert.match(fs.readFileSync(path.join(WEB, 'sessionitem.js'), 'utf8'), /chip\(s, \{ text: st\.key !== heading \|\| Boolean\(s\.background\) || st\.text === .Ready. \}\)/, 'the card says so under the Working heading too');
  assert.deepEqual([{ name: 't', kind: 'shell', activity: 9 }, { name: 'c', kind: 'claude', status: 'waiting', activity: 1 }].sort(needsYouFirst).map((s) => s.name), ['c', 't'], 'after the Claude sessions');
  const { markStarting } = await import('../../web/newsession.js');
  markStarting(null, 'fresh');
  assert.equal(groupOf({ name: 'fresh', machine: null, kind: 'shell', status: 'shell' }), 'working', 'just started from the page: Working, not a plain terminal');
  const acct = (label, pct, extra = {}) => ({ name: label.toLowerCase(), label, kind: 'subscription', usage: pct === null ? null : { fiveHour: { pct } }, ...extra });
  const one = (profiles) => [{ machine: null, machineLabel: 'Desk', profiles, autoSwitch: { order: [] } }];
  assert.deepEqual(accountsLine(one([acct('Max', 40), acct('Team', 10), { name: 'api', label: 'API', kind: 'api' }]), false), { text: '3 providers · all available', warn: false, lines: [] });
  const nearMax = 'Max is almost used up (96% of its 5-hour limit). When it runs out, sessions can go on with Team.';
  assert.deepEqual(accountsLine(one([acct('Max', 96), acct('Team', 10)]), false), { text: nearMax, warn: true, lines: [nearMax] });
  assert.match(accountsLine(one([acct('Max', 20, { limited: {} })]), false).text, /^Max is at its limit\.$/);
  assert.deepEqual(accountsLine(one([]), false).warn, true);
  const two = [{ machine: null, machineLabel: 'Desk', profiles: [acct('Max', 96)] }, { machine: 'lap', machineLabel: 'Lap', profiles: [acct('Team', 5)] }];
  assert.equal(accountsLine(two, true).text, 'Max is almost used up (96% of its 5-hour limit), on Desk. When it runs out, sessions can go on with Team.', 'the computer named once, only where something is near a limit');
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
  assert.equal(actionLabel({ kind: 'request', method: 'POST', path: '/api/x', label: 'Add the rules' }), 'Add the rules', 'the server\'s label for what one press does');
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
  // every open step with an action can be done from here, not only the next one (the phone step after Skills)
  const stepButtons = buttons(open).filter((b) => /btn small/.test(b.className) && !/ghost/.test(b.className));
  assert.equal(stepButtons.length, STEPS.filter((s) => !s.done && s.action).length, 'a button for each open step');
  assert.ok(texts(open).join(' ').includes('Sign in to Claude'), 'the phone step, after the next one, has its button');
  assert.ok(texts(getStartedCard({ steps: STEPS.map((x) => ({ ...x, done: false })), done: 0, total: 6 }, { firstRun: true })).join(' ').includes('Tools for coding'), 'nothing done yet: every step shows');
  const line = getStartedCard(allDone, {});
  assert.ok(/collapsed/.test(line.className));
  assert.ok(texts(line).join('').includes('all 6 done'));
  assert.equal(getStartedCard(onb, { dismissed: true }), null);
});

// ---------- Settings → Add-ons, and Settings → Public link ----------
const webSrc = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');
test('add-ons: no "Set up as a provider" for an add-on that is no gateway, notes before Start; the public link is not listed', async () => {
  const { addonView, shownAddons } = await import('../../web/addons.js');
  const gateway = addonView({ id: 'bridgebox', installed: true, running: true, url: 'http://localhost:20017' });
  assert.deepEqual([gateway.showAccount, gateway.confirmStart], [true, false]);
  const other = addonView({ id: 'x', installed: true, running: false, account: false, notes: ['Read this first.'] });
  assert.deepEqual([other.showAccount, other.confirmStart], [false, true]);
  // The public link has its own page; its entry in /api/addons is only for older hubs.
  assert.deepEqual(shownAddons([{ id: 'bridgebox' }, { id: 'public-link' }, null]).map((a) => a.id), ['bridgebox']);
  assert.doesNotMatch(webSrc('addons.js'), /publiclink\.js|fixed\./, 'Add-ons knows nothing of the public link');
});

test('public link: the state in one pill and one line, Off by default; it looks again only while something changes', async () => {
  const { statePill, linkSummary, needsPoll, makePassword } = await import('../../web/publiclink.js');
  assert.deepEqual(statePill({ on: false, state: 'off' }), ['ended', 'Off']);
  assert.deepEqual(statePill({ on: false, state: 'error' }), ['attention', 'Off: it did not start']);
  assert.deepEqual(statePill({ on: true, state: 'installing' }), ['starting', 'Installing cloudflared…']);
  assert.deepEqual(statePill({ on: true, state: 'on' }), ['waiting', 'On']);
  assert.deepEqual(statePill({ on: true, state: 'retrying' }), ['attention', 'Trying again']);
  assert.deepEqual(statePill({ on: true, state: 'blocked', need: 'stronger-password' }), ['attention', 'Waiting for a strong password']);
  assert.equal(needsPoll({ on: true, state: 'blocked', custom: { state: 'none' } }), false, 'held back: it waits for the owner, not for time');
  // cloudflared's raw words become plain ones (the raw line stays behind Details); the server's own are plain already.
  const { plainError } = await import('../../web/publiclink.js');
  assert.equal(plainError('failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com: no such host'), 'This computer cannot reach Cloudflare. Check its internet connection.');
  assert.match(plainError('cloudflared could not be installed: getaddrinfo ENOTFOUND github.com.'), /could not be downloaded/);
  assert.equal(plainError('Set up Custom first: sign in to Cloudflare and name the address.'), null);
  assert.equal(linkSummary(null), 'Off');
  assert.equal(linkSummary({ on: false, kind: 'custom' }), 'Off');
  assert.equal(linkSummary({ on: true, kind: 'temporary', state: 'on', url: 'https://a-b-c.trycloudflare.com' }), 'Temporary: a-b-c.trycloudflare.com');
  assert.equal(linkSummary({ on: true, kind: 'custom', state: 'on', url: 'https://pc.example.com' }), 'Custom: pc.example.com');
  assert.equal(linkSummary({ on: true, kind: 'temporary', state: 'starting', url: null }), 'Temporary: starting…');
  assert.equal(needsPoll({ on: true, state: 'starting', custom: { state: 'none' } }), true);
  assert.equal(needsPoll({ on: true, state: 'on', custom: { state: 'none' } }), false);
  assert.equal(needsPoll({ on: false, state: 'off', custom: { state: 'signing-in' } }), true, 'waiting for Cloudflare\'s approval');
  assert.equal(needsPoll({ on: false, state: 'off', custom: { state: 'ready' } }), false);
  // A made password is long, readable, and strong by the server's own rules.
  const { passwordProblem } = await import('../../src/server/strength.mjs');
  const pw = makePassword((n) => new Uint8Array(n).map((_, i) => (i * 37 + 11) % 256));
  assert.match(pw, /^[a-km-z2-9]{5}(-[a-km-z2-9]{5}){3}$/);
  assert.equal(passwordProblem(pw), null);
  assert.equal(passwordProblem(makePassword()), null);
});

test('public link: its own Settings page; refusals are asked for in place; the address with Copy, Open and a QR', async () => {
  const { forgetText } = await import('../../web/publiclink.js');
  const named = forgetText({ mode: 'named', url: 'https://office.example.com', hostname: 'office.example.com', extra: [{ hostname: 'bridgebox-office.example.com' }] });
  assert.match(named, /deletes its tunnel in your Cloudflare account/);
  assert.match(named, /DNS records for office\.example\.com, bridgebox-office\.example\.com stay in Cloudflare/);
  assert.match(forgetText({ mode: 'token', url: 'https://office.example.com' }), /stay in your Cloudflare dashboard/);
  assert.match(forgetText({ mode: null }), /Nothing was made in your Cloudflare account/);
  const page = webSrc('publiclink.js');
  const forms = webSrc('linkforms.js');
  assert.match(page, /registerSettingsPage\(\{\s*id: 'public-link', title: 'Public link'/);
  for (const need of ['password', 'check-password', 'custom-setup']) assert.ok(forms.includes(`'${need}'`), need);
  assert.match(forms, /return strongForm\(p, why, true\)/, 'a weak password: "Make a strong password" in place, then on');
  assert.match(forms, /p\.api\('\/api\/settings\/password', \{ current: cur\.value, next: next\.value, strong: true \}\)/);
  // A link that is on but held back (a weak password), or that runs with a password never checked (carried over
  // from an older version: the server's need while it runs), asks for the same in place.
  assert.match(page, /const need = ui\.need \|\| s\.need \|\| null;/);
  assert.match(forms, /running \? 'Check it' : 'Check it and turn on'/);
  // Typed passwords are never trimmed and live only in the page's own closure, not in a module.
  assert.match(page, /oninput: \(e\) => \(secret\[key\] = e\.target\.value\)/);
  assert.doesNotMatch(page.split('function render')[0], /secret|password: ''/, 'no password kept at module level');
  // Enter submits the Custom name and the tunnel token (forms), and a redraw gives the focus back.
  assert.match(forms, /h\('form\.addon-form', \{ onsubmit: async \(e\) => \{\n\s+e\.preventDefault\(\);\n\s+draft\.hostname/);
  assert.match(forms, /h\('button\.btn\.small\.secondary', \{ type: 'submit', disabled: p\.ui\.busy \}, 'Use it'\)/);
  assert.match(page, /const had = a && root\.contains\(a\) \? a\.dataset\.fk \|\| null : null;/);
  // Custom being set up while Temporary is on stays chosen across a look-again.
  assert.match(page, /const settingUp = ui\.chosen === 'custom' && s\.kind !== 'custom' && s\.custom\.state !== 'ready';/);
  // A field being typed in keeps the page from being drawn anew, but the switch and the kind radios are no such
  // field (a real click focuses them; the address would never show), and the owner's own action always redraws.
  assert.match(page, /a\.tagName === 'INPUT' && !\['checkbox', 'radio'\]\.includes\(a\.type\)/);
  assert.match(page, /await load\(true\);\n  \}/, 'turn() redraws at once');
  assert.match(page, /api\('~\/api\/login\/links', \{ base: url \}\)/, 'the sign-in QR is made for that address');
  assert.match(page, /The \$\{other\} address stops working/, 'moving to the other kind says so first');
  assert.match(page, /api\('~\/api\/links\/code', \{\}\)/, 'the line for another computer');
  assert.match(page, /must be linked again when this address changes/);
  assert.match(webSrc('app.js'), /import '\.\/publiclink\.js';/);
});

// ---------- wording ----------
test('wording: "provider" and "computer" in everything a visitor reads; Auto mode promises "without stopping" only for API', async () => {
  for (const f of [...pageFiles(), ...pageFiles('.html')]) {
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
  assert.match(accounts, /On another subscription, Claude Code restarts on that provider/);
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

test('Auto mode: subscriptions first, then gateways; pay-per-use keys only when allowed, and last', async () => {
  const { startOrder, isPaid } = await import('../../web/lib.js');
  const accts = [
    { name: 'key', kind: 'api', paid: true }, { name: 'tr', kind: 'api', paid: false }, { name: 'max', kind: 'subscription' },
    { name: 'gw', kind: 'api', paid: false }, { name: 'login', kind: 'login' },
  ];
  assert.deepEqual(startOrder(accts), ['max', 'login', 'tr', 'gw']);
  assert.deepEqual(startOrder(accts, true), ['max', 'login', 'tr', 'gw', 'key']);
  assert.equal(isPaid({ kind: 'api' }), true, 'an older computer that does not say: the safe side');
  assert.equal(isPaid({ kind: 'api', paid: false }), false);
});

test('limit card: the main button is the first free provider of the order, never a paid one; Auto says where it goes', async () => {
  const { limitBox } = await import('../../web/lib.js');
  const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
  const buttons = (n) => (n instanceof FakeText ? [] : [...(n.tag === 'button' ? [n] : []), ...n.children.flatMap(buttons)]);
  const s = { name: 'w', canSwitch: true, limit: { text: 'limit reached' }, profile: { name: 'max' } };
  const profiles = [
    { name: 'auto', label: 'Auto', kind: 'auto', virtual: true },
    { name: 'key', label: 'Claude API', kind: 'api', paid: true, autoPlace: 1 },
    { name: 'max', label: 'Claude Max', kind: 'subscription', autoPlace: 0, limited: { until: 1 } },
    { name: 'tr', label: 'API via Example relay', kind: 'api', paid: false, autoPlace: 2 },
    { name: 'team', label: 'Team plan', kind: 'subscription', autoPlace: null },
  ];
  const card = (ps) => buttons(limitBox(s, ps)).map((b) => [/primary/.test(b.className), texts(b).join('')]);
  assert.deepEqual(card(profiles), [
    [true, 'Continue on API via Example relay'],
    [false, 'Go on with the next provider that has room each time (next: Claude API · costs money per use)'],
    [false, 'Continue on Team plan'],
    [false, 'Continue on Claude API · costs money per use'],
  ], 'Auto with the paid key allowed goes to it; the main button does not');
  // The paid key is the only free one: no main button at all.
  const onlyPaid = card([profiles[1], profiles[2]]);
  assert.deepEqual(onlyPaid, [[false, 'Continue on Claude API · costs money per use']]);
});

test('limit card on Claude Code\'s stored sign-in: another Claude account next to another provider; "Continue" once one signed in', async () => {
  const { limitBox } = await import('../../web/lib.js');
  const { limitStripAction, accountText, onStoredLogin } = await import('../../web/claudeaccount.js');
  const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
  const buttons = (n) => (!n || n instanceof FakeText ? [] : [...(n.tag === 'button' ? [n] : []), ...n.children.flatMap(buttons)]);
  const card = (s, ps) => buttons(limitBox(s, ps)).map((b) => [/primary/.test(b.className), texts(b).join('')]);
  const profiles = [
    { name: 'sub', label: 'Claude Max', kind: 'login', signedIn: true, limited: { until: 1 }, accountAt: null },
    { name: 'tr', label: 'API via Example relay', kind: 'api', paid: false },
  ];
  const s = { name: 'w', machine: null, canSwitch: true, limit: { text: "You've hit your 5-hour limit" }, limitAt: 2000, profile: { name: 'sub', kind: 'login' } };
  assert.deepEqual(card(s, profiles), [[true, 'Continue on API via Example relay'], [false, 'Sign in with another Claude account']]);
  // another account signed in after the limit was seen: going on here leads, the move is second
  const since = [{ ...profiles[0], accountAt: 3000 }, profiles[1]];
  assert.deepEqual(card(s, since), [[true, 'Continue with the new account'], [false, 'Continue on API via Example relay'], [false, 'Sign in with another Claude account']]);
  assert.deepEqual(card({ ...s, limitAt: 4000 }, since), [[true, 'Continue on API via Example relay'], [false, 'Sign in with another Claude account']], 'a limit of the new account itself');
  assert.equal(card({ ...s, limitAt: null }, [{ ...profiles[0], accountAt: Date.now() - 60_000 }, profiles[1]])[0][1], 'Continue with the new account', 'since when is not known: a sign-in of the last hours counts');
  // a chat (it cannot be moved from its card) gets the same
  assert.deepEqual(card({ ...s, kind: 'chat', chatId: 'c1', canSwitch: false }, profiles), [[false, 'Sign in with another Claude account']]);
  // not for a provider with its own account token or an API key, and not through another computer's page
  assert.deepEqual(card({ ...s, profile: { name: 'own', kind: 'subscription' } }, [{ name: 'own', label: 'Second', kind: 'subscription' }, profiles[1]]), [[true, 'Continue on API via Example relay']]);
  assert.deepEqual(card({ ...s, machine: 'laptop' }, profiles), [[true, 'Continue on API via Example relay']], 'a sign-in never goes through another computer\'s page');
  // Home's line about the providers: the button only while this computer's stored sign-in is at its limit
  assert.deepEqual(buttons(limitStripAction([{ machine: null, profiles }])).map((b) => texts(b).join('')), ['Sign in with another Claude account']);
  assert.equal(limitStripAction([{ machine: null, profiles: [{ ...profiles[0], limited: null }] }]), null);
  assert.equal(limitStripAction([{ machine: 'laptop', profiles }]), null);
  assert.equal(limitStripAction([{ machine: null, profiles: [{ name: 'own', kind: 'subscription', limited: {} }] }]), null);
  assert.equal(accountText({ email: 'someone@example.invalid', org: 'Example Org', plan: 'max' }), 'someone@example.invalid · Example Org · Max');
  assert.equal(accountText({ email: null, org: null, plan: null }), '');
  // what runs on the stored sign-in: its own sessions and chats, and an Auto session while that provider serves it
  const sessions = [{ name: 'a', profile: { name: 'sub' } }, { name: 'b', profile: { name: 'tr' } }, { name: 'c', profile: { name: 'auto' }, autoOn: { name: 'sub' } }, { name: 'd' }];
  assert.deepEqual(onStoredLogin(sessions, profiles).map((x) => x.name), ['a', 'c']);
  // a sign-in provider with a Claude folder of its own: this page's sign-in, sign-out and other account are the
  // default folder's, so none of them is offered for it, and its sessions are not on the stored sign-in
  const ownP = [{ name: 'own', label: 'Own folder', kind: 'login', ownFolder: true, signedIn: true, limited: { until: 1 }, accountAt: null }, profiles[1]];
  assert.deepEqual(card({ ...s, profile: { name: 'own', kind: 'login' } }, ownP), [[true, 'Continue on API via Example relay']]);
  assert.equal(limitStripAction([{ machine: null, profiles: ownP }]), null);
  assert.deepEqual(onStoredLogin([{ name: 'e', profile: { name: 'own' } }], ownP), []);
  // Providers: the two actions on the provider's own page, said plainly before anything happens
  const acc = fs.readFileSync(path.join(WEB, 'accounts.js'), 'utf8');
  assert.match(acc, /'Sign in with another account'/);
  assert.match(acc, /'Sign out'/);
  assert.match(acc, /a\.kind === 'login' && a\.ownFolder \? h\('p\.hint\.acct-own-folder', '[^']*start a terminal session on this provider and type \/login there\./, 'how a folder of its own is signed in');
  const src = fs.readFileSync(path.join(WEB, 'claudeaccount.js'), 'utf8');
  assert.match(src, /No restart is needed/, 'what happens to running sessions is said before the owner confirms');
  assert.match(src, /Until that is complete nothing changes/);
  assert.match(src, /Their next request ends in "Not logged in"/, 'and what a sign-out means for them');
  assert.doesNotMatch(src, /logout'\), \{\}\)[\s\S]{0,200}claudeSignIn/, 'another account is one step: no sign-out before the sign-in');
});

test('a sheet opened over another takes its place: the earlier one is answered, its late close does not end the new one', async () => {
  const src = fs.readFileSync(path.join(WEB, 'lib.js'), 'utf8');
  // A stand-in <dialog>: close() reports a moment later, as browsers do.
  const made = [];
  const realCreate = document.createElement;
  document.createElement = (t) => {
    const el = realCreate(t);
    if (t === 'dialog') {
      Object.assign(el, {
        open: false,
        classList: { toggle() {} },
        querySelector: () => null,
        showModal() { this.open = true; },
        close() {
          if (!this.open) return;
          this.open = false;
          setTimeout(() => this.listeners.close && this.listeners.close(), 0);
        },
      });
      made.push(el);
    }
    return el;
  };
  document.body = { append() {} };
  try {
    const { openSheet } = await import('../../web/lib.js');
    let closeSecond;
    const first = openSheet({ title: 'one' }, () => []);
    const second = openSheet({ title: 'two' }, (close) => { closeSecond = close; return []; });
    assert.equal(await first, null, 'the earlier sheet is answered at once');
    let done = false;
    second.then(() => (done = true));
    await new Promise((r) => setTimeout(r, 20)); // the first sheet's close is reported now
    assert.equal(done, false, 'the sheet that is open stays open');
    assert.equal(made[0].open, true);
    closeSecond('value');
    assert.equal(await second, 'value');
    // closed and another opened in the same moment (close(); openSheet()): each gets its own answer
    let closeA;
    const a = openSheet({ title: 'a' }, (close) => { closeA = close; return []; });
    closeA('a');
    let closeB;
    const b = openSheet({ title: 'b' }, (close) => { closeB = close; return []; });
    assert.equal(await a, 'a');
    await new Promise((r) => setTimeout(r, 20));
    closeB('b');
    assert.equal(await b, 'b');
  } finally {
    document.createElement = realCreate;
  }
  assert.match(src, /sheetSkip/);
});

test('Settings → Workspace says why saving the map is on or off when the owner never chose', async () => {
  const { commitMapWhy } = await import('../../web/workspace.js');
  assert.match(commitMapWhy({ on: true, github: true }), /^On: the AI brain has a GitHub address\./);
  assert.match(commitMapWhy({ on: true, github: false }), /^On: the AI brain has a git server address\./);
  assert.match(commitMapWhy({ on: false }), /^Off: the AI brain has no git server address yet\./);
});

// ---------- several computers, a hub, providers that sign in ----------
test('a computer runs sessions only when online, not a hub, with Claude Code and a provider; the reason otherwise', async () => {
  const { runsSessions } = await import('../../web/store.js');
  const p = [{ name: 'max' }];
  assert.deepEqual(runsSessions({ status: 'online', profiles: p }), { ok: true, why: '' });
  assert.equal(runsSessions({ status: 'online', profiles: p }, undefined).ok, true, 'Claude Code not asked yet counts as there');
  assert.match(runsSessions({ status: 'offline', profiles: p }).why, /Did not answer when asked/);
  // A computer that answered but would not take this dashboard is never told as one that did not answer.
  const words = { unauthorised: /no longer lets this dashboard in\. Add it again here: Computers → Add a computer/, 'too-old': /too old.*update it there/, hostkey: /host key changed.*under Computers/, connecting: /Still connecting/ };
  for (const [status, re] of Object.entries(words)) {
    const w = runsSessions({ status, profiles: p });
    assert.equal(w.ok, false, status);
    assert.match(w.why, re, status);
    assert.doesNotMatch(w.why, /did not answer/i, status);
  }
  assert.match(runsSessions({ status: 'online', hub: true, profiles: p }).why, /main computer/);
  assert.match(runsSessions({ status: 'online', profiles: p }, null).why, /Claude Code is not installed/);
  assert.match(runsSessions({ status: 'online', profiles: [{ name: 'auto', virtual: true }] }).why, /No provider/);
  const src = fs.readFileSync(path.join(WEB, 'newsession-popup.js'), 'utf8');
  assert.match(src, /computerChips\(\{/, 'the computers are chips over the projects');
  assert.match(src, /prefs\.set\('new\.machine'/, 'the choice is kept for the next time');
  assert.doesNotMatch(src, /select\('Computer'/, 'not hidden under More options');
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
  assert.deepEqual(line, { text: '2 providers · 1 not signed in', warn: false, lines: [] }, 'never "all available" while one is not signed in, but no warning either');
  const both = accountsLine([{ machineLabel: 'A', profiles: [{ label: 'Pro', signedIn: false }, { label: 'Max', signedIn: true, usage: { fiveHour: { pct: 96 } } }] }], false);
  assert.deepEqual([both.text, both.warn], ['Max is almost used up (96% of its 5-hour limit).', true], 'the warning is about the limit only');
  const many = accountsLine([{ machineLabel: 'A', profiles: [{ label: 'Max', limited: {} }] }, { machineLabel: 'B', profiles: [{ label: 'Team', limited: {} }] }], true);
  assert.deepEqual(many.lines, ['Max is at its limit, on A.', 'Team is at its limit, on B.'], 'one line per provider');
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

test('joining: the one line to paste on the main computer, the terminal line too; one paste field on the other', () => {
  const src = fs.readFileSync(path.join(WEB, 'joinlink.js'), 'utf8');
  assert.match(fs.readFileSync(path.join(WEB, 'computers.js'), 'utf8'), /from '\.\/joinlink\.js'/);
  assert.match(src, /const cmd = c\.command \|\| /);
  // Opened on this computer's own loopback address, no 127.0.0.1 command is offered to another computer.
  assert.match(src, /: loopback\(\)\n\s+\? \[h\('p\.banner\.info'/);
  // Once linked, the other computer says to which main one, whether it is connected, and Leave.
  assert.match(src, /title: `Linked to your main \$\{APP_NAME\}`/);
  assert.match(src, /lineIn\.form\.requestSubmit\(\)/, 'Enter in the one-line paste field links');
  assert.match(src, /h\('details\.adv\.cp-fold', h\('summary', 'For the terminal'\),\n\s+c\.note \? h\('p\.hint', c\.note\) : null,/, 'the note, under For the terminal');
  assert.match(src, /cmdLine\(c\.line\)/);
  assert.match(src, /c\.via === 'temporary'/, 'a Temporary address: the other computer must be linked again after a restart');
  assert.match(src, /api\('~\/api\/joins', \{ line: lineIn\.value\.trim\(\), insecure: insecure\.checked \}\)/);
  assert.match(src, /label: `Link to my main \$\{APP_NAME\}`/);
  assert.doesNotMatch(src, /Fingerprint \(only when/, 'the fingerprint travels in the pasted line');
});

test('session view: the short placeholder on a narrow screen', () => {
  const src = fs.readFileSync(path.join(WEB, 'session.js'), 'utf8');
  assert.match(src, /matchMedia\('\(max-width: 599px\)'\)/);
  // The short one names the session's coding tool ("Message Codex"), Claude until the session is known.
  assert.match(src, /: `Message \$\{toolName\(\)\}`\)/);
  assert.match(src, /\|\| 'Claude';/);
});

// ---------- the workspace through git ----------
test('sync rows: what git ignores in the way is its own row, with no merge session; a diverged one keeps it', async () => {
  const { syncRows, TODO } = await import('../../web/projects.js');
  const why = '1 to pull, but the incoming commits put files where builds/acme is here, which this repository does not track (another repository, perhaps): nothing was changed; move it away first, then';
  const kept = texts(syncRows([{ label: 'kits', did: [], todo: [{ kind: 'kept-back', why, command: 'git merge --ff-only' }], dir: '/x/kits' }]));
  assert.ok(kept.includes(TODO['kept-back']()), 'its own words');
  assert.ok(!kept.some((t) => /commit/i.test(t) && /Save/.test(t)), 'never "save (commit) your changes": the owner changed nothing');
  assert.ok(!kept.includes('Sort it out in the App'), 'no session that merges or rebases: that deletes the repository in the way');
  // A row that also needs a decision (diverged, or a pull held back by changes here) still gets no merge session while
  // something is in the way: the guard, not the missing kind, keeps the button away.
  for (const kind of ['diverged', 'pull-blocked']) {
    const mixed = texts(syncRows([{ label: 'kits', did: [], todo: [{ kind: 'kept-back', why, command: 'git merge --ff-only' }, { kind, why: 'main and its upstream have both moved (1 ahead, 1 behind)', command: '' }], dir: '/x/kits' }]));
    const said = mixed.join(' ');
    assert.ok(said.includes(TODO['kept-back']()) && said.includes(TODO[kind]()), `both said (${kind})`);
    assert.ok(!mixed.includes('Sort it out in the App'), `no merge session where something is in the way, even with a ${kind} to-do`);
  }
  const both = texts(syncRows([{ label: 'kits', did: [], todo: [{ kind: 'diverged', why: 'main and its upstream have both moved (1 ahead, 1 behind)', command: '' }], dir: '/x/kits' }]));
  assert.ok(both.includes('Sort it out in the App'));
  assert.match(fs.readFileSync(path.join(WEB, 'projects.js'), 'utf8'), /ask me before you merge or rebase\. A folder this repository ignores may be a repository of its own: a merge or a rebase deletes it/, 'the session is told what a merge or a rebase deletes');
});

test('workspace: one line about it, the map in groups, commands that still work when pasted', async () => {
  const { workspaceLine, mapGroups, homeCommand } = await import('../../web/workspace.js');
  const map = { exists: true, entries: [
    { kind: 'brain', label: 'ai_brain', state: 'here' },
    { kind: 'project', label: 'shop', state: 'here' }, { kind: 'repo', label: 'shop/code/api', state: 'here' },
    { kind: 'project', label: 'invoices', state: 'missing' },
    { kind: 'other', label: 'git/tool', state: 'here' }, { kind: 'other', label: 'development/flutter', state: 'here', tool: true },
  ], map: { others: [] } };
  // A project only in the map is the normal state: said after the line, never a warning.
  assert.equal(workspaceLine(map, null).text, 'Not synced from here yet · 1 more project in your map, not on this computer');
  assert.equal(workspaceLine(map, null).warn, false);
  assert.equal(workspaceLine({ ...map, entries: map.entries.map((e) => (e.state === 'missing' ? { ...e, state: 'notHere' } : e)) }, null).missing.length, 1, 'notHere and an older computer\'s missing alike');
  const job = { kind: 'sync', result: { data: { todo: 2, repos: [{ label: 'a', todo: [{ kind: 'diverged' }] }, { label: 'b', todo: [{ kind: 'to-push' }] }, { label: 'invoices', todo: [{ kind: 'missing' }] }] } } };
  assert.equal(workspaceLine({ ...map, entries: map.entries.filter((e) => e.state !== 'missing') }, job).text, '2 repositories have changes to look at', '"not here" is not a change to look at');
  assert.equal(workspaceLine({ exists: true, entries: [] }, { kind: 'sync', result: { data: { todo: 0, repos: [] } } }).text, 'In step with git');
  assert.equal(workspaceLine({ exists: true, entries: [] }, null).text, 'Not synced from here yet', 'never "in step" without a sync');
  assert.equal(workspaceLine({ exists: false, entries: [] }, null).noMap, true);
  assert.equal(workspaceLine({ exists: true, entries: [], saved: { unsaved: true } }, null).text, 'The map changed and is not saved in the AI brain\'s history yet', 'said when nothing more important is there');
  assert.equal(workspaceLine({ ...map, saved: { unsaved: true } }, null).text, 'The map changed and is not saved in the AI brain\'s history yet · 1 more project in your map, not on this computer');
  const whole = fs.readFileSync(path.join(WEB, 'workspace.js'), 'utf8');
  const auto = whole.slice(whole.indexOf('function autoPanel('));
  const drawn = auto.slice(auto.indexOf('fill(box,'));
  assert.match(auto, /const commit = toggle\('Save a change of the map/);
  const order = ['Keep the map up to date', 'Keep the workspace in step', 'Also upload', 'commit,', 'Every how many hours'].map((t) => drawn.indexOf(t));
  assert.ok(order.every((x, k) => x > 0 && (k === 0 || x > order[k - 1])), 'four switches in that order, then the rest under More, the hours last');
  assert.match(auto, /commit\.querySelector\('input'\)\.disabled = !w\.map/, 'saving the map needs the map kept up to date');
  const g = mapGroups(map);
  assert.deepEqual(g.map((x) => x.id), ['brain', 'project', 'other', 'tool']);
  assert.deepEqual(g[1].rows.map((r) => [r.label, r.repos.map((x) => x.label)]), [['shop', ['shop/code/api']], ['invoices', []]]);
  assert.deepEqual(g[3].rows.map((r) => r.label), ['development/flutter'], 'a tool has a group of its own');
  assert.equal(homeCommand('git -C "/h/me/Workspace/ai_brain" add workspace.json', '/h/me'), 'git -C ~/"Workspace/ai_brain" add workspace.json');
  assert.equal(homeCommand("git -C '/h/me/my brain' add workspace.json && git -C /h/me/Workspace/ai_brain commit", '/h/me'), "git -C ~/'my brain' add workspace.json && git -C ~/Workspace/ai_brain commit");
  assert.equal(homeCommand('git -C /h/me2/x status', '/h/me'), 'git -C /h/me2/x status', 'only the home folder itself');
  const { notHereLine } = await import('../../web/workspace.js');
  const texts = (n) => (!n ? [] : n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
  const line = notHereLine({ notHere: ['invoices', 'invoices/code/api'], map: { projects: [{ name: 'invoices', url: 'https://git.example.com/x/invoices.git' }], others: [] } });
  assert.deepEqual(texts(line), ['Stays in the map, not on this computer: invoices', 'Get invoices'], 'a project once, its repositories come with it');
  assert.equal(notHereLine({ notHere: [] }), null);
  const src = fs.readFileSync(path.join(WEB, 'workspace.js'), 'utf8');
  assert.doesNotMatch(src, /Writing removes it from the map/, 'only Forget takes something out of the map');
  assert.match(src, /import \{ syncRows \} from '\.\/projects\.js'/, 'the same result rows as a project\'s Sync');
  assert.doesNotMatch(src, /Ask Claude to do it/, 'saving the map is a button, not a Claude session');
  assert.match(src, /'Save it now'/);
  assert.match(src, /api\('\/api\/workspace\/map\/commit'/);
  assert.match(src, /no password is typed into this dashboard|Nothing was moved/);
  assert.match(fs.readFileSync(path.join(WEB, 'gitsetup.js'), 'utf8'), /no password is typed into this dashboard/);
});

test('Git and GitHub: three rows, done only when all are; a step of Get started', async () => {
  const { gitRows, gitDone } = await import('../../web/gitsetup.js');
  const good = { git: true, identity: { set: true, name: 'A', email: 'a@example.invalid' }, gh: { installed: true, signedIn: true, account: 'a' }, brain: { exists: true, git: true, remote: 'https://git.example.com/a/b.git', upstream: 'origin/main', ahead: 0, behind: 0, changes: 0 } };
  assert.equal(gitDone(good), true);
  const out = { ...good, gh: { installed: true, signedIn: false, account: null }, brain: { exists: true, git: true, remote: null } };
  assert.deepEqual(gitRows(out).map((r) => [r.ok, r.text]), [[true, 'A · a@example.invalid'], [false, 'Not signed in'], [false, 'Not on a git server yet: sign in to GitHub first']]);
  assert.match(gitRows({ ...good, brain: { ...good.brain, ahead: 2 } })[2].text, /2 saved changes are not uploaded to your git server yet/);
  const { withGitStep, actionLabel } = await import('../../web/getstarted.js');
  const onb = { steps: [{ id: 'claude', done: true }], done: 1, total: 1 };
  const w = withGitStep(onb, out);
  assert.deepEqual([w.done, w.total, w.steps[1].id, w.steps[1].action.kind], [1, 1, 'git', 'git']);
  assert.equal(w.steps[1].optional, true, 'not needed for a first session');
  assert.equal(withGitStep(onb, null), onb, 'an older computer: the list as it came');
  assert.equal(actionLabel({ kind: 'git' }), 'Set up git and GitHub');
});

test('Get started: the brain\'s unlinked skills reopen the skills step with the Link now button; the count stays what Claude Code loads', async () => {
  const { withBrainSkills, actionLabel } = await import('../../web/getstarted.js');
  const onb = { steps: [{ id: 'claude', done: true }, { id: 'skills', done: true, detail: '1 that Claude Code uses', action: null }], done: 2, total: 2 };
  assert.equal(withBrainSkills(onb, 0), onb, 'nothing in the brain alone: as it came');
  assert.equal(withBrainSkills(null, 3), null);
  const w = withBrainSkills(onb, 2);
  assert.deepEqual([w.done, w.total], [2, 2], 'skills is optional: the counts do not move');
  assert.equal(w.steps[1].detail, 'Claude Code knows 1 extra skill (a ready-made way of working). 2 more are stored but not switched on.');
  assert.deepEqual(w.steps[1].action, { kind: 'link-brain' });
  assert.equal(actionLabel(w.steps[1].action), 'Switch on');
  const none = withBrainSkills({ steps: [{ id: 'skills', done: false, detail: 'none yet', action: { kind: 'page', target: 'settings/skills' } }], done: 0, total: 1 }, 1);
  assert.equal(none.steps[0].detail, '1 skill (a ready-made way of working) is stored but not switched on.');
  assert.equal(none.done, 0);
  // No page tells the owner to type the link command any more.
  for (const f of pageFiles().filter((x) => x !== 'brainlink.js')) assert.ok(!/workspace link/.test(fs.readFileSync(path.join(WEB, f), 'utf8')), f);
});

// ---------- every helper of lib.js that a page module calls is imported there ----------
// A module that calls one without importing it throws only when that code runs: the page then draws nothing (Setup was
// blank once because `link` was missing from pcsetup.js's import). Checked from the source, without a browser.
test('web modules import every lib.js helper they call', () => {
  const lib = fs.readFileSync(path.join(WEB, 'lib.js'), 'utf8');
  const helpers = [...lib.matchAll(/^export (?:async )?(?:function|const|class|let) ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  assert.ok(helpers.includes('link') && helpers.includes('api'), 'lib.js exports were read');
  const missing = [];
  for (const f of pageFiles().filter((x) => x !== 'lib.js')) {
    const raw = fs.readFileSync(path.join(WEB, f), 'utf8');
    const imported = new Set();
    for (const m of raw.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\.?\/lib\.js'/g)) for (const n of m[1].split(',')) imported.add(n.trim().split(/\s+as\s+/).pop());
    // Code only: no comments, no quoted text (a template's ${…} stays, it is code).
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1').replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''");
    for (const n of helpers) {
      if (imported.has(n)) continue;
      const esc = n.replace(/\$/g, '\\$');
      if (new RegExp(`\\b(?:const|let|var|function|class)\\s+${esc}\\b|[({,]\\s*${esc}\\s*[,)=]|\\(${esc}\\)\\s*=>`).test(code)) continue; // its own name
      if (new RegExp(`(?<![\\w$.])${esc}\\(`).test(code)) missing.push(`${f}: ${n}`);
    }
  }
  assert.deepEqual(missing, [], 'called without being imported from ./lib.js');
});

test('a question waiting for an OK: the same answers on the card and the banner; "always" only when Claude offers it', async () => {
  const { permissionActions, needsYou } = await import('../../web/lib.js');
  const ask = { name: 'mobile-app', kind: 'claude', status: 'attention', machine: null, ask: { type: 'permission', what: 'npm install', waiting: 1 } };
  assert.deepEqual(texts(permissionActions(ask)), ['Allow', 'Do not allow'], 'no third button without one on the screen');
  const always = { key: '2', text: "Yes, and don't ask again for npm install commands", label: "Don't ask again for npm install commands" };
  assert.deepEqual(texts(permissionActions({ ...ask, always })), ['Allow', "Allow, and don't ask again for this kind of command", 'Do not allow', 'This kind of command: npm install']);
  const edits = { key: '2', text: 'Yes, allow all edits during this session (shift+tab)', label: 'Allow all edits during this session' };
  assert.deepEqual(texts(permissionActions({ ...ask, always: edits })), ['Allow', 'Allow all edits during this session', 'Do not allow']);
  // Claude Code 2.1.326's own words (server/prompts.mjs alwaysOption).
  const access = { key: '2', text: 'Yes, and always allow access to /home/alex/app from this project', label: 'Always allow access to /home/alex/app from this project' };
  assert.deepEqual(texts(permissionActions({ ...ask, always: access })), ['Allow', 'Always allow access to /home/alex/app from this project', 'Do not allow']);
  assert.equal(permissionActions({ ...ask, always: { ...always, key: 'Enter' } }).children.length, 2, 'a key that is not a number is never sent');
  assert.equal(permissionActions({ ...ask, status: 'waiting' }), null);
  assert.equal(permissionActions({ ...ask, kind: 'chat' }), null, 'a chat answers on its own cards');
  // The card and the row use it; the session page's banner too (one code path).
  for (const f of ['sessionitem.js', 'session.js']) assert.match(fs.readFileSync(path.join(WEB, f), 'utf8'), /permissionActions\(/, f);
  // "Needs you" means what Home's group means: an OK, a limit or a start that failed, never "waiting for your next message".
  assert.equal(needsYou(ask), true);
  assert.equal(needsYou({ ...ask, status: 'waiting', limit: { text: 'x' } }), true);
  assert.equal(needsYou({ ...ask, status: 'waiting' }), false);
  const { GROUPS } = await import('../../web/home.js');
  // A tool that ended at its start (src/startfail.mjs) needs him too: it does nothing until he acts.
  assert.equal(needsYou({ name: 'x', kind: 'shell', startFailed: { code: 1, tool: 'claude' } }), true);
  assert.deepEqual(GROUPS.find(([id]) => id === 'needs')[2], ['attention', 'limit', 'failed'], 'the same three states as Home');
  assert.doesNotMatch(fs.readFileSync(path.join(WEB, 'session.js'), 'utf8'), /rank <= 2/);
});

test('a terminal session\'s answers: only a permission has them; a question or a plan is answered in the terminal', async () => {
  const { permissionActions, stateOf, needsYou } = await import('../../web/lib.js');
  const card = { name: 'web ui', kind: 'claude', status: 'attention', machine: null, note: 'Claude asks: Which toppings?' };
  const hrefs = (n) => (n instanceof FakeText ? [] : [...(n.attrs.href ? [n.attrs.href] : []), ...n.children.flatMap(hrefs)]);
  for (const [type, label, here, state] of [
    ['question', 'Answer', 'Answer in the terminal below: the arrow keys choose, Enter takes the answer.', 'Needs your answer'],
    ['plan', 'Read the plan', 'Read the plan in the terminal below and choose there.', 'Needs your approval'],
  ]) {
    const s = { ...card, ask: { type }, always: { key: '2', text: "Yes, and don't ask again", label: "Don't ask again" } };
    // On Home and Workspace: no Allow (Enter would pick an answer nobody read), one link to the terminal.
    assert.deepEqual(texts(permissionActions(s)), [label], type);
    assert.deepEqual(hrefs(permissionActions(s)), ['#/s/web%20ui'], type);
    assert.deepEqual(hrefs(permissionActions({ ...s, machine: 'box2' })), ['#/m/box2/s/web%20ui'], 'on its own computer');
    // On the session page the terminal is right below: a sentence, no button at all.
    assert.deepEqual(texts(permissionActions(s, null, { here: true })), [here]);
    assert.equal(stateOf(s).text, state);
    assert.equal(needsYou(s), true);
  }
  const permission = { ...card, ask: { type: 'permission', what: 'touch b.txt', waiting: 1 } };
  assert.deepEqual(texts(permissionActions(permission, null, { here: true })), ['Allow', 'Do not allow']);
  assert.equal(stateOf(permission).text, 'Needs your OK');
  assert.equal(stateOf(card).text, 'Needs your OK', 'a notification alone: the kind is not known');
  // The server types an answer only into the dialog that shows the card's command or file, and only while one asker
  // waits: with two, or with nothing to compare, the owner answers in the terminal (Claude Code shows its own queue).
  for (const [ask, why] of [[{ ...permission.ask, waiting: 2 }, 'More than one question waits: answer them in the terminal'], [{ type: 'permission', what: '' }, 'Answer in the terminal'], [undefined, 'Answer in the terminal']]) {
    assert.deepEqual(texts(permissionActions({ ...card, ask }, null, { here: true })), [`${why} below.`]);
    assert.deepEqual(texts(permissionActions({ ...card, ask })), [`${why}.`, 'Answer']);
    assert.deepEqual(hrefs(permissionActions({ ...card, ask })), ['#/s/web%20ui']);
  }
  assert.match(fs.readFileSync(path.join(WEB, 'session.js'), 'utf8'), /permissionActions\([^;]*\{ here: true \}\)/, 'the banner says it is the session page');
});

test('a terminal session\'s answers: an answer that was sent is not offered again until the card says something new', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  document.body = new FakeElement('body');
  FakeElement.prototype.remove = function remove() {};
  const fetchWas = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = fetchWas;
    delete document.body;
    delete FakeElement.prototype.remove;
  });
  const { permissionActions, answeredNow } = await import('../../web/lib.js');
  const card = { name: 'web ui', kind: 'claude', status: 'attention', machine: null, statusAt: 5, askAt: 7, ask: { type: 'permission', what: 'touch b.txt', waiting: 1 } };
  const sent = [];
  let answer = { ok: true, status: 200, json: async () => ({ ok: true }) };
  globalThis.fetch = async (u, o) => {
    sent.push([u, JSON.parse(o.body)]);
    return answer;
  };
  let looks = 0;
  const press = (b) => b.listeners.click({ preventDefault() {}, stopPropagation() {}, currentTarget: b });
  let box = permissionActions(card, () => looks++);
  await press(box.children[0]);
  // The owner's own answer, meant for a permission question: the server types it only while one is on the screen that
  // shows the card's command. Allow is the number of "Yes", which takes it wherever the arrow is.
  assert.deepEqual(sent, [['/api/sessions/web%20ui/key', { key: '1', owner: true, question: true, about: 'touch b.txt' }]]);
  assert.deepEqual(texts(box), ['Allowed'], 'the buttons are gone at once, not with the next look seconds later');
  assert.equal(looks, 1, 'and the page looks at once');
  t.mock.timers.tick(2000);
  assert.equal(looks, 3, 'and again soon: the coding tool has gone on by then');
  // The same card drawn again (Home draws every card anew with every look): still no buttons.
  assert.equal(answeredNow(card), true);
  assert.deepEqual(texts(permissionActions(card)), ['Your answer was sent.']);
  // The next question of the same batch has its own time: its answers show at once.
  assert.deepEqual(texts(permissionActions({ ...card, askAt: 8 })), ['Allow', 'Do not allow']);
  // Another session's question is its own.
  assert.deepEqual(texts(permissionActions({ ...card, name: 'api' })), ['Allow', 'Do not allow']);
  // "Do not allow" is Escape, with the same mark.
  box = permissionActions({ ...card, askAt: 9 }, () => looks++);
  await press(box.children[1]);
  assert.deepEqual(sent[1], ['/api/sessions/web%20ui/key', { key: 'Escape', owner: true, question: true, about: 'touch b.txt' }]);
  // Should the card say nothing new for ten seconds, the answers return.
  t.mock.timers.tick(10_200);
  assert.equal(answeredNow({ ...card, askAt: 9 }), false);
  assert.deepEqual(texts(permissionActions({ ...card, askAt: 9 })), ['Allow', 'Do not allow']);
  // The server found no permission question on the screen (409): nothing was typed, the buttons stay, the page looks again.
  answer = { ok: false, status: 409, json: async () => ({ error: 'No permission question is on the screen now. Look at the session and answer there' }) };
  box = permissionActions({ ...card, askAt: 10 }, () => looks++);
  const before = looks;
  await press(box.children[0]);
  assert.deepEqual([texts(box), box.children.map((b) => b.disabled), looks - before], [['Allow', 'Do not allow'], [false, false], 1]);
  assert.equal(answeredNow({ ...card, askAt: 10 }), false);
});

test('the mode that asks nothing says what it means, in the same sentences wherever it is chosen, for a terminal and the App', async () => {
  const sd = await import('../../web/sessiondefaults.js');
  assert.equal(sd.BYPASS_MEANS, 'Claude Code runs commands and changes files without asking. Use it only for folders you could lose. It still asks you: a question, a plan, a tool your settings say "ask" for, and before some deletes. Where it stops before a delete, Hoprig allows it by itself only when the delete is plainly inside the folder the command runs in (never your home, workspace or projects folder).');
  assert.equal(sd.BYPASS_MEANS.split(/(?<=\.) /).length, 4, 'four sentences');
  assert.equal('BYPASS_IN_CHAT' in sd, false, 'one rule (src/asking.mjs), one sentence: a chat and a terminal are the same');
  // Settings → New-session defaults (the banner under the choice); New session asks for no mode any more.
  assert.match(fs.readFileSync(path.join(WEB, 'sessiondefaults.js'), 'utf8'), /h\('p\.banner\.muted', BYPASS_MEANS\)/);
  const options = fs.readFileSync(path.join(WEB, 'newsession-options.js'), 'utf8');
  assert.doesNotMatch(options, /BYPASS_MEANS|can run any command and change any file/, 'no mode in More options');
  // The text itself is written once: every other page takes it from sessiondefaults.js.
  const holders = fs.readdirSync(WEB, { recursive: true }).filter((f) => f.endsWith('.js') && fs.readFileSync(path.join(WEB, f), 'utf8').includes('Hoprig allows it by itself only when the delete'));
  assert.deepEqual(holders, ['sessiondefaults.js']);
});

test('Home keeps "Your answer was sent." only as long as the session page: the answer is part of its render key', () => {
  // Without it Home drew the card once with the note and never again while the card itself did not change.
  assert.match(fs.readFileSync(path.join(WEB, 'home.js'), 'utf8'), /const key = JSON\.stringify\(\[only, all\.map\(\(m\) => \[[^\n]*m\.sessions\.map\(\(s\) => answeredNow\(s\)\)\]\)\]\);/);
  assert.match(fs.readFileSync(path.join(WEB, 'session.js'), 'utf8'), /const key = JSON\.stringify\(\[s, profiles, answeredNow\(/);
});

test('the session page says what Hoprig allowed by itself in bypass mode', () => {
  const src = fs.readFileSync(path.join(WEB, 'session.js'), 'utf8');
  assert.match(src, /'Allowed by Hoprig in bypass mode: '/);
  assert.match(src, /fill\(needSlot, [^\n]*allowedNote\(s\)/);
  // In the same words as the App's: the command itself for the shell, where it ran when not in the session's folder,
  // and read out to a screen reader.
  for (const file of ['session.js', 'chat/timeline.js']) {
    const text = fs.readFileSync(path.join(WEB, file), 'utf8');
    assert.match(text, /\.tool && [a-z]+\.tool !== 'Bash' \? `\$\{[a-z]+\.tool\}: ` : ''\}\$\{[a-z]+\.what \|\| [a-z]+\.tool\}\$\{[a-z]+\.folder \? ` · in \$\{[a-z]+\.folder\}` : ''\}/, file);
    assert.match(text, /allowed', \{ role: 'status'/, file);
  }
});

test('new session: what runs in a folder (a terminal session, or a chat at work) is one tap away beside its row', async () => {
  const { runningIn } = await import('../../web/newsession.js');
  assert.equal(runningIn({ live: true, session: 'web ui' }), '#/s/web%20ui');
  assert.equal(runningIn({ live: true, chat: '11111111-2222-4333-8444-555555555555' }), '#/chat/11111111-2222-4333-8444-555555555555');
  assert.equal(runningIn({ live: false, session: 'old' }), null, 'nothing runs there: a tap opens a new chat');
  assert.equal(runningIn({ live: true }), null);
  const src = fs.readFileSync(path.join(WEB, 'newsession-popup.js'), 'utf8');
  // One quiet line and More options first, then the projects.
  assert.ok(src.indexOf("'Tap a project to start'") < src.indexOf("groupHead('Recent')"), 'the line before the projects');
  assert.match(src, /row\(f, folderSub\(f, projectsShort\), \(e\) => start\(f, e\.currentTarget\)\)/, 'a tap on a project starts a new session, also where one runs');
  assert.match(src, /leave\(one \? link\(one, st\.m\) : sessionHref\(list\[0\]\)\)/, 'what runs there is its own button (runningIn)');
  assert.doesNotMatch(fs.readFileSync(path.join(WEB, 'newsession-options.js'), 'utf8'), /plain terminal/i, 'a plain shell opens from the chat, the Projects page and the editor');
});

test('new session: repositories by their own name, and a path only where it says more than the name', async () => {
  const { folderSub, repoWords } = await import('../../web/newsession.js');
  assert.deepEqual(repoWords('code/bookshop-api', 'bookshop'), { name: 'bookshop-api', sub: 'in bookshop' });
  assert.deepEqual(repoWords('.', 'bookshop'), { name: 'bookshop', sub: null }, 'a project\'s own folder: its name, no second line');
  assert.equal(folderSub({ name: 'shop', short: '~/Workspace/projects/shop' }, '~/Workspace/projects'), null, 'no "project" under every row');
  assert.equal(folderSub({ name: 'tool', short: '~/src/tool' }, '~/Workspace/projects'), '~/src/tool');
  assert.equal(folderSub({ name: 'x', short: '~/x' }, null), '~/x', 'projects folder not known: the path');
  const src = fs.readFileSync(path.join(WEB, 'newsession-popup.js'), 'utf8');
  assert.match(src, /sub \? h\('span\.row-sub', sub\) : null/, 'a row without a second line draws none');
  assert.deepEqual(repoWords('code/tool', null), { name: 'tool', sub: null }, 'a repository of no project: no second line');
});

test('Home cards: the pill leaves out what the heading says; the folder only when it is not projects/<name>', async () => {
  const { folderWorthShowing } = await import('../../web/sessionitem.js');
  assert.equal(folderWorthShowing({ name: 'shop', short: '~/Workspace/projects/shop' }), false);
  assert.equal(folderWorthShowing({ name: 'shop', short: '~/src/shop' }), true);
  assert.equal(folderWorthShowing({ name: 'shop-2', short: '~/Workspace/projects/shop' }), true, 'a second session: the folder tells which');
  const { statusPill } = await import('../../web/lib.js');
  const s = { status: 'working', statusAt: Date.now() - 120_000 };
  assert.deepEqual(texts(statusPill(s, { text: false })), ['2 min ago']);
  assert.deepEqual(texts(statusPill(s)), ['Working', ' · 2 min ago']);
});

test('workspace strip: a project that is not here gets a button that says so, not only "Sync"', async () => {
  const { stripActions, workspaceLine } = await import('../../web/workspace.js');
  const p = (label, state, url = `https://git.example.com/demo/${label}.git`) => ({ kind: 'project', label, state, url });
  const map = { exists: true, entries: [p('bookshop', 'here'), p('invoices', 'missing')] };
  const a = stripActions(map, workspaceLine(map, null));
  assert.deepEqual(texts(a), ['Get invoices', 'Sync']);
  assert.match(a.children[0].attrs.href || '', /^#\/get-project\/https%3A%2F%2Fgit\.example\.com%2Fdemo%2Finvoices\.git$/, 'what the card\'s Get it does');
  const three = { exists: true, entries: [p('a', 'missing'), p('b', 'missing'), p('c', 'missing')] };
  assert.deepEqual(texts(stripActions(three, workspaceLine(three, null))), ['Get 3 projects', 'Sync']);
  const none = { exists: true, entries: [p('bookshop', 'here')] };
  assert.deepEqual(texts(stripActions(none, workspaceLine(none, null))), ['Sync']);
  assert.equal(stripActions({ exists: false, entries: [] }, {}), null, 'no map: no buttons');
});

test('Setup on a plain leg: that computer\'s own page is a link only when it is an http or https address', async () => {
  const { pageHref } = await import('../../web/setupjob.js');
  assert.equal(pageHref('http://192.168.1.20:7433'), 'http://192.168.1.20:7433/');
  assert.equal(pageHref('https://pc.example.com/hop'), 'https://pc.example.com/hop');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', '//pc.example.com', 'not a url', '', null, 7]) assert.equal(pageHref(bad), null, String(bad));
});

test('a time until a limit resets: whole minutes first, so the minutes never read 60', async () => {
  const { until } = await import('../../web/lib.js');
  const now = Date.now();
  assert.equal(until(now + (2 * 3600 - 20) * 1000), 'in 2 h 0 min'); // was "in 1 h 60 min"
  assert.equal(until(now + 5400 * 1000), 'in 1 h 30 min');
  assert.equal(until(now + 59 * 60 * 1000), 'in 59 min');
});

test('one cost format: no part of the page writes a dollar amount its own way (web/chat/words.js money does)', () => {
  for (const f of pageFiles().filter((x) => x !== path.join('chat', 'words.js'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(WEB, f), 'utf8'), /\$\$\{[^`]*toFixed/, `${f}: a cost goes through money()`);
  }
});

test('a chat that is not open any more: its page\'s keys go with it (Esc would send a stop, Shift+Tab a mode change)', () => {
  const page = fs.readFileSync(path.join(WEB, 'chat', 'page.js'), 'utf8');
  const gone = page.slice(page.indexOf('function gone('), page.indexOf('const unfollow = follow('));
  assert.match(gone, /\bunkeys\(\)/, 'gone() removes the page\'s key handler');
});

test('a chat that is not open any more is never a dead end, and its head never says "New session"', () => {
  const page = fs.readFileSync(path.join(WEB, 'chat', 'page.js'), 'utf8');
  const gone = page.slice(page.indexOf('function gone('), page.indexOf('const unfollow = follow('));
  assert.match(gone, /was && was\.terminal \? h\('a\.btn\.primary', \{ href: link\(`#\/s\/\$\{encodeURIComponent\(was\.terminal\)\}`\) \}/, 'the terminal it went to');
  assert.match(gone, /'Continue in the App'/);
  assert.match(gone, /again\(true\)\ }, icon\('plus', \{ size: 18 \}\), h\('span', 'New session in this folder'\)/, 'nothing was said in it: a new session in its folder');
  assert.match(gone, /const lead = bin \|\| term \|\| go;/, 'one primary button');
  assert.match(gone, /was && was\.deleted \? h\('button\.btn\.primary'.*'Open the trash'/, 'a deleted one: the trash, where it is put back');
  assert.match(gone, /if \(bin && go\) go\.className = go\.className\.replace\('primary', 'secondary'\);/, 'and then only that one is primary');
  assert.match(fs.readFileSync(path.join(WEB, 'chat', 'header.js'), 'utf8'), /fill\(titleText, title \|\| 'Archived session'\);/);
});

test('Add provider → Other providers: as today with one gateway (its title and sentence), a step that asks which with more', async () => {
  const { otherProvidersChoice } = await import('../../web/accounts.js');
  const g = (id, title) => ({ id, title, words: { choice: `${title}: its own sentence` } });
  assert.equal(otherProvidersChoice([]), null, 'no gateway: no choice');
  assert.deepEqual(otherProvidersChoice([g('bridgebox', 'Bridgebox')]), { pick: false, id: 'bridgebox', title: 'Other providers through Bridgebox (for Claude Code)', sub: 'Bridgebox: its own sentence' });
  const two = otherProvidersChoice([g('bridgebox', 'Bridgebox'), g('relay', 'Relay')]);
  assert.equal(two.pick, true);
  assert.equal(two.title, 'Other providers through a gateway (for Claude Code)');
  assert.match(two.sub, /a gateway on this computer: Bridgebox, Relay\.$/);
});

test('Add a gateway: the program and its arguments are shown as code, the sentences around them as text', async () => {
  const { runsBlocks } = await import('../../web/gatewaydefine.js');
  assert.deepEqual(runsBlocks([
    'When it starts, Hoprig runs:',
    '  /opt/relay/bin/relay --listen=127.0.0.1:20100',
    '  (relay is /opt/relay/bin/relay on this computer)',
    'Nothing of it goes through a shell.',
  ]), [
    { code: false, text: 'When it starts, Hoprig runs:' },
    { code: true, text: '/opt/relay/bin/relay --listen=127.0.0.1:20100\n(relay is /opt/relay/bin/relay on this computer)' },
    { code: false, text: 'Nothing of it goes through a shell.' },
  ]);
  assert.deepEqual(runsBlocks(null), []);
});

test('a gateway that is not running: the shipped package reads as before; a program of the owner\'s own is not "installed"', async () => {
  const { notRunningText } = await import('../../web/accounts.js');
  assert.equal(notRunningText({ title: 'Bridgebox', installable: true, page: 'http://localhost:20017/' }), 'Bridgebox is installed but not running. Start it, then add your provider in its page and come back with a key.');
  assert.equal(notRunningText({ title: 'Relay', installable: false, page: null }), 'Relay is on this computer but not running. Start it, then add your provider in it and come back with a key.');
});

test('Add a gateway: the short name made from the name keeps its letters and starts with a letter', async () => {
  const { shortNameOf } = await import('../../web/gatewaydefine.js');
  assert.equal(shortNameOf('Relé'), 'rele');
  assert.equal(shortNameOf('2nd Relay'), 'g-2nd-relay');
  assert.equal(shortNameOf('  My  Relay (local) '), 'my-relay-local');
  assert.equal(shortNameOf('x'.repeat(40)), 'x'.repeat(31));
});

test('Add a gateway: every part the server names in an error has its label on the form', async () => {
  const { FIELD_LABELS } = await import('../../web/gatewaydefine.js');
  assert.deepEqual(Object.keys(FIELD_LABELS).sort(), ['args', 'bin', 'dashboard', 'firstPassword', 'id', 'npm', 'port', 'title']);
  const src = fs.readFileSync(path.join(WEB, 'gatewaydefine.js'), 'utf8');
  for (const k of Object.keys(FIELD_LABELS)) assert.match(src, new RegExp(`row\\('${k}'`), `${k} is a row of the form, with its error under it`);
});

test('Add-ons: a gateway definition that was not loaded is said, with its reason', async () => {
  const { skippedLines } = await import('../../web/addons.js');
  assert.deepEqual(skippedLines({ skipped: [{ id: 'relay', error: 'port 20017 is Bridgebox\'s' }, { id: null, error: 'a gateway is an object' }] }), [
    'A gateway in config.json (relay) was not loaded: port 20017 is Bridgebox\'s.',
    'A gateway in config.json was not loaded: a gateway is an object.',
  ]);
  assert.deepEqual(skippedLines({}), [], 'an older computer sends none');
});

test('Add-ons: a gateway whose program changed says so and offers Confirm the new program instead of Start', async () => {
  const { needsConfirmText } = await import('../../web/gatewaydefine.js');
  assert.match(needsConfirmText({ needsConfirm: 'changed' }), /^Its program changed since you confirmed it, so it is not started\. If you changed it yourself \(an update\), confirm the new program\.$/);
  assert.match(needsConfirmText({ needsConfirm: 'no-fingerprint' }), /keeps no fingerprint of its program/);
  assert.equal(needsConfirmText({}), null, 'as confirmed, and an older computer: nothing');
  const src = fs.readFileSync(path.join(WEB, 'addons.js'), 'utf8');
  assert.match(src, /a\.installed && !a\.running && !a\.foreign && !a\.needsConfirm \? start\(\)/, 'no Start that would only fail');
  assert.match(src, /label: a\.needsConfirm === 'changed' \|\| a\.needsConfirm === 'gone' \? 'Confirm the new program' : 'Confirm the program', disabled: busy, onclick: \(\) => confirmGatewayProgram\(a, again\)/);
  assert.match(src, /'Program changed'/, 'its state says it');
});

test('Add-ons: "Open its dashboard" only for a gateway that has a page; the shipped one as before', async () => {
  const { pageOf } = await import('../../web/addons.js');
  assert.equal(pageOf({ url: 'http://localhost:20017' }), 'http://localhost:20017', 'the shipped one (and an older computer): its url');
  assert.equal(pageOf({ url: 'http://localhost:7777', defined: true, page: null }), null, 'no page of its own: no link, no sentence');
  assert.equal(pageOf({ url: 'http://localhost:7777', defined: true, page: 'http://localhost:7777/ui' }), 'http://localhost:7777/ui');
  const src = fs.readFileSync(path.join(WEB, 'addons.js'), 'utf8');
  assert.doesNotMatch(src, /a\.running && a\.url/, 'the row never offers the API port as a page');
});

test('Providers: one whose gateway was removed is muted, listed last, and its page says why and offers Remove', async () => {
  const { profileState } = await import('../../web/lib.js');
  assert.deepEqual(profileState({ kind: 'api', gatewayGone: { id: 'relay' } }), { key: 'unusable', text: 'Its gateway relay was removed' });
  assert.deepEqual(profileState({ kind: 'api', gatewayGone: { id: 'relay', notLoaded: 'port 20017 is Bridgebox\'s' } }), { key: 'unusable', text: 'Its gateway relay was not loaded' });
  assert.deepEqual(profileState({ kind: 'api' }), { key: 'free', text: 'Available' });
  const src = fs.readFileSync(path.join(WEB, 'accounts.js'), 'utf8');
  assert.match(src, /a\.unusable \|\| a\.gatewayGone \? unusableBox\(a, d\)/, 'its page: the box with Remove');
  assert.match(src, /Its gateway \$\{a\.gatewayGone\.id\} was removed from this computer, so its sessions will not start\./);
  assert.match(src, /Its gateway \$\{a\.gatewayGone\.id\} is in config\.json but was not loaded \(\$\{a\.gatewayGone\.notLoaded\}\), so its sessions will not start\. Fix it there, or remove this provider\./, 'one not loaded: not "removed", and why');
  assert.match(src, /a\.unusable \|\| a\.gatewayGone \? 2/, 'listed last');
});

test('Other providers: a gateway whose program is missing says so without saying it is there, and can be checked again', async () => {
  const src = fs.readFileSync(path.join(WEB, 'accounts.js'), 'utf8');
  const missing = src.slice(src.indexOf('if (!g.installed) {'), src.indexOf('if (!g.running) {'));
  assert.match(missing, /g\.installable \? h\('p\.sheet-text', g\.words\.what\) : null,/, 'its "is a gateway on this computer" only when it can be installed');
  assert.match(missing, /: missing\(g\),/, 'its own words in place of Install');
  const box = src.slice(src.indexOf('const missing = (gw) => {'), src.indexOf('const job = '));
  assert.match(box, /programFacts\(gw\.title, view\)/, 'the words say its program was not found (web/gateways.js)');
  assert.match(box, /fill\(box, errorBox\(text, again\)/, 'with Try again');
});

test('the trust notice: its status names it, its card is the tool\'s own lines (folder, question, both answers)', async () => {
  const { stateOf } = await import('../../web/lib.js');
  const { exactCard } = await import('../../web/handsoff.js');
  const notice = { kind: 'notice', source: 'screen', notice: { type: 'trust', folder: '/w/shop', text: 'Quick safety check: Is this a project you created or one you trust?', detail: 'Claude Code\'ll be able to read, edit, and execute files here.', answers: ['No, exit', 'Yes, I trust this folder'] } };
  assert.equal(stateOf({ kind: 'claude', status: 'attention', askCard: notice }).text, 'Trust this folder?');
  assert.equal(stateOf({ kind: 'claude', status: 'attention' }).text, 'Needs your OK');
  const words = texts(exactCard(notice));
  for (const w of ['/w/shop', 'Quick safety check: Is this a project you created or one you trust?', 'No, exit', 'Yes, I trust this folder', 'Read from the screen']) assert.ok(words.includes(w), w);
  assert.ok(words.indexOf('No, exit') < words.indexOf('Yes, I trust this folder'), 'the answers in the tool\'s order');
});

test('the session page says when more than one question waits, above the exact card', () => {
  const src = fs.readFileSync(path.join(WEB, 'session.js'), 'utf8');
  assert.match(src, /s\.ask\.type !== 'permission' && s\.ask\.waiting > 1/);
  assert.match(src, /More than one question waits \(\$\{s\.ask\.waiting\}\): this is one of them/);
});

test('the App\'s question card marks the option the tool marked, says where it came from and what the tool does not tell', async () => {
  const { askCard } = await import('../../web/chat/asks.js');
  const { cardOf } = await import('../../src/askcard.mjs');
  const input = { questions: [{ question: 'Which test runner?', header: 'Runner', multiSelect: false, options: [{ label: 'node:test (Recommended)', description: 'Built in.' }, { label: 'vitest', description: 'Fast.' }] }] };
  const ev = { type: 'question', tool: 'AskUserQuestion', request: 'r1', input, card: cardOf({ tool: 'AskUserQuestion', input, engine: 'claude', source: 'channel' }) };
  const words = texts(askCard(ev, { A: '/api/chats/x' }));
  assert.equal(words.filter((w) => w === 'Marked by the tool').length, 1);
  assert.ok(words.indexOf('Marked by the tool') > words.indexOf('node:test (Recommended)') && words.indexOf('Marked by the tool') < words.indexOf('vitest'), 'on the marked option');
  assert.ok(words.includes('As the coding tool asked it'));
  // OpenCode: no mark, and the card says so.
  const oc = { ...ev, card: cardOf({ tool: 'AskUserQuestion', input, engine: 'opencode', source: 'channel' }) };
  const ocWords = texts(askCard(oc, { A: '/api/chats/x', who: 'OpenCode' }));
  assert.ok(ocWords.includes('OpenCode marks no option as recommended.'));
  assert.ok(!ocWords.includes('Marked by the tool'));
});

test('a plan\'s answer line on the page says the mode once, in words', async () => {
  const { answerLine } = await import('../../web/handsoff.js');
  assert.equal(answerLine({ text: 'approved the plan; it goes on in Accept edits, the mode it had', because: 'plan' }), 'approved the plan; it goes on in Accept edits, the mode it had');
  assert.equal(answerLine({ question: 'Which?', text: 'npm (Recommended)', because: 'recommended' }), 'Which? → npm (Recommended), because the tool recommended it');
});

test('what Hands-off answered: the newest with its time, the earlier ones when opened, dimmed under a newer question', async () => {
  const { answeredLines } = await import('../../web/handsoff.js');
  const now = Date.now();
  const done = [
    { at: now - 7_200_000, question: 'Which linter?', text: 'eslint (Recommended)', because: 'recommended' },
    { at: now - 720_000, question: 'Which package manager?', text: 'npm (Recommended)', because: 'recommended' },
  ];
  const el = answeredLines(done);
  assert.equal(el.tag, 'details', 'it opens to the earlier answers');
  const words = texts(el).join('');
  assert.match(words, /Answered by Hoprig 12 min ago: Which package manager\? → npm \(Recommended\), because the tool recommended it/);
  assert.match(words, /Which linter\? → eslint \(Recommended\), because the tool recommended it · 2 h ago/);
  assert.doesNotMatch(el.className, /ho-older/);
  // A question that came after the newest answer waits: the line is dimmed and says it was before that question.
  const under = answeredLines(done, { askAt: now - 1000 });
  assert.match(under.className, /ho-older/);
  assert.match(texts(under).join(''), /before the question above, which waits for you/);
  assert.equal(answeredLines([done[1]]).tag, 'p', 'one answer: one line');
});

test('after a press on the Hands-off bar the focus goes to the new bar\'s button, not to the page\'s body', async () => {
  const { handsOffBar } = await import('../../web/handsoff.js');
  document.body = new FakeElement('body');
  const focused = [];
  FakeElement.prototype.focus = function () { focused.push(this); };
  try {
    const button = (bar) => bar.children.find((c) => c.tag === 'button');
    const first = handsOffBar({ on: true }, async () => {});
    await button(first).listeners.click();
    const next = handsOffBar({ on: false, own: true }, async () => {});
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(focused, [button(next)]);
    // A bar drawn later for another reason takes no focus.
    handsOffBar({ on: false, own: true }, async () => {});
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(focused.length, 1);
  } finally {
    delete FakeElement.prototype.focus;
    delete document.body;
  }
});

test('the exact card above a terminal has a height limit and scrolls inside itself', () => {
  const css = fs.readFileSync(path.join(WEB, 'page-session.css'), 'utf8');
  assert.match(css, /\.sess-need \.ho-card \{[^}]*max-height: 40dvh;[^}]*overflow: auto;/);
  assert.match(css, /@media \(max-width: 480px\) \{ \.sess-need \.ho-card \{ max-height: 24dvh; \} \}/, 'less on a phone');
});

test('Settings → Hands-off: a note typed and not saved stays over a switch change; a row is titled by its folder\'s name', async () => {
  const { registeredSettingsPages } = await import('../../web/registry.js');
  await import('../../web/handsoffsettings.js');
  const page = registeredSettingsPages().find((p) => p.id === 'handsoff');
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o = {}) => {
    if (o.method === 'POST') sent.push(JSON.parse(o.body));
    return { ok: true, status: 200, json: async () => (o.method === 'POST' ? {} : { projects: [{ dir: '/w/projects/shop', on: true, stale: false, note: 'Old note.' }] }) };
  };
  const walk = (n, f) => (n instanceof FakeElement ? [...(f(n) ? [n] : []), ...n.children.flatMap((c) => walk(c, f))] : []);
  FakeElement.prototype.querySelectorAll = function (sel) {
    assert.equal(sel, 'textarea[data-dir]');
    return walk(this, (n) => n.tag === 'textarea' && n.dataset.dir);
  };
  try {
    const root = new FakeElement('div');
    root.append(...page.render());
    const tick = () => new Promise((r) => setTimeout(r, 5));
    await tick();
    const list = walk(root, (n) => /ho-projects/.test(n.className))[0];
    assert.ok(texts(list).includes('shop'), 'the folder\'s name titles the row');
    assert.ok(texts(list).includes('/w/projects/shop'), 'its path under it');
    walk(list, (n) => n.tag === 'textarea')[0].value = 'Prefer the smallest change.';
    await walk(list, (n) => n.tag === 'input')[0].listeners.change({ target: { checked: false } });
    await tick();
    assert.deepEqual(sent, [{ dir: '/w/projects/shop', on: false }]);
    assert.equal(walk(list, (n) => n.tag === 'textarea')[0].value, 'Prefer the smallest change.', 'the typed note is kept');
  } finally {
    globalThis.fetch = realFetch;
    delete FakeElement.prototype.querySelectorAll;
  }
});

test('the Hands-off bar: in the App it says plans are approved too; the loop is said once, by the bar', async () => {
  const { handsOffBar } = await import('../../web/handsoff.js');
  const words = (el) => texts(el).join(' ');
  assert.match(words(handsOffBar({ on: true }, async () => {}, null, { app: true })), /and approves plans, keeping the mode/);
  assert.doesNotMatch(words(handsOffBar({ on: true }, async () => {})), /plans/, 'a terminal\'s plan waits for the owner');
  const src = fs.readFileSync(path.join(WEB, 'session.js'), 'utf8');
  assert.match(src, /\(s\.handsWait === 'loop' \|\| s\.handsWait === 'hour'\) && s\.handsOff && s\.handsOff\.loop \? '' : waitWords\(s\.handsWait\)/);
});

test('a coding tool that ended at its start reads "Did not start" under Needs you, with its reason, never as a terminal', async () => {
  const { stateOf, needsYou } = await import('../../web/lib.js');
  const { groupOf } = await import('../../web/home.js');
  const card = { name: 'shop', kind: 'shell', status: 'failed', command: 'bash', note: '--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons', startFailed: { code: 1, tool: 'claude' } };
  assert.deepEqual(stateOf(card), { key: 'failed', text: 'Did not start', rank: 0 });
  assert.equal(needsYou(card), true);
  assert.equal(groupOf(card), 'needs');
  assert.equal(stateOf({ name: 't', kind: 'shell', command: 'bash' }).text, 'Terminal', 'a plain terminal stays one');
  const src = fs.readFileSync(path.join(WEB, 'sessionitem.js'), 'utf8');
  assert.match(src, /st\.key === 'failed' && s\.note \? h\('p\.card-note', s\.note\)/, 'the card shows the reason');
  assert.match(src, /st\.key === 'failed' && s\.note \? h\('span\.si-note', s\.note\)/, 'and the Workspace row');
  assert.match(fs.readFileSync(path.join(WEB, 'session.js'), 'utf8'), /stateOf\(s\)\.key === 'failed' \? didNotStart\(s\)/, 'the session page says it above the terminal');
});

test('a start Claude Code refused as root says what to do next: a mode that asks, or the move', async () => {
  const { rootRefusedNext } = await import('../../web/sessionitem.js');
  const { CLAUDE_ROOT_REFUSAL } = await import('../../src/setup/rootfacts.mjs');
  assert.match(rootRefusedNext(CLAUDE_ROOT_REFUSAL), /mode that asks \(Manual or Accept edits\).*Settings → Runs as root/);
  assert.equal(rootRefusedNext('npm error network'), null, 'another reason gets no root advice');
  assert.equal(rootRefusedNext(''), null);
  const src = fs.readFileSync(path.join(WEB, 'sessionitem.js'), 'utf8');
  assert.match(src, /st\.key === 'failed' && rootRefusedNext\(s\.note\) \? h\('p\.card-note\.card-next', rootRefusedNext\(s\.note\)\)/, 'the card on Home says it');
  assert.match(fs.readFileSync(path.join(WEB, 'session.js'), 'utf8'), /rootRefusedNext\(s\.note\) \? h\('p\.sess-ok-text', h\('a', \{ href: '#\/settings\/root' \}/, 'and the session page, with the way to Settings');
});

test('New project: a name as he types it becomes a folder name; only nothing usable is refused', async () => {
  const { toFolderName } = await import('../../web/projects.js');
  assert.equal(toFolderName('Bakery Website'), 'bakery-website');
  assert.equal(toFolderName('  Café & Bar!  '), 'cafe-bar');
  assert.equal(toFolderName('shop-v2'), 'shop-v2', 'a name that is fine stays as it is');
  assert.equal(toFolderName('My.Shop'), 'My.Shop');
  assert.equal(toFolderName('!!!'), '', 'nothing usable: the rule is said');
  assert.equal(toFolderName(''), '');
  assert.match(fs.readFileSync(path.join(WEB, 'projects.js'), 'utf8'), /const v = toFolderName\(input\.value\)/, 'the form uses it');
});

test('Home: a computer that does not answer is said in plain words; the system error is not the line', async () => {
  const { offlineWords } = await import('../../web/home.js');
  const texts = (n) => (n instanceof FakeText ? [n.text] : typeof n === 'string' ? [n] : n.children.flatMap(texts));
  const line = offlineWords({ machine: 'laptop', machineLabel: 'Laptop', status: 'offline', error: 'connect ECONNREFUSED 127.0.0.1:43171' }).flatMap(texts).join('');
  assert.match(line, /^Laptop cannot be reached\. Is it switched on and online\?/);
  assert.match(fs.readFileSync(path.join(WEB, 'pc.js'), 'utf8'), /`\$\{ctx\.label\(\)\} cannot be reached`/, 'the same words as the computer\'s own page');
  assert.doesNotMatch(line, /ECONNREFUSED|127\.0\.0\.1/, 'the raw error stays out of the line');
  assert.match(offlineWords({ machineLabel: 'NAS', status: 'too-old' }).flatMap(texts).join(''), /^NAS: Needs a .+ update\. Open it/);
  assert.match(fs.readFileSync(path.join(WEB, 'home.js'), 'utf8'), /href: link\('#\/computer', m\.machine\), title: m\.error/, 'it leads to that computer\'s page, the error as its tooltip');
});

test('a sentence that sends him to a switch in Settings opens the page at that switch, with the focus on it', async () => {
  const { partOf, showPart } = await import('../../web/showpart.js');
  const q = (s) => new URLSearchParams(s);
  assert.equal(partOf(q('show=bypass')), 'bypass');
  for (const bad of ['', 'show=', 'show=../x', 'show=Bypass', 'show=a%20b', `show=${'a'.repeat(41)}`]) assert.equal(partOf(q(bad)), null, bad);
  assert.equal(partOf(null), null);
  // Found once drawn: brought to the middle of the window, its switch focused, nothing pressed.
  const seen = [];
  const control = { focus: () => seen.push('focus'), click: () => seen.push('click') };
  const el = { querySelector: () => control, scrollIntoView: (o) => seen.push(`scroll ${o.block}`), focus: () => seen.push('panel') };
  let n = 0;
  assert.equal(await showPart('bypass', { find: (id) => (id === 'bypass' && ++n > 2 ? el : null), every: 1 }), el);
  assert.deepEqual(seen, ['focus', 'scroll center']);
  assert.equal(await showPart('gone', { find: () => null, tries: 3, every: 1 }), null);
  // The bypass switch is that place, and Home's note about it leads there.
  const sd = await import('../../web/sessiondefaults.js');
  assert.equal(sd.bypassPanel({ allow: false }, () => {}).attrs.id, 'bypass');
  const { BYPASS_SWITCH } = await import('../../web/home.js');
  assert.equal(BYPASS_SWITCH, '#/settings/new-sessions?show=bypass');
  assert.match(fs.readFileSync(path.join(WEB, 'home.js'), 'utf8'), /href: BYPASS_SWITCH, onclick: \(\) => seen\(\) \}, 'Open the switch'/);
  assert.match(fs.readFileSync(path.join(WEB, 'settings.js'), 'utf8'), /const part = partFor\(sub, partOf\(query\), pages\);\n\s*if \(part\) showPart\(part, \{ alive: isAlive \}\);/);
});

test('the sign-in code\'s banner opens the switch it names', async () => {
  const { PUBLIC_LINK_SWITCH } = await import('../../web/computers.js');
  assert.equal(PUBLIC_LINK_SWITCH, '#/settings/public-link?show=public-link-switch');
  const src = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');
  assert.match(src('computers.js'), /by its network address\. ', h\('a', \{ href: link\(PUBLIC_LINK_SWITCH\) \}, 'Open the switch'\)/);
  assert.match(src('publiclink.js'), /return panel\(\{ id: 'public-link-switch' \},\n\s*h\('label\.switchrow\.pl-switch'/);
});
