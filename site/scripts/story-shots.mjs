#!/usr/bin/env node
// The landing page's story pictures, made from the built-in demo (sample data in a temporary folder, nothing real):
//
//   node site/scripts/story-shots.mjs [--port N] [--only name,name]
//
// The mechanics are tools/screenshots.mjs's: `hoprig demo` started in this process, the local Chrome driven headless
// over the DevTools protocol (tools/chrome.mjs). Each screen is taken in the light and in the dark theme (the page
// shows the one that matches its own), as WebP into site/story/:
//   <name>-<theme>.webp        a desktop screen at 1280×800, for the still story on wide screens
//   <name>-<theme>-640.webp    the same at 640×400, for the still story's small panes
//   <name>-<theme>-1088.webp   the dashboard at 1088×680, for the moving story's front screen at pixel ratio 1
//   <name>-<theme>-2176.webp   the same at pixel ratio 2 (2176×1360): the front screen is about 1060 px wide at
//                              1440×900, so a texel of these is about one device pixel there
//   <name>-<theme>-phone.webp  a desktop screen taken at phone width, 780×1688 (390×844 at 2×), for the phone's story
//   <name>-<theme>.webp        a phone screen (…-phone) at 780×1688 too
//   home-<theme>-phone-top.webp  the top of Home at phone width, 780×1040, for the first screen on a phone (within the
//                              first screen's picture budget, 60 KB)
// The list of screens is STORY_SHOTS in app/(site)/story-data.mjs, which the page reads too.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOTS } from '../app/(site)/story-data.mjs';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SITE, '..');
const OUT = path.join(SITE, 'story');
const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const ONLY = opt('--only', '') ? new Set(opt('--only', '').split(',')) : null;
const MAX_BYTES = 140 * 1024;
const DESKTOP = { width: 1280, height: 800, mobile: false, scale: 1 };
const FRONT = { width: 1088, height: 680, mobile: false, scale: 2 };
const PHONE = { width: 390, height: 844, mobile: true, scale: 2 };
const PHONE_TOP = { width: 390, height: 520 }; // the first screen's picture on a phone: Home from its top, 3 by 4
// A desktop screen that starts further down its page: the element brought up to just under the page's sticky head.
// Providers: the list of providers itself (the Auto mode panel above it is the auto-mode picture). Taken from the top,
// its heading "PROVIDERS 4" sat on the bottom edge (a sliver at 2176) and the first card was cut there.
const SCROLL_TO = { providers: '.group-head', 'auto-mode': '#at-limit' };
fs.mkdirSync(OUT, { recursive: true });

const { launchChrome } = await import(path.join(ROOT, 'tools/chrome.mjs'));
const { main } = await import(path.join(ROOT, 'src/demo/index.mjs'));
const hooks = { onReady: (i) => (hooks.info = i) };
if ((await main(['--no-open', '--quiet', '--port', opt('--port', '8422')], hooks)) !== null) throw new Error('the demo did not start');
await hooks.background;
const { url } = hooks.info;
const chrome = await launchChrome();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(async () => {
  console.error('story-shots: still running after 20 minutes; stopping');
  await chrome.close().catch(() => {});
  await hooks.stop();
  process.exit(1);
}, 20 * 60_000).unref();

const written = [];
let origin = { x: 0, y: 0 };
async function capture(file, size, scale, max = MAX_BYTES) {
  let q = 80;
  const { x, y } = origin; // the clip is in the page's coordinates: a screen scrolled down (SCROLL_TO) is taken there
  const grab = async () => Buffer.from((await chrome.send('Page.captureScreenshot', { format: 'webp', quality: q, clip: { x, y, width: size.width, height: size.height, scale } })).data, 'base64');
  let buf = await grab();
  while (buf.length > max && q > 40) { q -= 10; buf = await grab(); }
  fs.writeFileSync(path.join(OUT, file), buf);
  written.push(`${file} ${Math.round(buf.length / 1024)} KB`);
}

try {
  let loads = 0;
  await chrome.viewport(DESKTOP.width, DESKTOP.height, { theme: 'light' });
  // Registered once, inert unless the address has firstrun=1: the page's own answer for the list of sessions is made empty,
  // so Home is a new install's (the demo has sessions), the same as tools/screenshots.mjs does for the first-run picture.
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { if (!location.search.includes('firstrun=1')) return; const f = window.fetch; window.fetch = async (...a) => { const r = await f(...a); if (!String((a[0] && a[0].url) || a[0]).includes('api/machines/sessions')) return r; const j = await r.clone().json(); for (const m of j.machines || []) m.sessions = []; return new Response(JSON.stringify(j), { status: r.status, headers: { 'Content-Type': 'application/json' } }); }; })();` });
  await chrome.goto(hooks.info.link, 2500); // the one-time sign-in link
  const chatId = await chrome.evaluate(`fetch('api/chats').then((r) => r.json()).then((j) => (j.chats || [])[0]?.chatId || '')`);
  const setting = (patch) => chrome.evaluate(`fetch('api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(patch)}) }).then((r) => r.status)`);
  const click = (text, sel) => chrome.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.getClientRects().length && b.textContent.replace(/\\s+/g, ' ').trim().includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`);
  // The first element `sel` brought up to 12 px under the sticky page head, whichever element scrolls.
  const scrollTo = (sel) => chrome.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; const head = document.querySelector('.pagehead'); el.style.scrollMarginTop = ((head ? head.getBoundingClientRect().height : 0) + 12) + 'px'; el.scrollIntoView({ block: 'start' }); return true; })()`);
  // The first run is shown while it is open, so its shots come first; then it is closed for the other Home shots.
  await setting({ server: { getStartedDismissed: false } });
  for (const shot of SHOTS) {
    if (shot.name === 'home') await setting({ server: { getStartedDismissed: true } });
    if (ONLY && !ONLY.has(shot.name)) continue;
    for (const theme of ['light', 'dark']) {
      const open = async (size) => {
        await chrome.viewport(size.width, size.height, { mobile: size.mobile, scale: size.scale, theme });
        await chrome.evaluate('try { sessionStorage.clear(); localStorage.clear(); } catch {} true').catch(() => {});
        await chrome.goto(`${url}/?shot=${++loads}${shot.hash.replace('{chat}', chatId)}`, shot.wait || 3000);
        if (shot.open) { await click(shot.open, 'summary'); await sleep(600); }
        if (shot.press) { await click(shot.press, '.row, button, a, [role=button]'); await sleep(1200); }
        origin = { x: 0, y: 0 };
        if (!size.mobile && SCROLL_TO[shot.name]) {
          await scrollTo(SCROLL_TO[shot.name]);
          await sleep(400);
          const [x, y] = await chrome.evaluate('[window.scrollX, window.scrollY]');
          origin = { x, y };
        }
      };
      // The phone viewport draws at 2×: a clip scale of 1 gives 780×1688, a texel a device pixel on the phone (at 1.5×
      // the phone's story drew them 1.2× up, a little soft).
      await open(PHONE);
      await capture(shot.phone ? `${shot.name}-${theme}.webp` : `${shot.name}-${theme}-phone.webp`, PHONE, 1);
      if (shot.name === 'home') await capture(`home-${theme}-phone-top.webp`, PHONE_TOP, 1, 60_000);
      if (shot.phone) continue;
      await open(DESKTOP);
      await capture(`${shot.name}-${theme}.webp`, DESKTOP, 1);
      await capture(`${shot.name}-${theme}-640.webp`, DESKTOP, 0.5);
      // The front screen's own size, drawn at 2×: the 2176 file as it is, the 1088 one at half.
      await open(FRONT);
      await capture(`${shot.name}-${theme}-2176.webp`, FRONT, 1);
      await capture(`${shot.name}-${theme}-1088.webp`, FRONT, 0.5);
    }
  }
} finally {
  await chrome.close().catch(() => {});
  await hooks.stop();
}
console.log(written.join('\n'));
console.log(`story-shots: ${written.length} pictures in ${path.relative(process.cwd(), OUT) || '.'}`);
process.exit(0);
