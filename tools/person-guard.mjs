#!/usr/bin/env node
// Dev-only (not in the published package): the guard that protects a person on every page, measured in a real browser on
// the built-in demo. It opens EVERY registered page (and every address the router knows) at 393 by 852 with touch (a phone)
// and at 1440 by 900, and writes one line per page and size. It ends with exit 1 only when a NEW break appears: one that
// is not in test/server/person-known.json (what the pages already had when the list was written).
//
//   TMPDIR=/tmp node tools/person-guard.mjs [--port 8240] [--out <folder for pictures of broken pages>]
//                                           [--sizes 393x852,1440x900] [--pages "#/work,#/providers"] [--shots]
//                                           [--write-known]   (write the list from this run, then exit 0)
//
// Three things are measured, and nothing is counted or limited (no number of things on a screen, of menu items or of tabs):
//   sideways  the page scrolls sideways (at either size)
//   cut       a part whose box passes the window, or the box that holds it, and is not a list meant to slide
//   touch     on a touch screen a control smaller than 44 by 44 is NAMED (the phone size only). BEFORE already has small
//             ones: they are in the known list, and making them bigger is a change shown to the owner first
// Pages under web/chat are measured too and reported apart: they do not decide the exit code (their own guard is
// test/chat/layout-guard.test.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RULES = ['sideways', 'cut', 'touch'];
export const KNOWN_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'server', 'person-known.json');

/**
 * Run in the page: what one page holds right now. `phone`: the touch size. Returns plain JSON (see judge()).
 * It is written as a real function and sent as its source text.
 */
export function measure({ phone }) {
  const W = innerWidth;
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
  const tag = (e) => `${e.tagName.toLowerCase()}${e.classList[0] ? '.' + e.classList[0] : ''}`;
  const inlineLink = (e) => e.tagName === 'A' && !e.classList.contains('btn') && !e.classList.contains('row') && !!e.parentElement
    && [...e.parentNode.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
  const out = { w: W };
  out.sideways = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - W;
  // A part that lies out of the window, or out of the box that clips it. A list that is made to slide (a scroller) and
  // what is inside it are not cut; a clipped one-line text with an ellipsis is a choice, not a cut.
  const slides = (e) => { for (let n = e.parentElement; n && n !== main; n = n.parentElement) { const o = getComputedStyle(n).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; };
  const clipper = (e) => { for (let n = e.parentElement; n && n !== document.body; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.overflowX === 'hidden' || cs.overflowX === 'clip') return n; } return null; };
  out.cut = [];
  for (const e of main.querySelectorAll('*')) {
    if (!vis(e) || e.closest('svg, .xterm') || slides(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.right > W + 1 || r.left < -1) { out.cut.push(`${tag(e)} ${label(e)} passes the window`); continue; }
    const c = clipper(e);
    if (c && e !== c && getComputedStyle(e).position !== 'absolute') {
      const cr = c.getBoundingClientRect();
      const ell = getComputedStyle(e).textOverflow === 'ellipsis' || getComputedStyle(c).textOverflow === 'ellipsis';
      if (!ell && (r.right > cr.right + 1.5 || r.left < cr.left - 1.5) && r.width < 2000) out.cut.push(`${tag(e)} ${label(e)} passes ${tag(c)}`);
    }
  }
  // Press areas (touch size): every control of the page and of the bars.
  out.small = [];
  if (phone) {
    for (const e of [...document.querySelectorAll(CTRL)].filter(vis)) {
      if (inlineLink(e) || e.closest('.chat-sr')) continue;
      const box = (e.matches('input[type=checkbox], input[type=radio]') && e.closest('label')) || e;
      const r = box.getBoundingClientRect();
      if (r.width < 43.5 || r.height < 43.5) out.small.push(`${label(e)} ${tag(e)}`);
    }
  }
  return out;
}

/**
 * What is wrong with one page at one size: [{ rule, item, text }]. Pure: the test feeds it made-up records.
 * `item` names the one part (with no size in it), so the known list can say which parts it already has.
 */
export function judge(m, { phone }) {
  const f = [];
  if (m.none) return f;
  if (m.sideways > 1) f.push({ rule: 'sideways', item: '', text: `scrolls sideways by ${m.sideways}px` });
  for (const c of m.cut || []) f.push({ rule: 'cut', item: c, text: c });
  if (phone) for (const s of m.small || []) f.push({ rule: 'touch', item: s, text: `${s} is under 44x44` });
  return f;
}

/** The key one break has in the known list. */
// The demo's clock and counts move between runs (a run's name, "Earlier conversations (2)"): the key keeps only the shape, every number is N.
export const keyOf = (size, addr, x) => [size, addr, x.rule, String(x.item).replace(/\d{8}-\d{4,6}-?[0-9a-z]*/g, 'RUN').replace(/\d+/g, 'N')].join(' | ');

/** The breaks that are not in the known list (a Set or an array of keys). Only these fail the guard. */
export const fresh = (keys, known) => { const k = new Set(known); return keys.filter((x) => !k.has(x)); };

/** One output line. */
export const line = (size, addr, faults, apart = false) => {
  const head = `${faults.length ? 'BREAK' : 'ok   '} ${size} | ${addr}${apart ? ' (apart)' : ''}`;
  return faults.length ? `${head} | ${faults.map((x) => `${x.rule}: ${x.text}`).join(' | ')}` : head;
};

// ---------------------------------------------------------------------------------------------------------------
// The drive: only when this file is run, not when the test imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const argv = process.argv.slice(2);
  const opt = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
  const PORT = Number(opt('--port', '8240'));
  const OUT = path.resolve(opt('--out', path.join(os.tmpdir(), 'person-guard')));
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
    console.error('person-guard: still running after 25 minutes; stopping');
    await stopAll();
    process.exit(1);
  }, 25 * 60_000).unref();
  const ev = (e) => chrome.evaluate(e);
  const J = JSON.stringify;
  let code = 0;
  try {
    await chrome.viewport(1440, 900, { theme: 'light' });
    await chrome.goto(link, 2500); // the one-time sign-in link
    await chrome.goto(`${url}/?pg=0#/`, 2500);
    // Every address: the registered pages, the settings pages and the ones the router lists.
    const addrs = await ev(`(async () => {
      const reg = await import(new URL('registry.js', document.baseURI).href);
      const app = await import(new URL('app.js', document.baseURI).href);
      const set = new Set(['#/', ...(app.PAGE_ADDRESSES || []), ...reg.allPages().map((p) => '#/' + p.id), ...reg.registeredSettingsPages().map((p) => '#/settings/' + p.id)]);
      return [...set];
    })()`);
    const list = addrs.filter((a) => a !== '#/new' && (!ONLY.length || ONLY.includes(a)));
    console.log(`person-guard: ${list.length} addresses x ${SIZES.length} sizes`);
    const seen = []; // every break key of the run (chat pages apart)
    const apartBroken = [];
    const WRITE = argv.includes('--write-known');
    const t0 = Date.now();
    let looked = 0;
    for (const size of SIZES) {
      await chrome.viewport(size.w, size.h, { mobile: size.phone, touch: size.phone, theme: 'light' });
      await chrome.goto(`${url}/?pg=${size.w}#/`, 2000);
      for (const addr of list) {
        // A fresh load per page with nothing remembered: a fold opened on one page must not stay open on the next.
        await ev('localStorage.clear(); sessionStorage.clear()');
        await chrome.goto(`${url}/?pg=${size.w}-${looked}${addr}`, 600);
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
        const faults = judge(m, { phone: size.phone });
        console.log(line(size.name, addr, faults, apart));
        if (SHOTS && faults.some((x) => x.rule !== 'touch')) {
          const f = path.join(OUT, `${size.name}-${addr.replace(/[^\w]+/g, '-')}.png`);
          fs.writeFileSync(f, await chrome.shot());
          console.log(`picture ${f}`);
        }
        for (const x of faults) (apart ? apartBroken : seen).push(keyOf(size.name, addr, x));
      }
    }
    console.log(`person-guard: ${looked} looks in ${Math.round((Date.now() - t0) / 1000)} s`);
    const keys = [...new Set(seen)].sort();
    if (WRITE) {
      fs.writeFileSync(KNOWN_FILE, `${JSON.stringify(keys, null, 2)}\n`);
      console.log(`person-guard: wrote ${keys.length} known breaks to ${path.relative(ROOT, KNOWN_FILE)}`);
    } else {
      const known = JSON.parse(fs.readFileSync(KNOWN_FILE, 'utf8'));
      const news = fresh(keys, known);
      for (const k of news) console.log(`NEW ${k}`);
      const gone = known.filter((k) => !keys.includes(k)).length;
      console.log(`person-guard: ${keys.length} breaks, ${known.length} known, ${news.length} new${gone ? `, ${gone} known ones no longer seen` : ''}`);
      if (news.length) code = 1;
    }
    if (apartBroken.length) console.log(`apart (the App chat has its own guard, does not decide): ${[...new Set(apartBroken)].length} breaks`);
    console.log(code ? 'person-guard: FAILED' : 'person-guard: clean');
  } catch (e) {
    console.error(`person-guard: ${e.stack || e}`);
    code = 2;
  } finally {
    await stopAll();
  }
  process.exit(code);
}
