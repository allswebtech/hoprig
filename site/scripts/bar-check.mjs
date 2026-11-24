#!/usr/bin/env node
// The top bar hides what scrolls under it, seen in a real browser on the built site:
//
//   node site/scripts/bar-check.mjs <base address of the built site, served> [--out <folder for the pictures>]
//
// At 1440×900 and 390×844, light and dark, the bar is photographed at the top of the landing page (nothing under it)
// and again with a page heading scrolled just under it, and the two are compared pixel by pixel. They must be the
// same: at 97 % of the page colour with a blur, a heading still showed through as a ghost. Exits 1 when any differs.
// The local Chrome headless is driven through tools/chrome.mjs; Chrome needs a short TMPDIR.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const base = argv[0];
if (!base || base.startsWith('--')) {
  console.error('usage: node site/scripts/bar-check.mjs <base address> [--out <folder>]');
  process.exit(2);
}
const OUT = argv.includes('--out') ? path.resolve(argv[argv.indexOf('--out') + 1]) : null;
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const SIZES = [{ width: 1440, height: 900, mobile: false }, { width: 390, height: 844, mobile: true }];
const HEADINGS = ['h1', '.band-title']; // the landing page's own heading and the first band's
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The pixels of a PNG as Chrome writes it (8 bits, RGB or RGBA, not interlaced): { width, height, channels, data }. */
export function decodePng(buf) {
  let pos = 8;
  let width = 0, height = 0, channels = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, , , interlace] = body.subarray(8, 13);
      channels = { 2: 3, 6: 4 }[colour];
      if (depth !== 8 || !channels || interlace) throw new Error(`a PNG this check does not read (depth ${depth}, colour type ${colour}, interlace ${interlace})`);
    } else if (type === 'IDAT') idat.push(body);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? data[y * stride + x - channels] : 0;
      const b = y ? data[(y - 1) * stride + x] : 0;
      const c = x >= channels && y ? data[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      data[y * stride + x] = v & 255;
    }
  }
  return { width, height, channels, data };
}

/** How the first `rows` rows of two pictures differ: the pixels that differ and the largest step of one channel. */
function compareRows(p, q, rows) {
  if (p.width !== q.width || p.channels !== q.channels) return { pixels: Infinity, most: Infinity };
  let pixels = 0, most = 0;
  for (let i = 0; i < p.width * rows; i++) {
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(p.data[i * p.channels + k] - q.data[i * q.channels + k]));
    if (d) pixels++;
    most = Math.max(most, d);
  }
  return { pixels, most };
}

const { launchChrome } = await import(path.join(ROOT, 'tools/chrome.mjs'));
const chrome = await launchChrome();
setTimeout(async () => {
  console.error('bar-check: still running after 5 minutes; stopping');
  await chrome.close().catch(() => {});
  process.exit(1);
}, 5 * 60_000).unref();

// The viewport as it is (not beyond it: a capture beyond the viewport resizes it, and a sticky bar moves with that).
const viewportPng = async () => decodePng(Buffer.from((await chrome.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
const scrollTo = async (y) => {
  await chrome.evaluate(`window.scrollTo({ top: ${y}, behavior: 'instant' }); true`);
  await sleep(400);
  return chrome.evaluate('window.scrollY');
};

let failed = 0;
try {
  for (const size of SIZES) {
    for (const theme of ['light', 'dark']) {
      const where = `${size.width}x${size.height} ${theme}`;
      await chrome.viewport(size.width, size.height, { mobile: size.mobile, theme });
      await chrome.goto(`${base.replace(/\/$/, '')}/`, 2500);
      const bar = await chrome.evaluate(`(() => { const b = document.querySelector('header.bar'); if (!b) return null; const r = b.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, bg: getComputedStyle(b).backgroundColor, dpr: devicePixelRatio }; })()`);
      if (!bar) throw new Error(`${where}: no header.bar on the page`);
      const rows = Math.floor(bar.bottom * bar.dpr);
      if ((await scrollTo(0)) !== 0 || bar.top !== 0) throw new Error(`${where}: the bar is not at the top of the page`);
      const empty = await viewportPng();
      if (OUT) fs.writeFileSync(path.join(OUT, `bar-${size.width}-${theme}-top.png`), await chrome.shot());
      for (const sel of HEADINGS) {
        // The heading's top 12 px under the bar's top: its letters run across the bar's whole height.
        const docTop = await chrome.evaluate(`(() => { const h = document.querySelector(${JSON.stringify(sel)}); return h ? h.getBoundingClientRect().top + window.scrollY : null; })()`);
        if (docTop === null) throw new Error(`${where}: no ${sel} on the page`);
        await scrollTo(Math.max(0, Math.round(docTop - 12)));
        const now = await chrome.evaluate(`(() => { const h = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); const b = document.querySelector('header.bar').getBoundingClientRect(); return { top: h.top, bottom: h.bottom, barTop: b.top, barBottom: b.bottom }; })()`);
        // Only a heading that really lies under the bar proves anything.
        if (now.barTop !== 0 || now.top > 20 || now.bottom < now.barBottom * 0.6) throw new Error(`${where}: ${sel} is not under the bar (heading ${Math.round(now.top)}..${Math.round(now.bottom)}, bar ${now.barTop}..${now.barBottom})`);
        const under = await viewportPng();
        if (OUT) fs.writeFileSync(path.join(OUT, `bar-${size.width}-${theme}-${sel.replace(/\W/g, '')}.png`), await chrome.shot());
        const d = compareRows(empty, under, rows);
        const ok = d.pixels === 0;
        if (!ok) failed++;
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${where}: the bar with ${sel} under it ${ok ? 'is the same as with nothing under it' : `differs in ${d.pixels} pixels, by up to ${d.most} of 255`} (${rows} rows at ${bar.dpr}x, background ${bar.bg})`);
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
console.log(failed ? `bar-check: ${failed} failed` : 'bar-check: the bar hides what scrolls under it in every size and theme');
process.exit(failed ? 1 : 0);
