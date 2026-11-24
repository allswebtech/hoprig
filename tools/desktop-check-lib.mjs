// Dev-only (not in the published package): what the desktop's browser checks share (tools/desktop-check.mjs for
// the windows and bars, tools/desktop-apps-check.mjs for the native apps): the local Chrome headless
// (tools/chrome.mjs), started before `hoprig demo` narrows PATH, the demo on its own port with its own temp folders,
// the sign-in, and small helpers to press, drag, type, read and photograph. Chrome needs a short TMPDIR.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { launchChrome } from './chrome.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Start Chrome and the demo, sign in; returns everything a check uses. */
export async function startCheck(outName) {
  const argv = process.argv.slice(2);
  const opt = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
  const PORT = Number(opt('--port', '7680'));
  const OUT = path.resolve(opt('--out', path.join(os.tmpdir(), outName)));
  const ONLY = opt('--only', '') ? new Set(opt('--only', '').split(',')) : null;
  const want = (p) => !ONLY || ONLY.has(p);
  fs.mkdirSync(OUT, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const results = [];
  let failed = 0;
  function check(part, what, ok, detail = '') {
    results.push({ part, what, ok: !!ok, detail });
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} [${part}] ${what}${detail ? ` (${detail})` : ''}`);
  }

  const chrome = await launchChrome({ realHome: true }); // as tools/screenshots.mjs: the demo's temp HOME cuts Chrome off the network
  const { main } = await import(path.join(ROOT, 'src/demo/index.mjs'));
  const hooks = { onReady: (i) => (hooks.info = i) };
  if ((await main(['--no-open', '--quiet', '--port', String(PORT)], hooks)) !== null) throw new Error('the demo did not start');
  await hooks.background;
  const { url } = hooks.info;
  let other = null;
  const stopAll = async () => {
    await chrome.close().catch(() => {});
    if (other) other.close();
    await hooks.stop();
  };
  setTimeout(async () => {
    console.error('desktop-check: still running after 8 minutes; stopping');
    await stopAll();
    process.exit(1);
  }, 8 * 60_000).unref();

  const ev = (expr) => chrome.evaluate(expr);
  const J = JSON.stringify;
  async function shot(name) {
    fs.writeFileSync(path.join(OUT, `${name}.png`), await chrome.shot());
  }
  async function waitFor(expr, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await ev(expr).catch(() => false)) return true;
      await sleep(150);
    }
    return false;
  }
  async function mouse(type, x, y, { buttons = type === 'mouseReleased' ? 0 : 1, clickCount = 1, button = 'left' } = {}) {
    await chrome.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : button, buttons, clickCount });
  }
  async function click(x, y, opts = {}) {
    await mouse('mouseMoved', x, y, { buttons: 0 });
    await mouse('mousePressed', x, y, opts);
    await mouse('mouseReleased', x, y, opts);
  }
  async function dblclick(x, y) {
    await click(x, y, { clickCount: 1 });
    await click(x, y, { clickCount: 2 });
  }
  async function drag(x0, y0, x1, y1, steps = 14) {
    await mouse('mouseMoved', x0, y0, { buttons: 0 });
    await mouse('mousePressed', x0, y0);
    for (let i = 1; i <= steps; i++) {
      await mouse('mouseMoved', Math.round(x0 + ((x1 - x0) * i) / steps), Math.round(y0 + ((y1 - y0) * i) / steps));
      await sleep(16);
    }
    await sleep(40);
    await mouse('mouseReleased', x1, y1);
    await sleep(120);
  }
  async function key(code, keyName, mods = 0, vk = 0) {
    await chrome.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key: keyName, modifiers: mods, windowsVirtualKeyCode: vk });
    await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: keyName, modifiers: mods, windowsVirtualKeyCode: vk });
  }
  const rectOf = (sel) => ev(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  const center = (r) => [r.x + Math.round(r.w / 2), r.y + Math.round(r.h / 2)];
  const winSel = (app) => `.dwin[data-app=${J(app)}]`;
  const area = () => rectOf('.desk-area');
  const windows = () => ev(`[...document.querySelectorAll('.dwin')].map((w) => ({ app: w.dataset.app, snap: w.dataset.snap, hidden: w.classList.contains('hidden'), front: w.getAttribute('aria-current') === 'true', title: w.querySelector('.dwin-title').textContent }))`);
  // '' when the window's page is in bare mode with nothing of the full page's frame; else what is wrong.
  const frameOk = (app) => ev(`(() => { const f = document.querySelector(${J(`.dwin[data-app="${app}"] iframe`)}); const d = f && f.contentDocument; if (!d || !d.body) return 'no page'; const extra = [...d.querySelectorAll('.sidebar, .bottombar, .fab, .tia-boxroot:not(.hidden)')].map((e) => e.className); if (extra.length) return 'has ' + extra.join(', '); if (!f.contentWindow.location.search.includes('bare=1')) return 'not bare'; return ''; })()`);
  /** Bring a window to the front from its taskbar button (a click on a window behind may land on another one). */
  const toFront = (app) => ev(`(() => { const w = document.querySelector('.dwin[data-app="${app}"]'); if (w.getAttribute('aria-current') !== 'true' || w.classList.contains('hidden')) document.querySelector('.desk-task[data-id="' + w.dataset.id + '"]').click(); return true; })()`).then(() => sleep(150));
  /** What the document in a frame target (Chrome's own list) shows: { url, ok: the dashboard's page is in it }. */
  async function frameTarget(re) {
    const list = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
    const t = list.find((x) => x.type === 'iframe' && re.test(x.url));
    if (!t) return null;
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    const answer = new Promise((r) => ws.on('message', (m) => { const j = JSON.parse(m); if (j.id === 1) r(j); }));
    ws.send(J({ id: 1, method: 'Runtime.evaluate', params: { expression: `({ url: location.href, ok: !!document.getElementById('app') })`, returnByValue: true } }));
    const j = await Promise.race([answer, sleep(5000).then(() => null)]);
    ws.close();
    return j && j.result && j.result.result ? j.result.result.value : { error: 'no answer' };
  }
  let loads = 0;
  async function open(hash, { w, h, theme = 'light', mobile = false, prefs = null, wait = 1800 } = {}) {
    await chrome.viewport(w, h, { mobile, theme });
    if (prefs) {
      await chrome.goto(`${url}/?load=${++loads}#/more`, 600);
      await ev(`(() => { ${Object.entries(prefs).map(([k, v]) => (v === null ? `localStorage.removeItem(${J(`pref:${k}`)});` : `localStorage.setItem(${J(`pref:${k}`)}, ${J(J(v))});`)).join(' ')} return true; })()`);
    }
    await chrome.goto(`${url}/?load=${++loads}${hash}`, wait);
  }
  await chrome.viewport(1440, 900, { theme: 'light' });
  await chrome.goto(hooks.info.link, 2500); // the one-time sign-in link; the cookie stays for the whole run
  async function finish() {
    const errs = chrome.errors.filter((e) => !/Failed to load resource|net::ERR_ABORTED|frame-ancestors|X-Frame-Options|Refused to display/.test(e));
    check('page', 'no uncaught errors in the page', errs.length === 0, errs.slice(0, 5).join(' | '));
  }
  async function done() {
    await stopAll();
    console.log(`\n${results.length - failed} of ${results.length} checks passed; screenshots in ${OUT}`);
    process.exit(failed ? 1 : 0);
  }
  return {
    PORT, OUT, want, sleep, check, chrome, hooks, url, ev, J, shot, waitFor, mouse, click, dblclick, drag, key, rectOf, center, winSel, area, windows,
    frameOk, toFront, frameTarget, open, finish, done, stopAll, setOther: (o) => (other = o),
  };
}
