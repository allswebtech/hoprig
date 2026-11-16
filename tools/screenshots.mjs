#!/usr/bin/env node
// Dev-only (not in the published package): the README's screenshots, made again after any UI change with
//
//   node tools/screenshots.mjs [--out docs/screenshots] [--only name,name] [--port N] [--chrome-port N]
//
// It starts `hoprig demo` in this process (sample data in a temp folder, nothing real), drives the local Chrome
// headless over the DevTools protocol (tools/chrome.mjs), and writes WebP images (each kept under ~300 KB) and the
// GitHub social preview (assets/social-preview.png, 1280×640). Needs Chrome or Chromium; nothing to install.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const OUT = path.resolve(ROOT, opt('--out', 'docs/screenshots'));
const ONLY = opt('--only', '') ? new Set(opt('--only', '').split(',')) : null;
const MAX_BYTES = 300 * 1024;
fs.mkdirSync(OUT, { recursive: true });

const DESKTOP = { width: 1280, height: 800, mobile: false };
const PHONE = { width: 390, height: 844, mobile: true };


// ---------- the demo ----------
const { main } = await import(path.join(ROOT, 'src/demo/index.mjs'));
const hooks = { onReady: (i) => (hooks.info = i) };
if ((await main(['--no-open', '--quiet', ...(opt('--port') ? ['--port', opt('--port')] : [])], hooks)) !== null) throw new Error('the demo did not start');
process.stdout.write('demo started; waiting for its sample data…');
await hooks.background;
console.log(' ready');
const { url } = hooks.info;

const chrome = await launchChrome(opt('--chrome-port') ? { port: Number(opt('--chrome-port')) } : {});
// A whole run takes about two minutes; past ten something is stuck: stop the demo and Chrome, and say so.
setTimeout(async () => {
  console.error('screenshots: still running after 10 minutes; stopping');
  await chrome.close().catch(() => {});
  await hooks.stop();
  process.exit(1);
}, 10 * 60_000).unref();
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await chrome.viewport(DESKTOP.width, DESKTOP.height, { theme: 'light' });
  await chrome.goto(hooks.info.link, 2500); // the one-time sign-in link; the cookie stays for the whole run

  let loads = 0;
  async function view(hash, size, theme, wait = 1800) {
    await chrome.viewport(size.width, size.height, { mobile: size.mobile, theme });
    // A real reload each time (a different query string; a hash change alone would keep the page and any open sheet).
    // A fresh trail each time: a reload by address would otherwise show "‹ <the shot before>" in the page head.
    await chrome.evaluate('try { sessionStorage.clear(); } catch {} true').catch(() => {});
    await chrome.goto(`${url}/?shot=${++loads}${hash}`, wait);
  }
  const click = (text, sel = 'button, a, [role=link]') =>
    chrome.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.getClientRects().length && getComputedStyle(b).display !== 'none' && b.textContent.replace(/\\s+/g, ' ').trim().includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`);

  /** Capture the viewport as WebP under the size budget. */
  async function save(name, { format = 'webp' } = {}) {
    let q = 82;
    let buf = await chrome.shot({ format, quality: q });
    while (format === 'webp' && buf.length > MAX_BYTES && q > 40) {
      q -= 10;
      buf = await chrome.shot({ format, quality: q });
    }
    const file = path.join(OUT, `${name}.${format}`);
    fs.writeFileSync(file, buf);
    results.push({ file: path.relative(ROOT, file), kb: Math.round(buf.length / 1024) });
    return buf;
  }
  const want = (name) => !ONLY || ONLY.has(name);

  // ---------- the screens ----------
  const setting = (patch) => chrome.evaluate(`fetch('api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(patch)}) }).then((r) => r.status)`);
  // The demo's chat (src/demo/chat.mjs) and the folder it changed: the chat and the editor shots open them.
  const chatId = await chrome.evaluate(`fetch('api/chats').then((r) => r.json()).then((j) => (j.chats || [])[0]?.chatId || '')`);
  const shopDir = await chrome.evaluate(`fetch('api/chats').then((r) => r.json()).then((j) => (j.chats || [])[0]?.cwd || '')`);
  const shots = {
    // Home → Get started first, while it is open; then it is closed so the other Home shots show the sessions.
    'get-started-desktop-light': async () => view('#/', DESKTOP, 'light', 3000),
    // Closed only now, after the shot above was taken (the open page would hide it on its next poll).
    'home-desktop-light': async () => {
      await setting({ server: { getStartedDismissed: true } });
      await view('#/', DESKTOP, 'light');
    },
    // The chat: thinking, the to-do list, a file read, an edit with its diff, and a test run waiting for the OK.
    'chat-desktop-light': async () => view(`#/chat/${chatId}`, DESKTOP, 'light', 3500),
    'chat-phone-light': async () => view(`#/chat/${chatId}`, PHONE, 'light', 3500),
    'session-phone-light': async () => view('#/s/api-server', PHONE, 'light', 3000),
    'new-session-phone-light': async () => view('#/new', PHONE, 'light', 2500), // one tap on a project starts it
    // The editor on the chat's folder, Source Control, the changed file side by side.
    'editor-desktop-light': async () => {
      await view(`#/code?dir=${encodeURIComponent(shopDir)}&view=changes`, DESKTOP, 'light', 3000);
      await chrome.evaluate(`document.querySelector('.ed-change-name')?.closest('[tabindex]')?.click(); true`);
      await sleep(3000);
    },
    // The desktop: Sessions snapped to the left half, the Task manager to the right (Alt+Shift+arrow snaps the window
    // in front, as a person would).
    'desktop-desktop-light': async () => {
      const snap = (code) => chrome.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', key: '${code}', altKey: true, shiftKey: true, bubbles: true })); true`);
      await chrome.evaluate(`try { for (const k of Object.keys(localStorage)) if (k.startsWith('desktop.')) localStorage.removeItem(k); } catch {} true`);
      await view('#/desktop', DESKTOP, 'light', 2500);
      await chrome.evaluate(`document.querySelector('.desk-icon[data-app="sessions"]')?.click(); true`);
      await sleep(1500);
      await snap('ArrowLeft');
      await chrome.evaluate(`document.querySelector('.desk-start')?.click(); true`);
      await sleep(500);
      await click('Task manager', '.desk-app');
      await sleep(1000);
      await snap('ArrowRight');
      await sleep(3000);
    },
    'limit-reached-desktop-light': async () => view('#/s/docs-site', DESKTOP, 'light', 3500),
    // Providers with "Carry on with the next provider" chosen (Auto mode) and how it works opened.
    'auto-mode-desktop-light': async () => {
      await view('#/providers', DESKTOP, 'light', 2500);
      await click('How it works', 'summary');
      await sleep(500);
    },
    // The list of providers itself (the shot above shows the choice at the top of the same page).
    'accounts-desktop-light': async () => {
      await view('#/providers', DESKTOP, 'light', 2500);
      await chrome.evaluate(`(() => { const heads = [...document.querySelectorAll('h2, h3, .group-head')]; const el = heads.find((x) => /^providers/i.test(x.textContent.trim())); if (el) window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 90); })()`);
      await sleep(500);
    },
    'computers-desktop-light': async () => view('#/computers', DESKTOP, 'light', 2500),
    'computer-overview-desktop-light': async () => view('#/computer', DESKTOP, 'light', 3500),
    'computer-setup-desktop-light': async () => view('#/computer/setup', DESKTOP, 'light', 4000),
    'tia-desktop-light': async () => view('#/tia', DESKTOP, 'light', 3000),
    'settings-desktop-light': async () => view('#/settings', DESKTOP, 'light', 2500),
    'coding-tools-desktop-light': async () => view('#/settings/codingtools', DESKTOP, 'light', 2500),
    'updates-desktop-light': async () => view('#/settings/updates', DESKTOP, 'light', 3000),
    'public-link-desktop-light': async () => view('#/settings/public-link', DESKTOP, 'light', 2500),
    'projects-desktop-light': async () => view('#/workspace', DESKTOP, 'light', 4000),
    'project-page-desktop-light': async () => view('#/workspace/project/shop-frontend', DESKTOP, 'light', 4000),
  };
  const images = {};
  for (const [name, go] of Object.entries(shots)) {
    if (!want(name) && !(name === 'home-desktop-light' || name === 'chat-phone-light')) continue;
    await go();
    images[name] = await save(name);
    console.log(`  ${name}`);
  }

  // ---------- the hero: desktop Home next to the chat on a phone ----------
  const dataUrl = (b) => `data:image/webp;base64,${b.toString('base64')}`;
  async function compose(name, width, height, html, format = 'webp') {
    await chrome.viewport(width, height, { theme: 'light', scale: 1 });
    await chrome.goto(`data:text/html;base64,${Buffer.from(html).toString('base64')}`, 1200);
    return save(name, { format });
  }
  const mark = fs.readFileSync(path.join(ROOT, 'assets/logo-mark.svg')).toString('base64');
  if (want('hero')) {
    await compose('hero', 1600, 900, `<!doctype html><body style="margin:0;width:1600px;height:900px;overflow:hidden;background:linear-gradient(135deg,#eef0ff 0%,#f5f6f8 55%,#e3f6ec 100%);font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
      <img src="${dataUrl(images['home-desktop-light'])}" style="position:absolute;left:70px;top:70px;width:1100px;border-radius:14px;box-shadow:0 30px 80px rgba(20,24,60,.28)">
      <img src="${dataUrl(images['chat-phone-light'])}" style="position:absolute;right:90px;top:120px;width:330px;border-radius:38px;border:10px solid #15171c;box-shadow:0 30px 80px rgba(20,24,60,.35)">
    </body>`);
    console.log('  hero');
  }

  // ---------- GitHub's social preview, 1280×640 ----------
  if (want('social')) {
    const buf = await compose('social-preview-tmp', 1280, 640, `<!doctype html><body style="margin:0;width:1280px;height:640px;overflow:hidden;background:#0e1014;color:#e9ebf0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
      <div style="position:absolute;left:80px;top:150px;width:560px">
        <div style="display:flex;align-items:center;gap:22px"><img src="data:image/svg+xml;base64,${mark}" width="96" height="96"><span style="font-size:64px;font-weight:750;letter-spacing:-1.5px"><span style="color:#8b92a0">hop</span>rig</span></div>
        <p style="font-size:34px;line-height:1.3;margin:40px 0 0;font-weight:600">Your coding chats, on every computer.</p>
        <p style="font-size:24px;line-height:1.45;margin:18px 0 0;color:#b8bdc8">Claude Code and OpenCode in one dashboard. At a usage limit the same session goes on with the next provider. From your phone, too.</p>
      </div>
      <img src="${dataUrl(images['home-desktop-light'])}" style="position:absolute;left:700px;top:90px;width:760px;border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.6)">
    </body>`, 'png');
    fs.copyFileSync(path.join(OUT, 'social-preview-tmp.png'), path.join(ROOT, 'assets/social-preview.png')); // --out may be on another disk
    fs.rmSync(path.join(OUT, 'social-preview-tmp.png'));
    results.find((r) => r.file.endsWith('social-preview-tmp.png')).file = 'assets/social-preview.png';
    console.log(`  social preview (${Math.round(buf.length / 1024)} KB)`);
  }

} finally {
  await chrome.close();
  await hooks.stop();
}
console.log('\nWritten:');
for (const r of results) console.log(`  ${r.file}  ${r.kb} KB${r.kb > 300 ? '  (over 300 KB)' : ''}`);
process.exit(0);
