#!/usr/bin/env node
// The moving story's pinned stage, seen in a real browser on the built site:
//
//   node site/scripts/stage-check.mjs <base address of the built site, served> [--out <folder>] [--sizes 700x900,…] [--themes light,dark]
//
// Each step is held at each of its screens, and Chrome is asked where the step's words end, where its floor box is,
// and where the scene drew the front screen (data-front, set by story-motion/scene.mjs). The front screen must start
// right under the words and run to the window's bottom, whole, with at most 10 % of the window empty; the words' box
// must be the one STAGES below holds, and the drawn screen the one ring.mjs's layout() gives for that floor box, so the
// site's test (test/site/site.test.mjs), which checks STAGES with stageFaults(), measures what the browser draws.
// Seen 21 Nov 2026: a test from a table of four sizes passed while 700x900 drew the front screen 340 px under the
// words. With --out it keeps a picture of each step held at its middle screen. Exits 1 when anything differs.
// The local Chrome headless is driven through tools/chrome.mjs; Chrome needs a short TMPDIR.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { box, emptyShare, layout, ringState } from '../app/(site)/story-motion/ring.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Measured in Chrome on the built site (21 Nov 2026; 1920x1080 on 22 Nov 2026), each step held: the step's words run from the bar's bottom
 * (61 px) to `bottom` of each step, between `left` and `right`; its floor box is the rest of the window.
 */
export const STAGES = {
  '1920x1080': { left: 398, right: 1522, bottom: { ready: 177, together: 177, limit: 191, phone: 206 } },
  '1440x900': { left: 158, right: 1282, bottom: { ready: 177, together: 177, limit: 191, phone: 206 } },
  '1280x720': { left: 78, right: 1202, bottom: { ready: 177, together: 177, limit: 191, phone: 206 } },
  '1024x768': { left: 28, right: 996, bottom: { ready: 206, together: 206, limit: 217, phone: 206 } },
  '999x700': { left: 28, right: 971, bottom: { ready: 206, together: 206, limit: 217, phone: 206 } },
  '820x1180': { left: 28, right: 792, bottom: { ready: 225, together: 225, limit: 251, phone: 225 } },
  '768x1024': { left: 28, right: 740, bottom: { ready: 224, together: 224, limit: 249, phone: 224 } },
  '700x900': { left: 16, right: 684, bottom: { ready: 224, together: 224, limit: 249, phone: 224 } },
  '390x844': { left: 16, right: 374, bottom: { ready: 237, together: 237, limit: 279, phone: 237 } },
};
export const BAR = 61;

/**
 * What is wrong with a pinned stage in a window `W` × `H`: `words` the words' box, `front` the front screen's box and
 * `screens` every screen ({ quad, alpha }), all in window px. An empty list when the stage fills the window.
 */
export function stageFaults({ W, H, words, front, screens }) {
  const faults = [];
  const f = front.map(Math.round);
  if (f[1] < words[3]) faults.push(`the front screen (top ${f[1]}) is under the words (bottom ${words[3]})`);
  else if (f[1] - words[3] > 24) faults.push(`${f[1] - words[3]} px empty between the words (bottom ${words[3]}) and the front screen (top ${f[1]})`);
  if (f[3] > H) faults.push(`the front screen is cut at the window's bottom (${f[3]} of ${H})`);
  else if (H - f[3] > 32) faults.push(`${H - f[3]} px empty under the front screen`);
  if (f[0] < 0 || f[2] > W) faults.push(`the front screen is cut at the window's sides (${f[0]} to ${f[2]} of ${W})`);
  const empty = emptyShare({ screens, words, W, H, top: BAR });
  if (empty > 0.1) faults.push(`${(empty * 100).toFixed(1)} % of the window is empty`);
  return faults;
}

/** The stage as ring.mjs lays it out on the floor box under `words` (window px), at ring place `t`. */
export function stageAt({ W, H, words, phones, t }) {
  const L = layout({ W, H: H - words[3], phones });
  const screens = ringState(t, L).map((st) => ({ ...st, quad: st.quad.map(([x, y]) => [x, y + words[3]]) }));
  const near = screens.reduce((a, b) => (Math.abs(b.d) < Math.abs(a.d) ? b : a));
  return { L, screens, front: box(near.quad) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function main(argv) {
  const base = argv[0];
  if (!base || base.startsWith('--')) {
    console.error('usage: node site/scripts/stage-check.mjs <base address> [--out <folder>] [--sizes 700x900,…] [--themes light,dark]');
    return 2;
  }
  const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const OUT = opt('--out') ? path.resolve(opt('--out')) : null;
  if (OUT) fs.mkdirSync(OUT, { recursive: true });
  const sizes = (opt('--sizes') || Object.keys(STAGES).join(',')).split(',');
  const themes = (opt('--themes') || 'light').split(',');
  const { launchChrome } = await import(path.join(ROOT, 'tools/chrome.mjs'));
  const chrome = await launchChrome();
  setTimeout(async () => {
    console.error('stage-check: still running after 20 minutes; stopping');
    await chrome.close().catch(() => {});
    process.exit(1);
  }, 20 * 60_000).unref();
  const ev = (js) => chrome.evaluate(js);
  let failed = 0;
  const fail = (line) => { failed++; console.log(`FAIL ${line}`); };
  try {
    for (const size of sizes) for (const theme of themes) {
      const [W, H] = size.split('x').map(Number);
      const mobile = W < 700;
      const where = `${size} ${theme}`;
      await chrome.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: mobile ? 2 : 1, mobile });
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'no-preference' }] });
      await chrome.goto(`${base.replace(/\/$/, '')}/`, 2500);
      // Scrolled toward the story in steps, as a person does: the moving form starts after the first scroll.
      const top = await ev(`document.querySelector('[data-story]').getBoundingClientRect().top + scrollY`);
      for (let k = 1; k <= 8; k++) { await ev(`scrollTo(0, ${Math.round(((top - 200) * k) / 8)}); true`); await sleep(120); }
      for (let i = 0; i < 80 && (await ev(`document.querySelector('[data-story]').dataset.motion || ''`)) !== 'on'; i++) await sleep(250);
      if ((await ev(`document.querySelector('[data-story]').dataset.motion || ''`)) !== 'on') { fail(`${where}: the moving form did not start (${await ev(`document.querySelector('[data-story]').dataset.still || 'no reason given'`)})`); continue; }
      const ids = await ev(`[...document.querySelectorAll('.story .step')].map((li) => li.dataset.step)`);
      for (const [n, id] of ids.entries()) for (const [k, p] of [0.12, 0.5, 0.88].entries()) {
        // The middle of screen k's hold in the pin (ring.mjs ringT: each screen held for 0.24 of it).
        await ev(`(() => { const li = document.querySelectorAll('.story .step')[${n}]; scrollTo(0, Math.round(li.getBoundingClientRect().top + scrollY - ${BAR} + ${p} * (li.offsetHeight - li.querySelector('.step-stage').offsetHeight))); return true; })()`);
        let seen = null;
        for (let i = 0; i < 60; i++) {
          await sleep(150);
          seen = await ev(`(() => { const li = document.querySelectorAll('.story .step')[${n}]; const b = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom].map(Math.round); };
            return { ring: li.dataset.ring || '', front: li.dataset.front || '', words: b(li.querySelector('.step-words')), floor: b(li.querySelector('.step-floor')), phones: !!li.querySelector('.floor-tall'), still: document.querySelector('[data-story]').dataset.still || '' }; })()`);
          if (seen.still || (seen.ring === k.toFixed(3) && seen.front)) break;
        }
        const at = `${where} step ${n + 1} (${id}) screen ${k + 1}`;
        if (seen.still) { fail(`${at}: the page went to the still story (${seen.still})`); break; }
        if (seen.ring !== k.toFixed(3) || !seen.front) { fail(`${at}: the ring did not come to rest (ring ${seen.ring || 'none'})`); continue; }
        const words = seen.words;
        const drawn = seen.front.split(',').map(Number).map((v, j) => v + (j % 2 ? seen.floor[1] : seen.floor[0]));
        const want = stageAt({ W, H, words, phones: seen.phones, t: k });
        const row = STAGES[size];
        const line = `${at}: words ${words.join(',')}, floor ${seen.floor.join(',')}, front drawn ${drawn.join(',')} (${want.L.form} ${want.L.w}x${want.L.h})`;
        const faults = [];
        if (seen.floor[1] !== words[3] || seen.floor[3] !== H || seen.floor[0] !== 0 || seen.floor[2] !== W) faults.push('the floor box is not the window under the words');
        if (drawn.some((v, j) => Math.abs(v - want.front[j]) > 1)) faults.push(`the scene drew the front screen at ${drawn.join(',')}, ring.mjs's layout puts it at ${want.front.map(Math.round).join(',')}`);
        if (!row) faults.push('no row in STAGES for this size');
        else if (Math.abs(words[0] - row.left) > 2 || Math.abs(words[2] - row.right) > 2 || Math.abs(words[3] - row.bottom[id]) > 2 || words[1] !== BAR) faults.push(`the words' box is not STAGES's (${row.left},${BAR},${row.right},${row.bottom[id]})`);
        faults.push(...stageFaults({ W, H, words, front: drawn, screens: want.screens }));
        if (faults.length) fail(`${line}: ${faults.join('; ')}`);
        else console.log(`ok   ${line}`);
        // After the lean frames of a turn (pace.mjs: half the pixel ratio, for 150 ms after it stops) comes one sharp frame.
        if (OUT && k === 1) await sleep(900);
        if (OUT && k === 1) fs.writeFileSync(path.join(OUT, `t${size}-${theme}-s${n + 1}-held.jpg`), await chrome.shot({ format: 'jpeg', quality: 85 }));
      }
    }
  } catch (e) {
    fail(`the check finished: ${e.message}`);
  } finally {
    await chrome.close().catch(() => {});
  }
  if (chrome.errors.length) console.log(`page errors: ${chrome.errors.slice(0, 5).join(' | ')}`);
  console.log(failed ? `stage-check: ${failed} failed` : 'stage-check: every pinned stage fills the window, as the site\'s test measures it');
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
