#!/usr/bin/env node
// On a phone nothing of a table or a code block is cut off, seen in a real browser on the built site:
//
//   node site/scripts/narrow-check.mjs <base address of the built site, served> [--out <folder>] [--dir <built folder>]
//
// Every page of the build (each .html file of site/out, or --dir) is opened at 390×844, light and dark. Every cell of
// every table must end inside the window and inside its box: a table never hides a column in a sideways scroll on a
// phone (below 480 px a row is a card). Every code block's widest line must end inside the window; a block wider than
// its box may scroll sideways in its own box, but only with a cue at the edge that has more (a fade). Exits 1 on any
// fault. With --out it keeps one picture per table and per wide code block: <page-slug>-<n>-<table|code>-<theme>.png
// (a table taller than 3000 px goes on in <...>-part2.png and so on).
// The local Chrome headless is driven through tools/chrome.mjs; Chrome needs a short TMPDIR.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SIZE = { width: 390, height: 844 };
const SLACK = 1; // a pixel of rounding between a box and what it holds

/**
 * The faults of one page in one theme, from measured boxes (pure: the suite checks it with boxes of its own).
 *   width: the window's width (its layout width, without a scroll bar)
 *   items: [{ kind: 'cell' | 'code', n, right, box }] with
 *     right: the right edge of the cell (or its content), or of the code block's widest line, in window pixels
 *     box:   the box that scrolls it sideways, when it lies in one: { right: its inner right edge, cue: a fade shows
 *            at that edge while more lies past it }; null when nothing between it and the page scrolls
 * Returns one sentence per fault.
 */
export function narrowFaults({ width, items }) {
  const faults = [];
  for (const it of items) {
    const name = `${it.kind === 'cell' ? 'table' : 'code block'} ${it.n}`;
    const at = Math.round(it.right);
    if (it.kind === 'cell') {
      // A cell in a box that scrolls is hidden by the box first; one in no such box pushes the page itself.
      if (it.box && it.right > it.box.right + SLACK) faults.push(`${name}: a cell ends at ${at} px, hidden in a sideways scroll that ends at ${Math.round(it.box.right)} (a table shows every column on a phone)`);
      else if (it.right > width + SLACK) faults.push(`${name}: a cell ends at ${at} px, outside the window of ${width}`);
    } else if (it.box) {
      if (it.box.right > width + SLACK) faults.push(`${name}: its scroll box ends at ${Math.round(it.box.right)} px, outside the window of ${width}`);
      else if (it.right > it.box.right + SLACK && !it.box.cue) faults.push(`${name}: a line ends at ${at} px, past its box's edge at ${Math.round(it.box.right)}, with no cue that more lies there`);
    } else if (it.right > width + SLACK) faults.push(`${name}: a line ends at ${at} px, outside the window of ${width}`);
  }
  return faults;
}

/** The addresses of every page of a built site folder: x/index.html -> /x/, 404.html -> /404.html. */
export function pagesOf(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (e.name !== '_next') walk(r); } else if (e.name.endsWith('.html')) out.push(r);
    }
  };
  walk('');
  return out.map((f) => (f === 'index.html' ? '/' : f.endsWith('/index.html') ? `/${f.slice(0, -'index.html'.length)}` : `/${f}`)).sort();
}

/**
 * The pictures of one block: a clip no taller than `most` CSS px (Chrome's own limit on a picture), so a table
 * taller than that is kept in parts, one under the other: <name>.png, then <name>-part2.png, ... Nothing is left out.
 */
export function clipsOf(name, clip, most = 3000) {
  const out = [];
  for (let y = 0, k = 1; y < clip.height; y += most, k++) out.push({ file: `${name}${k > 1 ? `-part${k}` : ''}.png`, clip: { ...clip, y: clip.y + y, height: Math.min(most, clip.height - y) } });
  return out;
}

const slugOf = (page) => (page === '/' ? 'home' : page.replace(/^\/|\/$/g, '').replace(/\.html$/, '').replace(/\//g, '-'));

// In the page: every table cell and every code block, with the right edge of what it holds and the box that scrolls it.
// A cue is the fade of the pages' styles: a scroll box whose background has a gradient that stays at the edge (attached
// to the box, "scroll") under a cover that moves with the content ("local") and hides the fade at the end.
const MEASURE = `(() => {
  const rightOf = (el) => { const r = document.createRange(); r.selectNodeContents(el); let m = el.getBoundingClientRect().right; for (const q of r.getClientRects()) if (q.width) m = Math.max(m, q.right); return m; };
  const scrollerOf = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p); if (/auto|scroll|hidden|clip/.test(s.overflowX)) return p; } return null; };
  const boxOf = (el) => {
    const p = scrollerOf(el);
    if (!p) return null;
    const s = getComputedStyle(p);
    const right = p.getBoundingClientRect().left + p.clientLeft + p.clientWidth;
    const att = s.backgroundAttachment.split(',').map((a) => a.trim());
    const cue = /auto|scroll/.test(s.overflowX) && /gradient/.test(s.backgroundImage) && att.includes('local') && att.includes('scroll');
    return { right, cue };
  };
  // A cell kept only for a screen reader (the head of a table shown as cards: 1 px, clipped) is not seen, so not judged.
  const hidden = (el) => { for (let p = el; p && p !== document.body; p = p.parentElement) { const r = p.getBoundingClientRect(); if (r.width <= 1 || r.height <= 1 || getComputedStyle(p).clipPath.startsWith('inset(50%')) return true; } return false; };
  const items = [];
  const tables = [...document.querySelectorAll('main table, article table, table')].filter((t, i, a) => a.indexOf(t) === i);
  tables.forEach((t, n) => { for (const c of t.querySelectorAll('td, th')) if (!hidden(c)) items.push({ kind: 'cell', n: n + 1, right: rightOf(c), box: boxOf(c) }); });
  const codes = [...document.querySelectorAll('pre')];
  codes.forEach((p, n) => items.push({ kind: 'code', n: n + 1, right: rightOf(p.querySelector('code') || p), box: boxOf(p.querySelector('code') || p), wide: p.scrollWidth > p.clientWidth + 1 }));
  return { width: document.documentElement.clientWidth, items, tables: tables.length, codes: codes.length };
})()`;

async function main(argv) {
  const base = argv[0];
  if (!base || base.startsWith('--')) {
    console.error('usage: node site/scripts/narrow-check.mjs <base address> [--out <folder>] [--dir <built folder>]');
    return 2;
  }
  const opt = (name) => (argv.includes(name) ? path.resolve(argv[argv.indexOf(name) + 1]) : null);
  const OUT = opt('--out');
  const DIR = opt('--dir') || path.join(ROOT, 'site/out');
  if (OUT) fs.mkdirSync(OUT, { recursive: true });
  const pages = pagesOf(DIR);
  console.log(`narrow-check: ${pages.length} pages of ${DIR} at ${SIZE.width}x${SIZE.height}, light and dark`);

  const { launchChrome } = await import(path.join(ROOT, 'tools/chrome.mjs'));
  const chrome = await launchChrome();
  setTimeout(async () => {
    console.error('narrow-check: still running after 15 minutes; stopping');
    await chrome.close().catch(() => {});
    process.exit(1);
  }, 15 * 60_000).unref();

  let failed = 0, tables = 0, codes = 0;
  try {
    for (const theme of ['light', 'dark']) {
      await chrome.viewport(SIZE.width, SIZE.height, { mobile: true, theme });
      for (const page of pages) {
        await chrome.goto(`${base.replace(/\/$/, '')}${page}`, 700);
        const m = await chrome.evaluate(MEASURE);
        tables += m.tables;
        codes += m.codes;
        const faults = narrowFaults(m);
        // One line per fault kind of a block, not one per cell: a table of 40 rows cut at one column says it once.
        const seen = new Set();
        for (const f of faults) {
          const key = f.replace(/\d+ px/g, '');
          if (seen.has(key)) continue;
          seen.add(key);
          failed++;
          console.log(`FAIL ${page} ${theme}: ${f}`);
        }
        if (OUT) {
          const shots = await chrome.evaluate(`(() => {
            const at = (el) => { const r = el.getBoundingClientRect(); return { x: Math.max(0, r.left + scrollX - 4), y: Math.max(0, r.top + scrollY - 4), width: Math.min(r.width + 8, ${SIZE.width}), height: r.height + 8 }; };
            return [...[...document.querySelectorAll('table')].map((t, n) => ({ kind: 'table', n: n + 1, clip: at(t.closest('.table') || t) })),
              ...[...document.querySelectorAll('pre')].map((p, n) => ({ kind: 'code', n: n + 1, wide: p.scrollWidth > p.clientWidth + 1, clip: at(p) })).filter((s) => s.wide)];
          })()`);
          for (const s of shots) for (const part of clipsOf(`${slugOf(page)}-${s.n}-${s.kind}-${theme}`, s.clip)) fs.writeFileSync(path.join(OUT, part.file), await chrome.shot({ clip: part.clip }));
        }
      }
    }
  } catch (e) {
    failed++;
    console.log(`FAIL the check finished: ${e.message}`);
  } finally {
    await chrome.close().catch(() => {});
  }
  if (chrome.errors.length) console.log(`page errors: ${chrome.errors.slice(0, 5).join(' | ')}`);
  console.log(failed
    ? `narrow-check: ${failed} failed`
    : `narrow-check: every table cell and code line of ${pages.length} pages shows at ${SIZE.width} px in both themes (${tables / 2} tables, ${codes / 2} code blocks)`);
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
