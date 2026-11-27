// The guard that keeps Hoprig easy: the eight rules of the easy design as tests, and a ninth for the touch screen.
// What can be read from the registered pages and from the source is checked here, in the page tests' small stand-in
// DOM. What needs a real layout (the first screen, the page height, tabs that slide, press areas, repeated button
// labels, headings with a count of 0) is measured by tools/easy-guard.mjs in a browser on the built-in demo; this file
// pins that tool's judging with made-up measurements, so a rule it stopped checking shows here.
//
// KNOWN_BREAKS is the list of pages that break a rule TODAY: each entry is a debt of the next stage, and an empty list
// is the aim. A break that is not in the list fails the test; an entry that no longer breaks fails it too (remove it).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FakeElement } from '../chat/fakedom.mjs';

globalThis.location = { hash: '#/', pathname: '/', protocol: 'http:', hostname: 'localhost', origin: 'http://localhost', href: '' };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.innerWidth = 393;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');
const RULES = ['menu', 'count', 'head', 'tabs', 'door', 'advanced', 'empty', 'short', 'touch'];

// ---- the debts: { page, rule, why } ----
const KNOWN_BREAKS = [
];

// Every page file of the app, except the App chat's own (web/chat is being rebuilt; reported apart by the browser tool).
const webFiles = fs.readdirSync(WEB).filter((f) => f.endsWith('.js'));
const imports = [...read('app.js').matchAll(/^import '\.\/([\w/.-]+\.js)';/gm)].map((m) => m[1]).concat(['home.js']);
const notLoaded = [];
for (const f of imports) {
  try {
    await import(`../../web/${f}`);
  } catch (e) {
    notLoaded.push(`${f}: ${String(e.message).slice(0, 80)}`);
  }
}
const registry = await import('../../web/registry.js');
const shell = await import('../../web/shell.js');

const breaks = []; // { page, rule, text }
const broken = (page, rule, text) => breaks.push({ page, rule, text });

// ---- rule 1: one menu (at most 6 on a wide screen, 5 in the phone bar, no More page) ----
{
  const { list, bar } = shell.menuItems();
  if (list.length > 6) broken('menu', 'menu', `${list.length} items in the list`);
  if (bar.length > 5) broken('menu', 'menu', `${bar.length} items in the phone bar`);
  const titles = list.map((p) => p.title);
  if (new Set(titles).size !== titles.length) broken('menu', 'menu', `a page listed under two names: ${titles.join(', ')}`);
  for (const p of registry.allPages()) {
    if (p.group === 'more' && p.id !== 'settings') broken(`#/${p.id}`, 'menu', 'registered in the old More group');
    if (p.id === 'more') broken('#/more', 'menu', 'a More page is registered');
  }
  if (!/'\/more': '\/settings'/.test(read('app.js'))) broken('#/more', 'menu', '#/more does not land on Settings');
  if (/side-group-title|href: '#\/more'/.test(read('shell.js'))) broken('menu', 'menu', 'a group heading or a More tab in shell.js');
}

// ---- rule 2: one count in one place (the only badge is Home's, fed by Needs you) ----
{
  // (A page outside the menu keeps a hook of its own; only a page the menu lists could show a number.)
  for (const p of registry.allPages()) if (p.group && String(p.badge) !== '() => 0') broken(`#/${p.id}`, 'count', 'registers a badge of its own');
  for (const f of webFiles) {
    const s = read(f);
    if (f !== 'shell.js' && /nav-badge/.test(s)) broken(`web/${f}`, 'count', 'draws a menu badge outside shell.js');
    if (/registerHomeCount\(/.test(s) && !['home.js', 'operator.js', 'registry.js'].includes(f)) broken(`web/${f}`, 'count', 'feeds the Home badge from a place that is not Needs you');
  }
  if (/tia-launch-n|count\.textContent = String\(n\)/.test(read('tia.js'))) broken('web/tia.js', 'count', 'a number badge on the Tia button; Home has the only one');
  const { list } = shell.menuItems();
  for (const p of list) if (p.id !== 'home' && p.count) broken(`#/${p.id}`, 'count', `a badge of ${p.count}`);
  // Counts in tabs are a second number in the menu's place: no tab list carries one.
  for (const f of ['work.js', 'pc.js', 'tia.js', 'brainlink.js']) {
    for (const m of read(f).matchAll(/tabBar\([^\n]*/g)) if (/\bcount\b/.test(m[0])) broken(`web/${f}`, 'count', 'a count inside a tab');
  }
}

// ---- rule 3: a page head is a title, one primary button, one line of words at 393, no theme button ----
{
  const s = read('shell.js');
  if (/themeButton|Dark colours|Light colours/.test(s)) broken('head', 'head', 'a theme button in the page head');
  const phoneLine = 45; // characters that fit one line at 393 px in the head's text size
  for (const f of webFiles) {
    const src = read(f);
    for (const m of src.matchAll(/\bframe\(\{/g)) {
      const call = src.slice(m.index, m.index + 900);
      const intro = /\bintro: ('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/.exec(call);
      if (intro && intro[1].length - 2 > phoneLine && !/introOnPhone: false/.test(call.slice(0, call.indexOf('body') < 0 ? 900 : call.indexOf('body')))) {
        broken(`web/${f}`, 'head', `an intro of ${intro[1].length - 2} characters shows on a phone: ${intro[1].slice(1, 40)}...`);
      }
      if ((call.match(/\bprimary: \{/g) || []).length > 1) broken(`web/${f}`, 'head', 'two primary buttons in one head');
    }
  }
}

// ---- rule 4: tabs at most four; straight under the head (the browser tool measures what is above them) ----
{
  const { TABS } = await import('../../web/work.js');
  if (TABS.length > 4) broken('web/work.js', 'tabs', `${TABS.length} tabs`);
  const { PARTS } = await import('../../web/pc.js');
  if (PARTS.length > 4) broken('web/pc.js', 'tabs', `${PARTS.length} tabs`);
  const views = /const VIEWS = \[([^;]*)\];/.exec(read('tia.js'));
  const nViews = views ? (views[1].match(/\['/g) || []).length : 0;
  if (nViews > 4) broken('web/tia.js', 'tabs', `${nViews} tabs`);
  const { projectsTabs } = await import('../../web/brainlink.js');
  const bar = projectsTabs('projects');
  const items = bar.querySelectorAll('a.tabs-item');
  if (items.length > 4 || !items.length) broken('web/brainlink.js', 'tabs', `${items.length} tabs of Projects`);
  if (bar.querySelectorAll('.tabs-count').length) broken('web/brainlink.js', 'tabs', 'a count in a tab');
  // tabBar is plain links with no scroll arrows and no wrapper that hides tabs: it slides only when it holds too many.
  for (const f of webFiles) {
    if (f === 'shell.js') continue;
    const s = read(f);
    const n = (s.match(/\btabBar\(/g) || []).length;
    if (n && !['work.js', 'pc.js', 'tia.js', 'brainlink.js'].includes(f)) broken(`web/${f}`, 'tabs', 'a tab list this test does not know: add it to rule 4');
  }
}

// ---- rule 5: one door per act: a setting is written from one page only; no two menu pages share a name ----
{
  const wrote = new Map(); // setting key -> files
  for (const f of webFiles) {
    for (const m of read(f).matchAll(/api\('~?\/api\/settings', \{\s*(\w+)(?::\s*\{\s*(\w+))?/g)) {
      const key = m[1] === 'server' || m[1] === 'sessionDefaults' ? m[2] || m[1] : m[1];
      wrote.set(key, [...new Set([...(wrote.get(key) || []), f])]);
    }
  }
  for (const [key, files] of wrote) if (files.length > 1) broken(`web/${files.join(' and web/')}`, 'door', `the setting ${key} is written from ${files.length} files`);
  const names = registry.registeredSettingsPages().filter((p) => (p.when ? true : true)).map((p) => p.title);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) broken('settings', 'door', `two settings pages with one name: ${dup.join(', ')}`);
}

// ---- rule 6: advanced is one press: every fold is closed on first paint ----
{
  const d = shell.fold('probe', 'Advanced', new FakeElement('p'));
  if (d.open) broken('web/shell.js', 'advanced', 'fold() opens by itself on first paint');
  if (!/prefs\.get\(`fold\.\$\{key\}`, false\)/.test(read('shell.js'))) broken('web/shell.js', 'advanced', 'a fold default that is not closed');
  for (const f of webFiles) {
    for (const m of read(f).matchAll(/details[^\n]*\{[^}\n]*\bopen: (true)\b[^\n]*/g)) broken(`web/${f}`, 'advanced', `a details drawn open: ${m[0].slice(0, 60)}`);
    for (const m of read(f).matchAll(/\bfold\([^\n]*\{ ?open: true/g)) broken(`web/${f}`, 'advanced', `a fold drawn open: ${m[0].slice(0, 60)}`);
  }
}

// ---- rule 7 and 8 need a real layout (a heading with a count of 0, row counts, page height): tools/easy-guard.mjs ----

// ---- rule 9: on a touch screen every control is at least 44 by 44: one rule in the shared style ----
{
  const css = read('style.css');
  const blocks = [...css.matchAll(/@media \(pointer: coarse\) \{\n([\s\S]*?)\n\}/g)].map((m) => m[1]);
  const wide = blocks.find((b) => /(^|[\s,])button\b|\.btn\b/.test(b) && /\.tabs-item/.test(b) && /\.icon-btn/.test(b) && /min-height: ?44px/.test(b) && /min-width: ?44px/.test(b));
  if (!wide) broken('web/style.css', 'touch', 'no one rule for touch screens that gives buttons, tabs, icon buttons, links and switches 44 by 44');
}

const report = breaks.map((b) => `${b.rule}|${b.page}`);
const known = new Set(KNOWN_BREAKS.map((k) => `${k.rule}|${k.page}`));

for (const rule of RULES) {
  test(`rule ${rule}: no break that is not in the known list`, (t) => {
    const mine = breaks.filter((b) => b.rule === rule);
    for (const b of mine) t.diagnostic(`${known.has(`${b.rule}|${b.page}`) ? 'known' : 'NEW'} ${b.rule} | ${b.page} | ${b.text}`);
    const fresh = mine.filter((b) => !known.has(`${b.rule}|${b.page}`));
    assert.deepEqual(fresh.map((b) => `${b.page}: ${b.text}`), [], `pages that break rule ${rule} and are not in KNOWN_BREAKS`);
  });
}

test('the known list holds no entry that has been mended: each one still breaks', () => {
  const stale = KNOWN_BREAKS.filter((k) => !report.includes(`${k.rule}|${k.page}`));
  assert.deepEqual(stale.map((k) => `${k.rule} | ${k.page}`), [], 'remove these from KNOWN_BREAKS: they are clean now');
  for (const k of KNOWN_BREAKS) assert.ok(RULES.includes(k.rule) && k.page && k.why, `an entry needs a rule, a page and why: ${JSON.stringify(k)}`);
});

test('the test saw the app: the main pages are registered and every feature file loaded', () => {
  assert.deepEqual(notLoaded.filter((n) => !/^(chat\/|editor\/|desktop\/)/.test(n)), [], 'feature files that did not load in the stand-in DOM');
  const ids = registry.allPages().map((p) => p.id);
  for (const id of ['work', 'workspace', 'providers', 'computers', 'settings']) assert.ok(ids.includes(id), `${id} is registered`);
});

test('the browser tool judges each rule: a clean page passes, each break is named', async () => {
  const { judge, RULES: toolRules } = await import('../../tools/easy-guard.mjs');
  assert.deepEqual(toolRules, RULES, 'the tool and this test know the same rules');
  const clean = {
    w: 393, h: 852, controls: 6, screens: 1.4, sideways: 0, menu: { bar: 5, side: 0, more: 0, groupTitles: 0 }, badges: [{ on: '#/', n: '2' }], otherBadges: [], tabCounts: 0,
    needsRows: 2, zeroGroups: [], head: { primaries: ['New'], theme: [], introLines: 0, introText: '' }, tabs: [{ n: 4, slides: 0, cut: 0, above: 0 }],
    openFolds: [], repeated: [], longLists: [], small: [],
  };
  const o = { phone: true, addr: '#/' };
  assert.deepEqual(judge(clean, o), []);
  const one = (patch, rule, part = o) => {
    const faults = judge({ ...clean, ...patch }, part);
    assert.ok(faults.some((f) => f.rule === rule), `${rule}: ${JSON.stringify(faults)}`);
  };
  one({ menu: { ...clean.menu, bar: 6 } }, 'menu');
  one({ menu: { ...clean.menu, more: 1 } }, 'menu');
  one({ badges: [{ on: '#/work', n: '1' }] }, 'count', { phone: true, addr: '#/work' });
  one({ badges: [{ on: '#/', n: '3' }] }, 'count');
  one({ tabCounts: 1 }, 'count');
  one({ otherBadges: ['1 on Ask Tia'] }, 'count');
  one({ head: { ...clean.head, primaries: ['A', 'B'] } }, 'head');
  one({ head: { ...clean.head, theme: ['Dark colours'] } }, 'head');
  one({ head: { ...clean.head, introLines: 2.9, introText: 'long' } }, 'head');
  one({ tabs: [{ n: 5, slides: 0, cut: 0, above: 0 }] }, 'tabs');
  one({ tabs: [{ n: 3, slides: 40, cut: 1, above: 0 }] }, 'tabs');
  one({ tabs: [{ n: 3, slides: 0, cut: 0, above: 1 }] }, 'tabs');
  one({ repeated: ['add x2'] }, 'door');
  one({ openFolds: ['Advanced'] }, 'advanced', { phone: true, addr: '#/work' });
  assert.deepEqual(judge({ ...clean, openFolds: ['Go live'] }, { phone: true, addr: '#/work/golive' }), [], 'an old address that opens its part on purpose');
  assert.equal(judge({ ...clean, openFolds: ['Go live'] }, { phone: true, addr: '#/work' }).length, 1, 'the same fold open on a plain visit is a break');
  one({ zeroGroups: ['Ready 0'] }, 'empty');
  one({ longLists: ['A.row x40'] }, 'short');
  one({ screens: 3.5 }, 'short', { phone: true, addr: '#/work' });
  assert.deepEqual(judge({ ...clean, screens: 3.5 }, { phone: true, addr: '#/' }), [], 'Home grows with its sessions');
  assert.deepEqual(judge({ ...clean, screens: 4 }, { phone: true, addr: '#/settings/workspace' }), [], 'an address that opens its part on purpose');
  one({ sideways: 20 }, 'short');
  one({ small: ['New session 34x34'] }, 'touch');
  assert.deepEqual(judge({ ...clean, small: ['x 30x30'], screens: 5 }, { phone: false, addr: '#/work' }), [], 'a wide screen has no touch rule and no phone height');
});
