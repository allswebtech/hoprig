#!/usr/bin/env node
// Dev-only (not in the published package): the guard that keeps Hoprig easy, measured in a real browser on the built-in
// demo. It opens EVERY registered page (and every address the router knows) at 393 by 852 with touch (a phone) and at
// 1440 by 900, and writes one line per page and size. It ends with exit 1 when a rule is broken.
//
//   TMPDIR=/tmp node tools/easy-guard.mjs [--port 8240] [--out <folder for pictures of broken pages>]
//                                         [--sizes 393x852,1440x900] [--pages "#/work,#/providers"] [--shots]
//
// The rules (the design of the easy round; the same words as test/server/web-easy-rules.test.mjs):
//   menu      one menu: at most 6 items on a wide screen, at most 5 in the phone bar, no More
//   count     the only number badge is Home's (none on Tia's button either), and it equals the rows of Home's Needs you; no count on a tab
//   head      a page head is a title, at most one primary button, at most one line of words at 393, no theme button
//   tabs      straight under the head, at most 4, all visible at 393 without sliding
//   door      one door per act: no button label twice on the first screen
//   advanced  nothing open on first paint (every fold closed)
//   empty     a group with no rows is not drawn (no heading with a count of 0)
//   short     a list shows at most 20 rows; no page taller than 3 phone screens
//   touch     on a touch screen every control is at least 44 by 44 (the phone size only)
// Pages under web/chat are measured too and reported apart: they do not decide the exit code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RULES = ['menu', 'count', 'head', 'tabs', 'door', 'advanced', 'empty', 'short', 'touch'];
// Old addresses that are MEANT to open one fold: the design says where each lands, with its part in view. The rule of
// closed folds does not hold for these addresses; every other address (and every plain visit to the page) is held to it.
export const OPENS_ITS_PART = ['#/work/golive', '#/skills/learned', '#/settings/work', '#/settings/workspace', '#/settings/public-link', '#/settings/handsoff', '#/settings/editor'];
// A page that is a live list or a conversation grows with what it holds (the sessions on Home, the history of a chat): its
// height is not held to the three screens, its rows are still held to the row limit.
export const LONG_BY_NATURE = ['#/', '#/tia', '#/operator', '#/desktop/sessions']; // the last two are Home under an old address
export const LIMITS = { wideMenu: 6, barMenu: 5, tabs: 4, rows: 20, screens: 3, press: 44, introLines: 1 };

/**
 * Run in the page: what one page holds right now. `phone`: the touch size. Returns plain JSON (see judge()).
 * It is written as a real function and sent as its source text.
 */
export function measure({ phone }) {
  const W = innerWidth;
  const H = innerHeight;
  const main = document.querySelector('main.page');
  if (!main) return { none: true };
  const vis = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(e);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
    if (e.closest('[hidden], .hidden, [inert]')) return false;
    return !e.checkVisibility || e.checkVisibility();
  };
  const CTRL = 'a[href], button, summary, select, textarea, input:not([type=hidden]), [role=button], [role=switch], [role=tab]';
  const label = (e) => (e.getAttribute('aria-label') || e.innerText || e.title || e.value || e.tagName).replace(/\s+/g, ' ').trim().slice(0, 40);
  const inlineLink = (e) => e.tagName === 'A' && !e.classList.contains('btn') && !e.classList.contains('row') && !!e.parentElement
    && [...e.parentNode.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
  const out = { w: W, h: H };
  // The first screen: controls in the page (bar left out) that lie in the window.
  const ctrls = [...main.querySelectorAll(CTRL)].filter(vis);
  const first = ctrls.filter((e) => { const r = e.getBoundingClientRect(); return r.top < H && r.bottom > 0; });
  out.controls = first.length;
  const root = document.scrollingElement || document.documentElement;
  out.screens = Math.round((Math.max(root.scrollHeight, document.body.scrollHeight) / H) * 100) / 100;
  out.sideways = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - W;
  // The menu.
  const bar = document.querySelector('nav.bottombar');
  const side = document.querySelector('nav.sidebar');
  out.menu = {
    bar: bar && vis(bar) ? [...bar.querySelectorAll('a')].filter(vis).length : 0,
    side: side && vis(side) ? [...side.querySelectorAll('a.side-item')].filter(vis).length : 0,
    more: [...document.querySelectorAll('nav a')].filter((a) => /^#\/more\b/.test(a.getAttribute('href') || '') || /^more$/i.test(a.innerText.trim())).length,
    groupTitles: document.querySelectorAll('nav .side-group-title').length,
  };
  // Badges: every number badge of the menu with the address it sits on; and a count inside a tab.
  out.badges = [...document.querySelectorAll('.nav-badge')].filter(vis).map((b) => ({ on: (b.closest('a') || {}).getAttribute ? b.closest('a').getAttribute('href') : '?', n: b.textContent.trim() }));
  // A number on any other button (Tia's, in the head or at the foot) is a second badge.
  out.otherBadges = [...document.querySelectorAll('.tia-launch-n, .pagehead .icon-btn span, .pagehead .gear-btn span, .tia-launch span')].filter((e) => vis(e) && /^\d+$/.test(e.textContent.trim())).map((e) => `${e.textContent.trim()} on ${((e.closest('button, a') || {}).getAttribute ? e.closest('button, a').getAttribute('aria-label') : '') || 'a button'}`);
  out.tabCounts = [...main.querySelectorAll('.tabs-count')].filter(vis).length;
  const heads = [...main.querySelectorAll('h2.group-head')].filter(vis);
  const needs = heads.find((h) => /^needs you$/i.test((h.querySelector('span') || h).textContent.trim()));
  out.needsRows = needs ? Number((needs.querySelector('.group-count') || {}).textContent) : 0;
  out.zeroGroups = heads.filter((h) => { const c = h.querySelector('.group-count'); return c && /^0$/.test(c.textContent.trim()); }).map((h) => h.textContent.replace(/\s+/g, ' ').trim());
  // The head.
  const head = main.querySelector('header.pagehead');
  if (head) {
    out.head = {
      primaries: [...head.querySelectorAll('.btn.primary')].filter(vis).map(label),
      theme: [...head.querySelectorAll('button, a')].filter(vis).map(label).filter((t) => /theme|dark|light|colou?r/i.test(t)),
      introLines: 0,
      introText: '',
    };
    const intro = head.querySelector('.page-intro');
    if (intro && vis(intro)) {
      const cs = getComputedStyle(intro);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.35;
      out.head.introLines = Math.round((intro.getBoundingClientRect().height / lh) * 10) / 10;
      out.head.introText = intro.textContent.replace(/\s+/g, ' ').trim().slice(0, 60);
    }
  }
  // Tabs: straight under the head, how many, whether they slide.
  const tabs = [...main.querySelectorAll('nav.tabs')].filter(vis);
  out.tabs = tabs.map((t) => {
    const items = [...t.querySelectorAll('.tabs-item')].filter(vis);
    // Anything drawn above it in the body (between the head and it) is a fault: look at the earlier siblings up to main.
    let above = 0;
    for (let n = t; n && n !== main; n = n.parentElement) {
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (!s.matches('header.pagehead') && vis(s)) above++;
    }
    return {
      n: items.length,
      slides: t.scrollWidth - t.clientWidth,
      cut: items.filter((i) => { const r = i.getBoundingClientRect(); return r.right > W + 1 || r.left < -1; }).length,
      above,
    };
  });
  // Folds open on first paint.
  out.openFolds = [...main.querySelectorAll('details[open]')].filter(vis).map((d) => label(d.querySelector('summary') || d));
  // One door: the same button label twice on the first screen.
  const seen = new Map();
  for (const e of first) {
    if (!e.matches('button, a.btn, .btn') || e.closest('nav.tabs, nav.sidebar, nav.bottombar, .row')) continue;
    const t = label(e).toLowerCase();
    if (t && t.length > 1) seen.set(t, (seen.get(t) || 0) + 1);
  }
  out.repeated = [...seen].filter(([, n]) => n > 1).map(([t, n]) => `${t} x${n}`);
  // Long lists: one parent with more than the limit of alike children drawn.
  out.longLists = [];
  for (const p of main.querySelectorAll('*')) {
    if (p.children.length <= 20) continue;
    const by = new Map();
    for (const c of p.children) {
      if (!vis(c) || c.getBoundingClientRect().height < 24) continue;
      const k = `${c.tagName}.${(c.classList[0] || '')}`;
      by.set(k, (by.get(k) || 0) + 1);
    }
    for (const [k, n] of by) if (n > 20) out.longLists.push(`${k} x${n}`);
  }
  // Press areas (touch size): every control of the page and of the bars.
  out.small = [];
  if (phone) {
    const all = [...document.querySelectorAll(CTRL)].filter(vis);
    for (const e of all) {
      if (inlineLink(e) || e.closest('.chat-sr')) continue;
      const box = (e.matches('input[type=checkbox], input[type=radio]') && e.closest('label')) || e;
      const r = box.getBoundingClientRect();
      if (r.width < 43.5 || r.height < 43.5) out.small.push(`${label(e)} ${Math.round(r.width)}x${Math.round(r.height)} ${e.tagName.toLowerCase()}${e.classList[0] ? '.' + e.classList[0] : ''}`);
    }
  }
  return out;
}

/** What is wrong with one page at one size: [{ rule, text }]. Pure: the test feeds it made-up records. */
export function judge(m, { phone, addr }) {
  const f = [];
  const add = (rule, text) => f.push({ rule, text });
  if (m.none) return f;
  if (m.sideways > 1) add('short', `scrolls sideways by ${m.sideways}px`);
  if (phone && m.screens > LIMITS.screens && !LONG_BY_NATURE.includes(addr) && !OPENS_ITS_PART.includes(addr)) add('short', `${m.screens} phone screens tall (at most ${LIMITS.screens})`);
  for (const l of m.longLists) add('short', `a list of ${l.split(' x')[1]} rows drawn (at most ${LIMITS.rows}, then Show more): ${l.split(' x')[0]}`);
  if (m.menu.bar > LIMITS.barMenu) add('menu', `${m.menu.bar} items in the phone bar (at most ${LIMITS.barMenu})`);
  if (m.menu.side > LIMITS.wideMenu) add('menu', `${m.menu.side} items in the list (at most ${LIMITS.wideMenu})`);
  if (m.menu.more) add('menu', 'a More item in the menu');
  if (m.menu.groupTitles) add('menu', 'a group heading in the menu');
  for (const b of m.badges) if (b.on !== '#/' && b.on !== '#') add('count', `a number badge (${b.n}) on ${b.on}; only Home has one`);
  for (const b of m.otherBadges || []) add('count', `a number badge (${b}); only Home has one`);
  if (m.tabCounts) add('count', `${m.tabCounts} count(s) inside tabs`);
  if (addr === '#/') {
    const home = m.badges.find((b) => b.on === '#/');
    const n = home ? Number(home.n) : 0;
    if (n !== (m.needsRows || 0)) add('count', `Home badge says ${n}, Needs you holds ${m.needsRows || 0}`);
  }
  if (m.head) {
    if (m.head.primaries.length > 1) add('head', `${m.head.primaries.length} primary buttons in the head (${m.head.primaries.join(', ')})`);
    if (m.head.theme.length) add('head', `a theme button in the head (${m.head.theme.join(', ')})`);
    if (phone && m.head.introLines > LIMITS.introLines + 0.4) add('head', `${m.head.introLines} lines of words in the head: ${m.head.introText}`);
  }
  for (const t of m.tabs) {
    if (t.n > LIMITS.tabs) add('tabs', `${t.n} tabs (at most ${LIMITS.tabs})`);
    if (t.above) add('tabs', `${t.above} part(s) above the tabs; they come straight under the head`);
    if (phone && (t.slides > 1 || t.cut)) add('tabs', `tabs slide at 393 (${Math.round(t.slides)}px, ${t.cut} cut)`);
  }
  if (m.repeated.length) add('door', `the same button twice on the first screen: ${m.repeated.join(', ')}`);
  if (m.openFolds.length && !OPENS_ITS_PART.includes(addr)) add('advanced', `open on first paint: ${m.openFolds.join(', ')}`);
  if (m.zeroGroups.length) add('empty', `a group with no rows is drawn: ${m.zeroGroups.join(', ')}`);
  if (phone && m.small.length) add('touch', `${m.small.length} control(s) under 44x44: ${m.small.slice(0, 12).join('; ')}${m.small.length > 12 ? '; ...' : ''}`);
  return f;
}

/** One output line. */
export const line = (size, addr, m, faults, apart = false) => {
  const head = `${faults.length ? 'BREAK' : 'ok   '} ${size} | ${addr}${apart ? ' (apart)' : ''} | controls ${m.controls ?? '-'} | ${m.screens ?? '-'} screens`;
  return faults.length ? `${head} | ${faults.map((x) => `${x.rule}: ${x.text}`).join(' | ')}` : head;
};

// ---------------------------------------------------------------------------------------------------------------
// The drive: only when this file is run, not when the test imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const argv = process.argv.slice(2);
  const opt = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
  const PORT = Number(opt('--port', '8240'));
  const OUT = path.resolve(opt('--out', path.join(os.tmpdir(), 'easy-guard')));
  const SIZES = opt('--sizes', '393x852,1440x900').split(',').map((t) => { const [w, h] = t.split('x').map(Number); return { w, h, name: t, phone: w < 600 }; });
  const SHOTS = argv.includes('--shots'); // a picture of each page that breaks a rule other than the press areas
  const ONLY = opt('--pages', '').split(',').filter(Boolean);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  fs.mkdirSync(OUT, { recursive: true });
  const { launchChrome } = await import('./chrome.mjs');
  const chrome = await launchChrome();
  const { main } = await import(path.join(ROOT, 'src/demo/index.mjs'));
  const hooks = { onReady: (i) => (hooks.info = i) };
  if ((await main(['--no-open', '--quiet', '--port', String(PORT)], hooks)) !== null) throw new Error('the demo did not start');
  await hooks.background;
  const { url, link } = hooks.info;
  const stopAll = async () => {
    await chrome.close().catch(() => {});
    await hooks.stop();
  };
  setTimeout(async () => {
    console.error('easy-guard: still running after 25 minutes; stopping');
    await stopAll();
    process.exit(1);
  }, 25 * 60_000).unref();
  const ev = (e) => chrome.evaluate(e);
  const J = JSON.stringify;
  let code = 0;
  try {
    await chrome.viewport(1440, 900, { theme: 'light' });
    await chrome.goto(link, 2500); // the one-time sign-in link
    await chrome.goto(`${url}/?easy=0#/`, 2500);
    // Every address: the registered pages, the settings pages and the ones the router lists.
    const addrs = await ev(`(async () => {
      const reg = await import(new URL('registry.js', document.baseURI).href);
      const app = await import(new URL('app.js', document.baseURI).href);
      const set = new Set(['#/', ...(app.PAGE_ADDRESSES || []), ...reg.allPages().map((p) => '#/' + p.id), ...reg.registeredSettingsPages().map((p) => '#/settings/' + p.id)]);
      return [...set];
    })()`);
    const list = addrs.filter((a) => a !== '#/new' && (!ONLY.length || ONLY.includes(a)));
    console.log(`easy-guard: ${list.length} addresses x ${SIZES.length} sizes`);
    const broken = new Map(); // rule -> pages (chat pages apart)
    const apartBroken = [];
    const t0 = Date.now();
    let looked = 0;
    for (const size of SIZES) {
      await chrome.viewport(size.w, size.h, { mobile: size.phone, touch: size.phone, theme: 'light' });
      await chrome.goto(`${url}/?easy=${size.w}#/`, 2000);
      for (const addr of list) {
        // A fresh load per page with nothing remembered: a fold opened on one page must not stay open on the next.
        await ev('localStorage.clear(); sessionStorage.clear()');
        await chrome.goto(`${url}/?easy=${size.w}-${looked}${addr}`, 600);
        // Drawn: the page exists and nothing is loading for a moment.
        const end = Date.now() + 8000;
        await sleep(500);
        while (Date.now() < end && (await ev(`!document.querySelector('main.page') || !!document.querySelector('main.page [aria-busy=true]')`))) await sleep(250);
        await sleep(400);
        let m;
        try {
          m = await ev(`(${measure.toString()})(${J({ phone: size.phone })})`);
        } catch (e) {
          m = { none: true, error: String(e.message || e) };
        }
        looked++;
        if (m.none) {
          console.log(`NOPAGE ${size.name} | ${addr}${m.error ? ` | ${m.error}` : ''}`);
          continue;
        }
        const apart = /^#\/chat/.test(addr);
        const faults = judge(m, { phone: size.phone, addr });
        console.log(line(size.name, addr, m, faults, apart));
        if (SHOTS && faults.some((x) => x.rule !== 'touch')) {
          const f = path.join(OUT, `${size.name}-${addr.replace(/[^\w]+/g, '-')}.png`);
          fs.writeFileSync(f, await chrome.shot());
          console.log(`picture ${f}`);
        }
        for (const x of faults) {
          const key = `${size.name} ${addr}`;
          if (apart) apartBroken.push(`${key} ${x.rule}`);
          else broken.set(x.rule, [...(broken.get(x.rule) || []), key]);
        }
      }
    }
    console.log(`easy-guard: ${looked} looks in ${Math.round((Date.now() - t0) / 1000)} s`);
    for (const rule of RULES) {
      const pages = [...new Set(broken.get(rule) || [])];
      console.log(`rule ${rule}: ${pages.length ? `BROKEN on ${pages.length}: ${pages.join(', ')}` : 'green'}`);
    }
    if (apartBroken.length) console.log(`apart (the App chat is being rebuilt, does not decide): ${[...new Set(apartBroken)].join(', ')}`);
    if (broken.size) code = 1;
    console.log(code ? 'easy-guard: FAILED' : 'easy-guard: clean');
  } catch (e) {
    console.error(`easy-guard: ${e.stack || e}`);
    code = 2;
  } finally {
    await stopAll();
  }
  process.exit(code);
}
